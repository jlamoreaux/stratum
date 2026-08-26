import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Free-form label strings per issue (migration 036). Deliberately a flat
 * (issue_id, label) table instead of a label catalog + join: at this scale the
 * only operations are set/remove/list/filter, and a catalog (colors,
 * descriptions) can layer on later without rewriting these rows.
 */

/**
 * Normalise a thrown value into an `AppError`, preserving one that is already
 * an AppError and tagging anything else as DATABASE_ERROR with the operation
 * and context attached for the log line.
 *
 * @returns The existing `AppError`, or a new database error carrying the operation and context
 */
function toAppError(error: unknown, operation: string, context: Record<string, unknown>) {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed in ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation, ...context },
      );
}

/**
 * Replace an issue's label set. The full set is written each time (a delete +
 * inserts in one atomic batch), which keeps "add" and "remove" a single
 * operation and makes the endpoint idempotent.
 *
 * @returns The deduplicated labels stored for the issue, or an application error on failure
 */
export async function setIssueLabels(
  db: D1Database,
  logger: Logger,
  issueId: string,
  labels: string[],
): Promise<Result<string[], AppError>> {
  const createdAt = new Date().toISOString();
  // Dedupe exact strings; SQL would reject duplicates on the primary key.
  const unique = [...new Set(labels)];

  try {
    const statements = [
      db.prepare("DELETE FROM issue_labels WHERE issue_id = ?").bind(issueId),
      ...unique.map((label) =>
        db
          .prepare("INSERT INTO issue_labels (issue_id, label, created_at) VALUES (?, ?, ?)")
          .bind(issueId, label, createdAt),
      ),
    ];
    await db.batch(statements);
    logger.info("Issue labels set", { issueId, count: unique.length });
    return ok(unique);
  } catch (error) {
    const appError = toAppError(error, "setIssueLabels", { issueId });
    logger.error("Failed to set issue labels", appError, { issueId });
    return err(appError);
  }
}

/** Labels for one issue, sorted for stable display. */
export async function listIssueLabels(
  db: D1Database,
  logger: Logger,
  issueId: string,
): Promise<Result<string[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label ASC")
      .bind(issueId)
      .all<{ label: string }>();
    return ok(result.results.map((r) => r.label));
  } catch (error) {
    const appError = toAppError(error, "listIssueLabels", { issueId });
    logger.error("Failed to list issue labels", appError, { issueId });
    return err(appError);
  }
}

/**
 * D1 caps how many parameters a single query may bind; `getLabelsForIssues`
 * chunks its `IN (...)` list to stay under it. `src/storage/d1-backup.ts`
 * carries the same value for its batched restore inserts.
 */
export const MAX_D1_BINDS = 100;

/**
 * Labels for many issues, chunked to respect D1's bind ceiling — D1 allows at
 * most MAX_D1_BINDS bound parameters per statement, and both the API (up to 500
 * ids) and the issues page can exceed that in one call. Exceeding it raises
 * `SQLITE_ERROR: too many SQL variables`, which surfaced as a 500 from the API
 * and as silently label-less issues in the UI.
 *
 * @param issueIds - The issue identifiers whose labels should be retrieved
 * @returns A map of issue id to sorted labels; issues without labels are absent, not empty arrays
 */
export async function getLabelsForIssues(
  db: D1Database,
  logger: Logger,
  issueIds: string[],
): Promise<Result<Record<string, string[]>, AppError>> {
  if (issueIds.length === 0) return ok({});
  try {
    const byIssue: Record<string, string[]> = {};
    // One `?` is bound per issue id, and D1 caps bound parameters per query, so a
    // single IN (...) over a whole page would fail outright once the page grows
    // past that ceiling. Chunk the ids and merge. (`src/storage/d1-backup.ts`
    // encodes the same platform limit for its batched inserts.)
    for (let i = 0; i < issueIds.length; i += MAX_D1_BINDS) {
      const chunk = issueIds.slice(i, i + MAX_D1_BINDS);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT issue_id, label FROM issue_labels WHERE issue_id IN (${placeholders}) ORDER BY label ASC`,
        )
        .bind(...chunk)
        .all<{ issue_id: string; label: string }>();
      for (const row of result.results) {
        const labels = byIssue[row.issue_id] ?? [];
        labels.push(row.label);
        byIssue[row.issue_id] = labels;
      }
    }
    return ok(byIssue);
  } catch (error) {
    const appError = toAppError(error, "getLabelsForIssues", { count: issueIds.length });
    logger.error("Failed to load labels for issues", appError, {});
    return err(appError);
  }
}
