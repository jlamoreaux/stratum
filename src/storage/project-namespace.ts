import type { Env, User } from "../types";
import { getArtifactsRepoName, getUserNamespace } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { deleteProject } from "./state";
import { getUser } from "./users";

/**
 * After a personal project has been written under `namespace`, confirm that
 * its owner still carries that username, and withdraw the project if not.
 *
 * Project creation reads the owner's username at the start of the request
 * (auth puts it on the context) and writes KV at the end, which for an
 * import can be seconds later. A username change lists KV and then writes
 * D1. Neither store can see the other's write in flight, so each side looks
 * again after its own write: the rename re-lists the old namespace and
 * reverts if a project appeared, and creation calls this to re-read the
 * owner and withdraw the entry if the name moved. Any interleaving that
 * would leave a project under a namespace nobody owns is caught by one of
 * the two, because D1 reads are strongly consistent. What neither can close
 * is KV's eventual consistency across edges on the rename's listing.
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

/** The owner row, with one retry: a single failed read must not decide a project's fate. */
async function readOwner(db: D1Database, ownerId: string, logger: Logger): Promise<User | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await getUser(db, ownerId, logger);
    if (result.success) return result.data;
  }
  return null;
}

/**
 * Remove the project entry, then its backing repository, in that order: once
 * the entry is gone the project is unreachable, and a leftover repository is
 * recovered by the "already exists" path on the next create, whereas the
 * reverse order could leave a reachable project with no repository. The KV
 * delete is retried once; an entry that still cannot be removed stays
 * reachable under a namespace its owner may not hold, so it is logged at
 * error level as an operator signal and reported as a server error, with the
 * repository left in place for it.
 */
async function withdraw(
  env: Pick<Env, "STATE" | "ARTIFACTS">,
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
  return ok(undefined);
}
