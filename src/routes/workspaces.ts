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
import { badRequest, created, notFound, ok, unauthorized } from "../utils/response";
import { isStringRecord, isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

app.post("/projects/:name/workspaces", async (c) => {
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: projectName } = c.req.param();
  const project = await getProject(c.env.STATE, projectName);
  if (!project) return notFound("Project", projectName);

  const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  const workspaceName = isValidSlug(body.name) ? body.name : `ws-${Date.now()}`;

  const projectRepo = await c.env.ARTIFACTS.get(projectName);
  const forked = await projectRepo.fork(workspaceName);

  await setWorkspace(c.env.STATE, {
    name: workspaceName,
    remote: forked.remote,
    token: forked.token,
    parent: projectName,
    createdAt: new Date().toISOString(),
  });

  return created({ workspace: workspaceName, remote: forked.remote, parent: projectName });
});

app.get("/projects/:name/workspaces", async (c) => {
  const { name: projectName } = c.req.param();
  const project = await getProject(c.env.STATE, projectName);
  if (!project) return notFound("Project", projectName);

  const workspaces = await listWorkspaces(c.env.STATE, projectName);
  return ok({
    project: projectName,
    workspaces: workspaces.map(({ name, parent, createdAt }) => ({ name, parent, createdAt })),
  });
});

app.post("/:name/commit", async (c) => {
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();
  const workspace = await getWorkspace(c.env.STATE, workspaceName);
  if (!workspace) return notFound("Workspace", workspaceName);

  const body = await c.req.json<{ files?: unknown; message?: unknown }>();
  if (!isStringRecord(body.files))
    return badRequest("files must be an object of string paths to string contents");
  if (typeof body.message !== "string" || !body.message.trim())
    return badRequest("message is required");

  const { fs, dir } = await cloneRepo(workspace.remote, workspace.token);
  const sha = await commitAndPush(
    fs,
    dir,
    workspace.remote,
    workspace.token,
    body.files,
    body.message,
  );

  return ok({ workspace: workspaceName, commit: sha, filesChanged: Object.keys(body.files) });
});

app.post("/:name/merge", (c) => {
  return c.json(
    { error: "This endpoint is deprecated. Use POST /api/projects/:name/changes instead." },
    410,
  );
});

app.delete("/:name", async (c) => {
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();
  const workspace = await getWorkspace(c.env.STATE, workspaceName);
  if (!workspace) return notFound("Workspace", workspaceName);

  await c.env.ARTIFACTS.delete(workspaceName).catch((err: unknown) => {
    console.warn(`[workspaces] Failed to delete Artifacts repo "${workspaceName}":`, err);
  });
  await deleteWorkspace(c.env.STATE, workspaceName);

  return ok({ deleted: true, workspace: workspaceName });
});

export { app as workspacesRouter };
