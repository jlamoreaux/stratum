import type { Env } from "../types";
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
 * Org-owned projects are not subject to this: an org's slug is its own.
 */
export async function confirmOwnerNamespace(
  env: Pick<Env, "DB" | "STATE" | "ARTIFACTS">,
  ownerId: string,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const owner = await getUser(env.DB, ownerId, logger);
  if (!owner.success) {
    // The project is written and the owner row unreadable. Destroying a valid
    // project over a transient read would be the worse outcome, so keep it and
    // leave a trace; a rename in this exact instant is the far rarer event.
    logger.warn("Could not re-read the owner after creating a project", {
      ownerId,
      namespace,
      slug,
    });
    return ok(undefined);
  }
  if (getUserNamespace(owner.data.username) === namespace) return ok(undefined);

  const removed = await deleteProject(env.STATE, namespace, slug, logger);
  // Best effort: the backing repository was named for the old namespace too.
  // A leftover is recovered by the "already exists" path on the next create.
  try {
    await env.ARTIFACTS.delete(getArtifactsRepoName(namespace, slug));
  } catch (error) {
    logger.warn("Could not delete the backing repository of a withdrawn project", {
      namespace,
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.warn("Project withdrawn - the owner's username changed during creation", {
    ownerId,
    namespace,
    slug,
    current: owner.data.username,
    removed: removed.success,
  });
  return err(
    new AppError(
      "Your username changed while the project was being created, so it was not kept. Try again.",
      "CONFLICT",
      409,
      { namespace, slug },
    ),
  );
}
