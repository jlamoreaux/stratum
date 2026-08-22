/**
 * Tests for issue #197: the change-detail UI route threads provenance, merge
 * metadata (mergedAt, githubPrUrl), and evaluator issues into ChangeDetailPage.
 *
 * Verifies that GET /changes/:id:
 * - renders the provenance card when a provenance record exists for the change,
 *   and omits it when getProvenance returns not-found;
 * - renders the merged timestamp and the "Open GitHub PR" action from the
 *   change row's mergedAt / githubPrUrl columns;
 * - passes run.issues through so evaluator findings render in the evidence table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Change, Env, ProjectEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Rate-limit and analytics pass-through
// ---------------------------------------------------------------------------

vi.mock("../src/middleware/rate-limit", () => ({
  rateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  checkImportRateLimit: vi.fn(async () => ({ allowed: true })),
  recordImportAttempt: vi.fn(),
  importRateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  releaseImportLock: vi.fn(),
}));

vi.mock("../src/middleware/analytics", () => ({
  analyticsMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

// ---------------------------------------------------------------------------
// Storage mocks — controllable per test; every other export keeps its original
// implementation so unrelated routes still import cleanly.
// ---------------------------------------------------------------------------

const mockGetChange = vi.fn();
const mockListEvalRuns = vi.fn();
const mockListComments = vi.fn();
const mockListReviews = vi.fn();
const mockGetChangeCostSummary = vi.fn();
const mockGetProvenance = vi.fn();

vi.mock("../src/storage/changes", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/changes")>();
  return {
    ...original,
    getChange: (...args: unknown[]) => mockGetChange(...args),
  };
});

vi.mock("../src/storage/eval-runs", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/eval-runs")>();
  return {
    ...original,
    listEvalRuns: (...args: unknown[]) => mockListEvalRuns(...args),
  };
});

vi.mock("../src/storage/change-reviews", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/change-reviews")>();
  return {
    ...original,
    listComments: (...args: unknown[]) => mockListComments(...args),
    listReviews: (...args: unknown[]) => mockListReviews(...args),
  };
});

vi.mock("../src/storage/costs", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/costs")>();
  return {
    ...original,
    getChangeCostSummary: (...args: unknown[]) => mockGetChangeCostSummary(...args),
  };
});

vi.mock("../src/storage/provenance", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/provenance")>();
  return {
    ...original,
    getProvenance: (...args: unknown[]) => mockGetProvenance(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(kv: KVNamespace): Env {
  return {
    ARTIFACTS: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: kv,
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true, results: [], meta: {} }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
      })),
    } as unknown as D1Database,
    IMPORT_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    } as unknown as Queue,
  };
}

const PROJECT: ProjectEntry = {
  id: "proj-001",
  name: "my-project",
  slug: "my-project",
  namespace: "@owner",
  ownerId: "user_owner",
  ownerType: "user",
  remote: "https://artifacts.example.com/repos/owner-my-project",
  createdAt: "2026-01-01T00:00:00.000Z",
  visibility: "public",
};

function seedProject(kv: KVNamespace, project: ProjectEntry): void {
  // The change-detail route resolves the project via getProject(change.project),
  // i.e. the legacy name key.
  void (kv as unknown as { put: (k: string, v: string) => Promise<void> }).put(
    `project:${project.name}`,
    JSON.stringify(project),
  );
}

function makeChange(overrides: Partial<Change> = {}): Change {
  return {
    id: "chg_197",
    project: "my-project",
    workspace: "fix-bug",
    status: "merged",
    evalScore: 0.92,
    evalPassed: true,
    evalReason: "All checks passed",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

const PROVENANCE_RECORD = {
  id: "prv_001",
  commitSha: "deadbeefcafe1234",
  project: "my-project",
  workspace: "fix-bug",
  changeId: "chg_197",
  agentId: "agent_gpt",
  evalScore: 0.92,
  model: "claude-fable-5",
  promptHash: "sha256:abc",
  mergedAt: "2026-01-03T10:00:00.000Z",
};

function getRequest(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /changes/:id threads provenance, merge metadata, and issues", () => {
  let env: Env;
  let kv: KVNamespace;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = makeKV();
    env = makeEnv(kv);
    seedProject(kv, PROJECT);

    mockGetChange.mockResolvedValue({ success: true, data: makeChange() });
    mockListEvalRuns.mockResolvedValue({ success: true, data: [] });
    mockListComments.mockResolvedValue({ success: true, data: [] });
    mockListReviews.mockResolvedValue({ success: true, data: [] });
    mockGetChangeCostSummary.mockResolvedValue({ success: true, data: [] });
    mockGetProvenance.mockResolvedValue({
      success: false,
      error: { message: "Provenance not found", code: "NOT_FOUND" },
    });
  });

  it("renders the provenance card when a provenance record exists", async () => {
    mockGetProvenance.mockResolvedValue({ success: true, data: PROVENANCE_RECORD });

    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Provenance");
    expect(html).toContain("deadbeefcafe1234");
    expect(html).toContain("agent_gpt");
    // Looked up by the change id, same source the REST API/merge paths write.
    expect(mockGetProvenance).toHaveBeenCalledWith(env.DB, expect.anything(), "chg_197");
  });

  it("omits the provenance card when no provenance record exists", async () => {
    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Provenance");
    expect(html).not.toContain("deadbeefcafe1234");
  });

  it("renders the merged timestamp from change.mergedAt", async () => {
    mockGetChange.mockResolvedValue({
      success: true,
      data: makeChange({ mergedAt: "2026-01-03T10:00:00.000Z" }),
    });

    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<dt>Merged</dt>");
    expect(html).toContain(new Date("2026-01-03T10:00:00.000Z").toLocaleString());
  });

  it("omits the merged row when the change has no mergedAt", async () => {
    mockGetChange.mockResolvedValue({
      success: true,
      data: makeChange({ status: "rejected" }),
    });

    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<dt>Merged</dt>");
  });

  it("renders the Open GitHub PR action from change.githubPrUrl", async () => {
    mockGetChange.mockResolvedValue({
      success: true,
      data: makeChange({
        status: "promoted",
        githubPrUrl: "https://github.com/acme/api/pull/42",
      }),
    });

    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Open GitHub PR");
    expect(html).toContain("https://github.com/acme/api/pull/42");
  });

  it("passes run.issues through so evaluator findings render", async () => {
    mockListEvalRuns.mockResolvedValue({
      success: true,
      data: [
        {
          id: "evl_001",
          changeId: "chg_197",
          evaluatorType: "secret_scan",
          score: 0,
          passed: false,
          reason: "Secrets detected",
          issues: ["AWS key found in config.ts", "Token found in .env.example"],
          ranAt: "2026-01-02T01:00:00.000Z",
        },
        {
          id: "evl_002",
          changeId: "chg_197",
          evaluatorType: "llm_judge",
          score: 0.9,
          passed: true,
          reason: "Looks good",
          ranAt: "2026-01-02T01:05:00.000Z",
        },
      ],
    });

    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("AWS key found in config.ts");
    expect(html).toContain("Token found in .env.example");
    expect(html).toContain("secret_scan");
    expect(html).toContain("llm_judge");
  });

  it("degrades to an empty evidence table when listing eval runs fails", async () => {
    mockListEvalRuns.mockResolvedValue({
      success: false,
      error: { message: "D1 unavailable", code: "DATABASE_ERROR" },
    });

    const res = await app.fetch(getRequest("/changes/chg_197"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No evaluator evidence recorded.");
  });
});
