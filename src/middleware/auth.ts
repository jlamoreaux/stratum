import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { isGitHttpPath } from "../routes/git-http";
import { getAgentByToken } from "../storage/agents";
import { deleteSession, getSession } from "../storage/sessions";
import { getUser, getUserByToken } from "../storage/users";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";

declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
    username: string;
    agentId?: string;
    agentOwnerId?: string;
    /** How the caller authenticated — CSRF checks apply to "session" only. */
    authVia?: "token" | "session";
    /**
     * The caller's product-analytics preference (#257), read from the same
     * `users` row this middleware already loads. Absent for unauthenticated
     * callers, who have no preference to honor.
     */
    telemetryOptOut?: boolean;
    logger: Logger;
  }
}

function sanitizeToken(token: string): string {
  // Only show first 8 characters of token for logging
  if (token.length <= 12) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Resolve the caller's identity from an agent token, a user token, or a session
 * cookie, and populate the auth context the routes read.
 *
 * Every account lookup here fails CLOSED (#236, mirroring #229 in git-http):
 * the caller is authenticated only when the lookup succeeds AND returns a live
 * account. A lookup that errors, rejects, or finds no row is a 401, never a
 * pass — otherwise a transient D1 failure would authenticate an account the
 * deletion cascade is erasing.
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const requestId = crypto.randomUUID();
  const logger = createLogger({
    requestId,
    path: c.req.path,
    method: c.req.method,
  });

  c.set("logger", logger);

  // The git smart-HTTP router authenticates over HTTP Basic itself; let it own
  // the challenge instead of rejecting the non-Bearer header here.
  if (isGitHttpPath(c.req.path)) {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");

  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) {
      logger.warn("Auth failed - invalid Authorization header format", {
        path: c.req.path,
      });
      return c.json({ error: "Invalid token" }, 401);
    }

    const token = authHeader.slice(7);

    if (token.startsWith("stratum_user_")) {
      const userResult = await getUserByToken(c.env.DB, token, logger);
      if (!userResult.success) {
        logger.warn("Auth failed - invalid user token", {
          path: c.req.path,
          tokenHint: sanitizeToken(token),
        });
        return c.json({ error: "Invalid token" }, 401);
      }
      // A soft-`deleting` account's credentials stop working immediately — the
      // deleting_at flag rides on the same user row (no second round-trip) and
      // we reject BEFORE setting any context so nothing downstream trusts it.
      if (userResult.data.deletingAt) {
        logger.warn("Auth rejected - user is deleting", {
          path: c.req.path,
          userId: userResult.data.id,
        });
        return c.json({ error: "Invalid token" }, 401);
      }
      c.set("userId", userResult.data.id);
      c.set("username", userResult.data.username);
      c.set("authVia", "token");
      c.set("telemetryOptOut", userResult.data.telemetryOptOut === true);
      logger.debug("Auth success - user", {
        userId: userResult.data.id,
        username: userResult.data.username,
      });
      await next();
      return;
    }

    if (token.startsWith("stratum_agent_")) {
      const agentResult = await getAgentByToken(c.env.DB, token, logger);
      if (!agentResult.success) {
        logger.warn("Auth failed - invalid agent token", {
          path: c.req.path,
          tokenHint: sanitizeToken(token),
        });
        return c.json({ error: "Invalid token" }, 401);
      }
      // An agent inherits its owner's access, so a deleting owner's agent must
      // stop working too — otherwise it's an authenticated write channel that
      // re-creates rows the account cascade is erasing. Fail CLOSED on the
      // owner lookup: an unresolved lookup or a deleting owner rejects the
      // agent token. getUser can reject on a D1 error, so catch it rather
      // than letting it propagate past this middleware.
      let ownerResult: Awaited<ReturnType<typeof getUser>>;
      try {
        ownerResult = await getUser(c.env.DB, agentResult.data.ownerId, logger);
      } catch (error) {
        logger.warn("Agent owner lookup threw during auth; failing closed", {
          ownerId: agentResult.data.ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "Invalid token" }, 401);
      }
      if (!ownerResult.success || ownerResult.data.deletingAt) {
        logger.warn("Auth failed - agent owner is deleting", { path: c.req.path });
        return c.json({ error: "Invalid token" }, 401);
      }
      c.set("agentId", agentResult.data.id);
      c.set("agentOwnerId", agentResult.data.ownerId);
      c.set("authVia", "token");
      // An agent acts under its owner's account, so the owner's telemetry
      // choice governs it — otherwise opting out could be defeated by routing
      // traffic through an agent. The owner row is already in hand.
      c.set("telemetryOptOut", ownerResult.data.telemetryOptOut === true);
      logger.debug("Auth success - agent", {
        agentId: agentResult.data.id,
        ownerId: agentResult.data.ownerId,
      });
      await next();
      return;
    }

    logger.warn("Auth failed - unsupported token type", {
      path: c.req.path,
      tokenHint: sanitizeToken(token),
    });
    return c.json({ error: "Invalid token" }, 401);
  }

  const sessionId = getCookie(c, "stratum_session");
  if (sessionId) {
    const sessionResult = await getSession(c.env.DB, sessionId, logger);
    if (sessionResult.success) {
      const userId = sessionResult.data.userId;
      if (new Date(sessionResult.data.expiresAt) <= new Date()) {
        logger.debug("Session expired, deleting", { userId });
        await deleteSession(c.env.DB, sessionId, userId, logger);
      } else {
        // Fetch the user row FIRST so a soft-`deleting` account is rejected
        // before any auth context is set (the deleting_at flag rides on the
        // same row, so this is not an extra round-trip beyond the username
        // lookup this path already did). Fail CLOSED: an unresolved lookup
        // (missing row, or getUser rejecting on a D1 error) must not end up
        // authenticated any more than a deleting account should.
        let userResult: Awaited<ReturnType<typeof getUser>>;
        try {
          userResult = await getUser(c.env.DB, sessionResult.data.userId, logger);
        } catch (error) {
          logger.warn("Session user lookup threw during auth; failing closed", {
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Unauthorized" }, 401);
        }
        if (!userResult.success || userResult.data.deletingAt) {
          logger.warn("Auth rejected - session user missing or deleting", { userId });
          return c.json({ error: "Unauthorized" }, 401);
        }

        c.set("userId", sessionResult.data.userId);
        c.set("authVia", "session");
        c.set("telemetryOptOut", userResult.data.telemetryOptOut === true);

        // Generate username from email if missing (backward compatibility)
        const username =
          userResult.data.username ||
          (userResult.data.email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        c.set("username", username);
        logger.debug("Auth success - session", { userId: sessionResult.data.userId, username });
      }
    } else {
      logger.debug("Session not found", { sessionId: sanitizeToken(sessionId) });
    }
  } else {
    logger.debug("No auth token or session", { path: c.req.path });
  }

  await next();
};
