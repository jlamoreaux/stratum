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
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_pr_state: string | null;
  promoted_at: string | null;
  promoted_by: string | null;
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
  if (row.github_owner !== null) change.githubOwner = row.github_owner;
  if (row.github_repo !== null) change.githubRepo = row.github_repo;
  if (row.github_branch !== null) change.githubBranch = row.github_branch;
  if (row.github_pr_number !== null) change.githubPrNumber = row.github_pr_number;
  if (row.github_pr_url !== null) change.githubPrUrl = row.github_pr_url;
  if (row.github_pr_state !== null) change.githubPrState = row.github_pr_state;
  if (row.promoted_at !== null) change.promotedAt = row.promoted_at;
  if (row.promoted_by !== null) change.promotedBy = row.promoted_by;
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
    githubOwner?: string;
    githubRepo?: string;
    githubBranch?: string;
    githubPrNumber?: number;
    githubPrUrl?: string;
    githubPrState?: string;
    promotedAt?: string;
    promotedBy?: string;
  },
): Promise<void> {
  const assignments = ["status = ?"];
  const bindings: unknown[] = [status];

  const addOptional = (column: string, value: unknown) => {
    if (value === undefined) return;
    assignments.push(`${column} = ?`);
    bindings.push(value);
  };

  addOptional("eval_score", opts?.evalScore);
  addOptional(
    "eval_passed",
    opts?.evalPassed !== undefined ? (opts.evalPassed ? 1 : 0) : undefined,
  );
  addOptional("eval_reason", opts?.evalReason);
  addOptional("merged_at", opts?.mergedAt);
  addOptional("github_owner", opts?.githubOwner);
  addOptional("github_repo", opts?.githubRepo);
  addOptional("github_branch", opts?.githubBranch);
  addOptional("github_pr_number", opts?.githubPrNumber);
  addOptional("github_pr_url", opts?.githubPrUrl);
  addOptional("github_pr_state", opts?.githubPrState);
  addOptional("promoted_at", opts?.promotedAt);
  addOptional("promoted_by", opts?.promotedBy);

  bindings.push(id);

  await db
    .prepare(`UPDATE changes SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();
}
