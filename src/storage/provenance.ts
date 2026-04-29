import { newId } from '../utils/ids';

export interface ProvenanceRecord {
  id: string;
  commitSha: string;
  project: string;
  workspace: string;
  changeId: string;
  agentId?: string;
  evalScore?: number;
  mergedAt: string;
}

interface ProvenanceRow {
  id: string;
  commit_sha: string;
  project: string;
  workspace: string;
  change_id: string;
  agent_id: string | null;
  eval_score: number | null;
  merged_at: string;
}

function rowToRecord(row: ProvenanceRow): ProvenanceRecord {
  const record: ProvenanceRecord = {
    id: row.id,
    commitSha: row.commit_sha,
    project: row.project,
    workspace: row.workspace,
    changeId: row.change_id,
    mergedAt: row.merged_at,
  };
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.eval_score !== null) record.evalScore = row.eval_score;
  return record;
}

export async function recordProvenance(
  db: D1Database,
  opts: {
    commitSha: string;
    project: string;
    workspace: string;
    changeId: string;
    agentId?: string;
    evalScore?: number;
  },
): Promise<ProvenanceRecord> {
  const id = newId('prv');
  const mergedAt = new Date().toISOString();

  await db
    .prepare(
      'INSERT INTO provenance (id, commit_sha, project, workspace, change_id, agent_id, eval_score, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      opts.commitSha,
      opts.project,
      opts.workspace,
      opts.changeId,
      opts.agentId ?? null,
      opts.evalScore ?? null,
      mergedAt,
    )
    .run();

  const record: ProvenanceRecord = {
    id,
    commitSha: opts.commitSha,
    project: opts.project,
    workspace: opts.workspace,
    changeId: opts.changeId,
    mergedAt,
  };
  if (opts.agentId !== undefined) record.agentId = opts.agentId;
  if (opts.evalScore !== undefined) record.evalScore = opts.evalScore;
  return record;
}

export async function getProvenance(db: D1Database, changeId: string): Promise<ProvenanceRecord | null> {
  const row = await db
    .prepare('SELECT * FROM provenance WHERE change_id = ?')
    .bind(changeId)
    .first<ProvenanceRow>();

  return row ? rowToRecord(row) : null;
}

export async function listProvenance(
  db: D1Database,
  project: string,
  limit = 50,
): Promise<ProvenanceRecord[]> {
  const result = await db
    .prepare('SELECT * FROM provenance WHERE project = ? ORDER BY merged_at DESC LIMIT ?')
    .bind(project, limit)
    .all<ProvenanceRow>();

  return result.results.map(rowToRecord);
}
