import { describe, expect, it, vi } from "vitest";
import { backfillWebhookProjectIds, computeBackfillPlan } from "../src/storage/backfill-plan";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

/** Fake D1 returning a per-table NULL-project_id count from a map. */
function makeD1(nullCounts: Record<string, number>): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({ first: async () => null }),
      first: async () => {
        const match = sql.match(/FROM (\w+) WHERE project_id IS NULL/);
        const table = match?.[1] ?? "";
        return { n: nullCounts[table] ?? 0 };
      },
    }),
  } as unknown as D1Database;
}

/** Fake KV serving project entries for listProjects (single page). */
function makeKV(projects: { id: string; name: string }[]): KVNamespace {
  const store = new Map<string, string>();
  for (const p of projects) {
    store.set(`project:@ns:${p.id}`, JSON.stringify({ ...p, slug: p.name, namespace: "@ns" }));
  }
  return {
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    get: async (key: string) => store.get(key) ?? null,
  } as unknown as KVNamespace;
}

describe("computeBackfillPlan (read-only)", () => {
  it("reports per-table NULL-project_id counts and their total", async () => {
    const env = {
      DB: makeD1({ changes: 3, issues: 2, webhooks: 1 }),
      STATE: makeKV([{ id: "proj_a", name: "alpha" }]),
    } as unknown as Env;

    const result = await computeBackfillPlan(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.totalNullRows).toBe(6);
    expect(result.data.tables.find((t) => t.table === "changes")?.nullRows).toBe(3);
    expect(result.data.tables).toHaveLength(7); // all seven tables reported
  });

  it("classifies unique names as backfillable and shared names as collisions", async () => {
    const env = {
      DB: makeD1({}),
      STATE: makeKV([
        { id: "proj_a", name: "alpha" }, // unique
        { id: "proj_b1", name: "beta" }, // collision with proj_b2
        { id: "proj_b2", name: "beta" },
      ]),
    } as unknown as Env;

    const result = await computeBackfillPlan(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projects.total).toBe(3);
    expect(result.data.projects.backfillable).toBe(1); // only "alpha"
    expect(result.data.projects.collisions).toEqual([
      { name: "beta", projectIds: ["proj_b1", "proj_b2"] },
    ]);
  });
});

interface FakeWebhookRow {
  id: string;
  project: string;
  project_id: string | null;
}

/** Fake D1 backing just the three statements backfillWebhookProjectIds issues. */
function makeWebhooksD1(rows: FakeWebhookRow[]): D1Database {
  return {
    prepare: (sql: string) => {
      if (sql.includes("SELECT id, project FROM webhooks")) {
        return {
          all: async () => ({
            results: rows
              .filter((r) => r.project_id === null)
              .map((r) => ({ id: r.id, project: r.project })),
          }),
        };
      }
      if (sql.includes("UPDATE webhooks SET project_id")) {
        return {
          bind: (projectId: string, id: string) => ({
            // Mirrors real D1: the statement's `AND project_id IS NULL` guard
            // means a row another writer already stamped matches nothing, and
            // `meta.changes` reports 0 for it.
            run: async () => {
              const row = rows.find((r) => r.id === id);
              if (row && row.project_id === null) {
                row.project_id = projectId;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          }),
        };
      }
      if (sql.includes("SELECT COUNT(*)")) {
        return {
          first: async () => ({ n: rows.filter((r) => r.project_id === null).length }),
        };
      }
      throw new Error(`Unexpected SQL in fake D1: ${sql}`);
    },
  } as unknown as D1Database;
}

describe("backfillWebhookProjectIds (apply)", () => {
  it("backfills a row whose project name resolves to exactly one project", async () => {
    const rows: FakeWebhookRow[] = [{ id: "wh_1", project: "alpha", project_id: null }];
    const env = {
      DB: makeWebhooksD1(rows),
      STATE: makeKV([{ id: "proj_a", name: "alpha" }]),
    } as unknown as Env;

    const result = await backfillWebhookProjectIds(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.updated).toBe(1);
    expect(result.data.skipped).toEqual([]);
    expect(result.data.remainingNullRows).toBe(0);
    expect(rows[0]?.project_id).toBe("proj_a");
  });

  it("does not count a row another writer stamped between the read and the write", async () => {
    // The UPDATE re-asserts `project_id IS NULL`, so a row resolved by a
    // concurrent run (or an ordinary webhook update) in the gap after the
    // SELECT matches nothing. `updated` is the number this backfill is
    // verified against, so it has to be writes actually made, not attempts.
    const rows: FakeWebhookRow[] = [
      { id: "wh_race", project: "alpha", project_id: null },
      { id: "wh_mine", project: "alpha", project_id: null },
    ];
    const db = makeWebhooksD1(rows);
    const raced = { done: false };
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      // Simulate the other writer landing right after our SELECT returned
      // both rows, and before our first UPDATE runs.
      if (sql.includes("UPDATE webhooks SET project_id") && !raced.done) {
        raced.done = true;
        const row = rows.find((r) => r.id === "wh_race");
        if (row) row.project_id = "proj_a";
      }
      return realPrepare(sql);
    };
    const env = {
      DB: db,
      STATE: makeKV([{ id: "proj_a", name: "alpha" }]),
    } as unknown as Env;

    const result = await backfillWebhookProjectIds(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Two rows were attempted; only wh_mine was actually written by this run.
    expect(result.data.updated).toBe(1);
    expect(result.data.skipped).toEqual([]);
    expect(result.data.remainingNullRows).toBe(0);
  });

  it("leaves an ambiguous name (same name in two namespaces) NULL and reports why", async () => {
    const rows: FakeWebhookRow[] = [{ id: "wh_2", project: "beta", project_id: null }];
    const env = {
      DB: makeWebhooksD1(rows),
      STATE: makeKV([
        { id: "proj_b1", name: "beta" },
        { id: "proj_b2", name: "beta" },
      ]),
    } as unknown as Env;

    const result = await backfillWebhookProjectIds(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.updated).toBe(0);
    expect(result.data.skipped).toEqual([
      { webhookId: "wh_2", project: "beta", reason: "ambiguous" },
    ]);
    expect(result.data.remainingNullRows).toBe(1);
    expect(rows[0]?.project_id).toBeNull();
  });

  it("leaves an unresolved name (no matching project) NULL and reports why", async () => {
    const rows: FakeWebhookRow[] = [{ id: "wh_3", project: "ghost", project_id: null }];
    const env = {
      DB: makeWebhooksD1(rows),
      STATE: makeKV([{ id: "proj_a", name: "alpha" }]),
    } as unknown as Env;

    const result = await backfillWebhookProjectIds(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.updated).toBe(0);
    expect(result.data.skipped).toEqual([
      { webhookId: "wh_3", project: "ghost", reason: "unresolved" },
    ]);
    expect(result.data.remainingNullRows).toBe(1);
  });

  it("never touches rows that already carry a project_id", async () => {
    const rows: FakeWebhookRow[] = [
      { id: "wh_4", project: "alpha", project_id: "proj_a" },
      { id: "wh_5", project: "alpha", project_id: null },
    ];
    const env = {
      DB: makeWebhooksD1(rows),
      STATE: makeKV([{ id: "proj_a", name: "alpha" }]),
    } as unknown as Env;

    const result = await backfillWebhookProjectIds(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Only the NULL row is touched; the already-backfilled row is never
    // selected and keeps its original project_id untouched.
    expect(result.data.updated).toBe(1);
    expect(result.data.remainingNullRows).toBe(0);
    expect(rows[0]?.project_id).toBe("proj_a");
    expect(rows[1]?.project_id).toBe("proj_a");
  });
});
