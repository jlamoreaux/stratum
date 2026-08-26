import { describe, expect, it, vi } from "vitest";
import { dismissApprovalsAndUpdateStatus, updateChangeStatus } from "../src/storage/changes";
import { NotFoundError } from "../src/utils/errors";
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

interface FakeChangeRow {
  id: string;
  status: string;
  evaluated_sha: string | null;
  [column: string]: unknown;
}

interface FakeReviewRow {
  id: string;
  change_id: string;
  reviewer_id: string;
  verdict: string;
  comment: string | null;
  created_at: string;
}

interface FakeState {
  changes: Map<string, FakeChangeRow>;
  reviews: FakeReviewRow[];
}

/**
 * Apply one statement's effect to a given state (either the real, committed
 * state or a batch's in-flight snapshot). Understands exactly the three
 * statement shapes `dismissApprovalsAndUpdateStatus` issues: the existence
 * check, the change_reviews DELETE ... RETURNING, and the changes UPDATE.
 */
function applyStatement(
  sql: string,
  bindings: unknown[],
  target: FakeState,
): { results: unknown[]; success: boolean; meta: Record<string, unknown> } {
  const upper = sql.trim().toUpperCase().replace(/\s+/g, " ");

  if (upper.startsWith("SELECT ID FROM CHANGES")) {
    const id = bindings[0] as string;
    return { results: target.changes.has(id) ? [{ id }] : [], success: true, meta: {} };
  }

  if (upper.startsWith("DELETE FROM CHANGE_REVIEWS")) {
    const changeId = bindings[0] as string;
    const dismissed: FakeReviewRow[] = [];
    target.reviews = target.reviews.filter((row) => {
      if (row.change_id === changeId && row.verdict === "approve") {
        dismissed.push(row);
        return false;
      }
      return true;
    });
    return {
      results: dismissed.map((row) => ({ reviewer_id: row.reviewer_id })),
      success: true,
      meta: {},
    };
  }

  if (upper.startsWith("UPDATE CHANGES SET")) {
    // Parse the dynamic `SET a = ?, b = ? WHERE id = ?` column list so this
    // stays correct regardless of which optional fields the caller set.
    const match = sql.match(/SET (.+) WHERE id = \?/i);
    const columns = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim().split("=")[0]?.trim() ?? "");
    const id = bindings[bindings.length - 1] as string;
    const row = target.changes.get(id);
    if (row) {
      columns.forEach((column, index) => {
        row[column] = bindings[index];
      });
    }
    return { results: [], success: true, meta: { changes: row ? 1 : 0 } };
  }

  throw new Error(`fake D1: unhandled SQL: ${sql}`);
}

/**
 * Fake D1 that models Cloudflare's D1Database.batch() all-or-nothing
 * guarantee: every statement passed to batch() applies to a snapshot first,
 * and the snapshot only replaces the committed state once every statement in
 * the batch has succeeded. If any statement throws, the committed state is
 * left exactly as it was — the rollback semantics
 * `dismissApprovalsAndUpdateStatus` relies on to close #238 (see
 * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
 *
 * Statements run individually via `.run()`/`.first()` (outside of `batch()`)
 * apply straight to the committed state, with no such protection — matching
 * real D1, where only `batch()` calls get transactional atomicity.
 */
function makeAtomicD1(seed: { changes: FakeChangeRow[]; reviews: FakeReviewRow[] }) {
  const state: FakeState = {
    changes: new Map(seed.changes.map((row) => [row.id, { ...row }])),
    reviews: seed.reviews.map((row) => ({ ...row })),
  };
  let failAtBatchIndex: number | null = null;

  /** Keep all fake statement methods on one SQL simulation path so rollback tests exercise the same semantics. */
  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => applyStatement(sql, bindings, state),
      all: async <T>() =>
        applyStatement(sql, bindings, state) as unknown as {
          results: T[];
          success: boolean;
          meta: Record<string, unknown>;
        },
      first: async <T>() => {
        const result = applyStatement(sql, bindings, state);
        return (result.results[0] ?? null) as T | null;
      },
      _sql: sql,
      _bindings: bindings,
    };
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (statements: Array<{ _sql: string; _bindings: unknown[] }>) => {
      // Apply every statement to a private snapshot first.
      const snapshot: FakeState = {
        changes: new Map(Array.from(state.changes.entries()).map(([id, row]) => [id, { ...row }])),
        reviews: state.reviews.map((row) => ({ ...row })),
      };
      const results: unknown[] = [];
      statements.forEach((stmt, index) => {
        if (failAtBatchIndex !== null && index === failAtBatchIndex) {
          throw new Error("simulated D1 batch failure");
        }
        results.push(applyStatement(stmt._sql, stmt._bindings, snapshot));
      });
      // Only now — every statement having succeeded — commit the snapshot.
      // A thrown error above skips these lines entirely, so the committed
      // `state` is untouched: this is the rollback the test below exercises.
      state.changes = snapshot.changes;
      state.reviews = snapshot.reviews;
      return results;
    },
  } as unknown as D1Database;

  return {
    db,
    state,
    /** Make the statement at this index (0-based, in batch order) throw. */
    failNextBatchAt: (index: number | null) => {
      failAtBatchIndex = index;
    },
  };
}

/** One approved change ("chg_1", old_sha) with an 'approve' and a 'request_changes' review — the #238 scenario. */
function seedRows(): { change: FakeChangeRow; reviews: FakeReviewRow[] } {
  return {
    change: { id: "chg_1", status: "approved", evaluated_sha: "old_sha" },
    reviews: [
      {
        id: "rev_1",
        change_id: "chg_1",
        reviewer_id: "user_1",
        verdict: "approve",
        comment: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "rev_2",
        change_id: "chg_1",
        reviewer_id: "user_2",
        verdict: "request_changes",
        comment: null,
        created_at: "2026-08-01T00:00:01.000Z",
      },
    ],
  };
}

describe("dismissApprovalsAndUpdateStatus — atomic dismiss + re-pin (#238)", () => {
  it("applies the approval dismissal and the status/sha update together on success", async () => {
    const { change, reviews } = seedRows();
    const { db, state } = makeAtomicD1({ changes: [change], reviews });

    const result = await dismissApprovalsAndUpdateStatus(db, mockLogger, "chg_1", "accepted", {
      evaluatedSha: "new_sha",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.dismissedReviewerIds).toEqual(["user_1"]);

    // Both writes landed: the approve verdict is gone, request_changes
    // survives, and the sha/status are re-pinned.
    expect(state.reviews.map((r) => r.reviewer_id)).toEqual(["user_2"]);
    expect(state.changes.get("chg_1")).toMatchObject({
      status: "accepted",
      evaluated_sha: "new_sha",
    });
  });

  it("returns NotFound and touches nothing for a missing change", async () => {
    const { reviews } = seedRows();
    const { db, state } = makeAtomicD1({ changes: [], reviews });

    const result = await dismissApprovalsAndUpdateStatus(
      db,
      mockLogger,
      "chg_missing",
      "accepted",
      {
        evaluatedSha: "new_sha",
      },
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(NotFoundError);
    expect(state.reviews).toHaveLength(2);
  });

  it("(failure injection) rolls back the dismissal when the paired status update fails mid-batch", async () => {
    const { change, reviews } = seedRows();
    const { db, state, failNextBatchAt } = makeAtomicD1({ changes: [change], reviews });
    // Batch order is [DELETE change_reviews, UPDATE changes] — fail the 2nd
    // write, exactly the "dismissal lands, re-pin doesn't" scenario #238
    // reports.
    failNextBatchAt(1);

    const result = await dismissApprovalsAndUpdateStatus(db, mockLogger, "chg_1", "accepted", {
      evaluatedSha: "new_sha",
    });

    expect(result.success).toBe(false);

    // The regression this fixes: a failed status/sha update must not leave
    // the approval dismissal applied on its own. Both verdicts are still
    // present and the sha is still the OLD one — nothing was lost, and
    // nothing was half-applied.
    expect(state.reviews.map((r) => r.reviewer_id).sort()).toEqual(["user_1", "user_2"]);
    expect(state.changes.get("chg_1")).toMatchObject({
      status: "approved",
      evaluated_sha: "old_sha",
    });
  });

  it("(failure injection) rolls back the status update too when the dismissal statement fails mid-batch", async () => {
    const { change, reviews } = seedRows();
    const { db, state, failNextBatchAt } = makeAtomicD1({ changes: [change], reviews });
    failNextBatchAt(0);

    const result = await dismissApprovalsAndUpdateStatus(db, mockLogger, "chg_1", "accepted", {
      evaluatedSha: "new_sha",
    });

    expect(result.success).toBe(false);
    // The other direction of the same guarantee: the sha/status never moves
    // ahead of a dismissal that didn't actually happen.
    expect(state.changes.get("chg_1")).toMatchObject({
      status: "approved",
      evaluated_sha: "old_sha",
    });
    expect(state.reviews).toHaveLength(2);
  });
});

describe("updateChangeStatus — unaffected by the #238 batch change", () => {
  it("still performs a single, non-batched write for callers with no approvals in play", async () => {
    const { change } = seedRows();
    const { db, state } = makeAtomicD1({ changes: [change], reviews: [] });
    const batchSpy = vi.spyOn(db, "batch");

    const result = await updateChangeStatus(db, mockLogger, "chg_1", "accepted", {
      evaluatedSha: "new_sha",
    });

    expect(result.success).toBe(true);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(state.changes.get("chg_1")).toMatchObject({
      status: "accepted",
      evaluated_sha: "new_sha",
    });
  });
});
