import { z } from "zod";
import type { Gh, IssueData } from "../ports.js";
import { mustRun, runProcess } from "../process.js";

const NO_PROMPT = { GH_PROMPT_DISABLED: "1" };

const gh = (args: string[], input?: string): Promise<string> => mustRun("gh", args, { env: NO_PROMPT, input });

const UserSchema = z.object({ login: z.string(), id: z.number() });
const NamesSchema = z.array(z.object({ name: z.string() }));
const NumbersSchema = z.array(z.object({ number: z.number() }));
const PrsSchema = z.array(z.object({ number: z.number(), url: z.string(), isDraft: z.boolean() }));
const MergedPrsSchema = z.array(z.object({ number: z.number(), url: z.string() }));
const CommentsSchema = z.object({
  comments: z.array(z.object({ author: z.object({ login: z.string() }).nullable(), body: z.string() })),
});
const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().transform((b) => b ?? ""),
  labels: z.array(z.object({ name: z.string() })),
});

/** The real GitHub adapter: the `gh` CLI, authenticated through GH_TOKEN. No client library. */
export const ghCli: Gh = {
  async whoami() {
    return UserSchema.parse(JSON.parse(await gh(["api", "user"])));
  },

  async listLabels(repo) {
    const out = await gh(["label", "list", "-R", repo, "--limit", "1000", "--json", "name"]);
    return NamesSchema.parse(JSON.parse(out)).map((l) => l.name);
  },

  async createLabel(repo, spec) {
    const result = await runProcess(
      "gh",
      ["label", "create", spec.name, "-R", repo, "--color", spec.color, "--description", spec.description],
      { env: NO_PROMPT },
    );
    if (result.code === 0) return "created";
    if (/already exists/i.test(result.stderr)) return "exists";
    throw new Error(`gh label create ${spec.name} failed: ${result.stderr.trim()}`);
  },

  async listIssuesByLabel(repo, label) {
    const out = await gh(["issue", "list", "-R", repo, "--label", label, "--state", "open", "--limit", "100", "--json", "number"]);
    return NumbersSchema.parse(JSON.parse(out));
  },

  async getIssue(repo, number): Promise<IssueData> {
    const out = await gh(["issue", "view", String(number), "-R", repo, "--json", "number,title,body,labels"]);
    const issue = IssueSchema.parse(JSON.parse(out));
    return { ...issue, labels: issue.labels.map((l) => l.name) };
  },

  async editIssue(repo, number, edit) {
    const args = ["issue", "edit", String(number), "-R", repo];
    if (edit.addAssignee) args.push("--add-assignee", edit.addAssignee);
    for (const l of edit.removeLabels ?? []) args.push("--remove-label", l);
    for (const l of edit.addLabels ?? []) args.push("--add-label", l);
    await gh(args);
  },

  async comment(repo, number, body) {
    await gh(["issue", "comment", String(number), "-R", repo, "--body-file", "-"], body);
  },

  async findOpenPr(repo, branch) {
    const out = await gh(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number,url,isDraft"]);
    return PrsSchema.parse(JSON.parse(out))[0] ?? null;
  },

  async findMergedPr(repo, branch) {
    const out = await gh(["pr", "list", "-R", repo, "--head", branch, "--state", "merged", "--json", "number,url"]);
    return MergedPrsSchema.parse(JSON.parse(out))[0] ?? null;
  },

  async closeIssue(repo, number) {
    await gh(["issue", "close", String(number), "-R", repo, "--reason", "completed"]);
  },

  async listIssueComments(repo, number) {
    const out = await gh(["issue", "view", String(number), "-R", repo, "--json", "comments"]);
    return CommentsSchema.parse(JSON.parse(out)).comments.map((c) => ({ author: c.author?.login ?? "", body: c.body }));
  },

  async markPrReady(repo, number) {
    await gh(["pr", "ready", String(number), "-R", repo]);
  },

  async mergePr(repo, number, opts) {
    await gh(["pr", "merge", String(number), "-R", repo, "--squash", "--match-head-commit", opts.matchHeadCommit]);
  },

  async createPr(repo, pr) {
    const out = await gh(
      ["pr", "create", "-R", repo, "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", "-"],
      pr.body,
    );
    const url = out.trim().split("\n").at(-1) ?? "";
    const number = /\/pull\/(\d+)$/.exec(url)?.[1];
    if (number === undefined) throw new Error(`gh pr create printed no pull request URL: ${url}`);
    return { number: Number(number), url };
  },

  async cloneRepo(repo, dir) {
    await gh(["repo", "clone", repo, dir]);
  },
};
