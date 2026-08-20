import { describe, expect, it, vi } from "vitest";
import type { EvalPolicy } from "../src/evaluation/types";
import { checkMergeProtection } from "../src/merge/protection";
import {
  addComment,
  countApprovals,
  dismissApprovals,
  listComments,
  listReviews,
  submitReview,
} from "../src/storage/change-reviews";
import type { Change } from "../src/types";
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

interface CommentRow {
  id: string;
  change_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
}

interface ReviewRow {
  id: string;
  change_id: string;
  reviewer_id: string;
  verdict: string;
  comment: string | null;
  created_at: string;
}

function makeReviewsD1(): { db: D1Database; comments: CommentRow[]; reviews: ReviewRow[] } {
  const comments: CommentRow[] = [];
  const reviews: ReviewRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase().replace(/\s+/g, " ");
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("INSERT INTO CHANGE_COMMENTS")) {
          comments.push({
            id: bindings[0] as string,
            change_id: bindings[1] as string,
            author_type: bindings[2] as string,
            author_id: bindings[3] as string,
            body: bindings[4] as string,
            created_at: bindings[5] as string,
          });
        } else if (upper.startsWith("INSERT INTO CHANGE_REVIEWS")) {
          // Emulate ON CONFLICT(change_id, reviewer_id) DO UPDATE.
          const existing = reviews.find(
            (r) => r.change_id === bindings[1] && r.reviewer_id === bindings[2],
          );
          if (existing) {
            existing.verdict = bindings[3] as string;
            existing.comment = bindings[4] as string | null;
            existing.created_at = bindings[5] as string;
          } else {
            reviews.push({
              id: bindings[0] as string,
              change_id: bindings[1] as string,
              reviewer_id: bindings[2] as string,
              verdict: bindings[3] as string,
              comment: bindings[4] as string | null,
              created_at: bindings[5] as string,
            });
          }
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        if (upper.includes("COUNT(*)")) {
          // Honor the optional author-exclusion clause (bindings[1] = excludeUserId).
          const excludeUserId = upper.includes("REVIEWER_ID !=")
            ? (bindings[1] as string)
            : undefined;
          const approvals = reviews.filter(
            (r) =>
              r.change_id === bindings[0] &&
              r.verdict === "approve" &&
              r.reviewer_id !== excludeUserId,
          ).length;
          return { approvals } as T;
        }
        return null;
      },
      all: async <T>() => {
        let results: unknown[] = [];
        if (upper.startsWith("DELETE FROM CHANGE_REVIEWS")) {
          // Return the dismissed reviewer IDs so tests can assert on the
          // dismissal audit contract, not just a count.
          const dismissed: ReviewRow[] = [];
          for (let i = reviews.length - 1; i >= 0; i--) {
            const r = reviews[i];
            if (r && r.change_id === bindings[0] && r.verdict === "approve") {
              dismissed.push(r);
              reviews.splice(i, 1);
            }
          }
          results = dismissed.map((r) => ({ reviewer_id: r.reviewer_id }));
        } else if (upper.includes("FROM CHANGE_COMMENTS")) {
          results = comments
            .filter((r) => r.change_id === bindings[0])
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        } else if (upper.includes("FROM CHANGE_REVIEWS")) {
          results = reviews
            .filter((r) => r.change_id === bindings[0])
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        }
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, comments, reviews };
}

describe("change comments", () => {
  it("adds and lists comments in chronological order", async () => {
    const { db } = makeReviewsD1();
    await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "First",
    });
    await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "agent",
      authorId: "agent_1",
      body: "Second",
    });
    await addComment(db, mockLogger, {
      changeId: "chg_other",
      authorType: "user",
      authorId: "user_1",
      body: "Elsewhere",
    });

    const result = await listComments(db, mockLogger, "chg_1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((c) => c.body)).toEqual(["First", "Second"]);
    expect(result.data[1]?.authorType).toBe("agent");
  });
});

describe("change reviews", () => {
  it("records review verdicts per reviewer", async () => {
    const { db } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_2",
      verdict: "request_changes",
      comment: "Needs tests",
    });

    const result = await listReviews(db, mockLogger, "chg_1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.find((r) => r.reviewerId === "user_2")?.comment).toBe("Needs tests");
  });

  it("replaces a reviewer's previous verdict on re-review", async () => {
    const { db, reviews } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "request_changes",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.verdict).toBe("approve");
  });

  it("counts only approvals", async () => {
    const { db } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_2",
      verdict: "request_changes",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_3",
      verdict: "approve",
    });

    const count = await countApprovals(db, mockLogger, "chg_1");
    expect(count.success).toBe(true);
    if (!count.success) return;
    expect(count.data).toBe(2);
  });

  it("excludes the change author's own approval from the count", async () => {
    const { db } = makeReviewsD1();
    // The author (user_1) approves their own change, plus one independent approval.
    await submitReview(db, mockLogger, {
      changeId: "chg_2",
      reviewerId: "user_1",
      verdict: "approve",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_2",
      reviewerId: "user_2",
      verdict: "approve",
    });

    const withAuthor = await countApprovals(db, mockLogger, "chg_2");
    expect(withAuthor.success && withAuthor.data).toBe(2);

    // Excluding the author leaves only the independent approval — a lone writer
    // can no longer self-approve past requiredApprovals: 1.
    const excluded = await countApprovals(db, mockLogger, "chg_2", "user_1");
    expect(excluded.success && excluded.data).toBe(1);
  });
});

describe("stale approval dismissal (#193)", () => {
  it("dismisses only the change's approve verdicts and reports the count", async () => {
    const { db, reviews } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_2",
      verdict: "request_changes",
      comment: "Needs tests",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_other",
      reviewerId: "user_3",
      verdict: "approve",
    });

    const dismissed = await dismissApprovals(db, mockLogger, "chg_1");
    expect(dismissed.success).toBe(true);
    if (!dismissed.success) return;
    expect(dismissed.data).toEqual(["user_1"]);

    // request_changes survives the re-push (GitHub keeps those); the other
    // change's approval is untouched.
    const remaining = await listReviews(db, mockLogger, "chg_1");
    expect(remaining.success).toBe(true);
    if (!remaining.success) return;
    expect(remaining.data).toHaveLength(1);
    expect(remaining.data[0]?.verdict).toBe("request_changes");
    expect(reviews.filter((r) => r.change_id === "chg_other")).toHaveLength(1);
  });

  it("reports zero when there are no approvals to dismiss", async () => {
    const { db } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "request_changes",
    });

    const dismissed = await dismissApprovals(db, mockLogger, "chg_1");
    expect(dismissed.success && dismissed.data).toEqual([]);
  });

  it("stops counting dismissed approvals; a re-approve counts again", async () => {
    const { db } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });

    const before = await countApprovals(db, mockLogger, "chg_1");
    expect(before.success && before.data).toBe(1);

    await dismissApprovals(db, mockLogger, "chg_1");
    const after = await countApprovals(db, mockLogger, "chg_1");
    expect(after.success && after.data).toBe(0);

    // The reviewer looks at the new revision and approves again.
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    const reapproved = await countApprovals(db, mockLogger, "chg_1");
    expect(reapproved.success && reapproved.data).toBe(1);
  });

  it("blocks the merge after dismissal until re-approved", async () => {
    const { db } = makeReviewsD1();
    const change: Change = {
      id: "chg_1",
      project: "my-project",
      workspace: "ws-1",
      status: "accepted",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const policy: EvalPolicy = { evaluators: [], merge: { requiredApprovals: 1 } };

    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    const approved = await checkMergeProtection(db, mockLogger, change, policy);
    expect(approved.success && approved.data.allowed).toBe(true);

    await dismissApprovals(db, mockLogger, "chg_1");
    const blocked = await checkMergeProtection(db, mockLogger, change, policy);
    expect(blocked.success).toBe(true);
    if (!blocked.success) return;
    expect(blocked.data.allowed).toBe(false);
    expect(blocked.data.reasons[0]).toBe("Requires 1 approval, has 0");

    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    const reapproved = await checkMergeProtection(db, mockLogger, change, policy);
    expect(reapproved.success && reapproved.data.allowed).toBe(true);
  });

  it("returns a DATABASE_ERROR when the delete fails", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1 unavailable");
          },
        }),
      }),
    } as unknown as D1Database;

    const result = await dismissApprovals(db, mockLogger, "chg_1");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("DATABASE_ERROR");
  });
});
