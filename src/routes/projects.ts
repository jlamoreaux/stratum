import { Hono } from "hono";
import { getCommitLog, importFromGitHub, initAndPush, listFilesInRepo } from "../storage/git-ops";
import { listProvenance } from "../storage/provenance";
import { getProject, listProjects, setProject } from "../storage/state";
import type { Env } from "../types";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { isStringRecord, isValidGitHubUrl, isValidSlug } from "../utils/validation";

const DEFAULT_FILES: Record<string, string> = {
  "README.md": "# My Project\n\nCreated with Stratum.\n",
  "src/index.ts": 'export function hello(): string {\n  return "hello world";\n}\n',
};

const app = new Hono<{ Bindings: Env }>();
function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git|\/)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

app.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const body = await c.req.json<{ name?: unknown; files?: unknown; visibility?: unknown }>();
  if (!isValidSlug(body.name)) return badRequest("name must be a 1-64 char alphanumeric slug");

  // Validate visibility if provided
  let visibility: "private" | "public" = "private";
  if (body.visibility !== undefined) {
    if (body.visibility !== "private" && body.visibility !== "public") {
      return badRequest("visibility must be 'private' or 'public'");
    }
    visibility = body.visibility;
  }

  const seed = c.req.query("seed") === "true";
  const files =
    body.files !== undefined
      ? isStringRecord(body.files)
        ? body.files
        : null
      : seed
        ? DEFAULT_FILES
        : { ".gitkeep": "" };

  if (files === null)
    return badRequest("files must be an object of string paths to string contents");

  const repo = await c.env.ARTIFACTS.create(body.name);
  const sha = await initAndPush(repo.remote, repo.token, files, "Initial commit");

  await setProject(c.env.STATE, {
    name: body.name,
    remote: repo.remote,
    token: repo.token,
    createdAt: new Date().toISOString(),
    ownerId: userId,
    visibility,
  });

  return created({ name: body.name, remote: repo.remote, commit: sha, visibility });
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const projects = filterReadableProjects(await listProjects(c.env.STATE), userId, agentOwnerId);
  return ok({
    projects: projects.map(({ name, remote, createdAt, visibility }) => ({ name, remote, createdAt, visibility })),
  });
});

app.post("/:name/import", async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return unauthorized("Authentication required");

    const { name } = c.req.param();
    if (!isValidSlug(name)) return badRequest("invalid project name");

    // Handle both JSON and form data
    let body: { url?: unknown; branch?: unknown; depth?: unknown; visibility?: unknown };
    const contentType = c.req.header("content-type") || "";
    
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else {
      // Form data
      const formData = await c.req.parseBody();
      body = {
        url: formData.url,
        branch: formData.branch,
        depth: formData.depth ? Number(formData.depth) : undefined,
        visibility: formData.visibility,
      };
    }

    if (!isValidGitHubUrl(body.url))
      return badRequest("url must be a valid github.com repository URL");

    const branch = typeof body.branch === "string" ? body.branch : "main";
    const depth = typeof body.depth === "number" ? body.depth : 10;

    // Validate visibility if provided
    let visibility: "private" | "public" = "private";
    if (body.visibility !== undefined) {
      if (body.visibility !== "private" && body.visibility !== "public") {
        return badRequest("visibility must be 'private' or 'public'");
      }
      visibility = body.visibility;
    }

    const repo = await c.env.ARTIFACTS.create(name);
    await importFromGitHub(repo.remote, repo.token, body.url, branch, depth);

    await setProject(c.env.STATE, {
      name,
      remote: repo.remote,
      token: repo.token,
      createdAt: new Date().toISOString(),
      githubUrl: body.url,
      ...(parseGitHubRepo(body.url) ?? {}),
      githubDefaultBranch: branch,
      githubConnectedAt: new Date().toISOString(),
      githubConnectionStatus: "connected",
      ownerId: userId,
      visibility,
    });

    // Redirect to project page if coming from web UI (form submission)
    if (!contentType.includes("application/json")) {
      return c.redirect(`/p/${name}`);
    }

    return created({ name, remote: repo.remote, source: body.url, visibility });
  } catch (err) {
    console.error("[import] Error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Import failed", details: message }, 500);
  }
});

app.get("/:name/files", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);
  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const files = await listFilesInRepo(project.remote, project.token);
  return ok({ project: name, files });
});

app.get("/:name/log", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);
  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const depth = Number(c.req.query("depth") ?? 20);
  const log = await getCommitLog(project.remote, project.token, depth);
  return ok({ project: name, log });
});

app.get("/:name/provenance", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);
  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;

  const records = await listProvenance(c.env.DB, name, limit);
  return ok({ project: name, records });
});

export { app as projectsRouter };
