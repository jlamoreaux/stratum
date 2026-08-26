import type { KVNamespace } from "@cloudflare/workers-types";
import type { ArtifactsNamespace } from "../types";
import type { Logger } from "../utils/logger";
import { updateImportProgress } from "./imports";
import { writeSnapshotFromRepo } from "./repo-snapshot";

/**
 * The tail shared by both import paths: write the repo snapshot, then report the
 * file count it produced.
 *
 * Both steps must happen *before* the import status flips to a terminal value.
 * The progress stream (GET /projects/:ns/:slug/import/stream in
 * src/routes/projects.ts) closes itself on a terminal status and the browser
 * closes its EventSource with it, so a count written after the flip reaches
 * nobody. That ordering is the whole reason this exists as one function rather
 * than two calls each caller sequences for itself.
 *
 * `writeSnapshotFromRepo` handles its own failures and returns null, so nothing
 * here can fail an import that already succeeded — the cost of a failed snapshot
 * is a completed import whose file counts stay at 0.
 */
export async function finalizeImportSnapshot(
  env: { STATE: KVNamespace; ARTIFACTS: ArtifactsNamespace; DB: D1Database },
  project: { remote: string; namespace: string; slug: string },
  logger: Logger,
): Promise<void> {
  const snapshot = await writeSnapshotFromRepo(
    env.STATE,
    env.ARTIFACTS,
    { remote: project.remote, namespace: project.namespace, slug: project.slug },
    logger,
  );
  if (!snapshot) return;
  await updateImportProgress(
    env.DB,
    project.namespace,
    project.slug,
    { progress: { processedFiles: snapshot.fileCount, totalFiles: snapshot.fileCount } },
    logger,
  );
}
