# Software Factory Board

A self-hosted board that shows how software work moves through an automated factory. Each company runs its own copy, so nothing is shared between companies.

You can create GitHub issues from the web board, or label one `ready`. A runner builds it with Claude Code in an isolated worktree, a second pass tests it, a third reviews it, and only after the review approves does the factory open a pull request. The web board shows every issue in its lane, and sits behind a login with roles, multi-factor authentication and an audit log.

## How it works

Issues move through lanes, which are GitHub labels: `ready`, `building`, `qa`, `review`, then `done`.

1. **Build:** picks the oldest `ready` issue, runs `claude -p` in a worktree on branch `issue-<n>`, checks the result itself (a commit, a clean tree, the project's tests), pushes the branch and moves the card to `qa`.
2. **QA** and **review:** each posts its verdict as a comment on the issue. The review lane opens the pull request (`Closes #<n>`) only when it approves, so an open pull request always means "approved".
3. **Rework:** a card that qa or review sent back is built again on the same branch, up to a limit per project.

The lanes run by hand, or automatically once you switch the scheduler on (see [The scheduler](#the-scheduler)). The details are in [runner/README.md](../runner/README.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `runner/` | The lane commands: `labels`, `build`, `qa`, `review` |
| `web/` | The board and the login system (Next.js, App Router, Tailwind) |
| `shared/` | Schemas used by both |
| `prompts/` | The builder, qa, review and rework prompts |
| `docker/`, `docker-compose.yml` | The hardened container setup |
| `docs/adr/`, `GLOSSARY.md` | Accepted decisions and the project's vocabulary |

## Run it in Docker

You need Docker with Compose v2, a GitHub token for the repositories you want to automate, and a Claude Code OAuth token. It is tested on Windows with Docker Desktop; it has not been run on Linux.

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Set it to |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Your Claude Code token (runner only) |
| `RUNNER_GITHUB_TOKEN` | A token that can write issues, pull requests and contents (runner only) |
| `BOARD_GITHUB_TOKEN` | A separate read-only token for the board. Leave it empty to see demo data |
| `CREATE_ISSUE_GITHUB_TOKEN` | Optional separate token with Issues: read/write for creating issues from the board |
| `MFA_ENCRYPTION_KEY` | 32 random bytes, base64. The web container refuses to start without it |
| `RUNNER_API_TOKEN` | 32 or more random bytes, base64. The runner uses it to fetch the projects from the web app. The web container refuses to start without it |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator (12 to 128 characters) |

Generate both values the same way, once each. Keep a copy of `MFA_ENCRYPTION_KEY` outside the repository: losing or changing it makes every stored MFA secret unreadable, and everyone must set MFA up again. `RUNNER_API_TOKEN` can be replaced at any time, in `.env` for both services:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then start it:

```bash
docker compose up -d --build
```

Open <http://localhost:2999>. The first login goes through three steps: log in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, choose a new password, then set up an authenticator app and save the ten recovery codes. After the first start, remove `ADMIN_PASSWORD` from `.env`: it is only used while no administrator exists.

The projects live in the web app. Log in as an Administrator and add, edit and switch on projects on the **Projects** screen (see [Administration](#administration)). Then run the lanes inside the runner container, or switch the scheduler on (next section):

```bash
docker compose exec runner npm run runner -- labels --project <name>
docker compose exec runner npm run runner -- build  --project <name> --dry-run
docker compose exec runner npm run runner -- build  --project <name>
```

Nothing runs by itself until you switch the scheduler on (next section). Stop it with `docker compose down`. Data stays in named volumes (`auth`, `workspace`, `data`, `cache`).

The board listens on `127.0.0.1` only, over plain http, with `COOKIE_SECURE=false` as `.env.example` sets it. To expose it beyond your machine, put a TLS proxy in front first, set `COOKIE_SECURE=true`, and only then change the port mapping. More in [docker/README.md](../docker/README.md).

## The scheduler

The scheduler runs the lanes for you. It is off by default: until you set `SCHEDULER_ENABLED=true` in `.env` and restart the runner (`docker compose up -d`), the runner container only idles. Once it is on, it builds every `ready` issue of every enabled project with your GitHub and Claude tokens, so turn it on on purpose.

Each **pass** goes through the lanes in this order: review for every project, then qa, then build. Projects go in name order and one run happens at a time. When a pass ends it waits `SCHEDULER_INTERVAL_MINUTES` (default 5) and starts the next. A single run is stopped after `SCHEDULER_RUN_TIMEOUT_MINUTES` (default 120).

- **It never merges.** Review opens the pull request when it approves and a person merges it.
- **Pausing:** switch a project off, or turn one of its lanes off, on the Projects screen. The runner asks the web app for the projects at every pass, so there is no restart. `docker compose stop runner` stops it. The web app must be running: when it is not, the pass is skipped.
- **Failing lanes back off.** A build that fails, a qa or review that cannot decide, or a run that is stopped for taking too long counts as no progress. The lane then waits 5, 10 and 20 minutes, and after three in a row it is paused and tried once an hour until a run makes progress. A card that qa or review sends back is the pipeline working, not a failure. A project that is not logged in to GitHub or lacks a tool is paused until its settings are changed on the Projects screen or the runner restarts.
- **Watching it:** `docker compose logs -f runner`. Pauses and resumes are also written to `data/events.jsonl` as `system` events.
- **Stopping mid-run** (`docker compose stop`) ends the run in progress. A build stopped that way leaves its card in `building` without a result: move it back to `ready` yourself.

## Signing in and roles

Anyone can register, but a new account sees only a "waiting for approval" page until an administrator gives it a role. Passwords are 12 to 128 characters and are checked against a list of common ones. Wrong guesses are delayed, never locked: five free attempts, then 30 seconds doubling up to 15 minutes.

| In this README | Role in the app | What it can do |
| --- | --- | --- |
| Administrator | `admin` | Everything below, plus the Users and Audit screens, switching projects on and setting their commands |
| Project manager | `issue-admin` | Sees the board, adds and edits projects, switches them off, and can mark a new issue `ready` for the factory. Cannot switch a project on or set its commands |
| Member | `viewer` | Sees the whole board and can create issues, but cannot mark one `ready` for the factory |

Sessions last 8 hours idle and 7 days at most. Administrator sessions are shorter: 1 hour idle and 12 hours at most.

## Administration

Administrators get an **Admin** link in the header, and Project managers a **Projects** link.

- **Users** (`/admin/users`): give or remove roles, disable or enable an account, reset a password (a temporary one is shown once and must be changed at next login), require MFA for a user, reset a user's MFA, and mark an email address as confirmed. Accounts waiting for a role are listed first. Users are disabled, never deleted. An administrator cannot remove their own role, disable themselves or reset their own password, at least one active administrator always remains, and an administrator who has MFA cannot be demoted in the app (disable the account instead).
- **Projects** (`/admin/projects`): the GitHub repositories the factory works on. A project has a name (fixed once created), a repository, a default branch, a stack, the lanes that run for it, limits on agent turns and automatic reworks, and a build and a test command. Administrators and Project managers can add and edit projects. **A project a Project manager adds starts switched off**, and only an Administrator can switch a project on or set its commands. A Project manager can edit a project only while it is switched off, so a project an Administrator vetted cannot be pointed at another repository: the commands run in the runner container, which holds your GitHub and Claude tokens. Anyone who can label issues in a switched-on project's repository can make the factory build, so switch a project on only for a repository you trust. A project is never deleted, so its history stays: an Administrator can archive a switched-off project, which hides it from the board and the runner, and restore it later from the **Archived** section (it comes back switched off). An archived project cannot be edited, and its name and repository stay reserved. Every change is in the audit log with the old and new values.
- **Audit log** (`/admin/audit`): who did what, newest first, filterable by action and user. It is read-only, and database triggers keep entries from being edited or deleted. It records logins, registrations, issue creation, role and account changes, password and MFA resets, and every change made by the break-glass command.

## Multi-factor authentication

MFA uses any authenticator app (6-digit codes, 30 seconds). It is off by default, administrators included. An administrator can require it for any user, themselves and other administrators too, and users can turn it on themselves at `/account/mfa`.

- Turning it on shows a QR code and **ten one-time recovery codes**, shown once.
- After the password, a user with MFA has five minutes to enter a code. Until then the session grants nothing, and a code works only once.
- Users can get new recovery codes or replace their authenticator, both after proving a current code.
- "Stop requiring MFA" on the Users screen also removes a non-admin's authenticator, as does Reset MFA. An administrator turns their own MFA off at `/account/mfa` after entering a current code (once MFA is no longer required for them). Another administrator's MFA can only be reset from the server (see below).

## Email verification and password reset

Off by default. With `EMAIL_VERIFICATION=true`, a new account is held until its address is confirmed, and the login page offers **Forgot your password?**. It needs these settings:

| Variable | Meaning |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Your mail server |
| `APP_URL` | The public address of the site, for links in emails (`https` unless `localhost`) |

- **Confirming** needs the emailed link and a login to that account, so a stranger cannot confirm an account they registered with your address by tricking you into clicking.
- **Resetting** works once for an hour, ends all the user's sessions and does not skip MFA.
- Mail uses TLS from the start on port 465 and requires STARTTLS on any other port. The certificate is always verified. If the mail server is down, logins still work.

The full behaviour, limits and trade-offs are in [docker/README.md](../docker/README.md).

## Break-glass recovery

When the web app cannot help (an administrator lost their authenticator and recovery codes, or the only administrator forgot their password), run these inside the web container:

```bash
docker compose exec web npm run admin -- reset-mfa      --email <email> --reason "<why>"
docker compose exec web npm run admin -- reset-password --email <email> --reason "<why>"
```

`reset-mfa` removes the user's MFA and ends their sessions. `reset-password` sets a temporary password, printed once on your terminal, and ends their sessions. It does not touch MFA, so run both if both are lost. If an administrator's password may be compromised, run `reset-password` first. Every run is recorded in the audit log with your reason.

Access to the server is the authorisation: anyone who can run `docker exec` can do this to any account, including administrators. The temporary password stays in your terminal's scrollback.

## Configuration reference

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MFA_ENCRYPTION_KEY` | yes | | Encrypts MFA secrets. Must be random bytes |
| `RUNNER_API_TOKEN` | yes | | Lets the runner fetch the projects from the web app (at least 32 random bytes, base64) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first start | | Creates the first administrator when none exists |
| `BOARD_GITHUB_TOKEN` | no | | Read-only token for the board. Empty means demo data |
| `CREATE_ISSUE_GITHUB_TOKEN` | no | | Optional Issues: read/write token for board issue creation. The token's account authors those issues |
| `RUNNER_GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | for the runner | | Runner credentials; the runner token is never given to the web container |
| `COOKIE_SECURE` | no | on in production | `false` for plain http on localhost |
| `TRUST_PROXY` | no | `false` | Believe `X-Forwarded-For` from a proxy you control |
| `EMAIL_VERIFICATION` | no | `false` | Email verification and reset by email |
| `SMTP_*`, `APP_URL` | with verification | | See above |
| `SCHEDULER_ENABLED` | no | `false` | `true` runs the lanes automatically |
| `SCHEDULER_INTERVAL_MINUTES` | no | `5` | Wait between the end of a pass and the next |
| `SCHEDULER_RUN_TIMEOUT_MINUTES` | no | `120` | A run is stopped after this long (1 to 170) |

## Status and limits

Built: the lane commands, the scheduler, the board, the login system described above, and the break-glass command.

Not built yet:

- **The scheduler is basic.** One run at a time, a fixed interval, and no view of it in the web app. Its failure counters are in memory, so a restart clears them. A card that keeps ending without a verdict at the head of the qa or review lane is retried about once an hour (a paused lane is probed that often) and holds up the cards behind it until someone moves it.
- **Credentials are still in `.env`.** The projects are managed in the web app, but the GitHub and Claude tokens are not. [ADR 0002](adr/0002-secrets-encrypted-in-db-master-key-outside-it.md) records the accepted direction (encrypted credentials set on a settings page); none of that exists yet.
- **The runner needs the web app.** It fetches the project list from it, so no run starts while the web app is down.
- **No network allow-list** for the runner container, which runs agent-written code.

Known limits of the login system:

- Resetting another account's password, resetting MFA or switching off "require MFA" does not ask the acting administrator for a fresh code, so a stolen, still-valid administrator session can do it. Those sessions are short for that reason.
- Switching a project on or setting its commands does not ask the Administrator for a fresh password or code, so a stolen, still-valid Administrator session could make the runner execute commands of its choosing. Administrator sessions are short for that reason. The web app's database now decides what runs in the runner container, so protect it like the tokens.
- Without a trusted proxy there is no per-IP limit, so registration and "forgot password" use shared hourly limits that a determined stranger can use up.
- Tested against a local mail server with a self-signed certificate, not a production mail provider.

## Development

You need Node.js 22 or newer (the login system uses the built-in `node:sqlite`).

```bash
npm install
npm test                # all workspaces
npm run typecheck
```

To run the board on your machine without Docker, set the login settings and start the production build. The development server (`next dev`) has not been tried with the login system.

```bash
export AUTH_DB_PATH="$PWD/auth.db" MFA_ENCRYPTION_KEY="<base64 key>" RUNNER_API_TOKEN="<base64 token>" COOKIE_SECURE=false FACTORY_DEMO=1
export ADMIN_EMAIL=you@example.com ADMIN_PASSWORD="<12 to 128 characters>"
npm run build -w web
npm run start -w web -- -p 3000
```

[web/README.md](../web/README.md) describes the board itself. [GLOSSARY.md](../GLOSSARY.md) defines the project's terms.

## License

MIT. See [LICENSE](../LICENSE).
