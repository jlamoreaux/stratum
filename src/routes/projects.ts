import { Hono } from "hono";
import { getCommitLog, importFromGitHub, initAndPush, listFilesInRepo } from "../storage/git-ops";
import { getProject, listProjects, setProject } from "../storage/state";
import { listProvenance } from "../storage/provenance";
import type { Env } from "../types";
import { badRequest, created, notFound, ok } from "../utils/response";
import { isStringRecord, isValidGitHubUrl, isValidSlug } from "../utils/validation";

const DEFAULT_FILES: Record<string, string> = {
  "README.md": "# My Project\n\nCreated with Stratum.\n",
  "src/index.ts": 'export function hello(): string {\n  return "hello world";\n}\n',
};

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const body = await c.req.json<{ name?: unknown; files?: unknown }>();
  if (!isValidSlug(body.name)) return badRequest("name must be a 1-64 char alphanumeric slug");

  const files =
    body.files !== undefined ? (isStringRecord(body.files) ? body.files : null) : DEFAULT_FILES;

  if (files === null)
    return badRequest("files must be an object of string paths to string contents");

  const repo = await c.env.ARTIFACTS.create(body.name);
  const sha = await initAndPush(repo.remote, repo.token, files, "Initial commit");

  await setProject(c.env.STATE, {
    name: body.name,
    remote: repo.remote,
    token: repo.token,
    createdAt: new Date().toISOString(),
  });

  return created({ name: body.name, remote: repo.remote, commit: sha });
});

app.get("/", async (c) => {
  const projects = await listProjects(c.env.STATE);
  return ok({
    projects: projects.map(({ name, remote, createdAt }) => ({ name, remote, createdAt })),
  });
});

app.post("/:name/import", async (c) => {
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
  });

  return created({ name, remote: repo.remote, source: body.url });
});

app.get("/:name/files", async (c) => {
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);

  const files = await listFilesInRepo(project.remote, project.token);
  return ok({ project: name, files });
});

app.get("/:name/log", async (c) => {
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);

  const depth = Number(c.req.query("depth") ?? 20);
  const log = await getCommitLog(project.remote, project.token, depth);
  return ok({ project: name, log });
});

app.get("/:name/provenance", async (c) => {
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) return notFound("Project", name);

  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;

  const records = await listProvenance(c.env.DB, name, limit);
  return ok({ project: name, records });
});

export { app as projectsRouter };
