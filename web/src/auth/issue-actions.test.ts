import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db";
import { createProject } from "./projects";
import { createSession } from "./sessions";
import { createUser, findUserByEmail, grantRole, type Role } from "./users";
import { createGitHubIssue } from "../lib/github-issues";
import { createIssueAction } from "./issue-actions";

const world = vi.hoisted(() => ({ db: undefined as unknown, token: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: <T>(fn: T) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && world.token ? { name, value: world.token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("./config", async (original) => ({
  ...(await original<typeof import("./config")>()),
  getAuthConfig: () => ({ cookieSecure: false, emailVerification: false, trustProxy: false }),
}));
vi.mock("./db", async (original) => ({ ...(await original<typeof import("./db")>()), getDb: () => world.db }));
vi.mock("../lib/github-issues", () => ({ createGitHubIssue: vi.fn() }));

let db: ReturnType<typeof openDb>;
const createIssue = vi.mocked(createGitHubIssue);
const makeUser = (role: Role): string => {
  const id = createUser(db, { email: `${role}@example.com`, passwordHash: "x" });
  grantRole(db, id, role, null);
  return id;
};
const logIn = (id: string): void => {
  world.token = createSession(db, id).token;
};
const addProject = (enabled = true): void => {
  const admin = makeUser("admin");
  createProject(db, admin, { name: "demo", repo: "Owner/Demo", enabled }, { ip: null });
};

beforeEach(() => {
  db = openDb(":memory:");
  world.db = db;
  world.token = undefined;
  createIssue.mockReset();
  createIssue.mockResolvedValue({ ok: true, number: 42, url: "https://github.com/Owner/Demo/issues/42" });
  vi.stubEnv("CREATE_ISSUE_GITHUB_TOKEN", "issue-token");
});

afterEach(() => vi.unstubAllEnvs());

describe("createIssueAction", () => {
  it("requires a logged-in user before contacting GitHub", async () => {
    const form = new FormData();
    await expect(createIssueAction({}, form)).rejects.toThrow("redirect:/login");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("rejects disabled projects even when a caller submits their name directly", async () => {
    addProject(false);
    logIn(makeUser("viewer"));
    const form = new FormData();
    form.set("project", "demo");
    form.set("title", "Issue title");

    await expect(createIssueAction({}, form)).resolves.toMatchObject({ error: "Choose an enabled project." });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("lets a member create an issue, but not start factory work on it", async () => {
    addProject();
    logIn(makeUser("viewer"));
    const form = new FormData();
    form.set("project", "demo");
    form.set("title", "Issue title");
    form.set("body", "Description");

    await expect(createIssueAction({}, form)).resolves.toMatchObject({ issue: { number: 42 } });
    expect(createIssue).toHaveBeenCalledWith("Owner/Demo", "issue-token", "Issue title", "Description", []);
  });

  it("refuses the ready label from a member, even when the form is posted directly", async () => {
    addProject();
    logIn(makeUser("viewer"));
    const form = new FormData();
    form.set("project", "demo");
    form.set("title", "Issue title");
    form.set("body", "Description");
    form.set("ready", "on");

    const result = await createIssueAction({}, form);
    expect(result.error).toContain("Only a project manager or an administrator");
    expect(result.issue).toBeUndefined();
    expect(result.values?.ready).toBe(false);
    expect(createIssue).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'issue.created'").get()).toEqual({ n: 0 });
  });

  it.each(["issue-admin", "admin"] as const)("lets a %s start factory work with the ready label", async (role) => {
    addProject(); // creates an admin, which is the one to log in as for the admin case
    logIn(findUserByEmail(db, `${role}@example.com`)?.id ?? makeUser(role));
    const form = new FormData();
    form.set("project", "demo");
    form.set("title", "Issue title");
    form.set("body", "Description");
    form.set("ready", "on");

    await expect(createIssueAction({}, form)).resolves.toMatchObject({ issue: { number: 42 } });
    expect(createIssue).toHaveBeenCalledWith("Owner/Demo", "issue-token", "Issue title", "Description", ["ready"]);
  });

  it("creates an issue for the selected enabled project and records the actor", async () => {
    addProject();
    const actor = makeUser("issue-admin");
    logIn(actor);
    const form = new FormData();
    form.set("project", "demo");
    form.set("title", "  Issue title  ");
    form.set("body", "Description");
    form.set("ready", "on");

    await expect(createIssueAction({}, form)).resolves.toMatchObject({
      issue: { number: 42, url: "https://github.com/Owner/Demo/issues/42" },
    });
    expect(createIssue).toHaveBeenCalledWith("Owner/Demo", "issue-token", "Issue title", "Description", ["ready"]);
    expect(db.prepare("SELECT actor_user_id, action, detail FROM audit_log WHERE action = 'issue.created'").get()).toEqual({
      actor_user_id: actor,
      action: "issue.created",
      detail: JSON.stringify({ project: "demo", repo: "Owner/Demo", number: 42 }),
    });
  });
});
