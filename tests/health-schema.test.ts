/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { CRITICAL_TABLES } from "../src/routes/health";

/**
 * Regression guard for the class of bug where a name in CRITICAL_TABLES is not
 * actually a D1 table (e.g. `projects`/`orgs` are KV-backed). Such a name makes
 * `/api/health` 503 on every healthy deploy — the opposite of the intent. We
 * derive the real table set from migrations/ (the schema source of truth) and
 * assert every critical table exists there.
 *
 * The SQL is loaded via Vite's raw glob (not node:fs) so the test stays fully
 * type-checked under the Workers tsconfig — no @ts-nocheck, no @types/node.
 */
const migrationSql = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function tablesDefinedInMigrations(): Set<string> {
  const names = new Set<string>();
  const createTable = /CREATE TABLE (?:IF NOT EXISTS )?["'`]?([a-z_]+)/gi;
  for (const sql of Object.values(migrationSql)) {
    for (const match of sql.matchAll(createTable)) {
      const table = match[1];
      if (table) names.add(table.toLowerCase());
    }
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
