import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { surfaceForRoute } from "../analytics/events";
import { trackerForRequest } from "../analytics/tracker";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "Analytics" });

export const analyticsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const start = Date.now();
  await next();
  const path = c.req.path;
  if (path === "/health") return;
  // Unmatched routes are overwhelmingly internet scanners probing for
  // /.env, /.git/config, and the like — noise, not product traffic.
  if (c.res.status === 404) return;

  const latency = Date.now() - start;
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  // Report the matched route pattern (e.g. /:namespace/:slug/blob/*), never
  // the concrete path — namespaces, repo slugs, change ids, and file paths
  // must not leave the process. Route patterns are source-code literals, so
  // they carry no request data by construction.
  const route = routePath(c, -1);

  logger.debug("Recording analytics", {
    method: c.req.method,
    route,
    status: c.res.status,
    latency_ms: latency,
    userId,
    agentId,
  });

  // The caller's opt-out (#257) is enforced inside the tracker, which cannot be
  // built without resolving it. Deliberately *after* the debug log above: that
  // log stays in the operator's own Workers logs and never leaves the instance,
  // whereas the tracker governs export to a third party.
  trackerForRequest(c).capture("api_request", {
    method: c.req.method,
    route,
    status: c.res.status,
    latency_ms: latency,
    surface: surfaceForRoute(route),
    actor_type: userId ? "user" : agentId ? "agent" : "anonymous",
  });
};
