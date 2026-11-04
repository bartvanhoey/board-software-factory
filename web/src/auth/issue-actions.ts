"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import { requestContext, requireAccess } from "./dal";
import { getProject } from "./projects";
import { hasRole } from "./users";
import { createGitHubIssue } from "../lib/github-issues";

export interface CreateIssueState {
  error?: string;
  issue?: { number: number; url: string; repo: string };
  warning?: string;
  values?: { project: string; title: string; body: string; ready: boolean };
}

const InputSchema = z.object({
  project: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1, "Enter a title.").max(256, "The title must be 256 characters or fewer."),
  body: z.string().max(65_536, "The description must be 65,536 characters or fewer."),
  ready: z.boolean(),
});

const READY_DENIED =
  "Only a project manager or an administrator can start factory work. Create the issue without it and ask one of them to label it ready.";

function value(form: FormData, key: string): string {
  const entry = form.get(key);
  return typeof entry === "string" ? entry : "";
}

function valuesOf(form: FormData): NonNullable<CreateIssueState["values"]> {
  return {
    project: value(form, "project"),
    title: value(form, "title"),
    body: value(form, "body"),
    ready: form.get("ready") === "on",
  };
}

export async function createIssueAction(_previous: CreateIssueState, form: FormData): Promise<CreateIssueState> {
  const session = await requireAccess("viewer");
  const values = valuesOf(form);
  const parsed = InputSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the issue details.", values };

  // `ready` makes the factory build the issue with its credentials, from text any member can write. A member (viewer)
  // may create issues, but only a project manager or an administrator may start factory work.
  if (parsed.data.ready && !hasRole(session.roles, "issue-admin")) {
    return { error: READY_DENIED, values: { ...values, ready: false } };
  }

  const project = getProject(getDb(), parsed.data.project);
  if (!project || !project.enabled || project.archivedAt !== null) {
    return { error: "Choose an enabled project.", values };
  }

  const token = process.env.CREATE_ISSUE_GITHUB_TOKEN;
  if (!token) return { error: "Issue creation is not configured. Set CREATE_ISSUE_GITHUB_TOKEN for the web service.", values };

  const created = await createGitHubIssue(
    project.repo,
    token,
    parsed.data.title,
    parsed.data.body,
    parsed.data.ready ? ["ready"] : [],
  );
  if (!created.ok) return { error: created.error, values };

  let warning: string | undefined;
  try {
    const ctx = await requestContext();
    audit(getDb(), {
      action: "issue.created",
      actor: session.userId,
      ip: ctx.ip,
      detail: { project: project.name, repo: project.repo, number: created.number },
    });
  } catch (err) {
    console.error(`[issues] created ${project.repo}#${created.number}, but audit logging failed: ${err instanceof Error ? err.message : "unknown error"}`);
    warning = "The issue was created, but its audit event could not be recorded.";
  }

  revalidatePath("/");
  return { issue: { number: created.number, url: created.url, repo: project.repo }, ...(warning ? { warning } : {}) };
}
