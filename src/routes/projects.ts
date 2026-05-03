import { Hono } from "hono";
import { getCommitLog, importFromGitHub, initAndPush, listFilesInRepo } from "../storage/git-ops";
import { listProvenance } from "../storage/provenance";
import { getProject, listProjects, setProject } from "../storage/state";
import type { Env } from "../types";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { internalError, badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { isStringRecord, isValidGitHubUrl, isValidSlug } from "../utils/validation";
import { createLogger } from "../utils/logger";

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
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

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
  const initResult = await initAndPush(repo.remote, repo.token, files, "Initial commit", logger);
  if (!initResult.success) {
    logger.error('Failed to initialize and push repository', initResult.error);
    return internalError(initResult.error.message);
  }

  const setResult = await setProject(c.env.STATE, {
    name: body.name,
    remote: repo.remote,
    token: repo.token,
    createdAt: new Date().toISOString(),
    ownerId: userId,
    visibility,
  }, logger);
  if (!setResult.success) {
    logger.error('Failed to set project', setResult.error);
    return internalError(setResult.error.message);
  }

  logger.info('Project created', { projectName: body.name, visibility });
  return created({ name: body.name, remote: repo.remote, commit: initResult.data, visibility });
});

app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const projectsResult = await listProjects(c.env.STATE, logger);
  if (!projectsResult.success) {
    logger.error('Failed to list projects', projectsResult.error);
    return internalError(projectsResult.error.message);
  }

  const projects = filterReadableProjects(projectsResult.data, userId, agentOwnerId);
  logger.info('Projects listed', { count: projects.length });
  return ok({
    projects: projects.map(({ name, remote, createdAt, visibility }) => ({ name, remote, createdAt, visibility })),
  });
});

app.post("/:name/import", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

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

    const importResult = await importFromGitHub(c.env.ARTIFACTS, name, body.url, logger, branch, depth);
    if (!importResult.success) {
      logger.error('Failed to import from GitHub', importResult.error, { url: body.url, branch });
      return internalError(importResult.error.message);
    }

    const importedRepo = importResult.data;

    const setResult = await setProject(c.env.STATE, {
      name,
      remote: importedRepo.remote,
      token: importedRepo.token,
      createdAt: new Date().toISOString(),
      githubUrl: body.url,
      ...(parseGitHubRepo(body.url) ?? {}),
      githubDefaultBranch: branch,
      githubConnectedAt: new Date().toISOString(),
      githubConnectionStatus: "connected",
      ownerId: userId,
      visibility,
    }, logger);
    if (!setResult.success) {
      logger.error('Failed to set project after import', setResult.error);
      return internalError(setResult.error.message);
    }

    // Redirect to project page if coming from web UI (form submission)
    if (!contentType.includes("application/json")) {
      return c.redirect(`/p/${name}`);
    }

    logger.info('Project imported from GitHub', { projectName: name, url: body.url, visibility });
    return created({ name, remote: repo.remote, source: body.url, visibility });
  } catch (err) {
    logger.error("[import] Error:", err instanceof Error ? err : undefined);
    const message = err instanceof Error ? err.message : String(err);
    return internalError(message);
  }
});

app.get("/:name/files", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name } = c.req.param();

  const projectResult = await getProject(c.env.STATE, name, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", name);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const filesResult = await listFilesInRepo(project.remote, project.token, logger);
  if (!filesResult.success) {
    logger.error('Failed to list files in repo', filesResult.error);
    return internalError(filesResult.error.message);
  }

  logger.info('Project files listed', { projectName: name, fileCount: filesResult.data.length });
  return ok({ project: name, files: filesResult.data });
});

app.get("/:name/log", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name } = c.req.param();

  const projectResult = await getProject(c.env.STATE, name, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", name);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const depth = Number(c.req.query("depth") ?? 20);
  const logResult = await getCommitLog(project.remote, project.token, logger, depth);
  if (!logResult.success) {
    logger.error('Failed to get commit log', logResult.error);
    return internalError(logResult.error.message);
  }

  logger.info('Commit log retrieved', { projectName: name, depth, commitCount: logResult.data.length });
  return ok({ project: name, log: logResult.data });
});

app.get("/:name/provenance", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name } = c.req.param();

  const projectResult = await getProject(c.env.STATE, name, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", name);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;

  const recordsResult = await listProvenance(c.env.DB, logger, name, limit);
  if (!recordsResult.success) {
    logger.error('Failed to list provenance', recordsResult.error);
    return internalError(recordsResult.error.message);
  }

  logger.info('Provenance listed', { projectName: name, limit, recordCount: recordsResult.data.length });
  return ok({ project: name, records: recordsResult.data });
});

export { app as projectsRouter };
