import type { MiddlewareHandler } from "hono";
import { createPostHogClient } from "../analytics/posthog";
import type { Env } from "../types";

export const analyticsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const start = Date.now();
  await next();
  const path = c.req.path;
  if (path === "/health") return;
  const client = createPostHogClient(c.env);
  const capture = client.capture({
    event: "api_request",
    distinctId: "server",
    properties: {
      method: c.req.method,
      path,
      status: c.res.status,
      latency_ms: Date.now() - start,
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
