import { Hono } from "hono";
import { getChange, listChanges } from "../storage/changes";
import { getImportProgress } from "../storage/imports";
import { listEvalRuns } from "../storage/eval-runs";
import { getCommitLog, listFilesInRepo, readFileFromRepo } from "../storage/git-ops";
import { getProvenance } from "../storage/provenance";
import { getProject, getProjectByPath, listProjects, listWorkspaces } from "../storage/state";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { createLogger } from "../utils/logger";
import { ChangeDetailPage } from "../ui/pages/change-detail";
import { ChangesPage } from "../ui/pages/changes";
import { HomePage } from "../ui/pages/home";
import { NewProjectPage } from "../ui/pages/new-project";
import { RepoPage } from "../ui/pages/repo";
import { WorkspacesPage } from "../ui/pages/workspaces";
import { ImportProgressCard } from "../ui/components/import-progress";

const app = new Hono<{ Bindings: Env }>();

// Helper to get current user info
async function getCurrentUser(c: { get: (key: "userId") => string | undefined; env: { DB: D1Database } }, logger: ReturnType<typeof createLogger>): Promise<{ id: string; email: string; username: string } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) return null;
  
  const user = result.data;
  // Generate username from email if missing (for users created before migration)
  const username = user.username || user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  
  return { id: user.id, email: user.email, username };
}

// GET / — Dashboard (list projects)
app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
  });

  const [userResult, allProjectsResult] = await Promise.all([
    getCurrentUser(c, logger),
    listProjects(c.env.STATE, logger),
  ]);

  if (!allProjectsResult.success) {
    logger.error("Failed to list projects", allProjectsResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading projects. Please try again.
      </div>,
      500,
    );
  }

  const user = userResult;
  const projects = filterReadableProjects(allProjectsResult.data, userId, agentOwnerId);
  const view = projects.map((p) => ({
    name: p.name,
    remote: p.remote,
    createdAt: p.createdAt,
    visibility: p.visibility,
  }));

  logger.debug("Rendering home page", { projectCount: view.length });
  return c.html(<HomePage projects={view} user={user} />);
});

// GET /new — New project form
app.get("/new", async (c) => {
  const logger = createLogger({
    path: c.req.path,
    userId: c.get("userId"),
  });

  const user = await getCurrentUser(c, logger);
  if (!user) {
    logger.debug("User not authenticated, redirecting to login");
    return c.redirect("/auth/email");
  }

  logger.debug("Rendering new project page");
  return c.html(<NewProjectPage user={user} />);
});

// GET /p/:name — Repo view (files + commit log) - DEPRECATED: Use /:namespace/:slug
app.get("/p/:name", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found", { name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project", { name, userId });
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
  let importProgress = null;

  // Check for active import
  const importResult = await getImportProgress(c.env.STATE, project.namespace || "@legacy", project.slug || project.name, logger);
  if (importResult.success && importResult.data) {
    importProgress = importResult.data;
  }

  try {
    const [filesResult, logResult] = await Promise.all([
      listFilesInRepo(project.remote, project.token, logger),
      getCommitLog(project.remote, project.token, 20, logger),
    ]);
    
    if (filesResult.success) {
      files = filesResult.data;
    } else {
      logger.warn("Failed to list files in repo", { error: filesResult.error });
    }
    
    if (logResult.success) {
      log = logResult.data;
    } else {
      logger.warn("Failed to get commit log", { error: logResult.error });
    }
    
    // Try to read README.md if it exists
    const readmePath = files.find(f => f.toLowerCase() === "readme.md");
    if (readmePath) {
      const readmeResult = await readFileFromRepo(project.remote, project.token, readmePath, logger);
      if (readmeResult.success) {
        readme = readmeResult.data;
      }
    }
  } catch (error) {
    // Repo may be empty or unreachable — render with empty data
    logger.warn("Error loading repo data", { error: error instanceof Error ? error.message : String(error) });
  }

  logger.debug("Rendering project page", { name, fileCount: files.length, hasImport: !!importProgress });
  return c.html(
    <RepoPage
      project={{ name: project.name, remote: project.remote, createdAt: project.createdAt }}
      files={files}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
    />,
  );
});

// GET /@:namespace/:slug — Repo view with namespace (NEW FORMAT)
app.get("/@:namespace/:slug", async (c) => {
  const { namespace, slug } = c.req.param();
  const fullNamespace = `@${namespace}`;
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: `${fullNamespace}/${slug}`,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, fullNamespace, slug, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found", { namespace: fullNamespace, slug });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{fullNamespace}/{slug}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project", { namespace: fullNamespace, slug, userId });
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
  let importProgress = null;

  // Check for active import
  const importResult = await getImportProgress(c.env.STATE, fullNamespace, slug, logger);
  if (importResult.success && importResult.data) {
    importProgress = importResult.data;
  }

  try {
    const [filesResult, logResult] = await Promise.all([
      listFilesInRepo(project.remote, project.token, logger),
      getCommitLog(project.remote, project.token, 20, logger),
    ]);
    
    if (filesResult.success) {
      files = filesResult.data;
    } else {
      logger.warn("Failed to list files in repo", { error: filesResult.error });
    }
    
    if (logResult.success) {
      log = logResult.data;
    } else {
      logger.warn("Failed to get commit log", { error: logResult.error });
    }
    
    // Try to read README.md if it exists
    const readmePath = files.find(f => f.toLowerCase() === "readme.md");
    if (readmePath) {
      const readmeResult = await readFileFromRepo(project.remote, project.token, readmePath, logger);
      if (readmeResult.success) {
        readme = readmeResult.data;
      }
    }
  } catch (error) {
    // Repo may be empty or unreachable — render with empty data
    logger.warn("Error loading repo data", { error: error instanceof Error ? error.message : String(error) });
  }

  logger.debug("Rendering project page", { namespace: fullNamespace, slug, fileCount: files.length, hasImport: !!importProgress });
  return c.html(
    <RepoPage
      project={{ name: project.name, remote: project.remote, createdAt: project.createdAt }}
      files={files}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
    />,
  );
});

// GET /p/:name/changes — Changes list
app.get("/p/:name/changes", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found for changes", { name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project changes", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  const changesResult = await listChanges(c.env.DB, name, logger);
  if (!changesResult.success) {
    logger.error("Failed to list changes", changesResult.error, { projectName: name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading changes. Please try again.
      </div>,
      500,
    );
  }

  const view = changesResult.data.map((ch) => {
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

  logger.debug("Rendering changes page", { name, changeCount: view.length });
  return c.html(<ChangesPage project={name} changes={view} user={userResult} />);
});

// GET /changes/:id — Change detail
app.get("/changes/:id", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    changeId: id,
  });

  const [userResult, changeResult] = await Promise.all([
    getCurrentUser(c, logger),
    getChange(c.env.DB, id, logger),
  ]);

  if (!changeResult.success) {
    logger.warn("Change not found", { id });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Change '{id}' not found.</div>,
      404,
    );
  }
  const change = changeResult.data;

  // Check permission on the associated project
  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success || !canReadProject(projectResult.data, userId, agentOwnerId)) {
    logger.warn("Access denied to change", { changeId: id, project: change.project, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this change.
      </div>,
      403,
    );
  }

  const [evalRunsResult, provenanceResult] = await Promise.all([
    listEvalRuns(c.env.DB, id, logger),
    getProvenance(c.env.DB, id, logger),
  ]);

  if (!evalRunsResult.success) {
    logger.error("Failed to list eval runs", evalRunsResult.error, { changeId: id });
  }
  if (!provenanceResult.success) {
    logger.error("Failed to get provenance", provenanceResult.error, { changeId: id });
  }

  logger.debug("Rendering change detail page", { changeId: id, project: change.project });
  return c.html(<ChangeDetailPage 
    change={change} 
    evalRuns={evalRunsResult.success ? evalRunsResult.data : []} 
    provenance={provenanceResult.success ? provenanceResult.data : null} 
    user={userResult} 
  />);
});

// GET /p/:name/workspaces — Workspace list
app.get("/p/:name/workspaces", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found for workspaces", { name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project workspaces", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  const workspacesResult = await listWorkspaces(c.env.STATE, name, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error, { projectName: name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading workspaces. Please try again.
      </div>,
      500,
    );
  }

  const view = workspacesResult.data.map((ws) => ({
    name: ws.name,
    parent: ws.parent,
    createdAt: ws.createdAt,
  }));

  logger.debug("Rendering workspaces page", { name, workspaceCount: view.length });
  return c.html(<WorkspacesPage project={name} workspaces={view} user={userResult} />);
});

export { app as uiRouter };
