import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

// ─── KV mock ──────────────────────────────────────────────────────────────────

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
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

// ─── Artifacts mock ───────────────────────────────────────────────────────────

const mockFork = vi.fn();
const mockArtifactsGet = vi.fn(() => ({ fork: mockFork }));
const mockArtifactsCreate = vi.fn((name: string) => ({
  name,
  remote: `https://artifacts.example.com/repos/${name}`,
  token: `tok_${name}`,
}));
const mockArtifactsDelete = vi.fn(async () => true);

// ─── git-ops mocks ────────────────────────────────────────────────────────────

vi.mock("../src/storage/git-ops", () => ({
  initAndPush: vi.fn(
    async (_remote: string, _token: string, _files: unknown, _msg: string) => "sha_init",
  ),
  cloneRepo: vi.fn(async () => ({ fs: {}, dir: "/" })),
  commitAndPush: vi.fn(async () => "sha_commit"),
  mergeWorkspaceIntoProject: vi.fn(async () => "sha_merge"),
  listFilesInRepo: vi.fn(async () => ["src/index.ts", "README.md"]),
  getCommitLog: vi.fn(async () => [
    {
      sha: "abc123",
      message: "Initial commit",
      author: "Stratum <system@usestratum.dev>",
      timestamp: 1000,
    },
  ]),
}));

// ─── Test env factory ─────────────────────────────────────────────────────────

function makeEnv(): Env {
  return {
    ARTIFACTS: {
      create: mockArtifactsCreate,
      get: mockArtifactsGet,
      delete: mockArtifactsDelete,
      list: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
  };
}

function request(method: string, path: string, body?: unknown): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: hasBody ? { "Content-Type": "application/json" } : {},
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

// ─── Projects ─────────────────────────────────────────────────────────────────

describe("POST /api/projects", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
  });

  it("creates a project and returns 201", async () => {
    const res = await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; commit: string };
    expect(body.name).toBe("my-project");
    expect(body.commit).toBe("sha_init");
  });

  it("rejects invalid name", async () => {
    const res = await app.fetch(request("POST", "/api/projects", { name: "invalid name!" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects missing name", async () => {
    const res = await app.fetch(request("POST", "/api/projects", {}), env);
    expect(res.status).toBe(400);
  });

  it("accepts custom files", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects", {
        name: "custom",
        files: { "hello.txt": "world" },
      }),
      env,
    );
    expect(res.status).toBe(201);
  });

  it("rejects non-string file contents", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects", {
        name: "bad",
        files: { "hello.txt": 42 },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects", () => {
  it("returns empty list initially", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/api/projects"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });

  it("lists created projects", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "proj-a" }), env);
    const res = await app.fetch(request("GET", "/api/projects"), env);
    const body = (await res.json()) as { projects: ProjectEntry[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.name).toBe("proj-a");
  });
});

describe("GET /api/projects/:name/files", () => {
  it("returns file list for existing project", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    const res = await app.fetch(request("GET", "/api/projects/my-project/files"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain("src/index.ts");
  });

  it("returns 404 for missing project", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/api/projects/nope/files"), env);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:name/log", () => {
  it("returns commit log for existing project", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    const res = await app.fetch(request("GET", "/api/projects/my-project/log"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { log: unknown[] };
    expect(body.log).toHaveLength(1);
  });

  it("returns 404 for missing project", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/api/projects/nope/log"), env);
    expect(res.status).toBe(404);
  });
});

// ─── Workspaces ───────────────────────────────────────────────────────────────

describe("POST /api/workspaces/projects/:name/workspaces", () => {
  let env: Env;

  beforeEach(async () => {
    env = makeEnv();
    mockFork.mockResolvedValue({
      name: "fix-bug",
      remote: "https://artifacts.example.com/repos/fix-bug",
      token: "tok_fix-bug",
    });
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
  });

  it("forks a workspace and returns 201", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", { name: "fix-bug" }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: string; parent: string };
    expect(body.workspace).toBe("fix-bug");
    expect(body.parent).toBe("my-project");
  });

  it("returns 404 for missing project", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/projects/nope/workspaces", { name: "ws" }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("auto-generates workspace name when not provided", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", {}),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toMatch(/^ws-\d+$/);
  });
});

describe("POST /api/workspaces/:name/commit", () => {
  let env: Env;

  beforeEach(async () => {
    env = makeEnv();
    mockFork.mockResolvedValue({
      name: "fix-bug",
      remote: "https://artifacts.example.com/repos/fix-bug",
      token: "tok_fix-bug",
    });
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", { name: "fix-bug" }),
      env,
    );
  });

  it("commits changes and returns sha", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/fix-bug/commit", {
        files: { "src/index.ts": "export const x = 1;" },
        message: "Fix bug",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit: string; filesChanged: string[] };
    expect(body.commit).toBe("sha_commit");
    expect(body.filesChanged).toContain("src/index.ts");
  });

  it("returns 400 for missing message", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/fix-bug/commit", {
        files: { "src/index.ts": "content" },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-string file values", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/fix-bug/commit", {
        files: { "src/index.ts": 42 },
        message: "oops",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for missing workspace", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/nope/commit", {
        files: { "f.ts": "x" },
        message: "msg",
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workspaces/:name/merge", () => {
  let env: Env;

  beforeEach(async () => {
    env = makeEnv();
    mockFork.mockResolvedValue({
      name: "fix-bug",
      remote: "https://artifacts.example.com/repos/fix-bug",
      token: "tok_fix-bug",
    });
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", { name: "fix-bug" }),
      env,
    );
  });

  it("returns 410 Gone (deprecated endpoint)", async () => {
    const res = await app.fetch(request("POST", "/api/workspaces/fix-bug/merge"), env);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('/api/projects/:name/changes');
  });

  it("returns 410 Gone even for missing workspace (deprecated endpoint)", async () => {
    const res = await app.fetch(request("POST", "/api/workspaces/nope/merge"), env);
    expect(res.status).toBe(410);
  });
});

describe("DELETE /api/workspaces/:name", () => {
  let env: Env;

  beforeEach(async () => {
    env = makeEnv();
    mockFork.mockResolvedValue({
      name: "fix-bug",
      remote: "https://artifacts.example.com/repos/fix-bug",
      token: "tok_fix-bug",
    });
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", { name: "fix-bug" }),
      env,
    );
  });

  it("deletes workspace", async () => {
    const res = await app.fetch(request("DELETE", "/api/workspaces/fix-bug"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns 404 for missing workspace", async () => {
    const res = await app.fetch(request("DELETE", "/api/workspaces/nope"), env);
    expect(res.status).toBe(404);
  });

  it("workspace is gone after delete (merge returns 410 deprecated)", async () => {
    await app.fetch(request("DELETE", "/api/workspaces/fix-bug"), env);
    const res = await app.fetch(request("POST", "/api/workspaces/fix-bug/merge"), env);
    expect(res.status).toBe(410);
  });
});

describe("health check", () => {
  it("returns ok", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("404 handler", () => {
  it("returns 404 for unknown routes", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/unknown/route"), env);
    expect(res.status).toBe(404);
  });
});
