import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import { changesRouter } from '../src/routes/changes';
import type { Change, Env } from '../src/types';

vi.mock('../src/storage/changes', () => ({
  createChange: vi.fn(),
  getChange: vi.fn(),
  listChanges: vi.fn(),
  updateChangeStatus: vi.fn(),
}));

vi.mock('../src/storage/git-ops', () => ({
  getDiffBetweenRepos: vi.fn(),
  mergeWorkspaceIntoProject: vi.fn(),
}));

vi.mock('../src/storage/state', () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock('../src/evaluation', () => ({
  loadPolicy: vi.fn(),
  DiffEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn(),
  })),
  WebhookEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn(),
  })),
  CompositeEvaluator: vi.fn().mockImplementation(() => ({
    evaluateAndAggregate: vi.fn(),
  })),
}));

vi.mock('../src/storage/provenance', () => ({
  recordProvenance: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/queue/events', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/storage/users', () => ({
  getUserByToken: vi.fn(),
}));

vi.mock('../src/storage/agents', () => ({
  getAgentByToken: vi.fn(),
}));

import { createChange, getChange, listChanges, updateChangeStatus } from '../src/storage/changes';
import { getDiffBetweenRepos, mergeWorkspaceIntoProject } from '../src/storage/git-ops';
import { getProject, getWorkspace } from '../src/storage/state';
import { loadPolicy, CompositeEvaluator } from '../src/evaluation';

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', authMiddleware);
  app.route('/api', changesRouter);
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env['ARTIFACTS'],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

function request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

const mockProject = {
  name: 'my-project',
  remote: 'https://artifacts.example.com/repos/my-project',
  token: 'tok_project',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const mockWorkspace = {
  name: 'fix-bug',
  remote: 'https://artifacts.example.com/repos/fix-bug',
  token: 'tok_workspace',
  parent: 'my-project',
  createdAt: '2026-01-01T01:00:00.000Z',
};

const mockChange: Change = {
  id: 'chg_abc123',
  project: 'my-project',
  workspace: 'fix-bug',
  status: 'open',
  createdAt: '2026-01-01T02:00:00.000Z',
};

const mockPolicy = {
  evaluators: [{ type: 'diff' as const }],
  requireAll: true,
  minScore: 0.7,
};

const passingEvalResult = {
  score: 1.0,
  passed: true,
  reason: 'Diff passed all checks.',
};

const failingEvalResult = {
  score: 0.2,
  passed: false,
  reason: 'Diff failed: too many lines.',
};

describe('POST /api/projects/:name/changes', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(getWorkspace).mockResolvedValue(mockWorkspace);
    vi.mocked(createChange).mockResolvedValue(mockChange);
    vi.mocked(loadPolicy).mockResolvedValue(mockPolicy);
    vi.mocked(getDiffBetweenRepos).mockResolvedValue('diff --git a/src/index.ts b/src/index.ts\n+new line');
    vi.mocked(updateChangeStatus).mockResolvedValue(undefined);
    vi.mocked(CompositeEvaluator).mockImplementation(() => ({
      evaluateAndAggregate: vi.fn().mockResolvedValue(passingEvalResult),
    }) as unknown as CompositeEvaluator);
  });

  it('creates a change, runs evaluators, and returns approved status when eval passes', async () => {
    const res = await app.fetch(
      request('POST', '/api/projects/my-project/changes', { workspace: 'fix-bug' }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { change: Change; eval: typeof passingEvalResult };
    expect(body.change.status).toBe('approved');
    expect(body.change.evalPassed).toBe(true);
    expect(body.eval.passed).toBe(true);
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      'chg_abc123',
      'approved',
      expect.objectContaining({ evalPassed: true }),
    );
  });

  it('returns open status when eval fails', async () => {
    vi.mocked(CompositeEvaluator).mockImplementation(() => ({
      evaluateAndAggregate: vi.fn().mockResolvedValue(failingEvalResult),
    }) as unknown as CompositeEvaluator);

    const res = await app.fetch(
      request('POST', '/api/projects/my-project/changes', { workspace: 'fix-bug' }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { change: Change; eval: typeof failingEvalResult };
    expect(body.change.status).toBe('open');
    expect(body.change.evalPassed).toBe(false);
    expect(body.eval.passed).toBe(false);
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      'chg_abc123',
      'open',
      expect.objectContaining({ evalPassed: false }),
    );
  });

  it('returns 404 when project not found', async () => {
    vi.mocked(getProject).mockResolvedValue(null);
    const res = await app.fetch(
      request('POST', '/api/projects/no-such-project/changes', { workspace: 'fix-bug' }),
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('no-such-project');
  });

  it('returns 400 when workspace is missing from body', async () => {
    const res = await app.fetch(
      request('POST', '/api/projects/my-project/changes', {}),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when workspace does not exist', async () => {
    vi.mocked(getWorkspace).mockResolvedValue(null);
    const res = await app.fetch(
      request('POST', '/api/projects/my-project/changes', { workspace: 'nonexistent' }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when workspace does not belong to project', async () => {
    vi.mocked(getWorkspace).mockResolvedValue({ ...mockWorkspace, parent: 'other-project' });
    const res = await app.fetch(
      request('POST', '/api/projects/my-project/changes', { workspace: 'fix-bug' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('does not belong to project');
  });
});

describe('GET /api/projects/:name/changes', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(listChanges).mockResolvedValue([mockChange]);
  });

  it('lists changes for a project', async () => {
    const res = await app.fetch(
      request('GET', '/api/projects/my-project/changes'),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: string; changes: Change[] };
    expect(body.project).toBe('my-project');
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]?.id).toBe('chg_abc123');
    expect(listChanges).toHaveBeenCalledWith(env.DB, 'my-project', undefined);
  });

  it('filters by status when ?status= is provided', async () => {
    vi.mocked(listChanges).mockResolvedValue([]);
    const res = await app.fetch(
      request('GET', '/api/projects/my-project/changes?status=open'),
      env,
    );
    expect(res.status).toBe(200);
    expect(listChanges).toHaveBeenCalledWith(env.DB, 'my-project', 'open');
  });

  it('returns 404 when project not found', async () => {
    vi.mocked(getProject).mockResolvedValue(null);
    const res = await app.fetch(
      request('GET', '/api/projects/nope/changes'),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/changes/:id', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
  });

  it('returns a single change by id', async () => {
    vi.mocked(getChange).mockResolvedValue(mockChange);
    const res = await app.fetch(
      request('GET', '/api/changes/chg_abc123'),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change: Change };
    expect(body.change.id).toBe('chg_abc123');
    expect(body.change.project).toBe('my-project');
  });

  it('returns 404 when change not found', async () => {
    vi.mocked(getChange).mockResolvedValue(null);
    const res = await app.fetch(
      request('GET', '/api/changes/chg_missing'),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/changes/:id/merge', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getProject).mockResolvedValue(mockProject);
    vi.mocked(getWorkspace).mockResolvedValue(mockWorkspace);
    vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue('sha_merged');
    vi.mocked(updateChangeStatus).mockResolvedValue(undefined);
  });

  it('merges an approved change and returns merged=true', async () => {
    const approvedChange: Change = { ...mockChange, status: 'approved' };
    vi.mocked(getChange).mockResolvedValue(approvedChange);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_abc123/merge'),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merged: boolean;
      changeId: string;
      project: string;
      workspace: string;
      commit: string;
    };
    expect(body.merged).toBe(true);
    expect(body.changeId).toBe('chg_abc123');
    expect(body.project).toBe('my-project');
    expect(body.workspace).toBe('fix-bug');
    expect(body.commit).toBe('sha_merged');
    expect(mergeWorkspaceIntoProject).toHaveBeenCalled();
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      'chg_abc123',
      'merged',
      expect.objectContaining({ mergedAt: expect.any(String) }),
    );
  });

  it('returns 400 when change is not approved', async () => {
    vi.mocked(getChange).mockResolvedValue(mockChange);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_abc123/merge'),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('approved');
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });

  it('merges even non-approved change when ?force=true', async () => {
    vi.mocked(getChange).mockResolvedValue(mockChange);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_abc123/merge?force=true'),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean };
    expect(body.merged).toBe(true);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalled();
  });

  it('returns 404 when change not found', async () => {
    vi.mocked(getChange).mockResolvedValue(null);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_missing/merge'),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/changes/:id/reject', () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(updateChangeStatus).mockResolvedValue(undefined);
  });

  it('rejects an open change', async () => {
    vi.mocked(getChange).mockResolvedValue(mockChange);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_abc123/reject'),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: boolean; changeId: string };
    expect(body.rejected).toBe(true);
    expect(body.changeId).toBe('chg_abc123');
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      'chg_abc123',
      'rejected',
      expect.any(Object),
    );
  });

  it('returns 400 when trying to reject a merged change', async () => {
    const mergedChange: Change = { ...mockChange, status: 'merged', mergedAt: '2026-01-01T03:00:00.000Z' };
    vi.mocked(getChange).mockResolvedValue(mergedChange);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_abc123/reject'),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Cannot reject a merged change');
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it('returns 404 when change not found', async () => {
    vi.mocked(getChange).mockResolvedValue(null);

    const res = await app.fetch(
      request('POST', '/api/changes/chg_missing/reject'),
      env,
    );
    expect(res.status).toBe(404);
  });
});
