import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

/**
 * Returns a human-readable error when the RepoDO / R2 fast-path config is
 * incoherent, else null.
 *
 * Flipping `REPO_DO_ENABLED` to "true" without binding the `REPO_OBJECTS` R2
 * bucket is a silent footgun (ADR 004): workspace staging no-ops and the merge
 * fast path throws "REPO_OBJECTS not bound" only at merge time. Production binds
 * no REPO_OBJECTS today, so enabling the flag there without adding the binding
 * would break merges — this makes that misconfiguration detectable up front.
 */
export function repoDoConfigError(
  env: Pick<Env, "REPO_DO_ENABLED" | "REPO_OBJECTS">,
): string | null {
  if (env.REPO_DO_ENABLED === "true" && !env.REPO_OBJECTS) {
    return (
      "REPO_DO_ENABLED is 'true' but the REPO_OBJECTS R2 bucket is not bound — " +
      "the merge fast path will throw at merge time and workspace staging silently " +
      "no-ops. Add the [[env.<env>.r2_buckets]] REPO_OBJECTS binding or set " +
      "REPO_DO_ENABLED='false'."
    );
  }
  return null;
}

// Log the config problem at most once per isolate rather than on every request.
let hasLoggedConfigError = false;

/**
 * Surfaces an incoherent RepoDO/R2 configuration loudly in Workers Logs on the
 * first request after a bad deploy, instead of only when a later merge throws.
 * Non-fatal: reads and the UI still work without the bucket, so we log rather
 * than reject the request.
 */
export const configGuardMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!hasLoggedConfigError) {
    const problem = repoDoConfigError(c.env);
    if (problem) {
      hasLoggedConfigError = true;
      createLogger({ component: "config-guard" }).error(problem);
    }
  }
  await next();
};
