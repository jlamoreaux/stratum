/**
 * Health Check Endpoint
 * Provides comprehensive health checks for all system dependencies
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

interface HealthCheckResult {
  status: "ok" | "error" | "degraded";
  latency: string;
  message?: string;
}

interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  checks: {
    database: HealthCheckResult;
    kv: HealthCheckResult;
    queue: HealthCheckResult;
    artifacts: HealthCheckResult;
  };
}

/**
 * Measure latency of an async operation
 */
async function measureLatency<T>(
  operation: () => Promise<T>,
): Promise<{ success: boolean; latency: number; error?: string }> {
  const start = performance.now();
  try {
    await operation();
    const latency = performance.now() - start;
    return { success: true, latency };
  } catch (error) {
    const latency = performance.now() - start;
    return {
      success: false,
      latency,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load-bearing tables whose absence means the schema is broken or unmigrated
 * (a missing `events` outbox table was the root of the #118 production incident).
 * Intentionally a minimal set of long-stable core tables — NOT the full schema,
 * which lives in `migrations/` and must not be duplicated here. Every entry must
 * be a real D1 table (projects/orgs live in KV, not D1); `health.test.ts` asserts
 * this against `migrations/` so a bogus name can't silently 503 every deploy.
 */
export const CRITICAL_TABLES = ["users", "sessions", "changes", "events"] as const;

/**
 * Check D1 database connectivity and that the load-bearing schema is present.
 * A shallow `SELECT 1` verifies the binding is reachable but not that migrations
 * ran, so we also assert the critical tables exist — this is what turns an
 * unmigrated production database into a failed (503) health check.
 */
async function checkDatabase(db: D1Database): Promise<HealthCheckResult> {
  const result = await measureLatency(async () => {
    const { results } = await db
      .prepare("SELECT 1 as health_check")
      .all<{ health_check: number }>();
    if (!results || results.length === 0 || !results[0] || results[0].health_check !== 1) {
      throw new Error("Unexpected query result");
    }

    const placeholders = CRITICAL_TABLES.map(() => "?").join(", ");
    const { results: tableRows } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
      .bind(...CRITICAL_TABLES)
      .all<{ name: string }>();
    const present = new Set((tableRows ?? []).map((row) => row.name));
    const missing = CRITICAL_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      throw new Error(`Missing tables: ${missing.join(", ")}`);
    }
  });

  return {
    status: result.success ? "ok" : "error",
    latency: `${Math.round(result.latency)}ms`,
    ...(result.error && { message: result.error }),
  };
}

/**
 * Check KV storage connectivity
 */
async function checkKV(kv: KVNamespace): Promise<HealthCheckResult> {
  const testKey = `health_check_${Date.now()}`;
  const result = await measureLatency(async () => {
    await kv.put(testKey, "ok", { expirationTtl: 60 });
    const value = await kv.get(testKey);
    if (value !== "ok") {
      throw new Error("KV read/write mismatch");
    }
    await kv.delete(testKey);
  });

  return {
    status: result.success ? "ok" : "error",
    latency: `${Math.round(result.latency)}ms`,
    ...(result.error && { message: result.error }),
  };
}

/**
 * Check Queue availability
 */
async function checkQueue(queue: Queue<unknown> | undefined): Promise<HealthCheckResult> {
  if (!queue) {
    return {
      status: "error",
      latency: "0ms",
      message: "Queue not configured",
    };
  }

  const result = await measureLatency(async () => {
    // Try to get queue metrics to verify connectivity
    const metrics = await queue.metrics();
    // Metrics call succeeded, queue is available
    if (metrics === undefined) {
      throw new Error("Queue metrics unavailable");
    }
  });

  return {
    status: result.success ? "ok" : "error",
    latency: `${Math.round(result.latency)}ms`,
    ...(result.error && { message: result.error }),
  };
}

/**
 * Check Artifacts service availability
 */
async function checkArtifacts(artifacts: Env["ARTIFACTS"]): Promise<HealthCheckResult> {
  const result = await measureLatency(async () => {
    // Try to list repos (should return an array even if empty)
    await artifacts.list({ limit: 1 });
  });

  return {
    status: result.success ? "ok" : "error",
    latency: `${Math.round(result.latency)}ms`,
    ...(result.error && { message: result.error }),
  };
}

// GET /api/health - Comprehensive health check
app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  logger.debug("Health check requested");

  const [database, kv, queue, artifacts] = await Promise.all([
    checkDatabase(c.env.DB).catch(
      (error): HealthCheckResult => ({
        status: "error",
        latency: "0ms",
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    checkKV(c.env.STATE).catch(
      (error): HealthCheckResult => ({
        status: "error",
        latency: "0ms",
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    checkQueue(c.env.IMPORT_QUEUE).catch(
      (error): HealthCheckResult => ({
        status: "error",
        latency: "0ms",
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    checkArtifacts(c.env.ARTIFACTS).catch(
      (error): HealthCheckResult => ({
        status: "error",
        latency: "0ms",
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
  ]);

  // Determine overall health status. Database, KV, and artifacts are critical:
  // the app cannot serve requests without them, so any critical failure is
  // `unhealthy` (503) — this is what lets a deploy smoke test fail on a broken
  // data plane. The queue is non-critical (async delivery degrades but the app
  // still serves), so a queue-only failure is `degraded` (200).
  const criticalChecks = [database, kv, artifacts];
  const errors = [database, kv, queue, artifacts].filter((check) => check.status === "error");
  const hasCriticalError = criticalChecks.some((check) => check.status === "error");
  let overallStatus: HealthCheckResponse["status"] = "healthy";
  if (hasCriticalError) {
    overallStatus = "unhealthy";
  } else if (errors.length > 0) {
    overallStatus = "degraded";
  }

  const response: HealthCheckResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks: {
      database,
      kv,
      queue,
      artifacts,
    },
  };

  const statusCode = overallStatus === "unhealthy" ? 503 : 200;

  logger.info("Health check completed", {
    status: overallStatus,
    errors: errors.length,
  });

  return c.json(response, statusCode);
});

// GET /api/health/simple - Simple liveness check
app.get("/simple", (c) => {
  return c.json({
    status: "ok",
    service: "stratum",
    timestamp: new Date().toISOString(),
  });
});

export const healthRouter = app;
