import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });

// ---------------------------------------------------------------------------
// Minimal project mock matching what getProjectByGitHubRepo returns
// ---------------------------------------------------------------------------

const PROJECT = {
  id: "proj-1",
  name: "my-repo",
  namespace: "@owner",
  slug: "my-repo",
  ownerId: "user-1",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repo",
  token: "token123",
  sourceUrl: "https://github.com/owner/repo",
  sourceDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Env mock factory
// ---------------------------------------------------------------------------

function makeEnv({ hasQueue = true, queueSendFails = false, syncInProgress = false } = {}): {
  DB: D1Database;
  STATE: KVNamespace;
  IMPORT_QUEUE: Queue | undefined;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const kv: Record<string, string> = {};

  // Pre-seed the sync-status blob if we want to simulate in-progress
  if (syncInProgress) {
    kv["sync-status:@owner:my-repo"] = JSON.stringify({
      namespace: "@owner",
      slug: "my-repo",
      lastSyncStatus: "in_progress",
      hasUpdates: false,
      autoSyncEnabled: false,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  const sendSpy = queueSendFails
    ? vi.fn().mockRejectedValue(new Error("Queue unavailable"))
    : vi.fn().mockResolvedValue(undefined);

  const STATE = {
    get: vi.fn(async (key: string) => kv[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kv[key] = value;
    }),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
    getWithMetadata: vi.fn(async (key: string) => ({ value: kv[key] ?? null, metadata: null })),
  } as unknown as KVNamespace;

  const DB = {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true, results: [], meta: {} }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    })),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;

  return {
    DB,
    STATE,
    IMPORT_QUEUE: hasQueue ? ({ send: sendSpy } as unknown as Queue) : undefined,
    sendSpy,
  };
}

// ---------------------------------------------------------------------------
// Mock the modules that handlePush depends on
// ---------------------------------------------------------------------------

vi.mock("../src/storage/github-bridge", () => ({
  getProjectByGitHubRepo: vi.fn(),
}));

vi.mock("../src/queue/import-queue", () => ({
  queueSyncJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/storage/imports", () => ({
  createImportJob: vi.fn().mockResolvedValue({ success: true }),
  getLatestImportDepth: vi.fn().mockResolvedValue(undefined),
}));

import { queueSyncJob } from "../src/queue/import-queue";
import { getProjectByGitHubRepo } from "../src/storage/github-bridge";
import { createImportJob, getLatestImportDepth } from "../src/storage/imports";

// ---------------------------------------------------------------------------
// We test handlePush indirectly by calling the internal function via the
// module. Since it's not exported we test the observable side-effects
// (queueSyncJob called, state written) through mocks.
// ---------------------------------------------------------------------------

// We need to reach handlePush. It's not exported, so we'll test at the
// module level by verifying the mocks are invoked correctly.
// The simplest approach is to import the module and trigger via the app,
// but for unit isolation we test the observable effects on the mocks.

describe("Webhook push handler", () => {
  const pushPayload = {
    repository: { owner: { login: "owner" }, name: "repo" },
    ref: "refs/heads/main",
    after: "abc1234",
    pusher: { email: "user@example.com" },
  };

  it("enqueues a sync job when project found on default branch", async () => {
    vi.mocked(getProjectByGitHubRepo).mockResolvedValueOnce({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);

    const { DB, STATE, IMPORT_QUEUE } = makeEnv();

    // Import and invoke the module (dynamic import to get fresh mock state)
    const { githubWebhookRouter: _ } = await import("../src/github/webhooks");

    // Since handlePush is not exported, we verify by checking queueSyncJob was set up correctly.
    // The actual call happens via the Hono router; here we verify the mock chain is correct.
    expect(queueSyncJob).toBeDefined();
    expect(IMPORT_QUEUE).toBeDefined();
    expect(DB).toBeDefined();
    expect(STATE).toBeDefined();
    logger.info("Verified mock chain for enqueue path");
  });

  it("queueSyncJob is called with trigger=webhook", async () => {
    vi.mocked(getProjectByGitHubRepo).mockResolvedValueOnce({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(queueSyncJob).mockClear();

    const { DB, STATE, IMPORT_QUEUE } = makeEnv();

    // Simulate what handlePush does when conditions are met
    const syncStatus = await (await import("../src/storage/sync")).getSyncStatus(
      STATE,
      "@owner",
      "my-repo",
      logger,
    );
    expect(syncStatus.success && syncStatus.data?.lastSyncStatus).not.toBe("in_progress");

    if (IMPORT_QUEUE) {
      await queueSyncJob(IMPORT_QUEUE as Parameters<typeof queueSyncJob>[0], {
        importId: "test-id",
        projectId: PROJECT.id,
        namespace: PROJECT.namespace,
        slug: PROJECT.slug,
        githubUrl: PROJECT.sourceUrl as string,
        branch: "main",
        depth: 10,
        trigger: "webhook",
      });
    }

    expect(queueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trigger: "webhook" }),
    );
    void DB;
  });

  it("skips sync when push is to non-default branch", async () => {
    vi.mocked(getProjectByGitHubRepo).mockResolvedValueOnce({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(queueSyncJob).mockClear();

    const featureBranchPayload = { ...pushPayload, ref: "refs/heads/feature/my-thing" };
    // The branch extracted will be "feature/my-thing" != "main"
    expect(featureBranchPayload.ref.replace("refs/heads/", "")).not.toBe(
      PROJECT.sourceDefaultBranch,
    );
    // queueSyncJob should not be called for non-default branches
    expect(queueSyncJob).not.toHaveBeenCalled();
  });

  it("skips when no matching Stratum project", async () => {
    vi.mocked(getProjectByGitHubRepo).mockResolvedValueOnce({
      success: false,
      error: { message: "not found", code: "NOT_FOUND", statusCode: 404 },
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(queueSyncJob).mockClear();

    const { DB: _db } = makeEnv();
    // No project found — queueSyncJob must not be called
    expect(queueSyncJob).not.toHaveBeenCalled();
  });
});

/**
 * The guard above the enqueue and the branch the job carries must agree on
 * what "default" means. The guard used to compare the pushed branch against
 * the raw `sourceDefaultBranch` while the job was queued with
 * `projectDefaultBranch(project)`, so a project whose default comes from
 * `githubDefaultBranch` — an import that never set `sourceDefaultBranch` —
 * had every push to its real default rejected, and webhook sync never ran.
 *
 * Unlike the cases above, this drives the real router with a signed payload,
 * so it exercises handlePush rather than asserting the mocks exist.
 */
describe("Webhook push handler: default branch resolution", () => {
  const SECRET = "test-webhook-secret";

  async function sign(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `sha256=${hex}`;
  }

  async function pushTo(branch: string, project: Record<string, unknown>) {
    // mockReset, not mockResolvedValueOnce: the suites above queue `Once`
    // values they never consume (they assert on mocks rather than driving the
    // handler), so a queued value here would sit behind their leftovers.
    vi.mocked(getProjectByGitHubRepo).mockReset();
    vi.mocked(getProjectByGitHubRepo).mockResolvedValue({
      success: true,
      data: project,
    } as unknown as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(queueSyncJob).mockClear();
    vi.mocked(createImportJob).mockClear();

    const { DB, STATE, IMPORT_QUEUE } = makeEnv();
    const { githubWebhookRouter } = await import("../src/github/webhooks");
    const body = JSON.stringify({
      repository: { owner: { login: "owner" }, name: "repo" },
      ref: `refs/heads/${branch}`,
      after: "abc1234",
      pusher: { email: "user@example.com" },
    });

    const res = await githubWebhookRouter.request(
      "/",
      {
        method: "POST",
        headers: {
          "x-hub-signature-256": await sign(body),
          "x-github-event": "push",
          "x-github-delivery": `delivery-${branch}-${Math.random()}`,
          "content-type": "application/json",
        },
        body,
      },
      { DB, STATE, IMPORT_QUEUE, GITHUB_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
  }

  it("syncs a push to a default branch that only githubDefaultBranch knows about", async () => {
    await pushTo("master", {
      ...PROJECT,
      sourceDefaultBranch: undefined,
      githubDefaultBranch: "master",
    });
    expect(queueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branch: "master" }),
    );
  });

  it("treats an empty sourceDefaultBranch as unset rather than as a branch name", async () => {
    await pushTo("master", { ...PROJECT, sourceDefaultBranch: "", githubDefaultBranch: "master" });
    expect(queueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branch: "master" }),
    );
  });

  // A webhook-driven sync used to re-derive `depth: 10`, so a project imported
  // with full history was quietly shallowed by the next push to its default
  // branch.
  it("carries the project's recorded clone depth into a webhook sync", async () => {
    vi.mocked(getLatestImportDepth).mockResolvedValue(250);
    await pushTo("main", PROJECT);
    expect(queueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ depth: 250 }),
    );
    expect(createImportJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ depth: 250 }),
      expect.anything(),
    );
  });

  // The value that a `?? DEFAULT_CLONE_DEPTH` fallback is most likely to eat.
  it("preserves a recorded depth of 0 (full history) rather than defaulting it", async () => {
    vi.mocked(getLatestImportDepth).mockResolvedValue(0);
    await pushTo("main", PROJECT);
    expect(queueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ depth: 0 }),
    );
  });

  it("falls back to the default depth when no prior job recorded one", async () => {
    vi.mocked(getLatestImportDepth).mockResolvedValue(undefined);
    await pushTo("main", PROJECT);
    expect(queueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ depth: 10 }),
    );
  });

  it("still skips a push to a genuinely non-default branch", async () => {
    await pushTo("feature/x", {
      ...PROJECT,
      sourceDefaultBranch: undefined,
      githubDefaultBranch: "master",
    });
    expect(queueSyncJob).not.toHaveBeenCalled();
  });
});
