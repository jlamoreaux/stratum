import { Hono } from "hono";
import { importFromGitHub } from "../storage/git-ops";
import { getProject, listProjects, setProject } from "../storage/state";
import { getGitHubAccessToken } from "../storage/users";
import type { Env, ProjectEntry } from "../types";
import { badRequest, notFound, ok } from "../utils/response";
import { isValidGitHubUrl } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

app.post("/projects/:name/sync", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");

  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);

  const body = await c.req.json<{ githubUrl?: unknown }>().catch(() => ({}));

  let githubUrl = project.githubUrl;

  if ("githubUrl" in body) {
    if (!isValidGitHubUrl(body.githubUrl)) {
      return badRequest("githubUrl must be a valid github.com repository URL");
    }
    githubUrl = body.githubUrl;
    const updated: ProjectEntry = { ...project, githubUrl };
    await setProject(c.env.STATE, updated);
  }

  if (!githubUrl) {
    return badRequest("no githubUrl set for this project — provide one in the request body");
  }

  // Get user's GitHub token for private repo access
  const githubToken = userId ? await getGitHubAccessToken(c.env.DB, userId) : null;

  const branch = project.githubDefaultBranch ?? "main";
  await importFromGitHub(c.env.ARTIFACTS, name, githubUrl, branch, 10, githubToken ?? undefined);

  return ok({ synced: true, project: name, source: githubUrl });
});

export { app as syncRouter };

export async function syncAllProjects(env: Env): Promise<{ synced: number; failed: number }> {
  const projects = await listProjects(env.STATE);
  let synced = 0;
  let failed = 0;

  for (const project of projects) {
    if (!project.githubUrl) continue;
    try {
      const githubToken = project.ownerId
        ? await getGitHubAccessToken(env.DB, project.ownerId)
        : null;
      const branch = project.githubDefaultBranch ?? "main";
      await importFromGitHub(
        env.ARTIFACTS,
        project.name,
        project.githubUrl,
        branch,
        10,
        githubToken ?? undefined,
      );
      synced++;
    } catch {
      failed++;
    }
  }

  return { synced, failed };
}
