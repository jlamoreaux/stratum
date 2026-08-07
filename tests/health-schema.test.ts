// @ts-nocheck — reads the filesystem (node:fs/path); the repo's tsconfig is
// Workers-only (no @types/node), matching the smoke tests' convention.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CRITICAL_TABLES } from "../src/routes/health";

/**
 * Regression guard for the class of bug where a name in CRITICAL_TABLES is not
 * actually a D1 table (e.g. `projects`/`orgs` are KV-backed). Such a name makes
 * `/api/health` 503 on every healthy deploy — the opposite of the intent. We
 * derive the real table set from migrations/ (the schema source of truth) and
 * assert every critical table exists there.
 */
function tablesDefinedInMigrations(): Set<string> {
  const dir = join(__dirname, "..", "migrations");
  const names = new Set<string>();
  const createTable = /CREATE TABLE (?:IF NOT EXISTS )?["'`]?([a-z_]+)/gi;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(createTable)) names.add(m[1].toLowerCase());
  }
  return names;
}

describe("CRITICAL_TABLES schema guard", () => {
  it("every CRITICAL_TABLES entry is a real D1 table created by a migration", () => {
    const defined = tablesDefinedInMigrations();
    expect(defined.size).toBeGreaterThan(0);
    for (const table of CRITICAL_TABLES) {
      expect(defined, `${table} must be a real D1 table, not KV-backed`).toContain(table);
    }
  });
});
