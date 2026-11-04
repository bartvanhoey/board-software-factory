import { join } from "node:path";
import type { NewEvent, Project } from "@factory/shared";
import { EXIT, UsageError, errorMessage } from "../errors.js";
import { laneContext, laneSections } from "../feedback.js";
import { compareUrl } from "../links.js";
import type { AgentRunner, Gh, Git, LabelEnsurer, Shell, EventLog } from "../ports.js";
import { DENIED_TOOLS, qaToolsFor, renderPrompt } from "../prompt.js";
import { parseVerdict } from "../verdict.js";

export interface QaDeps {
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

export interface QaOptions {
  project: Project;
  cloneDir: string;
  paths: { worktreeRoot: string; logDir: string };
  promptTemplate: string;
  /** A specific issue to test; default is the oldest one labelled `qa`. */
  issue?: number;
  /** Stop after picking the card and fetching its branch; mutating calls are expected to be no-ops. */
  dryRun: boolean;
}

export type QaResult =
  | { status: "noop" }
  | { status: "dry_run"; issue: number }
  | { status: "passed"; issue: number }
  | { status: "sent_back"; issue: number; reason: string }
  | { status: "inconclusive"; issue: number; reason: string }
  | { status: "failed"; issue?: number; reason: string };

/** Exit code for a result, as in scripts/qa.sh: 0 pass, 1 fail, 2 inconclusive. */
export function qaExitCode(result: QaResult): number {
  if (result.status === "inconclusive") return EXIT.inconclusive;
  if (result.status === "sent_back" || result.status === "failed") return EXIT.failed;
  return 0;
}

const hasLabel = (labels: readonly string[], name: string): boolean =>
  labels.some((l) => l.toLowerCase() === name);

/**
 * The qa lane: test the branch `issue-<n>` of one `qa` card in a fresh worktree pinned to its commit.
 * There is no PR yet, so the verdict comments go on the issue.
 * Mechanical checks (the project's build and test commands) run first, then a read-only agent
 * reviews the change. Pass moves the card to `review`; a failed check or a FAIL verdict sends it
 * back to `building`; anything the lane cannot decide leaves it in `qa` with a comment on the issue.
 */
export async function runQaLane(deps: QaDeps, opts: QaOptions): Promise<QaResult> {
  const { gh, git, agent, shell, events, labels, say, writeText } = deps;
  const { project, cloneDir, dryRun } = opts;
  const repo = project.repo;
  const emit = (type: NewEvent["type"], message: string, extra: { issue?: number; url?: string } = {}) =>
    events.append({ project: project.name, lane: "qa", type, message, ...extra });

  // 0. Lane labels must exist before anything tries to use them.
  try {
    await labels.ensure(repo);
  } catch (e) {
    const reason = `could not create the lane labels: ${errorMessage(e)}`;
    say(`FAILED: ${reason}`);
    emit("failed", reason);
    return { status: "failed", reason };
  }

  // 1. Pick a card, and find its pull request.
  let number = opts.issue;
  if (number === undefined) {
    const queued = await gh.listIssuesByLabel(repo, "qa");
    number = queued.map((i) => i.number).sort((a, b) => a - b)[0];
    if (number === undefined) {
      say("no open issue labelled qa");
      emit("noop", "no open issue labelled qa");
      return { status: "noop" };
    }
  }
  const issue = await gh.getIssue(repo, number);
  if (!hasLabel(issue.labels, "qa")) {
    throw new UsageError(`issue #${number} is not labelled qa`, EXIT.precondition);
  }
  const branch = `issue-${number}`;
  const rendered = renderPrompt(opts.promptTemplate, project);
  // The work is a branch: no PR exists until the review lane approves it.
  if (!(await git.remoteBranchExists(cloneDir, branch))) {
    throw new UsageError(`branch ${branch} not found on origin`, EXIT.precondition);
  }
  const compare = compareUrl(repo, project.defaultBranch, branch);

  try {
    await git.fetch(cloneDir, "origin", branch);
  } catch (e) {
    const reason = `could not fetch ${branch}: ${errorMessage(e)}`;
    say(`FAILED: ${reason}`);
    emit("failed", reason, { issue: number });
    return { status: "failed", issue: number, reason };
  }
  const sha = await git.revParse(cloneDir, `origin/${branch}`);
  const short = sha.slice(0, 7);
  say(`qa #${number} (${branch}) at commit ${short}: ${issue.title}`);
  emit("started", `qa of ${branch} at ${short}`, { issue: number, url: compare });

  // 2. A dry run stops here and shows both possible outcomes.
  if (dryRun) {
    say(`dry-run: would build + test ${short} in a fresh worktree, then run the read-only agent (max ${project.limits.qaMaxTurns} turns)`);
    say("dry-run: pass -> qa -> review, fail -> qa -> building");
    await gh.editIssue(repo, number, { removeLabels: ["qa"], addLabels: ["review"] });
    await gh.editIssue(repo, number, { removeLabels: ["qa"], addLabels: ["building"] });
    return { status: "dry_run", issue: number };
  }

  const worktree = join(opts.paths.worktreeRoot, `qa-${branch}`);
  const logFile = join(opts.paths.logDir, `qa-${branch}.log`);
  const agentFile = join(opts.paths.logDir, `qa-${branch}.agent.txt`);
  let worktreeCreated = false;

  const comment = async (body: string): Promise<void> => {
    try {
      await gh.comment(repo, number, body);
    } catch (e) {
      say(`could not comment on issue #${number}: ${errorMessage(e)}`);
    }
  };
  const inconclusive = async (why: string): Promise<QaResult> => {
    say(`INCONCLUSIVE: ${why} (card stays in qa)`);
    emit("inconclusive", why, { issue: number, url: compare });
    await comment(`[qa] inconclusive at ${short}\n${why}\nNext: card stays in qa, rerun the qa lane.`);
    return { status: "inconclusive", issue: number, reason: why };
  };
  const bullets = (reasons: readonly string[]): string =>
    reasons.length > 0 ? reasons.map((r) => `- ${r}`).join("\n") : "- (the agent gave no reason)";

  try {
    // The issue text, plus what earlier review and qa rounds asked for: a rework that did what review
    // asked must not fail for it.
    let prompt: string;
    try {
      const me = await gh.whoami();
      const context = laneContext(await gh.listIssueComments(repo, number), me.login);
      prompt = `${rendered}\n\n## Issue #${number}: ${issue.title}\n\n${issue.body}\n${laneSections(context, { recheck: true })}`;
    } catch (e) {
      return await inconclusive(`could not read the issue's comments (${errorMessage(e)})`);
    }

    // 3. Isolate: a fresh detached worktree at exactly the commit under test.
    await git.worktreeRemove(cloneDir, worktree);
    await git.worktreeAddDetached(cloneDir, worktree, sha);
    worktreeCreated = true;
    writeText(logFile, "");

    // 4. Mechanical checks, no AI. The first failure stops them.
    const checks = [
      project.commands.build ? { kind: "build", command: project.commands.build } : null,
      project.commands.test ? { kind: "test", command: project.commands.test } : null,
    ].filter((c): c is { kind: string; command: string } => c !== null);
    let checkNote: string | null = null;
    for (const check of checks) {
      say(`${check.kind}: ${check.command}`);
      if (!(await shell.run(check.command, { cwd: worktree, logFile })).ok) {
        checkNote = `${check.kind} failed`;
        break;
      }
    }
    if (checks.length > 0 && checkNote === null) {
      emit("verified", `${checks.map((c) => c.kind).join(" and ")} passed`, { issue: number });
    }
    const did =
      checks.length > 0
        ? `${checks.map((c) => c.kind).join(", ")}, agent review`
        : "agent review only (no build or test command configured)";

    // 5. Agent review, read-only.
    say(`qa agent running; its answer goes to ${agentFile}`);
    let answer: string;
    try {
      answer = await agent.run({
        cwd: worktree,
        prompt,
        maxTurns: project.limits.qaMaxTurns,
        allowedTools: qaToolsFor(project),
        disallowedTools: DENIED_TOOLS,
        logFile,
        env: {},
      });
    } catch (e) {
      return await inconclusive(`qa agent exited with an error (${errorMessage(e)})`);
    }
    writeText(agentFile, answer);

    // 6. Decide. If the branch moved, the result is about a commit that is no longer the branch's head.
    await git.fetch(cloneDir, "origin", branch);
    if ((await git.revParse(cloneDir, `origin/${branch}`)) !== sha) return await inconclusive("branch moved while qa ran");

    const { verdict, reasons } = parseVerdict(answer);
    if (verdict === null) return await inconclusive("agent gave no VERDICT line");

    if (checkNote !== null || verdict === "FAIL") {
      const lines = checkNote !== null ? [checkNote, ...reasons] : reasons;
      const reason = lines.join("; ");
      say("FAIL -> building");
      await gh.editIssue(repo, number, { removeLabels: ["qa"], addLabels: ["building"] });
      emit("sent_back", reason, { issue: number, url: compare });
      await comment(`[qa] fail at ${short}\nDid: ${did}.\n❌ Not done:\n${bullets(lines)}\nNext: back to building.`);
      return { status: "sent_back", issue: number, reason };
    }

    say("PASS -> review");
    await gh.editIssue(repo, number, { removeLabels: ["qa"], addLabels: ["review"] });
    emit("passed", `qa passed at ${short}`, { issue: number, url: compare });
    await comment(`[qa] pass at ${short}\nDid: ${did}.\n✅ Done:\n${bullets(reasons)}\nNext: review.`);
    say("done");
    return { status: "passed", issue: number };
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
