import type { Change } from "../types";
import { newId } from "../utils/ids";

interface ChangeRow {
  id: string;
  project: string;
  workspace: string;
  status: string;
  agent_id: string | null;
  eval_score: number | null;
  eval_passed: number | null;
  eval_reason: string | null;
  created_at: string;
  merged_at: string | null;
}

function rowToChange(row: ChangeRow): Change {
  const change: Change = {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    status: row.status as Change["status"],
    createdAt: row.created_at,
  };
  if (row.agent_id !== null) change.agentId = row.agent_id;
  if (row.eval_score !== null) change.evalScore = row.eval_score;
  if (row.eval_passed !== null) change.evalPassed = row.eval_passed === 1;
  if (row.eval_reason !== null) change.evalReason = row.eval_reason;
  if (row.merged_at !== null) change.mergedAt = row.merged_at;
  return change;
}

export async function createChange(
  db: D1Database,
  opts: {
    project: string;
    workspace: string;
    agentId?: string;
  },
): Promise<Change> {
  const id = newId("chg");
  const createdAt = new Date().toISOString();

  await db
    .prepare(
      "INSERT INTO changes (id, project, workspace, status, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, opts.project, opts.workspace, "open", opts.agentId ?? null, createdAt)
    .run();

  const change: Change = {
    id,
    project: opts.project,
    workspace: opts.workspace,
    status: "open",
    createdAt,
  };
  if (opts.agentId !== undefined) change.agentId = opts.agentId;
  return change;
}

export async function getChange(db: D1Database, id: string): Promise<Change | null> {
  const row = await db.prepare("SELECT * FROM changes WHERE id = ?").bind(id).first<ChangeRow>();

  return row ? rowToChange(row) : null;
}

export async function listChanges(
  db: D1Database,
  project: string,
  status?: Change["status"],
): Promise<Change[]> {
  const result = status
    ? await db
        .prepare("SELECT * FROM changes WHERE project = ? AND status = ? ORDER BY created_at DESC")
        .bind(project, status)
        .all<ChangeRow>()
    : await db
        .prepare("SELECT * FROM changes WHERE project = ? ORDER BY created_at DESC")
        .bind(project)
        .all<ChangeRow>();

  return result.results.map(rowToChange);
}

export async function updateChangeStatus(
  db: D1Database,
  id: string,
  status: Change["status"],
  opts?: {
    evalScore?: number;
    evalPassed?: boolean;
    evalReason?: string;
    mergedAt?: string;
  },
): Promise<void> {
  await db
    .prepare(
      "UPDATE changes SET status = ?, eval_score = ?, eval_passed = ?, eval_reason = ?, merged_at = ? WHERE id = ?",
    )
    .bind(
      status,
      opts?.evalScore ?? null,
      opts?.evalPassed !== undefined ? (opts.evalPassed ? 1 : 0) : null,
      opts?.evalReason ?? null,
      opts?.mergedAt ?? null,
      id,
    )
    .run();
}
