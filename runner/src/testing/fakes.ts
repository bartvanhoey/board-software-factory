import type { NewEvent } from "@factory/shared";
import type { AgentRun, AgentRunner, EventLog, Gh, Git, IssueData, IssueEdit, LabelSpec, Shell } from "../ports.js";

/** One shared, ordered log of every call, so tests can assert the order across gh, git and the agent. */
export type CallLog = string[];

export class FakeGh implements Gh {
  labels = new Set<string>();
  issues = new Map<number, IssueData>();
  /** Open pull requests by head branch. */
  openPrs = new Map<string, { number: number; url: string; isDraft?: boolean }>();
  /** Merged pull requests by head branch. */
  mergedPrs = new Map<string, { number: number; url: string }>();
  /** Issues closed with `closeIssue`. */
  closed: number[] = [];
  /** What `listIssueComments` returns: the issue's comment thread, oldest first. */
  issueThread: { author: string; body: string }[] = [];
  markedReady: number[] = [];
  merges: { number: number; sha: string }[] = [];
  me = { login: "factory-bot", id: 42 };
  prNumber = 7;
  prUrl = "https://github.com/o/r/pull/7";
  /** method name -> error to throw on its next call. */
  failOnce = new Map<string, Error>();
  edits: { number: number; edit: IssueEdit }[] = [];
  /** Comments posted on issues. */
  comments: { number: number; body: string }[] = [];
  /** Pull requests opened with `createPr`. */
  prs: { base: string; head: string; title: string; body: string }[] = [];
  createdLabels: LabelSpec[] = [];

  constructor(private readonly log: CallLog = []) {}

  private enter(name: string, detail = ""): void {
    this.log.push(`gh.${name}${detail ? ` ${detail}` : ""}`);
    const err = this.failOnce.get(name);
    if (err) {
      this.failOnce.delete(name);
      throw err;
    }
  }

  addIssue(number: number, labels: string[], extra: Partial<IssueData> = {}): void {
    this.issues.set(number, { number, title: `Issue ${number}`, body: `Body of ${number}`, labels, ...extra });
  }

  async whoami() {
    this.enter("whoami");
    return this.me;
  }
  async listLabels() {
    this.enter("listLabels");
    return [...this.labels];
  }
  async createLabel(_repo: string, spec: LabelSpec) {
    this.enter("createLabel", spec.name);
    if ([...this.labels].some((l) => l.toLowerCase() === spec.name.toLowerCase())) return "exists" as const;
    this.labels.add(spec.name);
    this.createdLabels.push(spec);
    return "created" as const;
  }
  async listIssuesByLabel(_repo: string, label: string) {
    this.enter("listIssuesByLabel", label);
    return [...this.issues.values()].filter((i) => i.labels.includes(label) && !this.closed.includes(i.number)).map((i) => ({ number: i.number }));
  }
  async getIssue(_repo: string, number: number) {
    this.enter("getIssue", String(number));
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return { ...issue, labels: [...issue.labels] };
  }
  async editIssue(_repo: string, number: number, edit: IssueEdit) {
    this.enter("editIssue", `${number} +[${edit.addLabels ?? []}] -[${edit.removeLabels ?? []}]`);
    this.edits.push({ number, edit });
    const issue = this.issues.get(number);
    if (issue) {
      issue.labels = issue.labels.filter((l) => !(edit.removeLabels ?? []).includes(l)).concat(edit.addLabels ?? []);
    }
  }
  async comment(_repo: string, number: number, body: string) {
    this.enter("comment", String(number));
    this.comments.push({ number, body });
  }
  async findOpenPr(_repo: string, branch: string) {
    this.enter("findOpenPr", branch);
    const pr = this.openPrs.get(branch);
    return pr ? { ...pr, isDraft: pr.isDraft ?? false } : null;
  }
  async findMergedPr(_repo: string, branch: string) {
    this.enter("findMergedPr", branch);
    const pr = this.mergedPrs.get(branch);
    return pr ? { ...pr } : null;
  }
  async closeIssue(_repo: string, number: number) {
    this.enter("closeIssue", String(number));
    this.closed.push(number);
  }
  async listIssueComments(_repo: string, number: number) {
    this.enter("listIssueComments", String(number));
    return this.issueThread.map((c) => ({ ...c }));
  }
  async markPrReady(_repo: string, number: number) {
    this.enter("markPrReady", String(number));
    this.markedReady.push(number);
  }
  async mergePr(_repo: string, number: number, opts: { matchHeadCommit: string }) {
    this.enter("mergePr", `${number} ${opts.matchHeadCommit.slice(0, 7)}`);
    this.merges.push({ number, sha: opts.matchHeadCommit });
    for (const [branch, pr] of this.openPrs) if (pr.number === number) this.openPrs.delete(branch);
  }
  async createPr(_repo: string, pr: { base: string; head: string; title: string; body: string }) {
    this.enter("createPr", pr.head);
    this.prs.push(pr);
    const created = { number: this.prNumber, url: this.prUrl };
    this.openPrs.set(pr.head, created);
    return created;
  }
  async cloneRepo(repo: string, dir: string) {
    this.enter("cloneRepo", `${repo} ${dir}`);
  }
}

export class FakeGit implements Git {
  remoteBranches = new Set<string>();
  localBranches = new Set<string>();
  ahead = 1;
  clean = true;
  /** Changed paths in the worktree, as `statusPaths` reports them. `commitAll` clears them. */
  dirtyPaths: string[] = [];
  commits: { message: string; identity: { name: string; email: string }; paths: string[] }[] = [];
  origin = "https://github.com/o/r.git";
  /** What `rev-parse` returns, call by call; the last value repeats. */
  shas: string[] = ["a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"];
  detachedAdds: { path: string; sha: string }[] = [];
  /** What `rev-parse` returns for one specific ref, call by call; the last value repeats. */
  refShas = new Map<string, string[]>();
  /** Whether `git merge` succeeds; false simulates a conflict. */
  mergeOk = true;
  merged: { cwd: string; sha: string }[] = [];
  deletedRemote: string[] = [];
  failOnce = new Map<string, Error>();

  constructor(private readonly log: CallLog = []) {}

  private enter(name: string, detail = ""): void {
    this.log.push(`git.${name}${detail ? ` ${detail}` : ""}`);
    const err = this.failOnce.get(name);
    if (err) {
      this.failOnce.delete(name);
      throw err;
    }
  }

  async originUrl() {
    this.enter("originUrl");
    return this.origin;
  }
  async fetch(_cwd: string, _remote: string, branch: string) {
    this.enter("fetch", branch);
  }
  async worktreeAdd(_cwd: string, _path: string, branch: string, startPoint: string) {
    this.enter("worktreeAdd", `${branch} from ${startPoint}`);
    this.localBranches.add(branch);
  }
  async worktreeAddDetached(_cwd: string, path: string, sha: string) {
    this.enter("worktreeAddDetached", sha.slice(0, 7));
    this.detachedAdds.push({ path, sha });
  }
  async revParse(_cwd: string, ref: string) {
    this.enter("revParse", ref);
    const queue = this.refShas.get(ref) ?? this.shas;
    const sha = queue.length > 1 ? queue.shift() : queue[0];
    return sha as string;
  }
  async merge(cwd: string, sha: string) {
    this.enter("merge", sha.slice(0, 7));
    this.merged.push({ cwd, sha });
    return this.mergeOk;
  }
  async deleteRemoteBranch(_cwd: string, branch: string) {
    this.enter("deleteRemoteBranch", branch);
    this.deletedRemote.push(branch);
  }
  async worktreeRemove() {
    this.enter("worktreeRemove");
  }
  async branchExists(_cwd: string, branch: string) {
    this.enter("branchExists", branch);
    return this.localBranches.has(branch);
  }
  async remoteBranchExists(_cwd: string, branch: string) {
    this.enter("remoteBranchExists", branch);
    return this.remoteBranches.has(branch);
  }
  async deleteBranch(_cwd: string, branch: string) {
    this.enter("deleteBranch", branch);
    this.localBranches.delete(branch);
  }
  async commitsAhead(_cwd: string, base: string) {
    this.enter("commitsAhead", base);
    return this.ahead;
  }
  async isClean() {
    this.enter("isClean");
    return this.clean && this.dirtyPaths.length === 0;
  }
  async statusPaths() {
    this.enter("statusPaths");
    return [...this.dirtyPaths];
  }
  async commitAll(_cwd: string, message: string, identity: { name: string; email: string }) {
    this.enter("commitAll");
    this.commits.push({ message, identity, paths: [...this.dirtyPaths] });
    this.dirtyPaths = [];
    this.ahead += 1;
  }
  async push(_cwd: string, branch: string) {
    this.enter("push", branch);
  }
}

export class FakeAgent implements AgentRunner {
  runs: AgentRun[] = [];
  error: Error | null = null;
  /** The text the agent answers with. */
  output = "";

  constructor(private readonly log: CallLog = []) {}

  async run(run: AgentRun) {
    this.log.push("agent.run");
    this.runs.push(run);
    if (this.error) throw this.error;
    return this.output;
  }
}

export class FakeShell implements Shell {
  commands: { command: string; cwd: string }[] = [];
  ok = true;
  /** Commands that fail even when `ok` is true. */
  failing = new Set<string>();

  constructor(private readonly log: CallLog = []) {}

  async run(command: string, opts: { cwd: string }) {
    this.log.push(`shell.run ${command}`);
    this.commands.push({ command, cwd: opts.cwd });
    return { ok: this.ok && !this.failing.has(command) };
  }
}

export class FakeEvents implements EventLog {
  events: NewEvent[] = [];
  append(event: NewEvent) {
    this.events.push(event);
  }
  get types(): string[] {
    return this.events.map((e) => e.type);
  }
}
