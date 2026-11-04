import { join } from "node:path";
import { parseProject, type ProjectInput } from "@factory/shared";
import { describe, expect, it } from "vitest";
import { dryRunGh, dryRunGit } from "../dryRun.js";
import { UsageError } from "../errors.js";
import { createLabelEnsurer } from "../labels.js";
import { FakeAgent, FakeEvents, FakeGh, FakeGit, FakeShell, type CallLog } from "../testing/fakes.js";
import { reviewExitCode, runReviewLane, type ReviewDeps, type ReviewResult } from "./review.js";

const TEMPLATE = "Review against origin/{{default_branch}}.";
const WORKTREES = join("work", ".factory-worktrees", "demo");
const HEAD = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const BASE = "b".repeat(40);
const MOVED = "c".repeat(40);
const QA_PASS = "[qa] pass at a1b2c3d\nDid: build, test, agent review.\n✅ Done:\n- criterion met\nNext: review.";
const APPROVE = "Looks right.\nREASON: minimal and correct (site.css:3)\nVERDICT: APPROVE\n";
const CHANGES = "REASON: the hover colour is not accessible (site.css:9)\nVERDICT: REQUEST_CHANGES\n";

const makeProject = (extra: Partial<ProjectInput> = {}) =>
  parseProject(
    {
      name: "demo",
      repo: "o/r",
      stack: "dotnet",
      commands: { build: "dotnet build x.sln", test: "dotnet test x.sln" },
      ...extra,
    },
    "projects/demo.json",
  );

function setup(project = makeProject()) {
  const log: CallLog = [];
  const gh = new FakeGh(log);
  const git = new FakeGit(log);
  const agent = new FakeAgent(log);
  const shell = new FakeShell(log);
  const events = new FakeEvents();
  const said: string[] = [];
  const written = new Map<string, string>();
  const labels = createLabelEnsurer(gh, events, project.name);
  const base = project.defaultBranch;
  gh.labels = new Set(["ready", "building", "qa", "review"]);
  gh.addIssue(4, ["review"], { title: "Purple buttons", body: "Make the delete buttons purple." });
  git.remoteBranches.add("issue-4");
  gh.issueThread = [{ author: gh.me.login, body: QA_PASS }];
  git.refShas.set("origin/issue-4", [HEAD]);
  git.refShas.set(`origin/${base}`, [BASE]);
  agent.output = APPROVE;

  const deps = (): ReviewDeps => ({
    gh,
    git,
    agent,
    shell,
    events,
    labels,
    say: (m) => said.push(m),
    writeText: (file, text) => written.set(file, text),
  });
  const run = (o: { issue?: number; merge?: boolean; dryRun?: boolean; template?: string; deps?: ReviewDeps } = {}): Promise<ReviewResult> =>
    runReviewLane(o.deps ?? deps(), {
      project,
      cloneDir: "clone",
      paths: { worktreeRoot: WORKTREES, logDir: "logs" },
      promptTemplate: o.template ?? TEMPLATE,
      issue: o.issue,
      merge: o.merge ?? false,
      dryRun: o.dryRun ?? false,
    });
  return { log, gh, git, agent, shell, events, said, written, run, deps, project };
}

type T = ReturnType<typeof setup>;

const inOrder = (log: string[], ...steps: string[]) => {
  let at = -1;
  for (const step of steps) {
    const found = log.findIndex((l, i) => i > at && l.startsWith(step));
    expect(found, `"${step}" should come after index ${at} in:\n${log.join("\n")}`).toBeGreaterThan(at);
    at = found;
  }
};

const expectNothingMerged = (t: T) => {
  expect(t.gh.merges).toEqual([]);
  expect(t.gh.markedReady).toEqual([]);
  expect(t.git.deletedRemote).toEqual([]);
  expect(t.log.some((l) => l.startsWith("gh.mergePr"))).toBe(false);
};

/** The rule of this flow: until the review approves, there is only a branch, never a PR. */
const expectNoPr = (t: T) => {
  expect(t.gh.prs).toEqual([]);
  expect(t.gh.openPrs.size).toBe(0);
  expect(t.log.some((l) => l.startsWith("gh.createPr"))).toBe(false);
};

describe("runReviewLane: the QA gate", () => {
  const expectBackToQa = (t: T, result: ReviewResult, why: RegExp) => {
    expect(result.status).toBe("back_to_qa");
    expect(result.status === "back_to_qa" && result.reason).toMatch(why);
    expect(t.gh.issues.get(4)?.labels).toEqual(["qa"]);
    expect(t.gh.comments[0]?.number).toBe(4); // on the issue
    expect(t.gh.comments[0]?.body).toMatch(/^\[review\] back to qa at a1b2c3d\n/);
    expect(t.gh.comments[0]?.body).toContain("Next: qa reruns on the new commit.");
    expect(t.events.types).toEqual(["started", "back_to_qa"]);
    expect(t.log.some((l) => l.startsWith("git.worktreeAddDetached"))).toBe(false);
    expect(t.agent.runs).toEqual([]);
    expectNothingMerged(t);
    expectNoPr(t);
    expect(reviewExitCode(result)).toBe(1);
  };

  it("sends the card back to qa when the factory left no qa comment", async () => {
    const t = setup();
    t.gh.issueThread = [];
    const result = await t.run();
    expectBackToQa(t, result, /no \[qa\] pass comment found on this issue/);
    expect(t.gh.comments[0]?.body).toBe(
      "[review] back to qa at a1b2c3d\nno [qa] pass comment found on this issue\nNext: qa reruns on the new commit.",
    );
  });

  it("ignores a qa pass written by anyone else, so it cannot be forged", async () => {
    const t = setup();
    t.gh.issueThread = [{ author: "mallory", body: QA_PASS }];
    expectBackToQa(t, await t.run({ merge: true }), /no \[qa\] pass comment/);
  });

  it("sends the card back when the latest qa result is a fail", async () => {
    const t = setup();
    t.gh.issueThread = [
      { author: "factory-bot", body: QA_PASS },
      { author: "factory-bot", body: "[qa] fail at a1b2c3d\n❌ Not done:\n- x" },
    ];
    expectBackToQa(t, await t.run(), /latest qa result is a fail at a1b2c3d/);
  });

  it("sends the card back when the PR head is not the commit qa passed", async () => {
    const t = setup();
    t.gh.issueThread = [{ author: "factory-bot", body: "[qa] pass at 1234567\nDid: x" }];
    expectBackToQa(t, await t.run(), /branch head is a1b2c3d but qa passed 1234567/);
  });

  it("accepts a later pass after an earlier fail, and an account name in another case", async () => {
    const t = setup();
    t.gh.issueThread = [
      { author: "Factory-Bot", body: "[qa] fail at 1111111" },
      { author: "FACTORY-BOT", body: QA_PASS },
    ];
    expect((await t.run()).status).toBe("approved");
  });
});

describe("runReviewLane: a card that is already approved", () => {
  const APPROVED = "[review] approved at a1b2c3d\nDid: merge gate (main + branch), agent review.\nPR #7: https://github.com/o/r/pull/7";
  const withApproval = (t: T, body = APPROVED, author = "factory-bot") => {
    t.gh.issueThread = [{ author: "factory-bot", body: QA_PASS }, { author, body }];
    t.gh.openPrs.set("issue-4", { number: 7, url: t.gh.prUrl });
  };
  const expectUntouched = (t: T) => {
    expect(t.agent.runs).toEqual([]);
    expect(t.log.some((l) => l.startsWith("git.worktreeAddDetached"))).toBe(false);
    expect(t.gh.comments).toEqual([]);
    expect(t.gh.edits).toEqual([]);
    expectNothingMerged(t);
  };

  it("is skipped when the factory approved the current head and its PR is open, so a pass does not review it again", async () => {
    const t = setup();
    withApproval(t);
    expect(await t.run()).toEqual({ status: "noop" });
    expectUntouched(t);
    expect(t.events.types).toEqual(["noop"]);
    expect(reviewExitCode({ status: "noop" })).toBe(0);
  });

  it("moves on to the next card in the lane instead of stopping at the approved one", async () => {
    const t = setup();
    withApproval(t);
    t.gh.addIssue(5, ["review"], { title: "Green buttons", body: "Make them green." });
    t.git.remoteBranches.add("issue-5");
    t.git.refShas.set("origin/issue-5", [HEAD]);
    const result = await t.run();
    expect(result).toMatchObject({ status: "approved", issue: 5 });
    expect(t.agent.runs).toHaveLength(1);
  });

  it("is reviewed again when the branch has moved since the approval", async () => {
    const t = setup();
    withApproval(t, "[review] approved at 1234567\nDid: x");
    expect((await t.run()).status).toBe("approved");
    expect(t.agent.runs).toHaveLength(1);
  });

  it("is reviewed again when its PR is no longer open", async () => {
    const t = setup();
    withApproval(t);
    t.gh.openPrs.clear();
    expect((await t.run()).status).toBe("approved");
    expect(t.agent.runs).toHaveLength(1);
  });

  it("is reviewed again when a later review result replaced the approval", async () => {
    const t = setup();
    withApproval(t);
    t.gh.issueThread.push({ author: "factory-bot", body: "[review] changes requested at a1b2c3d\n❌ Not done:\n- x" });
    expect((await t.run()).status).toBe("approved");
    expect(t.agent.runs).toHaveLength(1);
  });

  it("does not trust an approval comment written by anyone else", async () => {
    const t = setup();
    withApproval(t, APPROVED, "mallory");
    expect((await t.run()).status).toBe("approved");
    expect(t.agent.runs).toHaveLength(1);
  });

  it("is merged when the lane runs with --merge, because that is what an approved card waits for", async () => {
    const t = setup();
    withApproval(t);
    expect((await t.run({ merge: true })).status).toBe("merged");
    expect(t.gh.merges).toHaveLength(1);
  });
});

describe("runReviewLane: approved, without --merge", () => {
  it("runs the merge gate, then opens the PR and comments on the issue, and does not merge", async () => {
    const t = setup();
    const result = await t.run();

    expect(result).toEqual({ status: "approved", issue: 4, pr: 7, prUrl: t.gh.prUrl });
    inOrder(
      t.log,
      "gh.listLabels",
      "gh.listIssuesByLabel review",
      "gh.getIssue 4",
      "git.remoteBranchExists issue-4",
      "git.fetch main",
      "git.fetch issue-4",
      "git.revParse origin/issue-4",
      "git.revParse origin/main",
      "gh.whoami",
      "gh.listIssueComments 4",
      "git.worktreeRemove",
      "git.worktreeAddDetached bbbbbbb",
      "git.merge a1b2c3d",
      "shell.run dotnet build x.sln",
      "shell.run dotnet test x.sln",
      "agent.run",
      "git.fetch main",
      "git.fetch issue-4",
      "git.revParse origin/main",
      "git.revParse origin/issue-4",
      "gh.findOpenPr issue-4",
      "gh.createPr issue-4",
      "gh.comment 4",
      "git.worktreeRemove",
    );
    expect(t.gh.comments).toHaveLength(1);
    expect(t.gh.comments[0]?.number).toBe(4);
    expect(t.gh.comments[0]?.body).toBe(
      "[review] approved at a1b2c3d\nDid: merge gate (main + branch), agent review.\n✅ Done:\n- minimal and correct (site.css:3)\nPR #7: https://github.com/o/r/pull/7\nNext: not merged. A human merges the PR, or rerun with --merge.",
    );
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expect(t.gh.edits).toEqual([]);
    expectNothingMerged(t);
    expect(t.events.types).toEqual(["started", "verified", "pr_opened", "approved"]);
    expect(t.events.events.every((e) => e.lane === "review")).toBe(true);
    expect(reviewExitCode(result)).toBe(0);
  });

  it("opens a normal PR against the default branch, with Closes, the qa pass and the review notes", async () => {
    const t = setup(makeProject({ defaultBranch: "develop" }));
    t.git.refShas.set("origin/develop", [BASE]);
    await t.run();

    expect(t.gh.prs).toHaveLength(1);
    expect(t.gh.prs[0]).toMatchObject({ base: "develop", head: "issue-4", title: "Purple buttons" });
    expect(t.gh.prs[0]?.body).toBe(
      "Closes #4\n\nBuilt, tested and approved by the factory at a1b2c3d.\nQA: pass at a1b2c3d.\n" +
        "Review: merge gate (develop + branch), agent review.\n\nReviewer notes:\n- minimal and correct (site.css:3)",
    );
    expect(t.events.events.find((e) => e.type === "pr_opened")).toMatchObject({ lane: "review", issue: 4, url: t.gh.prUrl });
  });

  it("reuses an open PR instead of opening a second one, so a rerun is safe", async () => {
    const t = setup();
    expect((await t.run({ issue: 4 })).status).toBe("approved");
    expect((await t.run({ issue: 4 })).status).toBe("approved");
    expect(t.gh.prs).toHaveLength(1);
    expect(t.log.filter((l) => l.startsWith("gh.createPr"))).toHaveLength(1);
    expect(t.events.types.filter((x) => x === "pr_opened")).toHaveLength(1);
  });

  it("marks a draft PR from an older flow ready, and does not open another", async () => {
    const t = setup();
    t.gh.openPrs.set("issue-4", { number: 12, url: "https://github.com/o/r/pull/12", isDraft: true });
    const result = await t.run();
    expect(result).toEqual({ status: "approved", issue: 4, pr: 12, prUrl: "https://github.com/o/r/pull/12" });
    expect(t.gh.markedReady).toEqual([12]);
    expect(t.gh.prs).toEqual([]);
    expect(t.gh.comments[0]?.body).toContain("PR #12: https://github.com/o/r/pull/12");
  });

  it("is inconclusive, leaving the card in review, when the PR cannot be opened", async () => {
    const t = setup();
    t.gh.failOnce.set("createPr", new Error("HTTP 422"));
    const result = await t.run();
    expect(result).toMatchObject({ status: "inconclusive", reason: "could not open the pull request (HTTP 422)" });
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expect(t.gh.edits).toEqual([]);
    expect(t.gh.comments[0]?.body).toContain("[review] inconclusive at a1b2c3d");
    expect(t.events.types).toEqual(["started", "verified", "inconclusive"]);
    expectNothingMerged(t);
    expect(reviewExitCode(result)).toBe(2);
  });

  it("builds the merge worktree at the default branch, and merges the branch head into it", async () => {
    const t = setup();
    await t.run();
    expect(t.git.detachedAdds).toEqual([{ path: join(WORKTREES, "review-issue-4"), sha: BASE }]);
    expect(t.git.merged).toEqual([{ cwd: join(WORKTREES, "review-issue-4"), sha: HEAD }]);
    expect(t.shell.commands.map((c) => c.cwd)).toEqual([join(WORKTREES, "review-issue-4"), join(WORKTREES, "review-issue-4")]);
  });

  it("runs the agent read-only with the commit under review, the base, and the review turn cap", async () => {
    const t = setup(makeProject({ limits: { reviewMaxTurns: 6 } }));
    await t.run();
    const run = t.agent.runs[0];
    expect(run?.cwd).toBe(join(WORKTREES, "review-issue-4"));
    expect(run?.maxTurns).toBe(6);
    expect(run?.prompt).toContain("Review against origin/main.");
    expect(run?.prompt).toContain(`Commit under review: ${HEAD}`);
    expect(run?.prompt).toContain("Base: origin/main");
    expect(run?.prompt).toContain("## Issue #4: Purple buttons");
    expect(run?.prompt).toContain("Make the delete buttons purple.");
    expect(run?.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(dotnet:*)"]));
    expect(run?.disallowedTools).toContain("Bash(git log*--output*)");
    for (const write of ["Edit", "Write", "Bash(git add:*)", "Bash(git commit:*)", "Bash"]) {
      expect(run?.allowedTools, write).not.toContain(write);
    }
  });

  it("empties the log first and saves the agent's answer", async () => {
    const t = setup();
    await t.run();
    expect(t.written.get(join("logs", "review-issue-4.log"))).toBe("");
    expect(t.written.get(join("logs", "review-issue-4.agent.txt"))).toBe(APPROVE);
  });

  it("uses the project's own default branch everywhere", async () => {
    const t = setup(makeProject({ defaultBranch: "master" }));
    const result = await t.run();
    expect(result.status).toBe("approved");
    expect(t.log).toContain("git.fetch master");
    expect(t.log).toContain("git.revParse origin/master");
    expect(t.log.some((l) => l.includes("origin/main"))).toBe(false);
    expect(t.agent.runs[0]?.prompt).toContain("Base: origin/master");
    expect(t.gh.comments[0]?.body).toContain("Did: merge gate (master + branch), agent review.");
  });

  it("takes the lowest-numbered review card, or the one asked for", async () => {
    const t = setup();
    t.gh.addIssue(9, ["review"]);
    t.git.remoteBranches.add("issue-9");
    await t.run();
    expect(t.log).toContain("git.remoteBranchExists issue-4");

    const u = setup();
    u.gh.addIssue(9, ["review"]);
    u.git.remoteBranches.add("issue-9");
    u.gh.issueThread = [{ author: "factory-bot", body: QA_PASS }];
    u.git.refShas.set("origin/issue-9", [HEAD]);
    expect((await u.run({ issue: 9 })).status).toBe("approved");
    expect(u.log.some((l) => l.startsWith("gh.listIssuesByLabel"))).toBe(false);
  });

  it("lists at most five reasons", async () => {
    const t = setup();
    t.agent.output = [1, 2, 3, 4, 5, 6, 7].map((n) => `REASON: r${n}`).join("\n") + "\nVERDICT: APPROVE";
    await t.run();
    const bullets = (t.gh.comments[0]?.body ?? "").split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toEqual(["- r1", "- r2", "- r3", "- r4", "- r5"]);
  });
});

describe("runReviewLane: approved, with --merge", () => {
  it("opens the PR, merges it pinned to the reviewed commit, removes the review label, comments and tidies up, in order", async () => {
    const t = setup();
    t.git.localBranches.add("issue-4");
    const result = await t.run({ merge: true });

    expect(result).toEqual({ status: "merged", issue: 4, pr: 7, prUrl: t.gh.prUrl });
    inOrder(
      t.log,
      "agent.run",
      "git.revParse origin/issue-4",
      "gh.findOpenPr issue-4",
      "gh.createPr issue-4",
      "gh.mergePr 7 a1b2c3d",
      "gh.editIssue 4 +[] -[review]",
      "gh.comment 4",
      "git.worktreeRemove",
      "git.branchExists issue-4",
      "git.deleteBranch issue-4",
      "git.deleteRemoteBranch issue-4",
      "git.worktreeRemove",
    );
    expect(t.gh.merges).toEqual([{ number: 7, sha: HEAD }]);
    expect(t.gh.prs).toHaveLength(1);
    expect(t.gh.markedReady).toEqual([]);
    expect(t.git.deletedRemote).toEqual(["issue-4"]);
    expect(t.gh.comments[0]?.body).toBe(
      "[review] merged at a1b2c3d\nDid: merge gate (main + branch), agent review, squash merge pinned to this commit.\n✅ Done:\n- minimal and correct (site.css:3)\nPR #7: https://github.com/o/r/pull/7\nNext: none.",
    );
    expect(t.events.types).toEqual(["started", "verified", "pr_opened", "merged"]);
    expect(reviewExitCode(result)).toBe(0);
  });

  it("only removes the review label: no done label is added", async () => {
    const t = setup();
    await t.run({ merge: true });
    expect(t.gh.edits).toEqual([{ number: 4, edit: { removeLabels: ["review"] } }]);
    expect(t.gh.issues.get(4)?.labels).toEqual([]);
    expect(t.log.some((l) => l.includes("+[done]"))).toBe(false);
  });

  it("merges an already open PR that is ready, without opening or marking anything", async () => {
    const t = setup();
    t.gh.openPrs.set("issue-4", { number: 12, url: "u", isDraft: false });
    expect((await t.run({ merge: true })).status).toBe("merged");
    expect(t.gh.markedReady).toEqual([]);
    expect(t.gh.prs).toEqual([]);
    expect(t.gh.merges).toEqual([{ number: 12, sha: HEAD }]);
  });

  it("marks a draft PR from an older flow ready before merging it", async () => {
    const t = setup();
    t.gh.openPrs.set("issue-4", { number: 12, url: "u", isDraft: true });
    expect((await t.run({ merge: true })).status).toBe("merged");
    inOrder(t.log, "gh.findOpenPr issue-4", "gh.markPrReady 12", "gh.mergePr 12 a1b2c3d");
    expect(t.gh.markedReady).toEqual([12]);
    expect(t.gh.prs).toEqual([]);
  });

  it("does not delete a local branch that does not exist", async () => {
    const t = setup();
    await t.run({ merge: true });
    expect(t.log.some((l) => l.startsWith("git.deleteBranch"))).toBe(false);
  });

  it("is inconclusive, and deletes nothing, when GitHub refuses the merge", async () => {
    const t = setup();
    t.git.localBranches.add("issue-4");
    t.gh.failOnce.set("mergePr", new Error("head commit changed"));
    const result = await t.run({ merge: true });
    expect(result).toMatchObject({ status: "inconclusive", reason: "GitHub refused the merge of PR #7 (head commit changed)" });
    expect(t.gh.prs).toHaveLength(1); // the approved PR stays open
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expect(t.gh.edits).toEqual([]);
    expect(t.git.deletedRemote).toEqual([]);
    expect(t.log.some((l) => l.startsWith("git.deleteBranch"))).toBe(false);
    expect(t.gh.comments[0]?.body).toContain("[review] inconclusive at a1b2c3d");
    expect(t.gh.comments[0]?.body).toContain("Next: card stays in review, rerun the review lane.");
    expect(t.events.types).toEqual(["started", "verified", "pr_opened", "inconclusive"]);
    expect(reviewExitCode(result)).toBe(2);

    // The next run reuses that PR and merges it.
    expect((await t.run({ merge: true })).status).toBe("merged");
    expect(t.gh.prs).toHaveLength(1);
    expect(t.gh.merges).toEqual([{ number: 7, sha: HEAD }]);
  });

  it("still reports merged when something after the merge fails", async () => {
    const t = setup();
    t.git.localBranches.add("issue-4");
    t.gh.failOnce.set("editIssue", new Error("HTTP 502"));
    t.git.failOnce.set("deleteRemoteBranch", new Error("branch already deleted"));
    const result = await t.run({ merge: true });
    expect(result.status).toBe("merged");
    expect(t.gh.merges).toHaveLength(1);
    expect(t.said.some((m) => m.includes("merged, but removing the review label failed"))).toBe(true);
    expect(t.said.some((m) => m.includes("merged, but deleting the remote branch failed"))).toBe(true);
    expect(t.events.types.at(-1)).toBe("merged");
    expect(t.log).toContain("git.deleteBranch issue-4"); // later tidy-up steps still ran
  });
});

describe("runReviewLane: sent back to building", () => {
  const expectSentBack = (t: T, result: ReviewResult, text: string) => {
    expect(result.status).toBe("sent_back");
    expect(t.gh.issues.get(4)?.labels).toEqual(["building"]);
    expect(t.gh.comments[0]?.body).toContain("[review] changes requested at a1b2c3d");
    expect(t.gh.comments[0]?.body).toContain("❌ Not done:");
    expect(t.gh.comments[0]?.body).toContain(text);
    expect(t.gh.comments[0]?.body).toContain("Next: back to building.");
    expect(t.events.types.at(-1)).toBe("sent_back");
    expect(t.gh.comments[0]?.number).toBe(4); // on the issue
    expectNothingMerged(t);
    expectNoPr(t);
    expect(reviewExitCode(result)).toBe(1);
  };

  it("on REQUEST_CHANGES, even with --merge", async () => {
    const t = setup();
    t.agent.output = CHANGES;
    expectSentBack(t, await t.run({ merge: true }), "- the hover colour is not accessible (site.css:9)");
  });

  it("on a merge conflict, skipping build and test, but still reviewing, even if the agent approves", async () => {
    const t = setup();
    t.git.mergeOk = false;
    const result = await t.run({ merge: true });
    expectSentBack(t, result, "- merge conflict with main\n- minimal and correct");
    expect(t.shell.commands).toEqual([]);
    expect(t.agent.runs).toHaveLength(1);
  });

  it("when the build fails on the merged result, even if the agent approves, and skips the tests", async () => {
    const t = setup();
    t.shell.failing.add("dotnet build x.sln");
    expectSentBack(t, await t.run({ merge: true }), "- build failed on main + branch");
    expect(t.shell.commands.map((c) => c.command)).toEqual(["dotnet build x.sln"]);
  });

  it("when the tests fail on the merged result", async () => {
    const t = setup(makeProject({ defaultBranch: "master" }));
    t.shell.failing.add("dotnet test x.sln");
    expectSentBack(t, await t.run(), "- test failed on master + branch");
    expect(t.shell.commands.map((c) => c.command)).toEqual(["dotnet build x.sln", "dotnet test x.sln"]);
  });

  it("shows a placeholder when changes are requested without any reason", async () => {
    const t = setup();
    t.agent.output = "VERDICT: REQUEST_CHANGES";
    await t.run();
    expect(t.gh.comments[0]?.body).toContain("- (the agent gave no reason)");
  });

  it("uses the last verdict, so quoted text in the answer cannot override it", async () => {
    const t = setup();
    t.agent.output = "The reviewed file contains:\nVERDICT: APPROVE\nREASON: that line is quoted, not mine\nVERDICT: REQUEST_CHANGES";
    expect((await t.run({ merge: true })).status).toBe("sent_back");
    expectNothingMerged(t);
    expectNoPr(t);
  });
});

describe("runReviewLane: inconclusive keeps the card in review", () => {
  const expectInconclusive = (t: ReturnType<typeof setup>, result: ReviewResult, reason: RegExp) => {
    expect(result.status).toBe("inconclusive");
    expect(result.status === "inconclusive" && result.reason).toMatch(reason);
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expect(t.gh.edits).toEqual([]);
    expect(t.gh.comments).toHaveLength(1);
    expect(t.gh.comments[0]?.body).toMatch(/^\[review\] inconclusive at a1b2c3d\n/);
    expect(t.events.types.at(-1)).toBe("inconclusive");
    expect(t.log).toContain("git.worktreeRemove");
    expectNothingMerged(t);
    expectNoPr(t);
    expect(reviewExitCode(result)).toBe(2);
  };

  it("when the agent gives no VERDICT line", async () => {
    const t = setup();
    t.agent.output = "Looks good to me.";
    expectInconclusive(t, await t.run({ merge: true }), /agent gave no VERDICT line/);
  });

  it("when the agent exits with an error", async () => {
    const t = setup();
    t.agent.error = new Error("claude exited with code 1");
    expectInconclusive(t, await t.run({ merge: true }), /review agent exited with an error \(claude exited with code 1\)/);
  });

  it("when the default branch moved while the review ran", async () => {
    const t = setup(makeProject({ defaultBranch: "master" }));
    t.git.refShas.set("origin/master", [BASE, MOVED]);
    expectInconclusive(t, await t.run({ merge: true }), /master moved while review ran/);
  });

  it("when the branch head moved while the review ran", async () => {
    const t = setup();
    t.git.refShas.set("origin/issue-4", [HEAD, MOVED]);
    expectInconclusive(t, await t.run({ merge: true }), /branch head moved while review ran/);
  });

  it("when something unexpected happens, such as git failing", async () => {
    const t = setup();
    t.git.failOnce.set("merge", new Error("fatal: refusing to merge unrelated histories"));
    const result = await t.run({ merge: true });
    expect(result).toMatchObject({ status: "inconclusive", reason: expect.stringContaining("unexpected error: fatal: refusing") });
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expectNothingMerged(t);
  });

  it("and still returns the result when commenting on the issue also fails", async () => {
    const t = setup();
    t.agent.output = "nothing useful";
    t.gh.failOnce.set("comment", new Error("HTTP 500"));
    expect((await t.run()).status).toBe("inconclusive");
    expect(t.said.some((m) => m.includes("could not comment on issue #4"))).toBe(true);
  });
});

describe("runReviewLane: nothing to do, or wrong input", () => {
  it("does nothing when no card is in review", async () => {
    const t = setup();
    t.gh.addIssue(4, ["qa"]);
    expect(await t.run()).toEqual({ status: "noop" });
    expect(t.events.types).toEqual(["noop"]);
    expect(t.log.some((l) => l.startsWith("git."))).toBe(false);
  });

  it("refuses an issue that is not labelled review", async () => {
    const t = setup();
    t.gh.addIssue(5, ["qa"]);
    const error = await t.run({ issue: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(65);
    expect(t.gh.edits).toEqual([]);
  });

  it("refuses a card whose branch is not on origin, before fetching or creating anything", async () => {
    const t = setup();
    t.git.remoteBranches.clear();
    const error = await t.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toBe("branch issue-4 not found on origin");
    expect((error as UsageError).exitCode).toBe(65);
    expect(t.log.filter((l) => l.startsWith("git."))).toEqual(["git.remoteBranchExists issue-4"]);
    expect(t.gh.edits).toEqual([]);
    expect(t.gh.comments).toEqual([]);
    expectNoPr(t);
  });

  it("rejects an unknown placeholder in the prompt before touching git", async () => {
    const t = setup();
    await expect(t.run({ template: "Use {{nope}}" })).rejects.toThrow("unknown placeholder {{nope}}");
    expect(t.log.some((l) => l.startsWith("git."))).toBe(false);
  });

  it("fails without a comment when the branches cannot be fetched", async () => {
    const t = setup();
    t.git.failOnce.set("fetch", new Error("network down"));
    const result = await t.run({ merge: true });
    expect(result).toMatchObject({ status: "failed", issue: 4, reason: expect.stringContaining("could not fetch main and issue-4") });
    expect(t.gh.comments).toEqual([]);
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expectNothingMerged(t);
    expectNoPr(t);
    expect(reviewExitCode(result)).toBe(1);
  });

  it("fails before picking anything when the lane labels cannot be created", async () => {
    const t = setup();
    t.gh.labels = new Set();
    t.gh.failOnce.set("createLabel", new Error("HTTP 403"));
    const result = await t.run();
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("could not create the lane labels") });
    expect(t.log.some((l) => l.startsWith("gh.getIssue"))).toBe(false);
  });
});

describe("runReviewLane: projects without checks", () => {
  it("leaves the verdict to the agent when no build or test command is configured", async () => {
    const t = setup(makeProject({ stack: "other", commands: {} }));
    expect((await t.run()).status).toBe("approved");
    expect(t.shell.commands).toEqual([]);
    expect(t.gh.comments[0]?.body).toContain("Did: agent review (no build or test command configured).");
    expect(t.events.events.find((e) => e.type === "verified")?.message).toMatch(/no build or test command/);
  });
});

describe("runReviewLane: worktree", () => {
  it("removes a leftover review worktree first, and always removes it afterwards", async () => {
    const t = setup();
    await t.run();
    expect(t.log.filter((l) => l === "git.worktreeRemove")).toHaveLength(2);
    inOrder(t.log, "git.worktreeRemove", "git.worktreeAddDetached", "git.worktreeRemove");
  });
});

describe("runReviewLane: dry run", () => {
  const dry = (t: T, printed: string[]): ReviewDeps => ({
    ...t.deps(),
    gh: dryRunGh(t.gh, (l) => printed.push(l)),
    git: dryRunGit(t.git, (l) => printed.push(l)),
  });

  it("prints the outcomes and changes nothing, with no worktree, no agent and no merge", async () => {
    const t = setup();
    const printed: string[] = [];
    const result = await t.run({ dryRun: true, merge: true, deps: dry(t, printed) });

    expect(result).toEqual({ status: "dry_run", issue: 4 });
    expect(t.gh.edits).toEqual([]);
    expect(t.gh.comments).toEqual([]);
    expect(t.agent.runs).toEqual([]);
    expect(t.shell.commands).toEqual([]);
    expect(t.git.detachedAdds).toEqual([]);
    expect(t.git.merged).toEqual([]);
    expectNothingMerged(t);
    expectNoPr(t);
    expect(t.log).toContain("git.revParse origin/issue-4"); // reads still run
    expect(printed.filter((l) => l.includes("editIssue"))).toHaveLength(2);
    expect(printed.some((l) => l.includes('"addLabels":["building"]'))).toBe(true);
    expect(t.said.some((m) => m.includes("squash merge pinned to a1b2c3d"))).toBe(true);
    expect(reviewExitCode(result)).toBe(0);
  });

  it("without --merge, says that an approval opens the PR and leaves the merge to a human", async () => {
    const t = setup();
    const printed: string[] = [];
    await t.run({ dryRun: true, deps: dry(t, printed) });
    expect(printed.filter((l) => l.includes("editIssue"))).toHaveLength(1);
    expect(t.said.some((m) => m.includes("open PR issue-4 -> main with Closes #4") && m.includes("the card stays in review"))).toBe(true);
    expectNoPr(t);
  });

  it("says it would reuse an open PR, and mark a draft one ready", async () => {
    const t = setup();
    t.gh.openPrs.set("issue-4", { number: 12, url: "u", isDraft: true });
    const printed: string[] = [];
    await t.run({ dryRun: true, deps: dry(t, printed) });
    expect(t.said.some((m) => m.includes("reuse PR #12 (marking it ready)"))).toBe(true);
    expect(t.gh.markedReady).toEqual([]);
    expect(t.gh.prs).toEqual([]);
  });

  it("still checks the QA gate, and only prints the move back to qa", async () => {
    const t = setup();
    t.gh.issueThread = [];
    const printed: string[] = [];
    const result = await t.run({ dryRun: true, deps: dry(t, printed) });
    expect(result.status).toBe("back_to_qa");
    expect(t.gh.issues.get(4)?.labels).toEqual(["review"]);
    expect(t.gh.comments).toEqual([]);
    expect(printed.some((l) => l.includes('"addLabels":["qa"]'))).toBe(true);
    expect(printed.some((l) => l.includes("[dry-run] comment("))).toBe(true);
  });
});

describe("reviewExitCode", () => {
  it("is 0 for approved, merged, no-op and dry run, 1 for sent back, 2 for inconclusive", () => {
    expect(reviewExitCode({ status: "approved", issue: 1, pr: 1, prUrl: "u" })).toBe(0);
    expect(reviewExitCode({ status: "merged", issue: 1, pr: 1, prUrl: "u" })).toBe(0);
    expect(reviewExitCode({ status: "noop" })).toBe(0);
    expect(reviewExitCode({ status: "dry_run", issue: 1 })).toBe(0);
    expect(reviewExitCode({ status: "back_to_qa", issue: 1, reason: "x" })).toBe(1);
    expect(reviewExitCode({ status: "sent_back", issue: 1, reason: "x" })).toBe(1);
    expect(reviewExitCode({ status: "failed", reason: "x" })).toBe(1);
    expect(reviewExitCode({ status: "inconclusive", issue: 1, reason: "x" })).toBe(2);
  });
});

describe("runReviewLane: requirements from an earlier review", () => {
  const REVIEW = "[review] changes requested at 9999999\nDid: x.\n❌ Not done:\n- show the current year\nNext: back to building.";
  const prompt = (t: ReturnType<typeof setup>) => t.agent.runs[0]?.prompt ?? "";

  it("adds nothing when review never asked for changes", async () => {
    const t = setup();
    await t.run();
    expect(prompt(t)).not.toContain("Requirements added by review");
    expect(prompt(t).endsWith("Make the delete buttons purple.\n")).toBe(true);
  });

  it("adds the latest review request after the issue, so a rework that did what it asked is not rejected for it", async () => {
    const t = setup();
    t.gh.issueThread = [REVIEW, QA_PASS].map((body) => ({ author: t.gh.me.login, body }));
    await t.run();
    const p = prompt(t);
    expect(p).toContain("## Requirements added by review");
    expect(p).toContain(`~~~\n${REVIEW}\n~~~`);
    expect(p.indexOf("Make the delete buttons purple.")).toBeLessThan(p.indexOf("## Requirements added by review"));
  });

  it("never adds the qa re-check section", async () => {
    const t = setup();
    const rework = "[build] rework done (round 1). Pushed 1 commit(s). Next: qa.";
    t.gh.issueThread = ["[qa] fail at 8888888\n- x", rework, QA_PASS].map((body) => ({ author: t.gh.me.login, body }));
    await t.run();
    expect(prompt(t)).not.toContain("Earlier qa findings");
  });

  it("drops the request once review approved it, and ignores other authors", async () => {
    const t = setup();
    t.gh.issueThread = [REVIEW, "[review] approved at 9999999\nok", QA_PASS].map((body) => ({ author: t.gh.me.login, body }));
    await t.run();
    expect(prompt(t)).not.toContain("Requirements added by review");
    const u = setup();
    u.gh.issueThread = [{ author: "mallory", body: REVIEW }, { author: u.gh.me.login, body: QA_PASS }];
    await u.run();
    expect(prompt(u)).not.toContain("Requirements added by review");
  });
});

describe("runReviewLane: a PR merged by a human", () => {
  const MERGED = { number: 13, url: "https://github.com/o/r/pull/13" };

  const expectClosed = (t: T, issue: number) => {
    expect(t.gh.closed).toEqual([issue]);
    expect(t.gh.issues.get(issue)?.labels).toEqual([]);
    expect(t.gh.comments).toHaveLength(1);
    expect(t.gh.comments[0]?.body).toMatch(/^\[review\] merged\nPR #13: https:\/\/github.com\/o\/r\/pull\/13 /);
    expect(t.events.types).toEqual(["merged"]);
  };

  it("closes the issue and removes the review label, even though the PR had no Closes keyword", async () => {
    const t = setup();
    t.gh.mergedPrs.set("issue-4", MERGED);
    t.git.remoteBranches.delete("issue-4"); // the human deleted the branch on merge
    const result = await t.run();
    expect(result).toEqual({ status: "merged", issue: 4, pr: 13, prUrl: MERGED.url });
    expectClosed(t, 4);
    expect(t.agent.runs).toEqual([]);
    expectNoPr(t);
    expect(reviewExitCode(result)).toBe(0);
  });

  it("closes the issue when it is named with --issue, before the branch lookup", async () => {
    const t = setup();
    t.gh.mergedPrs.set("issue-4", MERGED);
    t.git.remoteBranches.delete("issue-4");
    expect((await t.run({ issue: 4 })).status).toBe("merged");
    expectClosed(t, 4);
  });

  it("closes the merged card and still reviews the next card in the queue", async () => {
    const t = setup();
    t.gh.addIssue(5, ["review"], { title: "Other", body: "Other work" });
    t.git.remoteBranches.add("issue-5");
    t.git.refShas.set("origin/issue-5", [HEAD]);
    t.gh.mergedPrs.set("issue-4", MERGED);
    const result = await t.run();
    expect(t.gh.closed).toEqual([4]);
    expect(result.status === "back_to_qa" || result.status === "approved").toBe(true);
    expect(result).toMatchObject({ issue: 5 });
  });

  it("leaves a card alone when no merged PR exists", async () => {
    const t = setup();
    await t.run();
    expect(t.gh.closed).toEqual([]);
  });

  it("leaves the card alone when the merged-PR lookup fails", async () => {
    const t = setup();
    t.gh.failOnce.set("findMergedPr", new Error("api down"));
    await t.run();
    expect(t.gh.closed).toEqual([]);
    expect(t.said.some((m) => m.includes("could not look for a merged PR of issue-4: api down"))).toBe(true);
  });

  it("does not remove the label or comment when closing the issue fails", async () => {
    const t = setup();
    t.gh.mergedPrs.set("issue-4", MERGED);
    t.gh.failOnce.set("closeIssue", new Error("forbidden"));
    await t.run();
    expect(t.gh.closed).toEqual([]);
    expect(t.events.types).not.toContain("merged");
    expect(t.said.some((m) => m.includes("could not close issue #4: forbidden"))).toBe(true);
  });

  it("still reports merged when removing the label or commenting fails", async () => {
    const t = setup();
    t.gh.mergedPrs.set("issue-4", MERGED);
    t.git.remoteBranches.delete("issue-4");
    t.gh.failOnce.set("editIssue", new Error("label boom"));
    expect((await t.run()).status).toBe("merged");
    expect(t.gh.closed).toEqual([4]);
    expect(t.said.some((m) => m.includes("removing the review label failed: label boom"))).toBe(true);
  });

  it("only prints the calls in a dry run", async () => {
    const t = setup();
    t.gh.mergedPrs.set("issue-4", MERGED);
    t.git.remoteBranches.delete("issue-4");
    const printed: string[] = [];
    const result = await t.run({ dryRun: true, deps: { ...t.deps(), gh: dryRunGh(t.gh, (l) => printed.push(l)) } });
    expect(result.status).toBe("merged");
    expect(t.gh.closed).toEqual([]);
    expect(printed.some((l) => l.startsWith("[dry-run] closeIssue"))).toBe(true);
  });
});
