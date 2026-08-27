import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

// Same stubbing approach as workspaces-authz.test.ts: the commit path clones +
// pushes via git-ops, which we don't want to exercise here — we only need to
// prove the pre-parse body cap rejects an oversized commit BEFORE any of that
// runs (and before the body is ever fully parsed).
vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
    cloneRepo: vi.fn(async () => ({ success: true, data: { fs: {}, dir: "/tmp/x" } })),
    commitAndPush: vi.fn(async () => ({ success: true, data: "abc123" })),
    stageWorkspaceTree: vi.fn(async () => ({ success: false, error: { message: "skip" } })),
  };
});

const OWNER_TOKEN = "stratum_user_owner000000000000000000";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === OWNER_TOKEN)
      return { success: true, data: { id: "user_owner", email: "o@x.io", username: "owner" } };
    return { success: false, error: { message: "not found" } };
  }),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

import { commitAndPush } from "../src/storage/git-ops";

const ARTIFACTS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/repo.git";
const WS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/myws.git";

/**
 * The commit route resolves the project and workspace through KV before it
 * ever looks at the body, so the test needs that lookup to succeed — otherwise
 * a 404 would pass for a "rejection" and the cap would go untested.
 */
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
        .filter((k) => (prefix ? k.startsWith(prefix) : true))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

/**
 * Supplies only the binding the pre-parse path actually reads. `ARTIFACTS` and
 * `DB` are left as bare objects on purpose: the cap must reject before either
 * is touched, so a test that somehow reached them would throw rather than
 * quietly pass.
 */
function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
  } as Env;
}

/**
 * Puts the route one step away from parsing: a real project and workspace the
 * owner can reach, so the only thing left to fail is the body size. Without
 * this the request dies at lookup and proves nothing about the limit.
 */
async function seed(env: Env): Promise<void> {
  const project: ProjectEntry = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "repo",
    slug: "repo",
    namespace: "@owner",
    ownerId: "user_owner",
    ownerType: "user",
    remote: ARTIFACTS_REMOTE,
    createdAt: new Date().toISOString(),
    visibility: "private",
  };
  await env.STATE.put(`project:${project.namespace}:${project.slug}`, JSON.stringify(project));
  await env.STATE.put(
    "workspace:00000000-0000-4000-8000-000000000001:myws",
    JSON.stringify({
      name: "myws",
      remote: WS_REMOTE,
      parent: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date().toISOString(),
      createdByUserId: "user_owner",
    }),
  );
}

/**
 * Streams `totalBytes` of filler in 1 MiB chunks, deliberately WITHOUT a
 * Content-Length header — this is the "chunked / unknown length" case the
 * streaming cap exists for, as opposed to the cheap declared-length pre-check.
 */
function streamingCommitRequest(totalBytes: number): Request {
  const chunkSize = 1024 * 1024;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(120)); // 'x' filler, deliberately not valid JSON
      sent += n;
    },
  });
  return new Request("http://localhost/api/workspaces/myws/commit", {
    method: "POST",
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

/** The control case: proves the cap rejects oversized bodies without also
 * breaking an ordinary commit, which a too-eager guard easily would. */
function smallCommitRequest(): Request {
  return new Request("http://localhost/api/workspaces/myws/commit", {
    method: "POST",
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "00000000-0000-4000-8000-000000000001",
      message: "m",
      files: { "a.txt": "hi" },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/:name/commit — pre-parse body-size cap (issue #264)", () => {
  it("rejects a body over the 32 MiB pre-parse cap with 413 before any git work — even with no Content-Length header", async () => {
    const env = makeEnv();
    await seed(env);
    const req = streamingCommitRequest(33 * 1024 * 1024);
    expect(req.headers.get("content-length")).toBeNull();

    const res = await app.fetch(req, env);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    // The body is neither valid JSON (parse would throw) nor a real commit
    // payload — reaching commitAndPush would mean the cap didn't fire.
    expect(vi.mocked(commitAndPush)).not.toHaveBeenCalled();
  }, 20_000);

  it("a normal commit body well under the cap still succeeds", async () => {
    const env = makeEnv();
    await seed(env);
    const res = await app.fetch(smallCommitRequest(), env);

    expect(res.status).toBe(200);
    expect(vi.mocked(commitAndPush)).toHaveBeenCalledOnce();
  });
});
