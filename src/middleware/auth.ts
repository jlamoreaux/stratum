import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getAgentByToken } from "../storage/agents";
import { deleteSession, getSession } from "../storage/sessions";
import { getUserByToken } from "../storage/users";
import { createLogger, type Logger } from "../utils/logger";
import type { Env } from "../types";

declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
    agentId?: string;
    agentOwnerId?: string;
    logger: Logger;
  }
}

function sanitizeToken(token: string): string {
  // Only show first 8 characters of token for logging
  if (token.length <= 12) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const requestId = crypto.randomUUID();
  const logger = createLogger({
    requestId,
    path: c.req.path,
    method: c.req.method,
  });

  c.set("logger", logger);

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
      c.set("userId", userResult.data.id);
      logger.debug("Auth success - user", { userId: userResult.data.id });
      await next();
      return;
    }

    if (token.startsWith("stratum_agent_")) {
      const agentResult = await getAgentByToken(c.env.DB, logger, token);
      if (!agentResult.success) {
        logger.warn("Auth failed - invalid agent token", {
          path: c.req.path,
          tokenHint: sanitizeToken(token),
        });
        return c.json({ error: "Invalid token" }, 401);
      }
      c.set("agentId", agentResult.data.id);
      c.set("agentOwnerId", agentResult.data.ownerId);
      logger.debug("Auth success - agent", { agentId: agentResult.data.id, ownerId: agentResult.data.ownerId });
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
      if (new Date(sessionResult.data.expiresAt) <= new Date()) {
        logger.debug("Session expired, deleting", { userId: sessionResult.data.userId });
        await deleteSession(c.env.DB, sessionId, logger);
      } else {
        c.set("userId", sessionResult.data.userId);
        logger.debug("Auth success - session", { userId: sessionResult.data.userId });
      }
    } else {
      logger.debug("Session not found", { sessionId: sanitizeToken(sessionId) });
    }
  } else {
    logger.debug("No auth token or session", { path: c.req.path });
  }

  await next();
};
