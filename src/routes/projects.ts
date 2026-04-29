import { Hono } from "hono";
import { getCommitLog, initAndPush, listFilesInRepo } from "../storage/git-ops";
import { getProject, listProjects, setProject } from "../storage/state";
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
  const importRes = await fetch(`${repo.remote}/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${repo.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: body.url, branch, depth }),
  });
  if (!importRes.ok) {
    const detail = await importRes.text().catch(() => "unknown error");
    throw new Error(`Artifacts import failed (${importRes.status}): ${detail}`);
  }

  await setProject(c.env.STATE, {
    name,
    remote: repo.remote,
    token: repo.token,
    createdAt: new Date().toISOString(),
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

export { app as projectsRouter };
