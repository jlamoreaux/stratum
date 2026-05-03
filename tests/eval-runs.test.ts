import { beforeEach, describe, expect, it, vi } from "vitest";
import { listEvalRuns, recordEvalRuns } from "../src/storage/eval-runs";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

interface StoredRow {
  id: string;
  change_id: string;
  evaluator_type: string;
  score: number;
  passed: number;
  reason: string;
  issues: string | null;
  ran_at: string;
}

function makeD1(): D1Database {
  const rows: StoredRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (sql.trim().toUpperCase().startsWith("INSERT INTO EVAL_RUNS")) {
          rows.push({
            id: bindings[0] as string,
            change_id: bindings[1] as string,
            evaluator_type: bindings[2] as string,
            score: bindings[3] as number,
            passed: bindings[4] as number,
            reason: bindings[5] as string,
            issues: bindings[6] as string | null,
            ran_at: bindings[7] as string,
          });
        }
        return { success: true, meta: {} };
      },
      all: async <T>() => {
        const changeId = bindings[0] as string;
        return {
          results: rows.filter((row) => row.change_id === changeId) as T[],
          success: true,
          meta: {},
        };
      },
    };
  }

  return {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (
      statements: Array<{
        run: () => Promise<{ success: boolean; meta: Record<string, unknown> }>;
      }>,
    ) => {
      return Promise.all(statements.map((stmt) => stmt.run()));
    },
  } as unknown as D1Database;
}

describe("eval run storage", () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it("records and lists per-evaluator results with issues", async () => {
    const recordResult = await recordEvalRuns(db, mockLogger, "chg_abc123", [
      {
        evaluatorType: "secret_scan",
        result: {
          score: 0,
          passed: false,
          reason: "Secret detected",
          issues: ["AWS Access Key: line 4"],
        },
      },
      {
        evaluatorType: "diff",
        result: { score: 1, passed: true, reason: "Diff passed" },
      },
    ]);

    expect(recordResult.success).toBe(true);

    const runsResult = await listEvalRuns(db, mockLogger, "chg_abc123");
    expect(runsResult.success).toBe(true);
    if (runsResult.success) {
      expect(runsResult.data).toHaveLength(2);
      expect(runsResult.data[0]).toMatchObject({
        evaluatorType: "secret_scan",
        passed: false,
        issues: ["AWS Access Key: line 4"],
      });
      expect(runsResult.data[1]).toMatchObject({ evaluatorType: "diff", passed: true });
    }
  });
});
