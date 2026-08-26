import { getUser } from "../storage/users";
import type { Env } from "../types";
import { constantTimeEqual } from "./crypto";
import type { Logger } from "./logger";

/** Which credential authorized an admin request. */
export type AdminAuthSource = "api-key" | "user";

export interface AdminAuthResult {
  authorized: boolean;
  /** Present only when `authorized` is true: which branch granted access. */
  via?: AdminAuthSource;
}

/**
 * Resolves *whether* the caller is an administrator and, when so, *which*
 * credential granted it. Two paths, checked in this order:
 * - service-to-service: X-Admin-API-Key matching the ADMIN_API_KEY secret
 * - human: an authenticated user whose email matches the ADMIN_EMAIL secret
 *
 * The API-key branch is authoritative on its own and short-circuits before
 * ever looking at `userId` -- a request carrying a valid admin key is a
 * system action regardless of which (if any) user session happens to be
 * attached to it. Callers that need to attribute an action correctly (e.g.
 * an audit entry) should use `via` rather than assuming a present `userId`
 * means the user authorized the request.
 *
 * Fails closed when neither secret is configured.
 */
export async function resolveAdminAuth(
  env: Env,
  opts: { adminApiKeyHeader?: string; userId?: string },
  logger: Logger,
): Promise<AdminAuthResult> {
  if (
    opts.adminApiKeyHeader &&
    env.ADMIN_API_KEY &&
    constantTimeEqual(opts.adminApiKeyHeader, env.ADMIN_API_KEY)
  ) {
    return { authorized: true, via: "api-key" };
  }

  if (opts.userId && env.ADMIN_EMAIL) {
    const userResult = await getUser(env.DB, opts.userId, logger);
    if (userResult.success && userResult.data.email === env.ADMIN_EMAIL) {
      return { authorized: true, via: "user" };
    }
  }

  return { authorized: false };
}

/**
 * Whether the caller is an administrator. Thin boolean wrapper over
 * {@link resolveAdminAuth} for callers that only need the yes/no answer.
 */
export async function isAdminRequest(
  env: Env,
  opts: { adminApiKeyHeader?: string; userId?: string },
  logger: Logger,
): Promise<boolean> {
  const result = await resolveAdminAuth(env, opts, logger);
  return result.authorized;
}
