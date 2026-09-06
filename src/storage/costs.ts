import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { getAgent } from "./agents";

export type CostKind = "llm_tokens" | "sandbox_ms" | "git_ops";

/**
 * Whose provider account paid for a sample: the operator's (`platform`) or the
 * project's own credential (`byok`). Recorded per sample rather than per change
 * because one evaluation can mix the two — a BYOK `llm` evaluator alongside
 * git operations that are always the operator's cost.
 */
export type CostSource = "platform" | "byok";

export interface CostSample {
  kind: CostKind;
  quantity: number;
  /** True when the quantity is an estimate (e.g. character-based token counts). */
  estimated?: boolean;
  /** Defaults to `"platform"`: an evaluator that says nothing spent our money. */
  source?: CostSource;
}

/**
 * An account a cost row can actually be billed to.
 *
 * Narrower than `ProjectEntry.ownerType`, which also admits `"agent"` — see
 * `resolveBillingSubject`, which is the only thing allowed to make that mapping.
 */
export interface BillingSubject {
  ownerId: string;
  ownerType: "user" | "org";
}

export interface CostSummaryEntry {
  kind: CostKind;
  total: number;
  estimated: boolean;
}

interface SummaryRow {
  kind: string;
  total: number;
  any_estimated: number;
}

/**
 * The account that owes for spend incurred on behalf of `owner`, or `null` when
 * no account can be named.
 *
 * The single home for the `ownerType -> billing subject` mapping: every
 * recording site resolves through here so the agent walk and the
 * cannot-be-attributed rule exist once rather than at each of them. Accepts a whole
 * `ProjectEntry` (structurally) or a bare owner pair.
 *
 * An **agent is not a payer** — it belongs to one — so `"agent"` walks
 * `agents.owner_id` (migrations/001_core.sql) to the user that owns it.
 * `billingContextFor` (src/services/change-flow.ts) deliberately does not do
 * this: it is synchronous and KV-only, while this needs D1. No creation path
 * writes `ownerType: "agent"` today, so that branch is defensive against
 * restored backups and future ownership transfer, not a live code path.
 *
 * **Never throws.** `recordCosts` is best-effort by contract and runs inside
 * change creation, merge and deploy; an unresolvable owner must cost the
 * attribution, never the change. Every failure returns `null` and logs — a row
 * with a NULL owner is honest about being unattributed, which is why migration
 * 048 leaves those columns nullable.
 *
 * @param owner - A `ProjectEntry`, or any object carrying its owner fields
 * @returns The billing subject, or `null` when none can be named
 */
export async function resolveBillingSubject(
  db: D1Database,
  logger: Logger,
  // Spelled out rather than `ProjectEntry["ownerType"]` on purpose: if a fourth
  // owner kind is ever added, this must fail to compile so someone decides who
  // pays, instead of silently falling through to the agent walk.
  owner: { ownerId?: string; ownerType?: "user" | "org" | "agent" },
): Promise<BillingSubject | null> {
  const { ownerId, ownerType } = owner;
  // KV entries are cast without shape validation and legacy rows genuinely lack
  // fields, so the type's promise is not a runtime guarantee.
  if (!ownerId || !ownerType) {
    logger.warn("Cost attribution skipped: project names no owner", { ownerId, ownerType });
    return null;
  }
  if (ownerType === "user" || ownerType === "org") return { ownerId, ownerType };

  const agentResult = await getAgent(db, ownerId, logger);
  if (!agentResult.success) {
    logger.warn("Cost attribution skipped: agent owner could not be resolved to a user", {
      agentId: ownerId,
      error: agentResult.error.message,
    });
    return null;
  }
  // No emptiness check on the resolved id, unlike the owner fields above:
  // `agents.owner_id` is NOT NULL and REFERENCES users(id), and D1 enforces
  // foreign keys, so a row that exists names a user that exists.
  return { ownerId: agentResult.data.ownerId, ownerType: "user" };
}

/**
 * Record cost samples for a change. Best-effort: failures are logged and
 * reported, but callers treat cost recording as non-blocking.
 *
 * `ownerId`/`ownerType` name who pays, and come from `resolveBillingSubject` —
 * omitting them records the spend unattributed rather than refusing to record
 * it, because a sample nobody can be billed for is still a sample that happened.
 */
export async function recordCosts(
  db: D1Database,
  logger: Logger,
  opts: {
    project: string;
    projectId?: string;
    changeId?: string;
    workspace?: string;
    ownerId?: string;
    ownerType?: BillingSubject["ownerType"];
  },
  samples: CostSample[],
): Promise<Result<void, AppError>> {
  if (samples.length === 0) return ok(undefined);
  const createdAt = new Date().toISOString();

  try {
    const stmt = db.prepare(
      "INSERT INTO cost_records (id, project, project_id, change_id, workspace, kind, quantity, estimated, created_at, owner_id, owner_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await db.batch(
      samples.map((sample) =>
        stmt.bind(
          newId("cost"),
          opts.project,
          opts.projectId ?? null,
          opts.changeId ?? null,
          opts.workspace ?? null,
          sample.kind,
          sample.quantity,
          sample.estimated ? 1 : 0,
          createdAt,
          opts.ownerId ?? null,
          opts.ownerType ?? null,
          // Bound explicitly rather than left to the column DEFAULT: the column
          // is NOT NULL, so an unset source must resolve here, not in SQLite.
          sample.source ?? "platform",
        ),
      ),
    );
    logger.debug("Cost samples recorded", {
      project: opts.project,
      changeId: opts.changeId,
      count: samples.length,
    });
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to record costs",
            "DATABASE_ERROR",
            500,
            { operation: "recordCosts", project: opts.project },
          );
    logger.error("Failed to record cost samples", appError, { project: opts.project });
    return err(appError);
  }
}

export async function getChangeCostSummary(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<CostSummaryEntry[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT kind, SUM(quantity) AS total, MAX(estimated) AS any_estimated FROM cost_records WHERE change_id = ? GROUP BY kind",
      )
      .bind(changeId)
      .all<SummaryRow>();
    return ok(
      result.results.map((row) => ({
        kind: row.kind as CostKind,
        total: row.total,
        estimated: row.any_estimated === 1,
      })),
    );
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to summarize costs",
            "DATABASE_ERROR",
            500,
            { operation: "getChangeCostSummary", changeId },
          );
    logger.error("Failed to get change cost summary", appError, { changeId });
    return err(appError);
  }
}

export async function getProjectCostSummary(
  db: D1Database,
  logger: Logger,
  project: string,
): Promise<Result<CostSummaryEntry[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT kind, SUM(quantity) AS total, MAX(estimated) AS any_estimated FROM cost_records WHERE project = ? GROUP BY kind",
      )
      .bind(project)
      .all<SummaryRow>();
    return ok(
      result.results.map((row) => ({
        kind: row.kind as CostKind,
        total: row.total,
        estimated: row.any_estimated === 1,
      })),
    );
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to summarize costs",
            "DATABASE_ERROR",
            500,
            { operation: "getProjectCostSummary", project },
          );
    logger.error("Failed to get project cost summary", appError, { project });
    return err(appError);
  }
}
