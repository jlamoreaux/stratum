import type { Env, User } from "../types";
import { getArtifactsRepoName, getUserNamespace } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { deleteProject } from "./state";
import { getUser } from "./users";

/*
 * A personal project is keyed under its owner's username, in KV. A username
 * change must therefore refuse while any project exists, and project creation
 * must not land under a name its owner has just given up. The two operations
 * touch different stores, and KV listings are only eventually consistent, so
 * KV alone cannot order them. D1 can: creation records a claim here before it
 * writes KV, and the rename (renameUser) refuses in the same UPDATE when a
 * claim exists. Whichever of the two reaches D1 first wins, and the loser sees
 * it: a rename after a claim is refused; a claim after a rename is caught by
 * confirmOwnerNamespace, which re-reads the owner and withdraws the project.
 *
 * Claims outlive their projects: a username is fixed once its first project
 * exists, deleted or not, so an old namespace's URLs never resolve to someone
 * else. Only a project withdrawn during creation releases its claim.
 */

/** Record that `ownerId` is creating `namespace/slug`. Same owner re-creating a deleted slug simply refreshes the row. */
export async function claimNamespace(
  db: D1Database,
  claim: { ownerId: string; namespace: string; slug: string },
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        "INSERT OR REPLACE INTO namespace_claims (namespace, slug, owner_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(claim.namespace, claim.slug, claim.ownerId, new Date().toISOString())
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to record a namespace claim", error instanceof Error ? error : undefined, {
      ...claim,
    });
    return err(new AppError("Failed to record the project", "STORAGE_ERROR", 500, { ...claim }));
  }
}

/** Forget a claim whose project was withdrawn before it ever existed. */
export async function releaseNamespaceClaim(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("DELETE FROM namespace_claims WHERE namespace = ? AND slug = ?")
      .bind(namespace, slug)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error(
      "Failed to release a namespace claim",
      error instanceof Error ? error : undefined,
      {
        namespace,
        slug,
      },
    );
    return err(
      new AppError("Failed to release the claim", "STORAGE_ERROR", 500, { namespace, slug }),
    );
  }
}

/** Whether `ownerId` has ever created a project: the strongly consistent half of "may this username change". */
export async function ownerHasClaims(
  db: D1Database,
  ownerId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const row = await db
      .prepare("SELECT 1 AS present FROM namespace_claims WHERE owner_id = ? LIMIT 1")
      .bind(ownerId)
      .first<{ present: number }>();
    return ok(row !== null);
  } catch (error) {
    logger.error("Failed to read namespace claims", error instanceof Error ? error : undefined, {
      ownerId,
    });
    return err(new AppError("Failed to read namespace claims", "STORAGE_ERROR", 500, { ownerId }));
  }
}

/**
 * After a personal project has been written under `namespace`, confirm that
 * its owner still carries that username, and withdraw the project if not.
 *
 * This is the creation side of the ordering described at the top of the
 * file: the claim went into D1 before the KV write, so if the owner's name
 * has moved by now, the rename committed before the claim and this project is
 * under a namespace nobody holds. It is withdrawn (KV entry, backing
 * repository, claim) and the caller reports a conflict so the user retries
 * under the new name.
 *
 * Fails closed. An owner that cannot be re-read (after one retry) leaves the
 * project unconfirmed, and an unconfirmed project is withdrawn rather than
 * left where a rename may have stranded it: the project is seconds old and
 * its creator is at the keyboard, so a retry is cheap, whereas an orphan is
 * invisible to everyone. Org-owned projects are not subject to any of this:
 * an org's slug is its own.
 */
export async function confirmOwnerNamespace(
  env: Pick<Env, "DB" | "STATE" | "ARTIFACTS">,
  ownerId: string,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const owner = await readOwner(env.DB, ownerId, logger);
  if (owner === null) {
    logger.warn("Owner could not be re-read after creating a project; withdrawing it", {
      ownerId,
      namespace,
      slug,
    });
    const withdrawn = await withdraw(env, namespace, slug, logger);
    if (!withdrawn.success) return withdrawn;
    return err(
      new AppError(
        "Your account could not be confirmed after the project was created, so it was not kept. Try again.",
        "STORAGE_ERROR",
        500,
        { namespace, slug },
      ),
    );
  }
  if (getUserNamespace(owner.username) === namespace) return ok(undefined);

  logger.warn("Project withdrawn - the owner's username changed during creation", {
    ownerId,
    namespace,
    slug,
    current: owner.username,
  });
  const withdrawn = await withdraw(env, namespace, slug, logger);
  if (!withdrawn.success) return withdrawn;
  return err(
    new AppError(
      "Your username changed while the project was being created, so it was not kept. Try again.",
      "CONFLICT",
      409,
      { namespace, slug },
    ),
  );
}

/**
 * The owner row, with one retry: a single failed read must not decide a
 * project's fate. A read that rejects counts as a failure like one that
 * returns an error, so a thrown D1 error still reaches the withdrawal path.
 */
async function readOwner(db: D1Database, ownerId: string, logger: Logger): Promise<User | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await getUser(db, ownerId, logger);
      if (result.success) return result.data;
    } catch (error) {
      logger.warn("Owner read threw", {
        ownerId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/**
 * Remove the project entry, then its backing repository and its claim, in
 * that order: once the entry is gone the project is unreachable, and a
 * leftover repository is recovered by the "already exists" path on the next
 * create, whereas the reverse order could leave a reachable project with no
 * repository. The KV delete is retried once; an entry that still cannot be
 * removed stays reachable under a namespace its owner may not hold, so it is
 * logged at error level as an operator signal and reported as a server error,
 * with the repository and the claim left in place for it.
 */
async function withdraw(
  env: Pick<Env, "DB" | "STATE" | "ARTIFACTS">,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  let removed = await deleteProject(env.STATE, namespace, slug, logger);
  if (!removed.success) removed = await deleteProject(env.STATE, namespace, slug, logger);
  if (!removed.success) {
    logger.error(
      "Project could not be withdrawn and remains under a namespace its owner may not hold",
      removed.error,
      { namespace, slug },
    );
    return err(
      new AppError(
        "The project could not be withdrawn after its namespace changed. Contact support with its name.",
        "STORAGE_ERROR",
        500,
        { namespace, slug },
      ),
    );
  }
  try {
    await env.ARTIFACTS.delete(getArtifactsRepoName(namespace, slug));
  } catch (error) {
    logger.warn("Could not delete the backing repository of a withdrawn project", {
      namespace,
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // A claim left behind would fix a username for a project that never
  // existed; the release is best effort, and a leftover only errs on the safe side.
  await releaseNamespaceClaim(env.DB, namespace, slug, logger);
  return ok(undefined);
}
