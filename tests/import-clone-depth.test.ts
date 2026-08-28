import { describe, expect, it, vi } from "vitest";
import { createImportJob, getImportProgress, getLatestImportDepth } from "../src/storage/imports";
import { DEFAULT_CLONE_DEPTH } from "../src/utils/validation";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(function (this: unknown) {
    return logger;
  }),
};

function jobParams(overrides: Record<string, unknown> = {}) {
  return {
    id: "imp_1",
    projectId: "prj_1",
    namespace: "@acme",
    slug: "widgets",
    sourceUrl: "https://github.com/acme/widgets",
    branch: "main",
    ...overrides,
  };
}

/**
 * Exercised against a real SQLite engine with every migration applied, so the
 * column added by 040 and the SQL that reads it are both genuinely executed.
 */
describe("import clone depth persistence", () => {
  it("round-trips a shallow depth through the job row", async () => {
    const { db, raw } = makeSqliteD1();
    const created = await createImportJob(db, jobParams({ depth: 250 }), logger);
    expect(created.success).toBe(true);

    expect(await getLatestImportDepth(db, "@acme", "widgets", logger)).toBe(250);
    const read = await getImportProgress(db, "@acme", "widgets", logger);
    expect(read.success && read.data?.depth).toBe(250);
    raw.close();
  });

  // The whole reason the column is nullable rather than NOT NULL DEFAULT 0.
  // Every consumer reads it as `depth ?? DEFAULT_CLONE_DEPTH`, so a 0 that
  // degrades to null or undefined anywhere in the round trip silently becomes
  // a depth-10 clone — the exact failure this change exists to stop.
  it("preserves a depth of 0 (full history) as distinct from unset", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams({ depth: 0 }), logger);

    const depth = await getLatestImportDepth(db, "@acme", "widgets", logger);
    expect(depth).toBe(0);
    expect(depth ?? DEFAULT_CLONE_DEPTH).toBe(0);

    const read = await getImportProgress(db, "@acme", "widgets", logger);
    expect(read.success && read.data?.depth).toBe(0);
    raw.close();
  });

  it("records no depth when the caller has none, so consumers fall back", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams(), logger);

    const depth = await getLatestImportDepth(db, "@acme", "widgets", logger);
    expect(depth).toBeUndefined();
    expect(depth ?? DEFAULT_CLONE_DEPTH).toBe(DEFAULT_CLONE_DEPTH);

    const read = await getImportProgress(db, "@acme", "widgets", logger);
    expect(read.success && read.data && "depth" in read.data).toBe(false);
    raw.close();
  });

  // A row written before migration 040 has depth NULL and must behave exactly
  // as it did before the column existed.
  it("treats a pre-migration row with a NULL depth as unset", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams({ depth: 250 }), logger);
    raw.exec("UPDATE import_jobs SET depth = NULL WHERE id = 'imp_1'");

    expect(await getLatestImportDepth(db, "@acme", "widgets", logger)).toBeUndefined();
    raw.close();
  });

  it("reads the most recent job's depth, not an older one", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams({ id: "imp_old", depth: 0 }), logger);
    // started_at defaults to the insert time; nudge the older row back so the
    // ordering is unambiguous rather than resolved by insertion luck.
    raw.exec("UPDATE import_jobs SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = 'imp_old'");
    await createImportJob(db, jobParams({ id: "imp_new", depth: 5 }), logger);

    expect(await getLatestImportDepth(db, "@acme", "widgets", logger)).toBe(5);
    raw.close();
  });

  it("returns unset for a project with no import jobs at all", async () => {
    const { db, raw } = makeSqliteD1();
    expect(await getLatestImportDepth(db, "@acme", "nothing-here", logger)).toBeUndefined();
    raw.close();
  });
});
