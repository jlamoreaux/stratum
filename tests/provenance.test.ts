import { beforeEach, describe, expect, it } from 'vitest';
import { recordProvenance, getProvenance, listProvenance } from '../src/storage/provenance';
import type { ProvenanceRecord } from '../src/storage/provenance';

interface StoredRow {
  id: string;
  commit_sha: string;
  project: string;
  workspace: string;
  change_id: string;
  agent_id: string | null;
  eval_score: number | null;
  merged_at: string;
}

function makeD1(): D1Database {
  const rows: StoredRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('INSERT INTO PROVENANCE')) {
          rows.push({
            id: bindings[0] as string,
            commit_sha: bindings[1] as string,
            project: bindings[2] as string,
            workspace: bindings[3] as string,
            change_id: bindings[4] as string,
            agent_id: (bindings[5] as string | null) ?? null,
            eval_score: (bindings[6] as number | null) ?? null,
            merged_at: bindings[7] as string,
          });
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT * FROM PROVENANCE WHERE CHANGE_ID')) {
          const changeId = bindings[0] as string;
          const row = rows.find((r) => r.change_id === changeId);
          return (row ?? null) as T | null;
        }
        return null as T | null;
      },
      all: async <T>() => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT * FROM PROVENANCE WHERE PROJECT')) {
          const project = bindings[0] as string;
          const limit = bindings[1] as number;
          const filtered = rows
            .filter((r) => r.project === project)
            .sort((a, b) => (a.merged_at < b.merged_at ? 1 : a.merged_at > b.merged_at ? -1 : 0))
            .slice(0, limit);
          return { results: filtered as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
    };
  }

  return {
    prepare: (sql: string) => makeStmt(sql, []),
  } as unknown as D1Database;
}

const baseOpts = {
  commitSha: 'abc123def456',
  project: 'my-project',
  workspace: 'fix-bug',
  changeId: 'chg_test001',
};

describe('recordProvenance', () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it('creates a record with correct fields', async () => {
    const record = await recordProvenance(db, baseOpts);
    expect(record.commitSha).toBe('abc123def456');
    expect(record.project).toBe('my-project');
    expect(record.workspace).toBe('fix-bug');
    expect(record.changeId).toBe('chg_test001');
    expect(record.id).toMatch(/^prv_/);
    expect(record.mergedAt).toBeTruthy();
  });

  it('stores optional agentId and evalScore', async () => {
    const record = await recordProvenance(db, {
      ...baseOpts,
      agentId: 'agt_xyz',
      evalScore: 0.95,
    });
    expect(record.agentId).toBe('agt_xyz');
    expect(record.evalScore).toBe(0.95);
  });

  it('omits agentId and evalScore when not provided', async () => {
    const record = await recordProvenance(db, baseOpts);
    expect(record.agentId).toBeUndefined();
    expect(record.evalScore).toBeUndefined();
  });
});

describe('getProvenance', () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it('returns record by changeId', async () => {
    await recordProvenance(db, baseOpts);
    const record = await getProvenance(db, 'chg_test001');
    expect(record).not.toBeNull();
    expect(record?.changeId).toBe('chg_test001');
    expect(record?.commitSha).toBe('abc123def456');
  });

  it('returns null for unknown changeId', async () => {
    const record = await getProvenance(db, 'chg_missing');
    expect(record).toBeNull();
  });
});

describe('listProvenance', () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1();
  });

  it('returns records for a project', async () => {
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_001' });
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_002' });
    const records = await listProvenance(db, 'my-project');
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.project === 'my-project')).toBe(true);
  });

  it('does not return records for a different project', async () => {
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_001' });
    await recordProvenance(db, { ...baseOpts, project: 'other-project', changeId: 'chg_002' });
    const records = await listProvenance(db, 'my-project');
    expect(records).toHaveLength(1);
    expect(records[0]?.changeId).toBe('chg_001');
  });

  it('respects the limit parameter', async () => {
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_001' });
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_002' });
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_003' });
    const records = await listProvenance(db, 'my-project', 2);
    expect(records).toHaveLength(2);
  });

  it('sorts multiple records by merged_at descending', async () => {
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_001' });
    await new Promise((r) => setTimeout(r, 2));
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_002' });
    await new Promise((r) => setTimeout(r, 2));
    await recordProvenance(db, { ...baseOpts, changeId: 'chg_003' });
    const records = await listProvenance(db, 'my-project');
    expect(records[0]?.changeId).toBe('chg_003');
    expect(records[records.length - 1]?.changeId).toBe('chg_001');
  });

  it('returns empty array for project with no records', async () => {
    const records = await listProvenance(db, 'nonexistent-project');
    expect(records).toHaveLength(0);
  });
});
