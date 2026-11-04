"use client";

import Link from "next/link";
import { useActionState, useId } from "react";
import { createIssueAction, type CreateIssueState } from "@/auth/issue-actions";

export interface IssueProjectOption {
  name: string;
  repo: string;
}

export function CreateIssueForm({
  projects,
  configured,
  canStartWork,
  initialProject,
}: {
  projects: readonly IssueProjectOption[];
  configured: boolean;
  /** Only a project manager or an administrator may add the `ready` label. */
  canStartWork: boolean;
  initialProject?: string;
}) {
  const [state, action, pending] = useActionState<CreateIssueState, FormData>(createIssueAction, {});
  const values = state.values;
  const unavailable = !configured || projects.length === 0;
  const errorId = useId();
  const errorProps = state.error ? { "aria-invalid": true, "aria-describedby": errorId } : {};

  return (
    <div className="max-w-3xl">
      <p className="page-lead">
        Issues are created by the GitHub account that owns <code>CREATE_ISSUE_GITHUB_TOKEN</code>, not by your app account.
      </p>

      {!configured && (
        <p role="status" className="alert alert-warn mb-4">
          Issue creation is not configured. Set <code>CREATE_ISSUE_GITHUB_TOKEN</code> for the web service with Issues: write access.
        </p>
      )}
      {configured && projects.length === 0 && (
        <p role="status" className="alert alert-warn mb-4">There are no enabled projects to create an issue for.</p>
      )}

      {state.error && <p id={errorId} role="alert" className="alert alert-error mb-4">{state.error}</p>}
      {state.issue && (
        <div role="status" className="alert alert-success mb-4">
          Created <a className="link" href={state.issue.url} target="_blank" rel="noreferrer">{state.issue.repo}#{state.issue.number}</a>.
          {state.warning && <p className="mt-1">{state.warning}</p>}
        </div>
      )}

      <form action={action} className="panel space-y-4">
        <label className="block text-sm">
          <span className="font-medium">Project</span>
          <select
            className="input mt-1"
            name="project"
            required
            disabled={unavailable || pending}
            defaultValue={values?.project ?? initialProject ?? ""}
            {...errorProps}
          >
            <option value="" disabled>Select a project</option>
            {projects.map((project) => (
              <option key={project.name} value={project.name}>{project.name} · {project.repo}</option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Title</span>
          <input
            className="input mt-1"
            name="title"
            required
            maxLength={256}
            disabled={unavailable || pending}
            defaultValue={values?.title ?? ""}
            {...errorProps}
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium">Description</span>
          <textarea
            className="input mt-1 min-h-40 resize-y"
            name="body"
            maxLength={65_536}
            disabled={unavailable || pending}
            defaultValue={values?.body ?? ""}
            {...errorProps}
          />
        </label>

        {canStartWork ? (
          <label className="flex items-start gap-2 text-sm">
            <input className="mt-1" type="checkbox" name="ready" disabled={unavailable || pending} defaultChecked={values?.ready ?? false} />
            <span>
              <span className="font-medium">Start factory work</span>
              <span className="mt-0.5 block text-xs text-muted">
                Adds the <code>ready</code> label. The factory may start working on this issue. Leave unchecked to create it without starting work.
              </span>
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted">
            The issue is created without starting factory work. A project manager or an administrator labels it <code>ready</code> when it should be built.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={unavailable || pending}>
            {pending ? "Creating…" : "Create issue"}
          </button>
          <Link className="btn" href="/">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
