import { Hono } from "hono";
import { getChange, listChanges } from "../storage/changes";
import { listEvalRuns } from "../storage/eval-runs";
import { getCommitLog, listFilesInRepo } from "../storage/git-ops";
import { getProvenance } from "../storage/provenance";
import { getProject, listProjects, listWorkspaces } from "../storage/state";
import type { Env } from "../types";
import { ChangeDetailPage } from "../ui/pages/change-detail";
import { ChangesPage } from "../ui/pages/changes";
import { HomePage } from "../ui/pages/home";
import { RepoPage } from "../ui/pages/repo";
import { WorkspacesPage } from "../ui/pages/workspaces";

const app = new Hono<{ Bindings: Env }>();

// GET /ui/ — Dashboard (list projects)
app.get("/", async (c) => {
  const projects = await listProjects(c.env.STATE);
  const view = projects.map((p) => ({
    name: p.name,
    remote: p.remote,
    createdAt: p.createdAt,
  }));
  return c.html(<HomePage projects={view} />);
});

// Alias: /ui/projects also shows dashboard
app.get("/projects", async (c) => {
  const projects = await listProjects(c.env.STATE);
  const view = projects.map((p) => ({
    name: p.name,
    remote: p.remote,
    createdAt: p.createdAt,
  }));
  return c.html(<HomePage projects={view} />);
});

// GET /ui/projects/:name — Repo view (files + commit log)
app.get("/projects/:name", async (c) => {
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  let files: string[] = [];
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];

  try {
    [files, log] = await Promise.all([
      listFilesInRepo(project.remote, project.token),
      getCommitLog(project.remote, project.token, 20),
    ]);
  } catch {
    // Repo may be empty or unreachable — render with empty data
  }

  return c.html(
    <RepoPage
      project={{ name: project.name, remote: project.remote, createdAt: project.createdAt }}
      files={files}
      log={log}
    />,
  );
});

// GET /ui/projects/:name/changes — Changes list
app.get("/projects/:name/changes", async (c) => {
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  const changes = await listChanges(c.env.DB, name);
  const view = changes.map((ch) => {
    const entry: {
      id: string;
      workspace: string;
      status: string;
      evalScore?: number;
      evalPassed?: boolean;
      createdAt: string;
    } = { id: ch.id, workspace: ch.workspace, status: ch.status, createdAt: ch.createdAt };
    if (ch.evalScore !== undefined) entry.evalScore = ch.evalScore;
    if (ch.evalPassed !== undefined) entry.evalPassed = ch.evalPassed;
    return entry;
  });

  return c.html(<ChangesPage project={name} changes={view} />);
});

// GET /ui/changes/:id — Change detail
app.get("/changes/:id", async (c) => {
  const { id } = c.req.param();
  const change = await getChange(c.env.DB, id);
  if (!change) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Change '{id}' not found.</div>,
      404,
    );
  }

  const [evalRuns, provenance] = await Promise.all([
    listEvalRuns(c.env.DB, id),
    getProvenance(c.env.DB, id),
  ]);

  return c.html(<ChangeDetailPage change={change} evalRuns={evalRuns} provenance={provenance} />);
});

// GET /ui/projects/:name/workspaces — Workspace list
app.get("/projects/:name/workspaces", async (c) => {
  const { name } = c.req.param();
  const project = await getProject(c.env.STATE, name);
  if (!project) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  const workspaces = await listWorkspaces(c.env.STATE, name);
  const view = workspaces.map((ws) => ({
    name: ws.name,
    parent: ws.parent,
    createdAt: ws.createdAt,
  }));

  return c.html(<WorkspacesPage project={name} workspaces={view} />);
});

export { app as uiRouter };
