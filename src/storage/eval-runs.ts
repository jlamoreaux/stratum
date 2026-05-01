import type { EvalResult } from "../evaluation/types";
import { newId } from "../utils/ids";

export interface EvalRun {
  id: string;
  changeId: string;
  evaluatorType: string;
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
  ranAt: string;
}

interface EvalRunRow {
  id: string;
  change_id: string;
  evaluator_type: string;
  score: number;
  passed: number;
  reason: string;
  issues: string | null;
  ran_at: string;
}

function rowToEvalRun(row: EvalRunRow): EvalRun {
  const run: EvalRun = {
    id: row.id,
    changeId: row.change_id,
    evaluatorType: row.evaluator_type,
    score: row.score,
    passed: row.passed === 1,
    reason: row.reason,
    ranAt: row.ran_at,
  };
  if (row.issues !== null) run.issues = JSON.parse(row.issues) as string[];
  return run;
}

export async function recordEvalRuns(
  db: D1Database,
  changeId: string,
  results: Array<{ evaluatorType: string; result: EvalResult }>,
): Promise<EvalRun[]> {
  const runs: EvalRun[] = [];

  for (const { evaluatorType, result } of results) {
    const id = newId("evl");
    const ranAt = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO eval_runs (id, change_id, evaluator_type, score, passed, reason, issues, ran_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        changeId,
        evaluatorType,
        result.score,
        result.passed ? 1 : 0,
        result.reason,
        result.issues !== undefined ? JSON.stringify(result.issues) : null,
        ranAt,
      )
      .run();

    const run: EvalRun = {
      id,
      changeId,
      evaluatorType,
      score: result.score,
      passed: result.passed,
      reason: result.reason,
      ranAt,
    };
    if (result.issues !== undefined) run.issues = result.issues;
    runs.push(run);
  }

  return runs;
}

export async function listEvalRuns(db: D1Database, changeId: string): Promise<EvalRun[]> {
  const result = await db
    .prepare("SELECT * FROM eval_runs WHERE change_id = ? ORDER BY ran_at ASC")
    .bind(changeId)
    .all<EvalRunRow>();

  return result.results.map(rowToEvalRun);
}
