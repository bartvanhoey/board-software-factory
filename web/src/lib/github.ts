import { z } from "zod";
import { resolveLane } from "./lanes";
import {
  DONE_WINDOW_DAYS,
  LANE_LABELS,
  type BoardIssue,
  type BoardPr,
  type ChecksState,
  type ProjectInfo,
  type ProjectResult,
} from "./types";

const ENDPOINT = "https://api.github.com/graphql";
const REVALIDATE_SECONDS = 30;

const ISSUE_FIELDS = `
  number title url updatedAt closedAt state
  labels(first: 20) { nodes { name } }
  assignees(first: 1) { nodes { login } }
  closedByPullRequestsReferences(first: 1, includeClosedPrs: true) {
    nodes {
      number url isDraft merged
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }`;

const ORDER = "orderBy: {field: UPDATED_AT, direction: DESC}";

/** One GraphQL request for all projects: an alias (p0, p1, ...) per repository. */
export function buildQuery(projects: readonly ProjectInfo[]): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {};
  const decls: string[] = [];
  const bodies = projects.map((p, i) => {
    const [owner = "", name = ""] = p.repo.split("/");
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    decls.push(`$o${i}: String!`, `$n${i}: String!`);
    const lanes = LANE_LABELS.map(
      (l) => `${l}: issues(states: OPEN, labels: ["${l}"], first: 50, ${ORDER}) { nodes { ...IssueFields } }`,
    ).join("\n      ");
    return `p${i}: repository(owner: $o${i}, name: $n${i}) {
      ${lanes}
      done: issues(states: CLOSED, first: 30, ${ORDER}) { nodes { ...IssueFields } }
    }`;
  });
  const query = `query Board(${decls.join(", ")}) {\n  ${bodies.join("\n  ")}\n}\nfragment IssueFields on Issue {${ISSUE_FIELDS}\n}`;
  return { query, variables };
}

const PrSchema = z.object({
  number: z.number(),
  url: z.string(),
  isDraft: z.boolean(),
  merged: z.boolean(),
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }),
        }),
      ),
    })
    .optional(),
});

const IssueNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED"]),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
  closedByPullRequestsReferences: z.object({ nodes: z.array(PrSchema) }).nullable(),
});

const Connection = z.object({ nodes: z.array(IssueNodeSchema) });

const RepoSchema = z.object({
  ready: Connection,
  building: Connection,
  qa: Connection,
  review: Connection,
  done: Connection,
});

const ResponseSchema = z.object({
  data: z.record(RepoSchema.nullable()).nullable().optional(),
  errors: z.array(z.object({ message: z.string(), path: z.array(z.union([z.string(), z.number()])).optional() })).optional(),
});

type IssueNode = z.infer<typeof IssueNodeSchema>;

function checksOf(pr: z.infer<typeof PrSchema>): ChecksState {
  const state = pr.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  if (state === undefined) return "none";
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  return "pending";
}

type BranchSource = Pick<ProjectInfo, "repo" | "defaultBranch">;

/**
 * True for an https://github.com link without credentials or a port, the only kind the board links to. The URLs come
 * from the API response and end up in `href`, so a `javascript:` URL, another host or a lookalike must not get through.
 */
export function isGithubUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === "";
}

function toIssue(project: string, node: IssueNode, now: Date, source?: BranchSource): BoardIssue | null {
  if (!isGithubUrl(node.url)) return null; // not a GitHub issue link: the card is left off the board
  const labels = node.labels.nodes.map((l) => l.name);
  const prNode = node.closedByPullRequestsReferences?.nodes[0];

  if (node.state === "CLOSED") {
    // Done = closed recently AND factory work (a lane label is left, or a PR closed it).
    const closedAt = node.closedAt ? new Date(node.closedAt).getTime() : 0;
    const cutoff = now.getTime() - DONE_WINDOW_DAYS * 86_400_000;
    const factoryWork = prNode !== undefined || labels.some((l) => (LANE_LABELS as readonly string[]).includes(l));
    if (closedAt < cutoff || !factoryWork) return null;
  }

  const resolved = resolveLane(labels, node.state);
  if (!resolved) return null;

  // A PR with a bad URL is shown without its link (and the card does not fall back to the branch link either).
  const pr: BoardPr | null = prNode && isGithubUrl(prNode.url)
    ? { number: prNode.number, url: prNode.url, draft: prNode.isDraft, merged: prNode.merged, checks: checksOf(prNode) }
    : null;

  // The build lane pushes `issue-<n>` and opens no PR: until the review approves, the work is a branch.
  const branch =
    source && !prNode && (resolved.lane === "qa" || resolved.lane === "review")
      ? {
          name: `issue-${node.number}`,
          compareUrl: `https://github.com/${source.repo}/compare/${source.defaultBranch}...issue-${node.number}`,
        }
      : null;

  return {
    project,
    number: node.number,
    title: node.title,
    url: node.url,
    lane: resolved.lane,
    laneConflict: resolved.conflict,
    assignee: node.assignees.nodes[0]?.login ?? null,
    updatedAt: node.updatedAt,
    pr,
    branch,
  };
}

/** Turn one repository's GraphQL data into board issues (deduplicated by number). */
export function parseRepo(project: string, repo: z.infer<typeof RepoSchema>, now: Date, source?: BranchSource): BoardIssue[] {
  const seen = new Map<number, BoardIssue>();
  for (const key of ["ready", "building", "qa", "review", "done"] as const) {
    for (const node of repo[key].nodes) {
      if (seen.has(node.number)) continue;
      const issue = toIssue(project, node, now, source);
      if (issue) seen.set(node.number, issue);
    }
  }
  return [...seen.values()];
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetch all projects' boards with plain fetch against the GraphQL API (no client library).
 * A failing repository only marks its own project as errored; a transport or auth failure
 * marks every project.
 */
export async function fetchBoards(
  projects: readonly ProjectInfo[],
  token: string,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ProjectResult[]> {
  const active = projects.filter((p) => p.enabled);
  const failAll = (error: string): ProjectResult[] =>
    projects.map((info) => (info.enabled ? { info, status: "error", error } : { info, status: "disabled" }));

  if (active.length === 0) return projects.map((info) => ({ info, status: "disabled" }));

  let json: unknown;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "software-factory-board",
      },
      body: JSON.stringify(buildQuery(active)),
      // Next.js data cache; ignored outside Next.
      next: { revalidate: REVALIDATE_SECONDS },
    } as RequestInit);
    if (res.status === 401) return failAll("GitHub rejected the token (401). Check BOARD_GITHUB_TOKEN.");
    if (!res.ok) return failAll(`GitHub returned HTTP ${res.status}.`);
    json = await res.json();
  } catch (e) {
    return failAll(`Could not reach GitHub: ${(e as Error).message}`);
  }

  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) return failAll("Unexpected response from GitHub.");
  const { data, errors = [] } = parsed.data;

  const byAlias = new Map<string, ProjectInfo>(active.map((p, i) => [`p${i}`, p]));
  const results = new Map<string, ProjectResult>();
  for (const [alias, info] of byAlias) {
    const repo = data?.[alias];
    if (repo) {
      results.set(info.name, { info, status: "ok", issues: parseRepo(info.name, repo, now, info) });
      continue;
    }
    const message =
      errors.find((e) => e.path?.[0] === alias)?.message ??
      errors[0]?.message ??
      `No data returned for ${info.repo}.`;
    results.set(info.name, { info, status: "error", error: message });
  }

  return projects.map((info) => results.get(info.name) ?? { info, status: "disabled" });
}
