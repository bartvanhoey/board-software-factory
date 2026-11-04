import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessOptions } from "../process.js";

// Which of the runner's own processes get the GitHub token (GH_TOKEN). The process module is replaced, so nothing is
// started: the question is only which options each adapter passes.
const spawned = vi.hoisted(() => ({
  calls: [] as { file: string; args: readonly string[]; opts: ProcessOptions }[],
  stdout: "",
}));

vi.mock("../process.js", () => {
  const result = () => ({ code: 0, stdout: spawned.stdout, stderr: "" });
  return {
    runProcess: vi.fn(async (file: string, args: readonly string[], opts: ProcessOptions = {}) => {
      spawned.calls.push({ file, args, opts });
      return result();
    }),
    mustRun: vi.fn(async (file: string, args: readonly string[], opts: ProcessOptions = {}) => {
      spawned.calls.push({ file, args, opts });
      return spawned.stdout;
    }),
    runShellCommand: vi.fn(async (command: string, opts: ProcessOptions = {}) => {
      spawned.calls.push({ file: command, args: [], opts });
      return result();
    }),
  };
});

import { claudeAgent, shellRunner } from "./claude.js";
import { ghCli } from "./gh.js";
import { gitCli } from "./git.js";

const last = () => spawned.calls[spawned.calls.length - 1]!;

beforeEach(() => {
  spawned.calls = [];
  spawned.stdout = "";
});

describe("who gets the GitHub token", () => {
  it("gives it to git's network commands, which authenticate through gh", async () => {
    await gitCli.fetch("/repo", "origin", "main");
    expect(last().opts.githubToken).toBe(true);
    await gitCli.push("/repo", "issue-1");
    expect(last().opts.githubToken).toBe(true);
    await gitCli.deleteRemoteBranch("/repo", "issue-1");
    expect(last().opts.githubToken).toBe(true);
    await gitCli.remoteBranchExists("/repo", "issue-1");
    expect(last().opts.githubToken).toBe(true);
  });

  it("does not give it to git commands that stay on disk", async () => {
    spawned.stdout = "abc123\n";
    await gitCli.isClean("/repo");
    await gitCli.revParse("/repo", "HEAD");
    await gitCli.branchExists("/repo", "main");
    await gitCli.worktreeAdd("/repo", "/wt", "issue-1", "origin/main");
    await gitCli.merge("/repo", "abc123");
    await gitCli.commitAll("/repo", "msg", { name: "bot", email: "bot@localhost" });
    expect(spawned.calls.length).toBeGreaterThan(6);
    for (const call of spawned.calls) expect(call.opts.githubToken ?? false, call.args.join(" ")).toBe(false);
  });

  it("gives it to every gh call", async () => {
    spawned.stdout = '{"login":"bot","id":1}';
    await ghCli.whoami();
    expect(last().opts.githubToken).toBe(true);
    await ghCli.createLabel("Owner/Repo", { name: "ready", color: "0e8a16", description: "d" });
    expect(last().opts.githubToken).toBe(true);
  });

  it("does not give it to the agent or to the project's build and test commands", async () => {
    await claudeAgent.run({ cwd: "/wt", prompt: "p", maxTurns: 1, allowedTools: [], disallowedTools: [], logFile: "log", env: {} });
    expect(last().file).toBe("claude");
    expect(last().opts.githubToken ?? false).toBe(false);

    await shellRunner.run("npm test", { cwd: "/wt", logFile: "log" });
    expect(last().file).toBe("npm test");
    expect(last().opts.githubToken ?? false).toBe(false);
  });
});
