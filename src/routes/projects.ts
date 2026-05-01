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

app.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const body = await c.req.json<{ name?: unknown; files?: unknown }>();
  if (!isValidSlug(body.name)) return badRequest("name must be a 1-64 char alphanumeric slug");

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
  });

  return created({ name: body.name, remote: repo.remote, commit: sha });
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentOwnerId) return unauthorized("Authentication required");

  const projects = filterReadableProjects(await listProjects(c.env.STATE), userId, agentOwnerId);
  return ok({
    projects: projects.map(({ name, remote, createdAt }) => ({ name, remote, createdAt })),
  });
});

app.post("/:name/import", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const { name } = c.req.param();
  if (!isValidSlug(name)) return badRequest("invalid project name");

  const body = await c.req.json<{ url?: unknown; branch?: unknown; depth?: unknown }>();
  if (!isValidGitHubUrl(body.url))
    return badRequest("url must be a valid github.com repository URL");

  const branch = typeof body.branch === "string" ? body.branch : "main";
  const depth = typeof body.depth === "number" ? body.depth : 10;

  const repo = await c.env.ARTIFACTS.create(name);
  await importFromGitHub(repo.remote, repo.token, body.url, branch, depth);

  await setProject(c.env.STATE, {
    name,
    remote: repo.remote,
    token: repo.token,
    createdAt: new Date().toISOString(),
    githubUrl: body.url,
    ownerId: userId,
  });

  return created({ name, remote: repo.remote, source: body.url });
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
