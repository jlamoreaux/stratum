import { Hono } from "hono";
import { recordAudit } from "../storage/audit";
import { backfillWebhookProjectIds, computeBackfillPlan } from "../storage/backfill-plan";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { forbidden, internalError, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

/**
 * Gate an admin-only backfill route, returning a request-scoped logger on
 * success. Accepts either the X-Admin-API-Key header or an authenticated
 * admin user, matching the existing /plan endpoint's contract.
 */
async function requireAdmin(c: {
  env: Env;
  req: { header: (n: string) => string | undefined; path: string; method: string };
  get: (k: "userId") => string | undefined;
}): Promise<{ ok: true; logger: ReturnType<typeof createLogger> } | { ok: false }> {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const isAdmin = await isAdminRequest(
    c.env,
    {
      ...(c.req.header("X-Admin-API-Key") !== undefined
        ? { adminApiKeyHeader: c.req.header("X-Admin-API-Key") }
        : {}),
      ...(c.get("userId") !== undefined ? { userId: c.get("userId") } : {}),
    },
    logger,
  );
  return isAdmin ? { ok: true, logger } : { ok: false };
}

// GET /api/admin/backfill-project-id/plan — DRY-RUN: how much legacy (NULL
// project_id) data exists per table, and which project names are safe to
// backfill vs. collide and need manual resolution. Read-only; mutates nothing.
app.get("/plan", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");

  const plan = await computeBackfillPlan(c.env, auth.logger);
  if (!plan.success) return internalError(plan.error.message);
  return ok({ plan: plan.data });
});

// POST /api/admin/backfill-project-id/webhooks/apply — APPLY: stamp
// project_id on every legacy (NULL project_id) `webhooks` row whose `project`
// name resolves to exactly one project across all namespaces. Ambiguous
// (name shared by >1 project) and unresolved (no matching project) rows are
// left NULL and reported — never guessed, since a bare name can collide
// across tenants. Response reports rows updated, rows left NULL with why, and
// the remaining NULL count (the step-2 verification for issue #235).
//
// This is step 1-2 of a 3-step coordinated fix (issue #235); the name-based
// fallback in webhookBelongsToProject/listWebhooks intentionally stays in
// place until this has actually run in production and the remaining NULL
// count is verified at zero.
app.post("/webhooks/apply", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  const { logger } = auth;

  const report = await backfillWebhookProjectIds(c.env, logger);
  if (!report.success) return internalError(report.error.message);

  const auditResult = await recordAudit(c.env.DB, logger, {
    action: "webhook.project_id_backfilled",
    actorType: c.get("userId") ? "user" : "system",
    ...(c.get("userId") !== undefined ? { actorId: c.get("userId") } : {}),
    detail: {
      updated: report.data.updated,
      skipped: report.data.skipped.length,
      remainingNullRows: report.data.remainingNullRows,
    },
  });
  if (!auditResult.success) {
    // The rows are already stamped by this point and nothing here can unwind
    // them, so a failed audit write is a partial success, not a failure: the
    // mutation landed, its provenance record did not. Deliberately NOT a 500
    // — that would tell an operator the backfill did not happen when it did,
    // and would throw away the `remainingNullRows` count this endpoint exists
    // to report (the step-2 verification for #235), pushing them toward a
    // re-run to recover numbers they already earned. Instead the gap is made
    // explicit in the log and in `audited` below, so it can neither be missed
    // nor mistaken for a clean run. (Auditing before the mutation, the
    // deletion-runner's fail-hard order, isn't available here: the entry's
    // detail is the run's own counts.)
    logger.error("Backfill applied but its audit entry failed to persist", auditResult.error, {
      updated: report.data.updated,
      remainingNullRows: report.data.remainingNullRows,
    });
  }

  return ok({ report: report.data, audited: auditResult.success });
});

export { app as backfillRouter };
