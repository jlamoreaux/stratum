import { Hono } from "hono";
import { getChange, listChanges } from "../storage/changes";
import { listEvalRuns } from "../storage/eval-runs";
import { getCommitLog, listFilesInRepo, readFileFromRepo } from "../storage/git-ops";
import { getProvenance } from "../storage/provenance";
import { getProject, listProjects, listWorkspaces } from "../storage/state";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { ChangeDetailPage } from "../ui/pages/change-detail";
import { ChangesPage } from "../ui/pages/changes";
import { HomePage } from "../ui/pages/home";
import { RepoPage } from "../ui/pages/repo";
import { WorkspacesPage } from "../ui/pages/workspaces";

const app = new Hono<{ Bindings: Env }>();

// Helper to get current user info
async function getCurrentUser(c: { get: (key: "userId") => string | undefined; env: { DB: D1Database } }): Promise<{ id: string; email: string } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const user = await getUser(c.env.DB, userId);
  return user ? { id: user.id, email: user.email } : null;
}

// GET / — Dashboard (list projects)
app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const [user, allProjects] = await Promise.all([
    getCurrentUser(c),
    listProjects(c.env.STATE),
  ]);
  const projects = filterReadableProjects(allProjects, userId, agentOwnerId);
  const view = projects.map((p) => ({
    name: p.name,
    remote: p.remote,
    createdAt: p.createdAt,
    visibility: p.visibility,
  }));
  return c.html(<HomePage projects={view} user={user} />);
});

// GET /p/:name — Repo view (files + commit log)
app.get("/p/:name", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const [user, project] = await Promise.all([
    getCurrentUser(c),
    getProject(c.env.STATE, name),
  ]);
  if (!project) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  let files: string[] = [];
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];
  let readme: string | null = null;

  try {
    [files, log] = await Promise.all([
      listFilesInRepo(project.remote, project.token),
      getCommitLog(project.remote, project.token, 20),
    ]);
    
    // Try to read README.md if it exists
    const readmePath = files.find(f => f.toLowerCase() === "readme.md");
    if (readmePath) {
      readme = await readFileFromRepo(project.remote, project.token, readmePath);
    }
  } catch {
    // Repo may be empty or unreachable — render with empty data
  }

  return c.html(
    <RepoPage
      project={{ name: project.name, remote: project.remote, createdAt: project.createdAt }}
      files={files}
      log={log}
      readme={readme}
      user={user}
    />,
  );
});

// GET /p/:name/changes — Changes list
app.get("/p/:name/changes", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const [user, project] = await Promise.all([
    getCurrentUser(c),
    getProject(c.env.STATE, name),
  ]);
  if (!project) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
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

  return c.html(<ChangesPage project={name} changes={view} user={user} />);
});

// GET /changes/:id — Change detail
app.get("/changes/:id", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const [user, change] = await Promise.all([
    getCurrentUser(c),
    getChange(c.env.DB, id),
  ]);
  if (!change) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Change '{id}' not found.</div>,
      404,
    );
  }

  // Check permission on the associated project
  const project = await getProject(c.env.STATE, change.project);
  if (!project || !canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this change.
      </div>,
      403,
    );
  }

  const [evalRuns, provenance] = await Promise.all([
    listEvalRuns(c.env.DB, id),
    getProvenance(c.env.DB, id),
  ]);

  return c.html(<ChangeDetailPage change={change} evalRuns={evalRuns} provenance={provenance} user={user} />);
});

// GET /p/:name/workspaces — Workspace list
app.get("/p/:name/workspaces", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const [user, project] = await Promise.all([
    getCurrentUser(c),
    getProject(c.env.STATE, name),
  ]);
  if (!project) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  const workspaces = await listWorkspaces(c.env.STATE, name);
  const view = workspaces.map((ws) => ({
    name: ws.name,
    parent: ws.parent,
    createdAt: ws.createdAt,
  }));

  return c.html(<WorkspacesPage project={name} workspaces={view} user={user} />);
});

export { app as uiRouter };
