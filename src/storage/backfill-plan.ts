import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { listProjects } from "./state";

/**
 * The seven project-scoped tables that gained a nullable `project_id` in
 * migration 025. Rows written before that migration keep `project_id` NULL and
 * are what a backfill would stamp. This is a FIXED allow-list — never user input
 * — so interpolating a name into the COUNT query below is safe.
 */
export const PROJECT_ID_TABLES = [
  "changes",
  "events",
  "provenance",
  "cost_records",
  "commit_metrics",
  "issues",
  "webhooks",
] as const;

export interface BackfillPlan {
  /** Per-table count of rows still missing a project_id (backfill candidates). */
  tables: { table: string; nullRows: number }[];
  totalNullRows: number;
  projects: {
    total: number;
    /** Projects whose NAME is unique — their legacy rows can be stamped safely
     *  by name, because no other project shares the name. */
    backfillable: number;
    /** Names shared by >1 project: their legacy rows can't be attributed by name
     *  alone and need manual resolution before a backfill touches them. */
    collisions: { name: string; projectIds: string[] }[];
  };
}

export interface WebhookBackfillSkip {
  webhookId: string;
  project: string;
  /** "ambiguous": name matches >1 project across namespaces. "unresolved": name matches none. */
  reason: "ambiguous" | "unresolved";
}

export interface WebhookBackfillReport {
  updated: number;
  skipped: WebhookBackfillSkip[];
  /** NULL project_id rows remaining in `webhooks` after this run — the step-2 verification. */
  remainingNullRows: number;
}

/**
 * DRY-RUN diagnostic for the KV→D1 project_id backfill. Reads only: reports how
 * much legacy (NULL project_id) data exists per table and which project names
 * are safe to backfill vs. which collide across namespaces and need manual
 * resolution. Mutates nothing — this is the "plan" half; the actual stamping is
 * a separate, deliberate operation.
 */
export async function computeBackfillPlan(
  env: Pick<Env, "DB" | "STATE">,
  logger: Logger,
): Promise<Result<BackfillPlan, AppError>> {
  try {
    const tables: { table: string; nullRows: number }[] = [];
    let totalNullRows = 0;
    for (const table of PROJECT_ID_TABLES) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id IS NULL`,
      ).first<{ n: number }>();
      const nullRows = row?.n ?? 0;
      tables.push({ table, nullRows });
      totalNullRows += nullRows;
    }

    const projectsResult = await listProjects(env.STATE, logger);
    if (!projectsResult.success) return err(projectsResult.error);

    const idsByName = new Map<string, string[]>();
    for (const project of projectsResult.data) {
      const ids = idsByName.get(project.name) ?? [];
      ids.push(project.id);
      idsByName.set(project.name, ids);
    }
    const collisions: { name: string; projectIds: string[] }[] = [];
    let backfillable = 0;
    for (const [name, ids] of idsByName) {
      if (ids.length === 1) backfillable++;
      else collisions.push({ name, projectIds: ids });
    }

    return ok({
      tables,
      totalNullRows,
      projects: { total: projectsResult.data.length, backfillable, collisions },
    });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to compute backfill plan",
            "DATABASE_ERROR",
            500,
            { operation: "computeBackfillPlan" },
          );
    logger.error("Failed to compute backfill plan", appError);
    return err(appError);
  }
}

/**
 * APPLY half of the KV→D1 project_id backfill, scoped to `webhooks` (see
 * {@link computeBackfillPlan} for the read-only survey across all seven
 * tables). For every `webhooks` row with a NULL `project_id`, resolves the
 * row's free-form `project` name against the KV project directory and stamps
 * `project_id` — but ONLY when the name resolves to exactly one project
 * across ALL namespaces.
 *
 * A name shared by more than one project ("ambiguous") or matching none
 * ("unresolved") is left NULL and reported rather than guessed: this is a
 * tenant-isolation boundary, not a best-effort heuristic, since guessing here
 * would silently attribute a legacy webhook (and its deliveries) to the wrong
 * tenant's namespace-mate.
 */
export async function backfillWebhookProjectIds(
  env: Pick<Env, "DB" | "STATE">,
  logger: Logger,
): Promise<Result<WebhookBackfillReport, AppError>> {
  try {
    const projectsResult = await listProjects(env.STATE, logger);
    if (!projectsResult.success) return err(projectsResult.error);

    // Single-pass name -> id resolution. A name is only ever backfillable while
    // it maps to exactly one id; the moment a second project claims the same
    // name it moves to `ambiguousNames` and is evicted from `nameToId` for good.
    const nameToId = new Map<string, string>();
    const ambiguousNames = new Set<string>();
    for (const project of projectsResult.data) {
      if (ambiguousNames.has(project.name)) continue;
      if (nameToId.has(project.name)) {
        nameToId.delete(project.name);
        ambiguousNames.add(project.name);
        continue;
      }
      nameToId.set(project.name, project.id);
    }

    const rows = await env.DB.prepare(
      "SELECT id, project FROM webhooks WHERE project_id IS NULL",
    ).all<{ id: string; project: string }>();

    const skipped: WebhookBackfillSkip[] = [];
    let updated = 0;
    for (const row of rows.results) {
      const projectId = nameToId.get(row.project);
      if (projectId === undefined) {
        const reason = ambiguousNames.has(row.project) ? "ambiguous" : "unresolved";
        skipped.push({ webhookId: row.id, project: row.project, reason });
        continue;
      }
      // Re-assert `project_id IS NULL` at write time: cheap defense against a
      // concurrent backfill run (or a delivery/update in between) re-stamping
      // an already-resolved row. That guard means the UPDATE can legitimately
      // match nothing, so count what it actually changed rather than how many
      // times it ran -- `updated` is the step-2 verification number and must
      // not report writes this run did not make.
      const result = await env.DB.prepare(
        "UPDATE webhooks SET project_id = ? WHERE id = ? AND project_id IS NULL",
      )
        .bind(projectId, row.id)
        .run();
      updated += result.meta.changes;
    }

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM webhooks WHERE project_id IS NULL",
    ).first<{ n: number }>();

    logger.info("Webhook project_id backfill applied", {
      updated,
      skipped: skipped.length,
      remainingNullRows: remaining?.n ?? 0,
    });

    return ok({ updated, skipped, remainingNullRows: remaining?.n ?? 0 });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to backfill webhook project_id",
            "DATABASE_ERROR",
            500,
            { operation: "backfillWebhookProjectIds" },
          );
    logger.error("Failed to backfill webhook project_id", appError);
    return err(appError);
  }
}
