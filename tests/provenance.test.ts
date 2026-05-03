import { beforeEach, describe, expect, it } from "vitest";
import { getProvenance, listProvenance, recordProvenance } from "../src/storage/provenance";
import { Logger } from "../src/utils/logger";

interface StoredRow {
  id: string;
  commit_sha: string;
  project: string;
  workspace: string;
  change_id: string;
  agent_id: string | null;
  eval_score: number | null;
  merged_at: string;
}

const mockLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => mockLogger,
};

function makeD1(): D1Database {
  const rows: StoredRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("INSERT INTO PROVENANCE")) {
          rows.push({
            id: bindings[0] as string,
            commit_sha: bindings[1] as string,
            project: bindings[2] as string,
            workspace: bindings[3] as string,
            change_id: bindings[4] as string,
            agent_id: (bindings[5] as string | null) ?? null,
            eval_score: (bindings[6] as number | null) ?? null,
            merged_at: bindings[7] as string,
          });
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("SELECT * FROM PROVENANCE WHERE CHANGE_ID")) {
          const changeId = bindings[0] as string;
          const row = rows.find((r) => r.change_id === changeId);
          return (row ?? null) as T | null;
        }
        return null as T | null;
      },
      all: async <T>() => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("SELECT * FROM PROVENANCE WHERE PROJECT")) {
          const project = bindings[0] as string;
          const limit = bindings[1] as number;
          const filtered = rows
            .filter((r) => r.project === project)
            .sort((a, b) => (a.merged_at < b.merged_at ? 1 : a.merged_at > b.merged_at ? -1 : 0))
            .slice(0, limit);
          return { results: filtered as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
    };
  }

  return {
    prepare: (sql: string) => makeStmt(sql, []),
  } as unknown as D1Database;
}

const baseOpts = {
  commitSha: "abc123def456",
  project: "my-project",
  workspace: "fix-bug",
  changeId: "chg_test001",
};

describe("recordProvenance", () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it("creates a record with correct fields", async () => {
    const result = await recordProvenance(db, mockLogger, baseOpts);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commitSha).toBe("abc123def456");
      expect(result.data.project).toBe("my-project");
      expect(result.data.workspace).toBe("fix-bug");
      expect(result.data.changeId).toBe("chg_test001");
      expect(result.data.id).toMatch(/^prv_/);
      expect(result.data.mergedAt).toBeTruthy();
    }
  });

  it("stores optional agentId and evalScore", async () => {
    const result = await recordProvenance(db, mockLogger, {
      ...baseOpts,
      agentId: "agt_xyz",
      evalScore: 0.95,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe("agt_xyz");
      expect(result.data.evalScore).toBe(0.95);
    }
  });

  it("omits agentId and evalScore when not provided", async () => {
    const result = await recordProvenance(db, mockLogger, baseOpts);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBeUndefined();
      expect(result.data.evalScore).toBeUndefined();
    }
  });
});

describe("getProvenance", () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it("returns record by changeId", async () => {
    await recordProvenance(db, mockLogger, baseOpts);
    const result = await getProvenance(db, mockLogger, "chg_test001");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.changeId).toBe("chg_test001");
      expect(result.data.commitSha).toBe("abc123def456");
    }
  });

  it("returns error for unknown changeId", async () => {
    const result = await getProvenance(db, mockLogger, "chg_missing");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe("NotFoundError");
    }
  });
});

describe("listProvenance", () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it("returns records for a project", async () => {
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_001" });
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_002" });
    const result = await listProvenance(db, mockLogger, "my-project");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data.every((r) => r.project === "my-project")).toBe(true);
    }
  });

  it("does not return records for a different project", async () => {
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_001" });
    await recordProvenance(db, mockLogger, { ...baseOpts, project: "other-project", changeId: "chg_002" });
    const result = await listProvenance(db, mockLogger, "my-project");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.changeId).toBe("chg_001");
    }
  });

  it("respects the limit parameter", async () => {
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_001" });
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_002" });
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_003" });
    const result = await listProvenance(db, mockLogger, "my-project", 2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
  });

  it("sorts multiple records by merged_at descending", async () => {
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_001" });
    await new Promise((r) => setTimeout(r, 2));
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_002" });
    await new Promise((r) => setTimeout(r, 2));
    await recordProvenance(db, mockLogger, { ...baseOpts, changeId: "chg_003" });
    const result = await listProvenance(db, mockLogger, "my-project");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0]?.changeId).toBe("chg_003");
      expect(result.data[result.data.length - 1]?.changeId).toBe("chg_001");
    }
  });

  it("returns empty array for project with no records", async () => {
    const result = await listProvenance(db, mockLogger, "nonexistent-project");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });
});
