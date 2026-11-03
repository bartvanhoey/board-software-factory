import type { Git } from "../ports.js";
import { mustRun, runProcess } from "../process.js";

/**
 * Network commands authenticate through `gh` (GH_TOKEN) for this one command only.
 * Nothing is written to git config, which matters because HOME is wiped on restart.
 */
const AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

const MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: "factory-runner",
  GIT_AUTHOR_EMAIL: "factory-runner@localhost",
  GIT_COMMITTER_NAME: "factory-runner",
  GIT_COMMITTER_EMAIL: "factory-runner@localhost",
};

/**
 * Every git call runs on a clone or worktree the builder agent could write to, so none of them may run a program that
 * the repository's own config or hooks name. Command-line `-c` outranks any config file, so a planted
 * `core.fsmonitor` or `core.hooksPath` has no effect; `GIT_CONFIG_NOSYSTEM` leaves out the system gitconfig.
 * The result: no git hook runs on the runner's own commits either.
 */
const PIN = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const PINNED_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

const argv = (cwd: string, args: readonly string[], network: boolean): string[] => ["-C", cwd, ...PIN, ...(network ? AUTH : []), ...args];

/** Run git without throwing on a non-zero exit. */
const gitRun = (cwd: string, args: readonly string[], opts: { network?: boolean; env?: NodeJS.ProcessEnv } = {}) =>
  runProcess("git", argv(cwd, args, opts.network ?? false), { env: { ...PINNED_ENV, ...opts.env } });

const git = (cwd: string, args: string[], network = false): Promise<string> =>
  mustRun("git", argv(cwd, args, network), { env: PINNED_ENV });

/** The real git adapter. */
export const gitCli: Git = {
  async originUrl(cwd) {
    return (await git(cwd, ["remote", "get-url", "origin"])).trim();
  },

  async fetch(cwd, remote, branch) {
    await git(cwd, ["fetch", "-q", remote, branch], true);
  },

  async worktreeAdd(cwd, path, branch, startPoint) {
    await git(cwd, ["worktree", "add", "-b", branch, path, startPoint]);
  },

  async worktreeAddDetached(cwd, path, sha) {
    await git(cwd, ["worktree", "add", "--detach", path, sha]);
  },

  async revParse(cwd, ref) {
    return (await git(cwd, ["rev-parse", ref])).trim();
  },

  async merge(cwd, sha) {
    // `--no-commit` creates no commit, but git still refuses to start a merge without an identity,
    // and the container has none. This one that never lands in history satisfies it.
    const r = await gitRun(cwd, ["merge", "--no-commit", "--no-ff", sha], { env: MERGE_IDENTITY });
    if (r.code === 0) return true;
    // Exit 1 also means "not something we can merge" (a bad commit). Only a real conflict leaves a
    // merge in progress, which shows as MERGE_HEAD.
    if (r.code === 1) {
      const inProgress = await gitRun(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      if (inProgress.code === 0) return false;
    }
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" | ");
    throw new Error(`git merge failed (exit ${r.code}): ${detail}`);
  },

  async deleteRemoteBranch(cwd, branch) {
    await git(cwd, ["push", "origin", "--delete", branch], true);
  },

  async worktreeRemove(cwd, path) {
    await gitRun(cwd, ["worktree", "remove", "--force", path]);
    await gitRun(cwd, ["worktree", "prune"]);
  },

  async branchExists(cwd, branch) {
    const r = await gitRun(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0;
  },

  async remoteBranchExists(cwd, branch) {
    const r = await gitRun(cwd, ["ls-remote", "--exit-code", "--heads", "origin", branch], { network: true });
    if (r.code === 0) return true;
    if (r.code === 2) return false; // no matching ref
    throw new Error(`git ls-remote failed (exit ${r.code}): ${r.stderr.trim()}`);
  },

  async deleteBranch(cwd, branch) {
    await git(cwd, ["branch", "-D", branch]);
  },

  async commitsAhead(cwd, base) {
    return Number.parseInt((await git(cwd, ["rev-list", "--count", `${base}..HEAD`])).trim(), 10);
  },

  async isClean(cwd) {
    return (await git(cwd, ["status", "--porcelain"])).trim() === "";
  },

  async statusPaths(cwd) {
    // -z: NUL-separated and never quoted. A rename or copy is followed by one extra entry, its old path.
    const out = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = out.split("\0").filter((e) => e.length > 0);
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as string;
      paths.push(entry.slice(3));
      if (entry[0] === "R" || entry[0] === "C") i++;
    }
    return paths;
  },

  async commitAll(cwd, message, identity) {
    const env = {
      ...PINNED_ENV,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    await mustRun("git", argv(cwd, ["add", "-A"], false), { env });
    await mustRun("git", argv(cwd, ["commit", "-q", "-m", message], false), { env });
  },

  async push(cwd, branch) {
    await git(cwd, ["push", "-u", "origin", branch], true);
  },
};
