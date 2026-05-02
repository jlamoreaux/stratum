import { describe, expect, it } from "vitest";
import { getChange, updateChangeStatus } from "../src/storage/changes";

interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

function makeRecordingD1(calls: RecordedStatement[]): D1Database {
  return {
    prepare: (sql: string) =>
      ({
        bind: (...bindings: unknown[]) => ({
          run: async () => {
            calls.push({ sql, bindings });
            return { success: true, meta: {} };
          },
        }),
      }) as unknown as D1PreparedStatement,
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

    await updateChangeStatus(makeRecordingD1(calls), "chg_abc123", "merged", {
      mergedAt: "2026-05-02T12:00:00.000Z",
    });

    expect(calls).toEqual([
      {
        sql: "UPDATE changes SET status = ?, merged_at = ? WHERE id = ?",
        bindings: ["merged", "2026-05-02T12:00:00.000Z", "chg_abc123"],
      },
    ]);
    expect(calls[0]?.sql).not.toContain("eval_score");
    expect(calls[0]?.sql).not.toContain("github_pr_url");
  });

  it("updates provided eval and GitHub metadata fields with id bound last", async () => {
    const calls: RecordedStatement[] = [];

    await updateChangeStatus(makeRecordingD1(calls), "chg_abc123", "promoted", {
      evalPassed: false,
      githubOwner: "jlamoreaux",
      githubRepo: "stratum",
      githubBranch: "codex/test",
      githubPrNumber: 6,
      githubPrUrl: "https://github.com/jlamoreaux/stratum/pull/6",
      githubPrState: "open",
      promotedAt: "2026-05-02T13:00:00.000Z",
      promotedBy: "user_test",
    });

    expect(calls[0]).toEqual({
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
    });
  });

  it("maps GitHub promotion metadata from change rows", async () => {
    const change = await getChange(
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
      "chg_abc123",
    );

    expect(change).toMatchObject({
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
  });
});
