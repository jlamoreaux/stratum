import { describe, expect, it } from "vitest";
import { getChange, updateChangeStatus } from "../src/storage/changes";
import { Logger } from "../src/utils/logger";

interface RecordedStatement {
  sql: string;
  bindings: unknown[];
  method: "run" | "first" | "all";
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

function makeRecordingD1(calls: RecordedStatement[], firstResult?: Record<string, unknown>): D1Database {
  return {
    prepare: (sql: string) => {
      const stmt = {
        bind: (...bindings: unknown[]) => {
          return {
            run: async () => {
              calls.push({ sql, bindings, method: "run" });
              return { success: true, meta: {} };
            },
            first: async <T>() => {
              calls.push({ sql, bindings, method: "first" });
              return (firstResult ?? null) as T | null;
            },
            all: async <T>() => {
              calls.push({ sql, bindings, method: "all" });
              return { results: [] as T[], success: true, meta: {} };
            },
          };
        },
      } as unknown as D1PreparedStatement;
      return stmt;
    },
  } as unknown as D1Database;
}

function makeChangeRowD1(row: Record<string, unknown> | null): D1Database {
  return {
    prepare: () =>
      ({
        bind: () => ({
          first: async <T>() => row as T | null,
        }),
      }) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
}

describe("change storage", () => {
  it("preserves omitted optional fields when updating status", async () => {
    const calls: RecordedStatement[] = [];

    const result = await updateChangeStatus(
      makeRecordingD1(calls, { id: "chg_abc123" }),
      mockLogger,
      "chg_abc123",
      "merged",
      {
        mergedAt: "2026-05-02T12:00:00.000Z",
      }
    );

    expect(result.success).toBe(true);
    
    // Find the UPDATE statement call
    const updateCall = calls.find(c => c.sql.includes("UPDATE changes"));
    expect(updateCall).toBeDefined();
    expect(updateCall?.sql).toBe("UPDATE changes SET status = ?, merged_at = ? WHERE id = ?");
    expect(updateCall?.bindings).toEqual(["merged", "2026-05-02T12:00:00.000Z", "chg_abc123"]);
    expect(updateCall?.sql).not.toContain("eval_score");
    expect(updateCall?.sql).not.toContain("github_pr_url");
  });

  it("updates provided eval and GitHub metadata fields with id bound last", async () => {
    const calls: RecordedStatement[] = [];

    const result = await updateChangeStatus(
      makeRecordingD1(calls, { id: "chg_abc123" }),
      mockLogger,
      "chg_abc123",
      "promoted",
      {
        evalPassed: false,
        githubOwner: "jlamoreaux",
        githubRepo: "stratum",
        githubBranch: "codex/test",
        githubPrNumber: 6,
        githubPrUrl: "https://github.com/jlamoreaux/stratum/pull/6",
        githubPrState: "open",
        promotedAt: "2026-05-02T13:00:00.000Z",
        promotedBy: "user_test",
      }
    );

    expect(result.success).toBe(true);
    
    const updateCall = calls.find(c => c.sql.includes("UPDATE changes"));
    expect(updateCall).toEqual({
      sql: [
        "UPDATE changes SET status = ?",
        "eval_passed = ?",
        "github_owner = ?",
        "github_repo = ?",
        "github_branch = ?",
        "github_pr_number = ?",
        "github_pr_url = ?",
        "github_pr_state = ?",
        "promoted_at = ?",
        "promoted_by = ? WHERE id = ?",
      ].join(", "),
      bindings: [
        "promoted",
        0,
        "jlamoreaux",
        "stratum",
        "codex/test",
        6,
        "https://github.com/jlamoreaux/stratum/pull/6",
        "open",
        "2026-05-02T13:00:00.000Z",
        "user_test",
        "chg_abc123",
      ],
      method: "run",
    });
  });

  it("maps GitHub promotion metadata from change rows", async () => {
    const result = await getChange(
      makeChangeRowD1({
        id: "chg_abc123",
        project: "my-project",
        workspace: "fix-bug",
        status: "promoted",
        agent_id: "agt_123",
        eval_score: 0.95,
        eval_passed: 1,
        eval_reason: "passed",
        created_at: "2026-05-02T11:00:00.000Z",
        merged_at: null,
        github_owner: "jlamoreaux",
        github_repo: "stratum",
        github_branch: "codex/test",
        github_pr_number: 6,
        github_pr_url: "https://github.com/jlamoreaux/stratum/pull/6",
        github_pr_state: "open",
        promoted_at: "2026-05-02T13:00:00.000Z",
        promoted_by: "user_test",
      }),
      mockLogger,
      "chg_abc123",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        id: "chg_abc123",
        status: "promoted",
        githubOwner: "jlamoreaux",
        githubRepo: "stratum",
        githubBranch: "codex/test",
        githubPrNumber: 6,
        githubPrUrl: "https://github.com/jlamoreaux/stratum/pull/6",
        githubPrState: "open",
        promotedAt: "2026-05-02T13:00:00.000Z",
        promotedBy: "user_test",
      });
    }
  });
});
