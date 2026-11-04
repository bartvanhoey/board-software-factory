import { join } from "node:path";
import type { NewEvent, Project } from "@factory/shared";
import { EXIT, UsageError, errorMessage } from "../errors.js";
import { laneContext, laneSections } from "../feedback.js";
import { compareUrl } from "../links.js";
import type { AgentRunner, EventLog, Gh, Git, LabelEnsurer, Shell } from "../ports.js";
import { DENIED_TOOLS, qaToolsFor, renderPrompt } from "../prompt.js";
import { latestQaResult } from "../qaGate.js";
import { parseVerdict } from "../verdict.js";

export interface ReviewDeps {
  gh: Gh;
  git: Git;
  agent: AgentRunner;
  shell: Shell;
  events: EventLog;
  labels: LabelEnsurer;
  say: (message: string) => void;
  /** Writes a text file, creating its folder. */
  writeText: (file: string, text: string) => void;
}

export interface ReviewOptions {
  project: Project;
  cloneDir: string;
  paths: { worktreeRoot: string; logDir: string };
  promptTemplate: string;
  /** A specific issue to review; default is the oldest one labelled `review`. */
  issue?: number;
  /** On approval, also squash-merge the PR. Without it the lane opens the PR and leaves the merge to a human. */
  merge: boolean;
  /** Stop after the QA gate; mutating calls are expected to be no-ops. */
  dryRun: boolean;
}

export type ReviewResult =
  | { status: "noop" }
  | { status: "dry_run"; issue: number }
  | { status: "back_to_qa"; issue: number; reason: string }
  | { status: "sent_back"; issue: number; reason: string }
  | { status: "inconclusive"; issue: number; reason: string }
  | { status: "approved"; issue: number; pr: number; prUrl: string }
  | { status: "merged"; issue: number; pr: number; prUrl: string }
  | { status: "failed"; issue?: number; reason: string };

/** Exit code for a result, as in scripts/review.sh: 0 approved or merged, 1 sent back, 2 inconclusive. */
export function reviewExitCode(result: ReviewResult): number {
  if (result.status === "inconclusive") return EXIT.inconclusive;
  if (result.status === "back_to_qa" || result.status === "sent_back" || result.status === "failed") return EXIT.failed;
  return 0;
}

const hasLabel = (labels: readonly string[], name: string): boolean =>
  labels.some((l) => l.toLowerCase() === name);

/**
 * The commit the factory's latest review result approved, from its comments (`[review] approved at <sha>`; other results
 * are `changes requested`, `back to qa` and `inconclusive`). Only comments by `login` count, and the latest result wins.
 * Returns null unless that latest result is an approval.
 */
function latestApproval(comments: readonly { author: string; body: string }[], login: string): string | null {
  let latest: string | null = null;
  for (const comment of comments) {
    if (comment.author.toLowerCase() !== login.toLowerCase()) continue;
    for (const line of comment.body.replace(/\r/g, "").split("\n")) {
      const m = /^\[review\] (approved|changes requested|back to qa|inconclusive|merged)\b(?: at ([0-9a-f]{7,40})\b)?/.exec(line);
      if (m) latest = m[1] === "approved" ? (m[2] ?? null) : null;
    }
  }
  return latest;
}

/**
 * The review lane: the last gate before a merge.
 *
 * There is no PR until this lane approves, so everything it says goes on the issue.
 *
 * 1. The branch must be exactly what the qa lane passed: a `[qa] pass at <sha>` comment on the issue
 *    from the factory's own account, for the branch's current head. Otherwise the card goes back to `qa`.
 * 2. The merge gate: the branch head is merged into the current default branch in a fresh worktree, and
 *    the project's build and test run on that result.
 * 3. A read-only agent reviews the change.
 * 4. A conflict, a failed check or REQUEST_CHANGES sends the card back to `building`, with no PR.
 *    APPROVE opens the PR (`Closes #N`), reusing an open one, and comments on the issue. With `merge`
 *    set it then squash-merges the PR, pinned to the reviewed commit.
 *
 * Nothing is merged without `merge`, and anything the lane cannot decide leaves the card in `review`.
 */
export async function runReviewLane(deps: ReviewDeps, opts: ReviewOptions): Promise<ReviewResult> {
  const { gh, git, agent, shell, events, labels, say, writeText } = deps;
  const { project, cloneDir, dryRun } = opts;
  const repo = project.repo;
  const base = project.defaultBranch;
  const emit = (type: NewEvent["type"], message: string, extra: { issue?: number; url?: string } = {}) =>
    events.append({ project: project.name, lane: "review", type, message, ...extra });

  // 0. Lane labels must exist before anything tries to use them.
  try {
    await labels.ensure(repo);
  } catch (e) {
    const reason = `could not create the lane labels: ${errorMessage(e)}`;
    say(`FAILED: ${reason}`);
    emit("failed", reason);
    return { status: "failed", reason };
  }

  /** True when the factory approved the card's current head and the PR it opened is still open. Any doubt means false. */
  const isApproved = async (candidate: number): Promise<boolean> => {
    try {
      const approved = latestApproval(await gh.listIssueComments(repo, candidate), (await gh.whoami()).login);
      if (approved === null) return false;
      const branch = `issue-${candidate}`;
      if (!(await gh.findOpenPr(repo, branch))) return false;
      await git.fetch(cloneDir, "origin", branch);
      return (await git.revParse(cloneDir, `origin/${branch}`)).startsWith(approved);
    } catch {
      return false;
    }
  };

  /**
   * A card in `review` whose `issue-<n>` PR was merged without the factory (a human merged it, and the PR may lack
   * `Closes #<n>`): close the issue and drop its review label. Any doubt means null and the card is left alone.
   */
  const closeIfMerged = async (candidate: number): Promise<Extract<ReviewResult, { status: "merged" }> | null> => {
    let pr: { number: number; url: string } | null;
    try {
      pr = await gh.findMergedPr(repo, `issue-${candidate}`);
    } catch (e) {
      say(`could not look for a merged PR of issue-${candidate}: ${errorMessage(e)}`);
      return null;
    }
    if (pr === null) return null;
    say(`PR #${pr.number} of issue-${candidate} is already merged: closing #${candidate}`);
    try {
      await gh.closeIssue(repo, candidate);
    } catch (e) {
      say(`could not close issue #${candidate}: ${errorMessage(e)}`);
      return null;
    }
    emit("merged", `PR #${pr.number} was merged outside the factory`, { issue: candidate, url: pr.url });
    try {
      await gh.editIssue(repo, candidate, { removeLabels: ["review"] });
    } catch (e) {
      say(`closed #${candidate}, but removing the review label failed: ${errorMessage(e)}`);
    }
    try {
      await gh.comment(repo, candidate, `[review] merged\nPR #${pr.number}: ${pr.url} was merged by a human, so the issue is closed.\nNext: none.`);
    } catch (e) {
      say(`could not comment on issue #${candidate}: ${errorMessage(e)}`);
    }
    return { status: "merged", issue: candidate, pr: pr.number, prUrl: pr.url };
  };

  // 1. Pick a card, and find its pull request.
  let number = opts.issue;
  if (number === undefined) {
    let queued = (await gh.listIssuesByLabel(repo, "review")).map((i) => i.number).sort((a, b) => a - b);
    let closedByMerge: Extract<ReviewResult, { status: "merged" }> | null = null;
    const handled = new Set<number>();
    for (const candidate of queued) {
      const closed = await closeIfMerged(candidate);
      if (closed !== null) {
        closedByMerge = closed;
        handled.add(candidate);
      }
    }
    if (closedByMerge !== null) {
      queued = queued.filter((n) => !handled.has(n));
      if (queued.length === 0) return closedByMerge;
    }
    if (queued.length === 0) {
      say("no open issue labelled review");
      emit("noop", "no open issue labelled review");
      return { status: "noop" };
    }
    // An approved card waits in `review` for a human to merge its PR. Without --merge there is nothing left to do for it,
    // and reviewing it again on every pass would spend the agent on a verdict that is already given.
    for (const candidate of queued) {
      if (opts.merge || !(await isApproved(candidate))) {
        number = candidate;
        break;
      }
    }
    if (number === undefined) {
      const why = "every card in review is already approved and waits for a human to merge its PR";
      say(why);
      emit("noop", why);
      return { status: "noop" };
    }
  }
  const issue = await gh.getIssue(repo, number);
  if (!hasLabel(issue.labels, "review")) {
    throw new UsageError(`issue #${number} is not labelled review`, EXIT.precondition);
  }
  if (opts.issue !== undefined) {
    const closed = await closeIfMerged(number);
    if (closed !== null) return closed;
  }
  const branch = `issue-${number}`;
  const rendered = renderPrompt(opts.promptTemplate, project);
  // The work is a branch: no PR exists until this lane approves it.
  if (!(await git.remoteBranchExists(cloneDir, branch))) {
    throw new UsageError(`branch ${branch} not found on origin`, EXIT.precondition);
  }
  const compare = compareUrl(repo, base, branch);

  let sha: string;
  let baseSha: string;
  try {
    await git.fetch(cloneDir, "origin", base);
    await git.fetch(cloneDir, "origin", branch);
    sha = await git.revParse(cloneDir, `origin/${branch}`);
    baseSha = await git.revParse(cloneDir, `origin/${base}`);
  } catch (e) {
    const reason = `could not fetch ${base} and ${branch}: ${errorMessage(e)}`;
    say(`FAILED: ${reason}`);
    emit("failed", reason, { issue: number });
    return { status: "failed", issue: number, reason };
  }
  const short = sha.slice(0, 7);
  say(`review #${number} (${branch}) head ${short} onto ${base} ${baseSha.slice(0, 7)}: ${issue.title}`);
  emit("started", `review of ${branch} at ${short}`, { issue: number, url: compare });

  const comment = async (body: string): Promise<void> => {
    try {
      await gh.comment(repo, number, body);
    } catch (e) {
      say(`could not comment on issue #${number}: ${errorMessage(e)}`);
    }
  };
  const bullets = (reasons: readonly string[]): string =>
    reasons.length > 0 ? reasons.map((r) => `- ${r}`).join("\n") : "- (the agent gave no reason)";

  // 2. The branch must be what the qa lane passed, judged by the factory's own account.
  const me = await gh.whoami();
  const thread = await gh.listIssueComments(repo, number);
  const qa = latestQaResult(thread, me.login);
  const toQa = async (why: string): Promise<ReviewResult> => {
    say(`back to qa: ${why}`);
    await gh.editIssue(repo, number, { removeLabels: ["review"], addLabels: ["qa"] });
    emit("back_to_qa", why, { issue: number, url: compare });
    await comment(`[review] back to qa at ${short}\n${why}\nNext: qa reruns on the new commit.`);
    return { status: "back_to_qa", issue: number, reason: why };
  };
  if (qa === null) return toQa("no [qa] pass comment found on this issue");
  if (!qa.pass) return toQa(`the latest qa result is a fail at ${qa.sha}`);
  if (!sha.startsWith(qa.sha)) return toQa(`branch head is ${short} but qa passed ${qa.sha}`);

  // 3. A dry run stops here and shows the possible outcomes.
  if (dryRun) {
    const existing = await gh.findOpenPr(repo, branch);
    const prStep = existing
      ? `reuse PR #${existing.number}${existing.isDraft ? " (marking it ready)" : ""}`
      : `open PR ${branch} -> ${base} with Closes #${number}`;
    say(`dry-run: qa passed ${qa.sha}, matches head`);
    say(`dry-run: would merge ${short} into ${base} ${baseSha.slice(0, 7)} in a fresh worktree, build + test, then run the read-only agent (max ${project.limits.reviewMaxTurns} turns)`);
    say(
      opts.merge
        ? `dry-run: approve + --merge -> ${prStep}, squash merge pinned to ${short}, remove the review label; changes -> review -> building`
        : `dry-run: approve -> ${prStep}, comment on the issue, the card stays in review (no --merge); changes -> review -> building`,
    );
    if (opts.merge) await gh.editIssue(repo, number, { removeLabels: ["review"] });
    await gh.editIssue(repo, number, { removeLabels: ["review"], addLabels: ["building"] });
    return { status: "dry_run", issue: number };
  }

  const worktree = join(opts.paths.worktreeRoot, `review-${branch}`);
  const logFile = join(opts.paths.logDir, `review-${branch}.log`);
  const agentFile = join(opts.paths.logDir, `review-${branch}.agent.txt`);
  let worktreeCreated = false;

  const inconclusive = async (why: string): Promise<ReviewResult> => {
    say(`INCONCLUSIVE: ${why} (card stays in review)`);
    emit("inconclusive", why, { issue: number, url: compare });
    await comment(`[review] inconclusive at ${short}\n${why}\nNext: card stays in review, rerun the review lane.`);
    return { status: "inconclusive", issue: number, reason: why };
  };

  try {
    // 4. The merge gate: the branch merged into the current default branch, built and tested.
    await git.worktreeRemove(cloneDir, worktree);
    await git.worktreeAddDetached(cloneDir, worktree, baseSha);
    worktreeCreated = true;
    writeText(logFile, "");

    const checks = [
      project.commands.build ? { kind: "build", command: project.commands.build } : null,
      project.commands.test ? { kind: "test", command: project.commands.test } : null,
    ].filter((c): c is { kind: string; command: string } => c !== null);

    let gateNote: string | null = null;
    say(`merge gate: ${base} + branch head`);
    if (!(await git.merge(worktree, sha))) {
      gateNote = `merge conflict with ${base}`;
    } else {
      for (const check of checks) {
        say(`${check.kind}: ${check.command}`);
        if (!(await shell.run(check.command, { cwd: worktree, logFile })).ok) {
          gateNote = `${check.kind} failed on ${base} + branch`;
          break;
        }
      }
      if (gateNote === null) {
        emit("verified", `merge gate passed${checks.length > 0 ? `: ${checks.map((c) => c.kind).join(" and ")}` : " (no build or test command configured)"}`, { issue: number });
      }
    }
    const did = checks.length > 0 ? `merge gate (${base} + branch), agent review` : `agent review (no build or test command configured)`;

    // 5. Agent review, read-only.
    const prompt = `${rendered}\n\nCommit under review: ${sha}\nBase: origin/${base}\n\n## Issue #${number}: ${issue.title}\n\n${issue.body}\n${laneSections(laneContext(thread, me.login), { recheck: false })}`;
    say(`review agent running; its answer goes to ${agentFile}`);
    let answer: string;
    try {
      answer = await agent.run({
        cwd: worktree,
        prompt,
        maxTurns: project.limits.reviewMaxTurns,
        allowedTools: qaToolsFor(project),
        disallowedTools: DENIED_TOOLS,
        logFile,
        env: {},
      });
    } catch (e) {
      return await inconclusive(`review agent exited with an error (${errorMessage(e)})`);
    }
    writeText(agentFile, answer);

    // 6. Staleness: the result only counts for the commits that were actually reviewed.
    await git.fetch(cloneDir, "origin", base);
    await git.fetch(cloneDir, "origin", branch);
    if ((await git.revParse(cloneDir, `origin/${base}`)) !== baseSha) return await inconclusive(`${base} moved while review ran`);
    if ((await git.revParse(cloneDir, `origin/${branch}`)) !== sha) return await inconclusive("branch head moved while review ran");

    const { verdict, reasons } = parseVerdict(answer, ["APPROVE", "REQUEST_CHANGES"] as const);
    if (verdict === null) return await inconclusive("agent gave no VERDICT line");

    // 7. Decide.
    if (gateNote !== null || verdict === "REQUEST_CHANGES") {
      const lines = gateNote !== null ? [gateNote, ...reasons] : reasons;
      const reason = lines.join("; ");
      say("REQUEST CHANGES -> building");
      await gh.editIssue(repo, number, { removeLabels: ["review"], addLabels: ["building"] });
      emit("sent_back", reason, { issue: number, url: compare });
      await comment(`[review] changes requested at ${short}\nDid: ${did}.\n❌ Not done:\n${bullets(lines)}\nNext: back to building.`);
      return { status: "sent_back", issue: number, reason };
    }

    // 8. Approved: only now does a PR exist. A rerun reuses the open one, and a draft left by an
    // older flow is marked ready, because from here on an open PR means "approved".
    const prBody = [
      `Closes #${number}`,
      "",
      `Built, tested and approved by the factory at ${short}.`,
      `QA: pass at ${qa.sha}.`,
      `Review: ${did}.`,
      "",
      "Reviewer notes:",
      bullets(reasons),
    ].join("\n");
    let pr: { number: number; url: string };
    try {
      const existing = await gh.findOpenPr(repo, branch);
      if (existing) {
        say(`reusing PR #${existing.number}`);
        if (existing.isDraft) await gh.markPrReady(repo, existing.number);
        pr = existing;
      } else {
        say(`approved: opening PR ${branch} -> ${base}`);
        pr = await gh.createPr(repo, { base, head: branch, title: issue.title, body: prBody });
        emit("pr_opened", `PR #${pr.number} ${pr.url}`, { issue: number, url: pr.url });
      }
    } catch (e) {
      return await inconclusive(`could not open the pull request (${errorMessage(e)})`);
    }

    if (!opts.merge) {
      say(`approved, PR #${pr.number} is open for a human to merge (rerun with --merge to merge it)`);
      emit("approved", `approved at ${short}, PR #${pr.number} open`, { issue: number, url: pr.url });
      await comment(
        `[review] approved at ${short}\nDid: ${did}.\n✅ Done:\n${bullets(reasons)}\nPR #${pr.number}: ${pr.url}\nNext: not merged. A human merges the PR, or rerun with --merge.`,
      );
      return { status: "approved", issue: number, pr: pr.number, prUrl: pr.url };
    }

    // 9. Merge, pinned to the reviewed commit, so a later push makes GitHub refuse it.
    say(`merge PR #${pr.number} (squash, pinned to ${short})`);
    try {
      await gh.mergePr(repo, pr.number, { matchHeadCommit: sha });
    } catch (e) {
      return await inconclusive(`GitHub refused the merge of PR #${pr.number} (${errorMessage(e)})`);
    }

    // The PR is merged. Whatever fails below is reported, but the result is still "merged".
    // The issue closes through the PR's `Closes #N`, so only the review label is removed.
    emit("merged", `squash merged at ${short}`, { issue: number, url: pr.url });
    const after = async (what: string, step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (e) {
        say(`merged, but ${what} failed: ${errorMessage(e)}`);
      }
    };
    await after("removing the review label", () => gh.editIssue(repo, number, { removeLabels: ["review"] }));
    await comment(`[review] merged at ${short}\nDid: ${did}, squash merge pinned to this commit.\n✅ Done:\n${bullets(reasons)}\nPR #${pr.number}: ${pr.url}\nNext: none.`);
    await after("removing the builder's worktree", () => git.worktreeRemove(cloneDir, join(opts.paths.worktreeRoot, branch)));
    await after("deleting the local branch", async () => {
      if (await git.branchExists(cloneDir, branch)) await git.deleteBranch(cloneDir, branch);
    });
    await after("deleting the remote branch", () => git.deleteRemoteBranch(cloneDir, branch));
    say(`done: PR #${pr.number} merged`);
    return { status: "merged", issue: number, pr: pr.number, prUrl: pr.url };
  } catch (e) {
    return await inconclusive(`unexpected error: ${errorMessage(e)}`);
  } finally {
    if (worktreeCreated) {
      try {
        await git.worktreeRemove(cloneDir, worktree);
      } catch (e) {
        say(`could not remove worktree ${worktree}: ${errorMessage(e)}`);
      }
    }
  }
}
