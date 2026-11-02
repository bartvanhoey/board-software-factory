import type { Gh, Git, IssueEdit, LabelSpec } from "./ports.js";

const fmt = (name: string, args: unknown[]): string =>
  `[dry-run] ${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`;

/** Same interface, but the calls that change GitHub only print what they would do. Reads still run, and so does a clone, which only writes to the local workspace. */
export function dryRunGh(real: Gh, print: (line: string) => void): Gh {
  // Object.create keeps every read method of `real`, whether it is a plain object or a class instance.
  return Object.assign(Object.create(real) as Gh, {
    async createLabel(repo: string, spec: LabelSpec) {
      print(fmt("createLabel", [repo, spec.name, spec.color]));
      return "created";
    },
    async editIssue(repo: string, number: number, edit: IssueEdit) {
      print(fmt("editIssue", [repo, number, edit]));
    },
    async comment(repo: string, number: number, body: string) {
      print(fmt("comment", [repo, number, body]));
    },
    async closeIssue(repo: string, number: number) {
      print(fmt("closeIssue", [repo, number]));
    },
    async markPrReady(repo: string, number: number) {
      print(fmt("markPrReady", [repo, number]));
    },
    async mergePr(repo: string, number: number, opts: { matchHeadCommit: string }) {
      print(fmt("mergePr", [repo, number, "squash", opts.matchHeadCommit.slice(0, 7)]));
    },
    async createPr(repo: string, pr: { base: string; head: string; title: string; body: string }) {
      print(fmt("createPr", [repo, pr.base, pr.head, pr.title]));
      return { number: 0, url: "<pr-url>" };
    },
  });
}

/** Same for git: fetch and the read-only queries run; anything that writes only prints. */
export function dryRunGit(real: Git, print: (line: string) => void): Git {
  return Object.assign(Object.create(real) as Git, {
    async worktreeAdd(_cwd: string, path: string, branch: string, startPoint: string) {
      print(fmt("worktreeAdd", [path, branch, startPoint]));
    },
    async worktreeAddDetached(_cwd: string, path: string, sha: string) {
      print(fmt("worktreeAddDetached", [path, sha]));
    },
    async worktreeRemove(_cwd: string, path: string) {
      print(fmt("worktreeRemove", [path]));
    },
    async deleteBranch(_cwd: string, branch: string) {
      print(fmt("deleteBranch", [branch]));
    },
    async deleteRemoteBranch(_cwd: string, branch: string) {
      print(fmt("deleteRemoteBranch", [branch]));
    },
    async commitAll(_cwd: string, message: string) {
      print(fmt("commitAll", [message.split("\n")[0]]));
    },
    async push(_cwd: string, branch: string) {
      print(fmt("push", [branch]));
    },
  });
}
