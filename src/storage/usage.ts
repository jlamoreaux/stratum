import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import type { BillingSubject, CostKind, CostSource } from "./costs";

/**
 * A metered quantity an allowance can be set against, over a calendar month.
 *
 * The `_month` suffix is redundant with the row's `period` column and is kept
 * anyway: these are the strings an entitlement's limits are keyed on, so a
 * limit lookup is `limits[row.meter]` rather than a second mapping table that
 * could disagree with this one.
 *
 * `deploys_month` has no writer yet, deliberately — see `meterForCostKind`.
 */
export type MeterKey = "llm_tokens_month" | "sandbox_ms_month" | "deploys_month";

/** One meter's increment. Quantities are added, never replaced. */
export interface UsageDelta {
  meter: MeterKey;
  quantity: number;
  /**
   * Whose provider account paid. Omitted means `"platform"` — the operator's,
   * and so the only kind an allowance limits. Kept as a separate total rather
   * than summed in, because a limit applies to one of the two and not the
   * other; see migration 049.
   */
  source?: CostSource;
}

export interface UsageSummaryEntry {
  meter: MeterKey;
  source: CostSource;
  quantity: number;
  /** ISO 8601, app-written. When this owner last consumed this meter. */
  updatedAt: string;
}

interface UsageRow {
  meter: string;
  source: string;
  quantity: number;
  updated_at: string;
}

/**
 * The meter a cost sample accumulates into, or `null` when it accumulates into
 * none.
 *
 * `CostKind` and `MeterKey` are not the same vocabulary and are not meant to
 * be. A cost kind names a *resource consumed by one change*; a meter names a
 * *thing an allowance is set on*. Two align exactly:
 *
 * - `llm_tokens` -> `llm_tokens_month`
 * - `sandbox_ms` -> `sandbox_ms_month`
 *
 * `git_ops` maps to nothing. It is the count of clones and pushes an operation
 * performed — several per change — and there is no `git_ops_month` allowance
 * in the PRD's meter set. The tempting misreading is to route it to
 * `deploys_month`, which would be wrong in both directions: `post-merge.ts`
 * records `git_ops` for a merge that deploys nothing, and `deploy/runner.ts`
 * records one for a config read that may precede a deploy that never happens.
 * `deploys_month` counts `deployments` rows, so its writer is the deploy
 * consumer and not this function; the key exists in `MeterKey` now only so
 * that adding that writer needs no migration.
 */
export function meterForCostKind(kind: CostKind): MeterKey | null {
  switch (kind) {
    case "llm_tokens":
      return "llm_tokens_month";
    case "sandbox_ms":
      return "sandbox_ms_month";
    case "git_ops":
      return null;
  }
}

/**
 * The 'YYYY-MM' UTC period a moment falls in (PRD Open Question 1).
 *
 * Derived from the ISO string rather than `getMonth()` so it is UTC by
 * construction: a local-time month would put a spend just after midnight UTC
 * into the previous period for half the world, and two counters keyed on
 * different months are two allowances.
 *
 * @param at - The moment to classify; defaults to now
 * @returns The calendar month in 'YYYY-MM' form, UTC
 */
export function usagePeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/**
 * Add to an owner's meters for one period, creating the rows if they do not
 * exist yet.
 *
 * Each meter is a single SQLite UPSERT, which is where the correctness lives:
 * `ON CONFLICT ... DO UPDATE SET quantity = quantity + excluded.quantity` reads
 * and writes inside one statement, so concurrent recorders sum. A
 * read-then-write would let N of them all read the same total and each write
 * back "+1", losing N-1 increments — precisely the race
 * `MagicLinkRateLimiter`'s doc comment describes for KV counters.
 *
 * Deliberately not `db.batch`: the meters are independent, so cross-meter
 * atomicity buys nothing, and one statement per meter keeps the atomicity claim
 * at the statement where it is actually true. However many deltas arrive, only
 * as many statements run as there are distinct (meter, source) pairs.
 *
 * Best-effort by contract, like `recordCosts` which drives it: this returns a
 * Result and logs, and never throws into change creation, merge or deploy.
 *
 * @param subject - The account the usage is billed to
 * @param period - 'YYYY-MM' UTC, from `usagePeriod`
 * @param deltas - Increments to apply; same-meter entries are summed first
 * @returns Success, or the database error that stopped the accumulation
 */
export async function upsertUsage(
  db: D1Database,
  logger: Logger,
  subject: BillingSubject,
  period: string,
  deltas: readonly UsageDelta[],
): Promise<Result<void, AppError>> {
  // Keyed on both dimensions the row is keyed on, so platform and BYOK spend
  // for one meter accumulate as two totals rather than one.
  const merged = new Map<string, { meter: MeterKey; source: CostSource; quantity: number }>();
  for (const delta of deltas) {
    // A NaN or Infinity would poison the running total permanently: SQLite has
    // no way back from it and every later comparison against a limit would be
    // false. A NEGATIVE would do something worse than poison it — it would
    // refund the month, through the single statement that exists to stop the
    // month being refundable. Wall-clock arithmetic makes that reachable
    // without malice (`Date.now() - startedAt` under a backwards clock step).
    // Drop either and keep the meter usable; migration 049's CHECK is the
    // backstop if one ever gets past here.
    if (!Number.isFinite(delta.quantity) || delta.quantity < 0) {
      logger.warn("Usage delta skipped: quantity is not a usable increment", {
        ownerId: subject.ownerId,
        meter: delta.meter,
        quantity: delta.quantity,
      });
      continue;
    }
    const source: CostSource = delta.source ?? "platform";
    const key = `${delta.meter}\u0000${source}`;
    const existing = merged.get(key);
    merged.set(key, {
      meter: delta.meter,
      source,
      quantity: (existing?.quantity ?? 0) + delta.quantity,
    });
  }
  if (merged.size === 0) return ok(undefined);

  const updatedAt = new Date().toISOString();
  try {
    for (const { meter, source, quantity } of merged.values()) {
      await db
        .prepare(
          "INSERT INTO usage_periods (owner_id, owner_type, period, meter, source, quantity, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(owner_id, period, meter, source) DO UPDATE SET " +
            "quantity = quantity + excluded.quantity, updated_at = excluded.updated_at",
        )
        .bind(subject.ownerId, subject.ownerType, period, meter, source, quantity, updatedAt)
        .run();
    }
    logger.debug("Usage aggregate updated", {
      ownerId: subject.ownerId,
      period,
      meters: merged.size,
    });
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to accumulate usage",
            "DATABASE_ERROR",
            500,
            { operation: "upsertUsage", ownerId: subject.ownerId, period },
          );
    logger.error("Failed to accumulate usage", appError, { ownerId: subject.ownerId, period });
    return err(appError);
  }
}

/**
 * What one account consumed in one period, one entry per meter it touched.
 *
 * The period is a required argument rather than defaulted to the current month
 * for the reason the PRD gives for `UsageMeter`'s `nowMs`: the caller decides
 * which window it is asking about, so one request cannot straddle a boundary
 * and read half of each. Meters with no rows are absent rather than zero —
 * "never used" and "used nothing" are the same fact, and the caller knows the
 * meter set it wants to display.
 *
 * @param ownerId - The billing subject's id
 * @param period - 'YYYY-MM' UTC, from `usagePeriod`
 * @returns The per-meter totals, or the database error
 */
export async function getOwnerUsageSummary(
  db: D1Database,
  logger: Logger,
  ownerId: string,
  period: string,
): Promise<Result<UsageSummaryEntry[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT meter, source, quantity, updated_at FROM usage_periods WHERE owner_id = ? AND period = ? ORDER BY meter, source",
      )
      .bind(ownerId, period)
      .all<UsageRow>();
    return ok(
      result.results.map((row) => ({
        // Cast, not validated: the column carries no CHECK on purpose (see
        // migration 049), so a row written by a future meter this build does
        // not know about reads through rather than failing the whole summary.
        meter: row.meter as MeterKey,
        source: row.source as CostSource,
        quantity: row.quantity,
        updatedAt: row.updated_at,
      })),
    );
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to summarize usage",
            "DATABASE_ERROR",
            500,
            { operation: "getOwnerUsageSummary", ownerId, period },
          );
    logger.error("Failed to get owner usage summary", appError, { ownerId, period });
    return err(appError);
  }
}
