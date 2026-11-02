# Runner

TypeScript port of the bash lane scripts. This version has the **build lane**, the **qa lane**, the
**review lane** and **label setup**, as one-shot CLI commands, and the **scheduler** (`runner schedule`) that runs them for you.

**A PR exists only after a successful review.** Build pushes a branch `issue-<n>`, qa and review find the
work by that branch name, and every verdict is a comment on the **issue**. The review lane opens the PR
(`Closes #<n>`) when it approves. So an open PR always means "approved", and a card that was sent back
leaves only a branch behind.

## Use

Inside the Docker container (see `docker/README.md`):

```
docker compose exec runner npm run runner -- labels --project <name> [--dry-run]
docker compose exec runner npm run runner -- build  --project <name> [--issue <n>] [--dry-run]
docker compose exec runner npm run runner -- qa     --project <name> [--issue <n>] [--dry-run]
docker compose exec runner npm run runner -- review --project <name> [--issue <n>] [--merge] [--dry-run]
```

- `--dry-run` runs every read (labels, issues, fetch, an initial clone) and only prints the calls that
  would change GitHub or the repo. It skips the agent and the tests and writes no events.
- Needs `RUNNER_GITHUB_TOKEN` (write access to the repo's issues, pull requests and contents) and, for `build`,
  `ANTHROPIC_API_KEY`, both from the root `.env`.
- The projects come from the web app, not from files (ADR 0001): every command fetches the list from
  `FACTORY_WEB_URL` (default `http://web:2999`) with `RUNNER_API_TOKEN` as a bearer token. A missing token is a usage
  error (exit `64`); a web app that is down, refuses the token or sends an answer this version does not understand is
  exit `70` with a message that never contains the token. The request never follows a redirect and gives up after
  ten seconds. Clone locations stay here, in `local.json` or `FACTORY_WORKSPACE`.
- Exit codes: `0` ok or nothing to do, `1` lane failed or a card was sent back, `2` qa or review inconclusive, `64` usage, `65` precondition (for example the
  issue is not `ready`), `66` missing file, `69` missing tool or not logged in, `70` unexpected error (a thrown exception), `75` another run holds the lock.

## The scheduler

```
docker compose exec runner npm run runner -- schedule   # or the container's own command
```

`runner schedule` runs until SIGTERM. It is what the `runner` service starts, and it only idles unless
`SCHEDULER_ENABLED=true`. A **pass** asks the web app for the projects again, then runs `runner review`, `runner qa` and
`runner build` for every enabled project, lane by lane (all review runs, then all qa, then all build), projects in
name order, one run at a time. Each run is a child process of its own. It never passes `--merge`. The next pass starts
`SCHEDULER_INTERVAL_MINUTES` after the previous one ended.

What a finished run means:

| Exit | Meaning for the scheduler |
| --- | --- |
| `0` | progress (including "nothing to do") |
| `1` from `qa` or `review` | progress: a card was sent back |
| `1` from `build`, `2`, a crash, or a run killed after `SCHEDULER_RUN_TIMEOUT_MINUTES` | no progress |
| `75` | another run holds the lock: skipped, no penalty |
| `69` | the project is paused until its settings change in the web app or the runner restarts |
| `65`, `70`, anything else | no progress (`65` is about one card, such as a missing branch, so it never pauses the project) |

No progress backs a project's lane off for 5, 10 and 20 minutes. On the third in a row the lane is paused and probed
once an hour, until a run makes progress. Pauses and resumes are `system` events in `events.jsonl` and lines in the log.
The counters live in memory only.

A bad `SCHEDULER_*` value makes `runner schedule` exit with a message naming the variable (compose then restarts it, so
fix `.env`). A web app that cannot be reached, or an answer that is not valid, skips that pass, is recorded once as a
`failed` `system` event, and is asked again at the next. Each run gets its own process group, so a timeout or a stop also ends the agent and the
build and test commands that run started. On SIGTERM it starts no new run, passes SIGTERM to the run
in progress and exits when it ends (docker kills the container after `stop_grace_period`, 60 s). A build stopped that way
leaves its card in `building` with no result: move it back to `ready` by hand.

## What the build lane does

1. Creates any missing `ready`, `building`, `qa`, `review` labels (grey, blue, yellow, green). It only
   creates: existing labels keep their colour and description.
2. Picks a card: a `building` card to **rework** first (see below), else the oldest `ready` issue. With `--issue`,
   a `ready` card is built and a `building` card is reworked. It fetches the project's `defaultBranch`; a wrong
   branch name fails here, before anything is claimed.
3. Claims it: assigns the bot, `ready` becomes `building`.
4. Creates a worktree `issue-<n>` from `origin/<defaultBranch>` and runs `claude -p` in it.
5. Checks the result itself: at least one commit, a clean tree, then the project's `commands.test`
   (or `commands.build` when there are no tests, or nothing when there are neither).
   If the builder made **no commit** but left changes, the lane commits them itself as the bot
   (`🤖 [build] #<n>: <issue title>`, `git add -A`, hooks run) and still verifies. It refuses, and
   commits nothing, when a changed file looks like a secret (`.env*` except `.env.example`, `*.pem`,
   `*.key`, `*.pfx`, `*.p12`, `id_rsa*`). Leftover changes next to a commit the builder made stay a failure.
   The issue comment says when the lane made the commit.
6. Pushes the branch (no PR), moves the card to `qa`, and comments on the issue with the branch and a
   GitHub compare link (`<default>...issue-<n>`).

On a failure after the claim, the lane comments on the issue and the card stays in `building`.

## Rework: a card that qa or review sent back

A card in `building` that already has a branch used to wait for a human. Now the build lane continues on that
branch. A `building` card is **reworked** when all of these hold:

1. Branch `issue-<n>` exists on `origin`.
2. The latest factory verdict on the issue is `[qa] fail at <sha>` or `[review] changes requested at <sha>`
   (written by the runner's own `gh` login; comments from anyone else are ignored). A later pass, approval or
   inconclusive result cancels it.
3. That `<sha>` is the branch's current head. If someone pushed since, the feedback may be stale: the card is
   **not** reworked, and you send it to `qa` by hand. `--issue` never bypasses this.
4. No `[build]` comment is newer than the feedback. A failed rework comments `[build] failed`, which parks the
   card, so a scheduler cannot loop on it. `--issue` ignores this rule, which is how you retry.
5. Fewer than `limits.maxReworks` (default `2`, `0` turns it off) reworks finished (`[build] rework done`
   comments). `--issue` ignores this rule too.

Rework cards are picked before `ready` cards, oldest first. The run:

- creates the worktree at the branch's current head (pinned), and starts the agent with `prompts/rework.md`
  (or `prompts.rework`), the issue, and the feedback comment quoted as data in a fenced block;
- counts new commits from that head, commits left-over changes itself as in a fresh build (same secret guard),
  runs the independent build or test, and pushes as a plain fast-forward (never forced);
- moves the card to `qa` with `[build] rework done (round <k>). Pushed <n> commit(s) to issue-<n> (compare: <url>).
  Addressed: <first reason>.`, and opens no PR. A failure leaves the card in `building`.

## What the qa lane does

1. Picks the oldest `qa` issue (or `--issue`) and checks that branch `issue-<n>` exists on `origin`. A card
   without that branch is refused (exit 65) and left alone.
2. Fetches the branch, pins its commit, and creates a fresh detached worktree `qa-issue-<n>` at exactly that commit.
3. Runs the mechanical checks from the registry, build then test (the first failure stops them). A project
   with neither command skips them, and the agent decides alone.
4. Runs a read-only agent (`prompts/qa.md`: Read, Glob, Grep, a few `git` subcommands and the stack's
   toolchain; no Edit or Write) that ends with `VERDICT: PASS` or `FAIL` and up to five `REASON:` lines.
   The last exact `VERDICT:` line counts, and a failed check always wins over a PASS. Besides the issue, the
   agent gets what earlier rounds asked for, read from the issue's comments (factory login only, quoted as
   data): **Requirements added by review** (the latest `[review] changes requested`, live until a
   `[review] approved` or `merged`), and **Earlier qa findings to re-check** (the latest `[qa] fail`, once a
   rework answered it). So a rework that did what review asked is not failed for it.
5. Decides, and comments on the **issue** (`[qa] pass|fail at <sha>`; there is no PR yet):
   - pass: `qa` becomes `review`
   - failed check or FAIL verdict: `qa` becomes `building`
   - inconclusive (agent error, no verdict line, or the branch moved while qa ran): the card stays in `qa`

## What the review lane does

The last gate before a merge. **Nothing is merged unless you pass `--merge`.**

0. **Merged by a human:** a `review` issue whose `issue-<n>` PR is already merged is closed and loses its `review`
   label (comment `[review] merged`), even if the PR has no `Closes #<n>`. This runs first, so a deleted branch is fine.
1. Picks the oldest `review` issue (or `--issue`) and checks that branch `issue-<n>` exists on `origin`
   (exit 65 if not).
2. **QA gate:** the issue must carry a `[qa] pass at <sha>` comment for the branch's current head, written by
   the factory's own account (the `gh` login). Comments from anyone else are ignored, so a pass cannot be
   forged, and the latest qa result wins. Otherwise the card goes back to `qa`.
3. **Merge gate:** a fresh worktree at the current default branch, the branch head merged in with
   `git merge --no-commit --no-ff`, then the project's build and test on that result.
4. A read-only agent (`prompts/review.md`, same tools as qa) answers `VERDICT: APPROVE` or `REQUEST_CHANGES`.
   It gets the same **Requirements added by review** section as qa, so a re-review judges against what the
   earlier review asked for.
5. Staleness: if the default branch or the branch head moved while it ran, the result is inconclusive.
6. Decides, and comments on the **issue**:
   - a conflict, a failed build or test, or `REQUEST_CHANGES`: `review` becomes `building`. **No PR is opened.**
   - approved: **opens the PR** (a normal one, not a draft) with `Closes #<n>`, the qa pass and the review
     notes in its body, and comments `PR #<n>: <url>` on the issue. An open PR for the branch is reused, so a
     rerun never opens a second one, and a draft PR left by an older flow is marked ready. Without `--merge`
     the card stays in `review` and the open PR waits for a human to merge it.
   - approved with `--merge`: also squash-merges **pinned to the reviewed commit** (a later push makes GitHub
     refuse it), removes the `review` label, and deletes the `issue-<n>` branch locally and on `origin`. The
     issue closes through the PR's `Closes #<n>`, so there is no `done` label.
   - anything undecidable, including GitHub refusing the PR or the merge: the card stays in `review`. A PR that
     was already opened stays open and the next run reuses it.

A pull request opened by hand, or a push to the branch after the approval, is not covered by this: GitHub does
not know the factory's verdict. A required `factory/review` commit status with branch protection is the
follow-up that closes that.

A card sent back to `building` is not picked up again automatically: the build lane only takes `ready`
issues and refuses a branch that already exists on `origin`. A rework path comes later.

## Where things live

| What | Where |
| --- | --- |
| clones | `local.json` override, else `$FACTORY_WORKSPACE/<repo name>` (cloned with `gh` if missing) |
| worktrees | `<workspace>/.factory-worktrees/<project>/issue-<n>`, removed when the run ends |
| agent logs | `$FACTORY_DATA/logs/<project>/issue-<n>.log`; for qa `qa-issue-<n>.log` (checks) and `qa-issue-<n>.agent.txt` (the agent's answer); the same for review as `review-issue-<n>.*` |
| events | `$FACTORY_DATA/events.jsonl` (schema: `shared/src/event.ts`) |
| locks | `$FACTORY_DATA/locks/<project>.lock`, one run per project, stale locks are taken over |
| prompt | `prompts/builder.md`, `prompts/qa.md` and `prompts/review.md`, or the project's `prompts.builder` / `prompts.qa` / `prompts.review`; `{{build_command}}`, `{{test_command}}`, `{{default_branch}}` and `{{project_name}}` are filled in |

## Design

`src/lanes/build.ts` only talks to the interfaces in `src/ports.ts` (`Gh`, `Git`, `AgentRunner`, `Shell`,
`EventLog`). The real implementations in `src/adapters/` call the `gh`, `git` and `claude` programs with an
argument array, so no shell is involved, and long text goes through stdin. The tests use fakes
(`src/testing/fakes.ts`), so they need no network.

Git authenticates through `gh auth git-credential` per command and nothing is written to git config.
Commits are authored as the bot account. The agent only gets file tools, a few `git` subcommands and its
stack's toolchain (`allowedToolsFor` in `src/prompt.ts`).

## Limits

- Network egress from the container is not restricted yet.
- On native Windows, `gh`, `git` and `claude` must be real executables on `PATH` (no `.cmd` shims), because
  nothing is run through a shell.
- Test with `npm test -w runner`; `npm run typecheck -w runner`.
