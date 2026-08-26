import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { AppError } from "../src/utils/errors";

vi.mock("../src/storage/backfill-plan", () => ({
  computeBackfillPlan: vi.fn(),
  backfillWebhookProjectIds: vi.fn(),
}));
vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn(async () => ({ success: true, data: undefined })),
}));

import { backfillRouter } from "../src/routes/backfill";
import { recordAudit } from "../src/storage/audit";
import { backfillWebhookProjectIds, computeBackfillPlan } from "../src/storage/backfill-plan";

const ADMIN_KEY = "admin-secret";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin/backfill-project-id", backfillRouter);
  return app;
}

const env = { DB: {}, STATE: {}, ADMIN_API_KEY: ADMIN_KEY } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/backfill-project-id/plan", {
    method: "GET",
    headers,
  });
}

describe("GET /api/admin/backfill-project-id/plan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 without admin credentials", async () => {
    const res = await makeApp().fetch(req(), env, ctx);
    expect(res.status).toBe(403);
    expect(computeBackfillPlan).not.toHaveBeenCalled();
  });

  it("200 with the plan for an admin", async () => {
    vi.mocked(computeBackfillPlan).mockResolvedValue({
      success: true,
      data: {
        tables: [{ table: "changes", nullRows: 3 }],
        totalNullRows: 3,
        projects: { total: 1, backfillable: 1, collisions: [] },
      },
    } as never);

    const res = await makeApp().fetch(req({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { totalNullRows: number } };
    expect(body.plan.totalNullRows).toBe(3);
  });
});

function applyReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/backfill-project-id/webhooks/apply", {
    method: "POST",
    headers,
  });
}

/** Builds the app with a middleware that attaches `userId` before routing,
 *  so mixed-credential requests (a valid admin API key alongside a non-admin
 *  user session) can be exercised. */
function makeAppWithUser(userId: string | undefined) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (userId !== undefined) c.set("userId", userId);
    await next();
  });
  app.route("/api/admin/backfill-project-id", backfillRouter);
  return app;
}

describe("POST /api/admin/backfill-project-id/webhooks/apply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 without admin credentials, and never runs the backfill", async () => {
    const res = await makeApp().fetch(applyReq(), env, ctx);
    expect(res.status).toBe(403);
    expect(backfillWebhookProjectIds).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("200 with the report for an admin, and records an audit entry", async () => {
    vi.mocked(backfillWebhookProjectIds).mockResolvedValue({
      success: true,
      data: {
        updated: 2,
        skipped: [{ webhookId: "wh_2", project: "beta", reason: "ambiguous" }],
        remainingNullRows: 1,
      },
    } as never);

    const res = await makeApp().fetch(applyReq({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { updated: number; remainingNullRows: number };
      audited: boolean;
    };
    expect(body.report.updated).toBe(2);
    expect(body.report.remainingNullRows).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ action: "webhook.project_id_backfilled" }),
    );
    expect(body.audited).toBe(true);
  });

  // A failed audit write is a partial success: the rows are already stamped
  // and nothing here can unwind them, so the route must neither claim a clean
  // run nor pretend the backfill did not happen. It reports the counts (the
  // reason this endpoint exists) with `audited: false` alongside them.
  it("still reports the counts when the audit write fails, flagged audited: false", async () => {
    vi.mocked(backfillWebhookProjectIds).mockResolvedValue({
      success: true,
      data: { updated: 2, skipped: [], remainingNullRows: 0 },
    } as never);
    vi.mocked(recordAudit).mockResolvedValueOnce({
      success: false,
      error: new AppError("D1 write failed", "DATABASE_ERROR", 500),
    } as never);

    const res = await makeApp().fetch(applyReq({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { updated: number; remainingNullRows: number };
      audited: boolean;
    };
    expect(body.audited).toBe(false);
    // The numbers survive the audit failure — losing them would push the
    // operator into a re-run to recover counts they already earned.
    expect(body.report.updated).toBe(2);
    expect(body.report.remainingNullRows).toBe(0);
  });

  // D1 auto-commits each row's UPDATE independently, so a throw partway
  // through the backfill can leave earlier rows already stamped even though
  // the call reports failure. That partial mutation must not land with zero
  // provenance: an audit entry has to be recorded before the 500 goes out.
  it("records a failure-path audit entry carrying partial progress, and still 500s", async () => {
    vi.mocked(backfillWebhookProjectIds).mockResolvedValue({
      success: false,
      error: new AppError("D1 write failed on row 3", "DATABASE_ERROR", 500, {
        operation: "backfillWebhookProjectIds",
        updated: 2,
        skipped: 1,
      }),
    } as never);

    const res = await makeApp().fetch(applyReq({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(500);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({
        action: "webhook.project_id_backfilled",
        actorType: "system",
        detail: expect.objectContaining({ failed: true, updated: 2, skipped: 1 }),
      }),
    );
  });

  it("still returns the original 500 when the failure-path audit write itself fails", async () => {
    vi.mocked(backfillWebhookProjectIds).mockResolvedValue({
      success: false,
      error: new AppError("D1 write failed on row 3", "DATABASE_ERROR", 500, {
        operation: "backfillWebhookProjectIds",
        updated: 1,
        skipped: 0,
      }),
    } as never);
    vi.mocked(recordAudit).mockResolvedValueOnce({
      success: false,
      error: new AppError("D1 write failed", "DATABASE_ERROR", 500),
    } as never);

    const res = await makeApp().fetch(applyReq({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("D1 write failed on row 3");
  });

  // requireAdmin checks the X-Admin-API-Key branch first: a request carrying
  // a valid admin key is authorized by that key alone, regardless of which
  // (if any) non-admin user session also rides along on the request. The
  // audit entry must attribute the run to that key, not to the bystander
  // user.
  it("attributes the audit entry to the API key, not a non-admin user riding along", async () => {
    vi.mocked(backfillWebhookProjectIds).mockResolvedValue({
      success: true,
      data: { updated: 1, skipped: [], remainingNullRows: 0 },
    } as never);

    const res = await makeAppWithUser("usr_non_admin").fetch(
      applyReq({ "X-Admin-API-Key": ADMIN_KEY }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ actorType: "system" }),
    );
    const recordedOpts = vi.mocked(recordAudit).mock.calls[0]?.[2];
    expect(recordedOpts).not.toHaveProperty("actorId");
  });
});
