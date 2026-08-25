/**
 * Where the sync-vs-import decision lives.
 *
 * Deliberately its own module rather than a function inside `git-ops`: the
 * three call sites' tests mock `syncFromGitHub`/`importFromGitHub` as module
 * exports, and a helper defined alongside them would call the real
 * implementations through module-local bindings, bypassing those mocks.
 */
import { artifactsRepoNameFromRemote, importFromGitHub, syncFromGitHub } from "../storage/git-ops";
import type { ArtifactsNamespace } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";

/** What a sync attempt resolved to: the remote to record, plus any failure. */
export interface SyncOrImportOutcome {
  /**
   * The remote to persist. Unchanged on the incremental path — that is the
   * point of #190, since workspace forks are attached to it — and a NEW repo
   * only when the legacy fallback import ran.
   */
  remote: string;
  error?: AppError;
}

/**
 * Route one project to an incremental sync or the legacy full import.
 *
 * All three sync entry points (the import-queue consumer, the daily cron, and
 * the queue-less route fallback) have to make the same call, and each one
 * getting it independently right is how #190's destructive re-import survived
 * as long as it did. The rule lives here once: a project with a parseable
 * Artifacts remote syncs INCREMENTALLY into its existing repo and keeps that
 * remote; only a project without one — meaning the initial import never
 * finished, so no forks can exist to orphan — may take the import path.
 *
 * `depth` applies to the fallback import only; the incremental fetch uses its
 * own SYNC_FETCH_DEPTH.
 */
export async function syncOrImportProject(
  artifacts: ArtifactsNamespace,
  opts: {
    remote: string;
    artifactsRepoName: string;
    sourceUrl: string;
    branch?: string;
    depth?: number;
    logContext?: Record<string, unknown>;
  },
  logger: Logger,
): Promise<SyncOrImportOutcome> {
  const { remote, artifactsRepoName, sourceUrl, branch, depth, logContext } = opts;

  if (artifactsRepoNameFromRemote(remote) !== null) {
    const syncResult = await syncFromGitHub(artifacts, remote, sourceUrl, logger, branch);
    return syncResult.success ? { remote } : { remote, error: syncResult.error };
  }

  logger.warn("Project has no Artifacts remote — falling back to full import", logContext ?? {});
  const importResult = await importFromGitHub(
    artifacts,
    artifactsRepoName,
    sourceUrl,
    logger,
    branch,
    depth,
  );
  return importResult.success
    ? { remote: importResult.data.remote }
    : { remote, error: importResult.error };
}
