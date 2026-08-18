import { Hono } from "hono";
import { artifactsRepoNameFromRemote, importFromGitHub, syncFromGitHub } from "../storage/git-ops";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import { listProjects } from "../storage/state";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

// The former unauthenticated `POST /projects/:name/sync` handler was removed: it
// let any caller repoint a project's githubUrl and trigger a destructive
// re-import with no auth check. The authenticated, namespaced equivalent lives
// in sync-management.ts. This router is kept as an empty mount so the
// co-located syncAllProjects cron helper below keeps its import path.
const app = new Hono<{ Bindings: Env }>();

export { app as syncRouter };

export async function syncAllProjects(env: Env): Promise<{ synced: number; failed: number }> {
  const logger = createLogger({ operation: "syncAllProjects" });

  const projectsResult = await listProjects(env.STATE, logger);
  if (!projectsResult.success) {
    logger.error("Failed to list projects for sync", projectsResult.error);
    return { synced: 0, failed: 0 };
  }

  const projects = projectsResult.data;
  let synced = 0;
  let failed = 0;

  for (const project of projects) {
    if (!project.githubUrl) continue;

    const projectLogger = logger.child({ projectName: project.name, githubUrl: project.githubUrl });

    try {
      projectLogger.info("Syncing project");

      // #190: existing projects sync INCREMENTALLY into their Artifacts repo —
      // never delete-and-re-import, which destroyed Stratum-native commits and
      // orphaned workspace forks. Only projects without a recorded Artifacts
      // remote (no repo to preserve) still take the legacy import path.
      let succeeded: boolean;
      let syncedRemote = project.remote;
      let syncError: Error | undefined;
      if (artifactsRepoNameFromRemote(project.remote) !== null) {
        const result = await syncFromGitHub(
          env.ARTIFACTS,
          project.remote,
          project.githubUrl,
          projectLogger,
          project.sourceDefaultBranch ?? project.githubDefaultBranch ?? "main",
        );
        succeeded = result.success;
        if (!result.success) syncError = result.error;
      } else {
        const result = await importFromGitHub(
          env.ARTIFACTS,
          project.name,
          project.githubUrl,
          projectLogger,
        );
        succeeded = result.success;
        if (result.success) {
          syncedRemote = result.data.remote;
        } else {
          syncError = result.error;
        }
      }

      if (succeeded) {
        synced++;
        projectLogger.info("Project synced successfully");
        // NOTE: writeSnapshotFromRepo must be called after any new sync trigger added here
        await writeSnapshotFromRepo(
          env.STATE,
          env.ARTIFACTS,
          {
            remote: syncedRemote,
            namespace: project.namespace,
            slug: project.slug,
          },
          projectLogger,
        );
      } else {
        failed++;
        projectLogger.error("Project sync failed", syncError);
      }
    } catch (error) {
      failed++;
      projectLogger.error(
        "Project sync threw exception",
        error instanceof Error ? error : undefined,
      );
    }
  }

  logger.info("Batch sync completed", { synced, failed, total: projects.length });
  return { synced, failed };
}
