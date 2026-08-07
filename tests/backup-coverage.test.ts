/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { BACKUP_EXCLUDED_TABLES, BACKUP_TABLES } from "../src/storage/d1-backup";

/**
 * Backup-coverage drift guard. `BACKUP_TABLES` is a hand-maintained allow-list,
 * so a new table holding user data could be added in a migration and silently
 * left out of every backup. This derives the real table set from migrations/
 * (the schema source of truth) and asserts every table is either backed up or
 * explicitly excluded — forcing that decision at PR time, not after data loss.
 */
const migrationModules = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function tablesDefinedInMigrations(): Set<string> {
  const names = new Set<string>();
  const createTable = /CREATE TABLE (?:IF NOT EXISTS )?["'`]?([a-z_]+)/gi;
  for (const sql of Object.values(migrationModules)) {
    for (const match of sql.matchAll(createTable)) {
      const table = match[1];
      if (table) names.add(table.toLowerCase());
    }
  }
  return names;
}

describe("backup coverage", () => {
  const migrationTables = tablesDefinedInMigrations();
  const backed = new Set(BACKUP_TABLES);
  const excluded = new Set(BACKUP_EXCLUDED_TABLES);

  it("has migration tables to check", () => {
    expect(migrationTables.size).toBeGreaterThan(0);
  });

  it("classifies every migration table as backed-up or explicitly excluded", () => {
    const unclassified = [...migrationTables]
      .filter((t) => !backed.has(t) && !excluded.has(t))
      .sort();
    // If this fails, a new table was added without deciding its backup fate:
    // add it to BACKUP_TABLES (in FK order) or to BACKUP_EXCLUDED_TABLES (with a reason).
    expect(unclassified).toEqual([]);
  });

  it("never lists a table as both backed-up and excluded", () => {
    const overlap = [...backed].filter((t) => excluded.has(t)).sort();
    expect(overlap).toEqual([]);
  });

  it("references only real tables (no typos or dropped tables)", () => {
    const phantomBacked = [...backed].filter((t) => !migrationTables.has(t)).sort();
    const phantomExcluded = [...excluded].filter((t) => !migrationTables.has(t)).sort();
    expect(phantomBacked).toEqual([]);
    expect(phantomExcluded).toEqual([]);
  });
});
