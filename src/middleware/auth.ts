import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getAgentByToken } from "../storage/agents";
import { deleteSession, getSession } from "../storage/sessions";
import { getUserByToken } from "../storage/users";
import type { Env } from "../types";

declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
    agentId?: string;
    agentOwnerId?: string;
  }
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const token = authHeader.slice(7);

    if (token.startsWith("stratum_user_")) {
      const user = await getUserByToken(c.env.DB, token);
      if (!user) return c.json({ error: "Invalid token" }, 401);
      c.set("userId", user.id);
      await next();
      return;
    }

    if (token.startsWith("stratum_agent_")) {
      const agent = await getAgentByToken(c.env.DB, token);
      if (!agent) return c.json({ error: "Invalid token" }, 401);
      c.set("agentId", agent.id);
      c.set("agentOwnerId", agent.ownerId);
      await next();
      return;
    }

    return c.json({ error: "Invalid token" }, 401);
  }

  const sessionId = getCookie(c, "stratum_session");
  if (sessionId) {
    const session = await getSession(c.env.DB, sessionId);
    if (session) {
      if (new Date(session.expiresAt) <= new Date()) {
        await deleteSession(c.env.DB, sessionId);
      } else {
        c.set("userId", session.userId);
      }
    }
  }

  await next();
};
