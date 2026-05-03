import { Hono } from "hono";
import { cloneRepo, commitAndPush } from "../storage/git-ops";
import {
  deleteWorkspace,
  getProject,
  getWorkspace,
  listWorkspaces,
  setWorkspace,
} from "../storage/state";
import type { Env } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { isStringRecord, isValidSlug } from "../utils/validation";
import { createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

app.post("/projects/:name/workspaces", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: projectName } = c.req.param();

  const projectResult = await getProject(c.env.STATE, projectName, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", projectName);
    }
    logger.error('Failed to get project', projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canWriteProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  const workspaceName = isValidSlug(body.name) ? body.name : `ws-${Date.now()}`;

  const projectRepo = await c.env.ARTIFACTS.get(projectName);
  const forked = await projectRepo.fork(workspaceName);

  const setResult = await setWorkspace(c.env.STATE, {
    name: workspaceName,
    remote: forked.remote,
    token: forked.token,
    parent: projectName,
    createdAt: new Date().toISOString(),
  }, logger);
  if (!setResult.success) {
    logger.error('Failed to set workspace', setResult.error);
    return badRequest(setResult.error.message);
  }

  logger.info('Workspace created', { workspaceName, projectName });
  return created({ workspace: workspaceName, remote: forked.remote, parent: projectName });
});

app.get("/projects/:name/workspaces", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name: projectName } = c.req.param();

  const projectResult = await getProject(c.env.STATE, projectName, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", projectName);
    }
    logger.error('Failed to get project', projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const workspacesResult = await listWorkspaces(c.env.STATE, logger, projectName);
  if (!workspacesResult.success) {
    logger.error('Failed to list workspaces', workspacesResult.error);
    return badRequest(workspacesResult.error.message);
  }

  logger.info('Workspaces listed', { projectName, count: workspacesResult.data.length });
  return ok({
    project: projectName,
    workspaces: workspacesResult.data.map(({ name, parent, createdAt }) => ({ name, parent, createdAt })),
  });
});

app.post("/:name/commit", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  const workspaceResult = await getWorkspace(c.env.STATE, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === 'NOT_FOUND') {
      return notFound("Workspace", workspaceName);
    }
    logger.error('Failed to get workspace', workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  const projectResult = await getProject(c.env.STATE, workspace.parent, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", workspace.parent);
    }
    logger.error('Failed to get project', projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canWriteProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const body = await c.req.json<{ files?: unknown; message?: unknown }>();
  if (!isStringRecord(body.files))
    return badRequest("files must be an object of string paths to string contents");
  if (typeof body.message !== "string" || !body.message.trim())
    return badRequest("message is required");

  const cloneResult = await cloneRepo(workspace.remote, workspace.token, logger);
  if (!cloneResult.success) {
    logger.error('Failed to clone repo', cloneResult.error);
    return badRequest(cloneResult.error.message);
  }

  const { fs, dir } = cloneResult.data;
  const commitResult = await commitAndPush(
    fs,
    dir,
    workspace.remote,
    workspace.token,
    body.files,
    body.message,
    logger,
  );
  if (!commitResult.success) {
    logger.error('Failed to commit and push', commitResult.error);
    return badRequest(commitResult.error.message);
  }

  logger.info('Changes committed', { workspaceName, commit: commitResult.data });
  return ok({ workspace: workspaceName, commit: commitResult.data, filesChanged: Object.keys(body.files) });
});

app.post("/:name/merge", (c) => {
  return c.json(
    { error: "This endpoint is deprecated. Use POST /api/projects/:name/changes instead." },
    410,
  );
});

app.delete("/:name", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  const workspaceResult = await getWorkspace(c.env.STATE, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === 'NOT_FOUND') {
      return notFound("Workspace", workspaceName);
    }
    logger.error('Failed to get workspace', workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  const projectResult = await getProject(c.env.STATE, workspace.parent, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", workspace.parent);
    }
    logger.error('Failed to get project', projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canWriteProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  await c.env.ARTIFACTS.delete(workspaceName).catch((err: unknown) => {
    logger.warn(`[workspaces] Failed to delete Artifacts repo "${workspaceName}"`, { error: err instanceof Error ? err.message : String(err) });
  });

  const deleteResult = await deleteWorkspace(c.env.STATE, workspaceName, logger);
  if (!deleteResult.success) {
    logger.error('Failed to delete workspace', deleteResult.error);
    return badRequest(deleteResult.error.message);
  }

  logger.info('Workspace deleted', { workspaceName });
  return ok({ deleted: true, workspace: workspaceName });
});

export { app as workspacesRouter };
