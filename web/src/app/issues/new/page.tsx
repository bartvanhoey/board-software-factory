import Link from "next/link";
import { requireAccess } from "@/auth/dal";
import { getDb } from "@/auth/db";
import { hasRole } from "@/auth/users";
import { listProjects } from "@/auth/projects";
import { CreateIssueForm } from "@/components/CreateIssueForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create issue · Software Factory Board" };

export default async function NewIssuePage({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const session = await requireAccess("viewer");
  const projects = listProjects(getDb())
    .filter((project) => project.enabled)
    .map(({ name, repo }) => ({ name, repo }));
  const params = await searchParams;
  const requested = Array.isArray(params.project) ? params.project[0] : params.project;
  const initialProject = projects.some((project) => project.name === requested) ? requested : undefined;

  return (
    <main>
      <p className="mb-4 text-sm"><Link className="link" href="/">← Back to board</Link></p>
      <h1 className="page-title mb-2">Create a GitHub issue</h1>
      <CreateIssueForm projects={projects} configured={!!process.env.CREATE_ISSUE_GITHUB_TOKEN} canStartWork={hasRole(session.roles, "issue-admin")} initialProject={initialProject} />
    </main>
  );
}
