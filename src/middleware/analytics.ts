import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { createPostHogClient } from "../analytics/posthog";
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

  // Honor the caller's opt-out (#257). Deliberately placed after the debug log
  // above: that log stays in the operator's own Workers logs and never leaves
  // the instance, whereas this gate governs export to a third party.
  //
  // Every path that authenticates a caller publishes the preference alongside
  // the identity: authMiddleware for the API and UI, and git-http's own
  // `authenticate` for the smart-HTTP surface it owns. Note the latter sets the
  // preference WITHOUT a userId, so this must not be gated on attribution.
  if (c.get("telemetryOptOut") === true) return;

  const distinctId = userId ?? agentId ?? "server";
  const client = createPostHogClient(c.env);
  const capture = client.capture({
    event: "api_request",
    distinctId,
    properties: {
      method: c.req.method,
      route,
      status: c.res.status,
      latency_ms: latency,
      // Unattributed events would otherwise accrete on a shared "server"
      // person profile; capture them personless instead.
      ...(distinctId === "server" ? { $process_person_profile: false } : {}),
    },
  });
  try {
    const ctx = c.executionCtx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(capture);
    }
  } catch {
    capture.catch(() => undefined);
  }
};
