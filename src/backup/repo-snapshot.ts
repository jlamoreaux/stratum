import git from "isomorphic-git";
import { type NodeFS, cloneRepo, extractTreeObjects, freshRepoToken } from "../storage/git-ops";
import { packObjects } from "../storage/object-loader";
import type { Env, ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export const DEFAULT_MAX_BACKUP_BYTES = 128 * 1024 * 1024;

/** A tag ref captured in a snapshot: refs/tags/<name> → oid (the annotated tag
 * object for annotated tags, the target itself for lightweight ones). */
export interface TagRefRecord {
  name: string;
  oid: string;
}

export interface RepoManifest {
  projectId: string;
  /** Full identity so restore can recreate the correctly-named Artifacts repo
   * without depending on KV (which is backed up separately). */
  project: ProjectEntry;
  tipSha: string;
  objectCount: number;
  byteCount: number;
  capturedAt: string;
  /** Tag refs captured with the pack (#182). OPTIONAL for backward
   * compatibility: manifests written before tag support omit it, and restore
   * must treat a missing field as "no tags". */
  tags?: TagRefRecord[];
}

export interface RepoSnapshot {
  pack: Uint8Array;
  manifest: RepoManifest;
}

export type SnapshotResult =
  | { status: "ok"; snapshot: RepoSnapshot }
  | { status: "skipped"; reason: string };

interface WalkResult {
  objects: { oid: string; bytes: Uint8Array }[];
  tipSha: string;
  tags: TagRefRecord[];
}

/**
 * Collects all objects reachable from the repository tip and tags.
 *
 * @param fs - The filesystem containing the cloned repository
 * @param dir - The repository directory
 * @param maxBytes - Maximum total size of collected objects
 * @returns A result containing the walked objects and tag references, an empty or oversized status, or a Git error
 */
export async function walkRepoObjects(
  fs: NodeFS,
  dir: string,
  maxBytes: number,
  logger: Logger,
): Promise<Result<WalkResult | { tooLarge: true } | { empty: true }, AppError>> {
  // A repo with no commits has no HEAD ref, so git.log throws a NotFoundError:
  // treat that as an empty repo (skip). Any OTHER error is a real read failure
  // (transient or a corrupt object) and must surface as a failure, not be
  // silently mislabeled "empty" — which would advance the coverage cursor and
  // never retry the repo.
  let log: Awaited<ReturnType<typeof git.log>>;
  try {
    log = await git.log({ fs, dir, depth: -1 });
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") {
      logger.debug("Repo has no commits; skipping as empty", { dir });
      return ok({ empty: true });
    }
    logger.error("Failed to read repo log", error instanceof Error ? error : undefined, { dir });
    return err(new AppError("Failed to read repo log", "GIT_ERROR", 500));
  }
  if (log.length === 0) return ok({ empty: true });

  try {
    const tipSha = log[0]?.oid;
    if (!tipSha) return ok({ empty: true });

    const seen = new Set<string>();
    const objects: { oid: string; bytes: Uint8Array }[] = [];
    let byteCount = 0;

    const add = (oid: string, bytes: Uint8Array): boolean => {
      if (seen.has(oid)) return true;
      seen.add(oid);
      objects.push({ oid, bytes });
      byteCount += bytes.byteLength;
      return byteCount <= maxBytes;
    };

    /** Add one object's wrapped bytes; false = over budget. */
    const addWrapped = async (oid: string): Promise<boolean> => {
      const obj = await git.readObject({ fs, dir, oid, format: "wrapped" });
      return add(oid, obj.object as Uint8Array);
    };

    /** Add a commit's full history (commits + trees + blobs); false = over budget.
     * `prefetched` lets the HEAD traversal reuse the log it already read. */
    const addCommitHistory = async (
      tip: string,
      prefetched?: Awaited<ReturnType<typeof git.log>>,
    ): Promise<boolean> => {
      const entries = prefetched ?? (await git.log({ fs, dir, ref: tip, depth: -1 }));
      for (const entry of entries) {
        if (seen.has(entry.oid)) continue;
        if (!(await addWrapped(entry.oid))) return false;
        for (const o of await extractTreeObjects(fs, dir, entry.commit.tree)) {
          if (!add(o.oid, o.bytes)) return false;
        }
      }
      return true;
    };

    if (!(await addCommitHistory(tipSha, log))) return ok({ tooLarge: true });

    // Tags: walk every refs/tags/* tip too. A tag whose objects are missing
    // locally (e.g. the clone could not deliver them) is SKIPPED with a warning
    // rather than recorded — recording it would restore a dangling ref, and the
    // pack must stay closed under reachability.
    const tags: TagRefRecord[] = [];
    let tagNames: string[] = [];
    try {
      tagNames = await git.listTags({ fs, dir });
    } catch (error) {
      // No tags is normal; an unreadable ref store is not. Log so the two are
      // distinguishable, then back up the repo without tags rather than failing.
      logger.warn("Failed to list tags for snapshot; backing up without tag refs", {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
      tagNames = [];
    }
    for (const name of [...tagNames].sort()) {
      let refOid: string;
      try {
        refOid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` });
      } catch {
        logger.warn("Backup: skipping unreadable tag ref", { name });
        continue;
      }
      try {
        // Peel annotated tags (adding each tag object in the chain) down to the
        // target, then close the pack over the target's reachability. A
        // visited-oid set (not a fixed hop cap) so a valid, unusually long
        // tag-of-tag chain still snapshots correctly instead of being dropped.
        let current = refOid;
        let target: string | null = null;
        const visited = new Set<string>();
        while (target === null) {
          if (visited.has(current)) throw new Error(`tag ${name}: cyclic tag chain`);
          visited.add(current);
          const parsed = await git.readObject({ fs, dir, oid: current });
          if (parsed.type === "tag") {
            if (!(await addWrapped(current))) return ok({ tooLarge: true });
            current = (parsed.object as { object: string }).object;
          } else {
            target = current;
          }
        }
        const targetType = (await git.readObject({ fs, dir, oid: target })).type;
        if (targetType === "commit") {
          if (!(await addCommitHistory(target))) return ok({ tooLarge: true });
        } else if (targetType === "tree") {
          for (const o of await extractTreeObjects(fs, dir, target)) {
            if (!add(o.oid, o.bytes)) return ok({ tooLarge: true });
          }
        } else if (!(await addWrapped(target))) {
          return ok({ tooLarge: true });
        }
        tags.push({ name, oid: refOid });
      } catch (error) {
        logger.warn("Backup: skipping unresolvable tag", {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug("Walked repo objects", {
      tipSha,
      objectCount: objects.length,
      byteCount,
      tagCount: tags.length,
    });
    return ok({ objects, tipSha, tags });
  } catch (error) {
    logger.error("Failed to walk repo objects", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to walk repo objects", "GIT_ERROR", 500));
  }
}

/**
 * Builds a repository snapshot from walked objects and project metadata.
 *
 * @param project - The project associated with the snapshot
 * @param walk - The collected repository objects, tip commit, and tag references
 * @param capturedAt - The snapshot capture timestamp
 * @returns A packed repository snapshot with its manifest
 */
export function buildSnapshot(
  project: ProjectEntry,
  walk: WalkResult,
  capturedAt: string,
): RepoSnapshot {
  const byteCount = walk.objects.reduce((n, o) => n + o.bytes.byteLength, 0);
  return {
    pack: packObjects(walk.objects),
    manifest: {
      projectId: project.id,
      project,
      tipSha: walk.tipSha,
      objectCount: walk.objects.length,
      byteCount,
      capturedAt,
      tags: walk.tags,
    },
  };
}

/**
 * Creates a full-history repository snapshot with its manifest and tag references.
 *
 * @param project - The project whose repository is being snapshotted
 * @param capturedAt - Timestamp recorded in the snapshot manifest
 * @returns A successful snapshot, a skipped result for empty or oversized repositories, or an application error
 */
export async function snapshotRepo(
  env: Env,
  project: ProjectEntry,
  capturedAt: string,
  logger: Logger,
): Promise<Result<SnapshotResult, AppError>> {
  const parsed = env.MAX_BACKUP_BYTES ? Number(env.MAX_BACKUP_BYTES) : DEFAULT_MAX_BACKUP_BYTES;
  // A NaN cap makes every `byteCount <= maxBytes` check false, silently skipping
  // every repo as "too large"; fall back to the default on garbage input.
  const maxBytes = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_BACKUP_BYTES;

  const token = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  if (!token.success) return err(token.error);

  // Full history: a shallow clone would drop ancestors past depth 50, yielding a
  // pack that can't restore the repo to its true tip. Tags are fetched too
  // (#182) so refs/tags/* and their objects land in the snapshot.
  //
  // Known trade-off: `maxBytes` is enforced by walkRepoObjects AFTER the clone,
  // so an over-cap repo is loaded into MemoryFS before it is skipped. This is
  // inherent to full-history backup — restorability requires the whole history,
  // and the smart-HTTP fetch (isomorphic-git) gives no way to know a repo's size
  // before fetching it, so there is no correctness-preserving pre-clone guard. A
  // bounded/streaming fetch that aborts mid-clone would be the real fix (tracked
  // as a follow-up); for now MAX_BACKUP_BYTES should be set well under the
  // Worker's memory budget so a normal repo never approaches it.
  const clone = await cloneRepo(project.remote, token.data, logger, undefined, {
    fullHistory: true,
    includeTags: true,
  });
  if (!clone.success) return err(clone.error);

  const walk = await walkRepoObjects(clone.data.fs, clone.data.dir, maxBytes, logger);
  if (!walk.success) return err(walk.error);
  if ("empty" in walk.data) return ok({ status: "skipped", reason: "empty" });
  if ("tooLarge" in walk.data) return ok({ status: "skipped", reason: "too large" });

  return ok({ status: "ok", snapshot: buildSnapshot(project, walk.data, capturedAt) });
}
