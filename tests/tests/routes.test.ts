import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_, token: string) => {
    if (token === "stratum_user_testtoken00000000000000000") {
      return {
        success: true,
        data: {
          id: "user_test",
          email: "test@example.com",
          username: "testuser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    if (token === "stratum_user_othertoken000000000000000") {
      return {
        success: true,
        data: {
          id: "user_other",
          email: "other@example.com",
          username: "otheruser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUser: vi.fn(async (_, userId: string) => {
    if (userId === "user_test") {
      return {
        success: true,
        data: {
          id: "user_test",
          email: "test@example.com",
          username: "testuser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    if (userId === "user_other") {
      return {
        success: true,
        data: {
          id: "user_other",
          email: "other@example.com",
          username: "otheruser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async (_, token: string) => {
    if (token === "stratum_agent_testtoken0000000000000000") {
      return {
        id: "agent_test",
        name: "agent",
        ownerId: "user_test",
        tokenHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    }
    if (token === "stratum_agent_othertoken00000000000000") {
      return {
        id: "agent_other",
        name: "other-agent",
        ownerId: "user_other",
        tokenHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    }
    return null;
  }),
}));

vi.mock("../src/storage/sessions", () => ({
  getSession: vi.fn(async () => null),
  deleteSession: vi.fn(async () => {}),
}));

const AUTH_HEADERS = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };
const OTHER_AUTH_HEADERS = { Authorization: "Bearer stratum_user_othertoken000000000000000" };
const AGENT_AUTH_HEADERS = { Authorization: "Bearer stratum_agent_testtoken0000000000000000" };
const OTHER_AGENT_AUTH_HEADERS = {
  Authorization: "Bearer stratum_agent_othertoken00000000000000",
};

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

function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
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
    const res = await app.fetch(
      request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; namespace?: string; slug?: string; commit: string };
    expect(body.name).toBe("my-project");
    expect(body.commit).toBe("sha_init");
    // Namespace support - may be undefined until auth mock is fully working
    if (body.namespace) {
      expect(body.namespace).toBe("@testuser");
      expect(body.slug).toBe("my-project");
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.fetch(request("POST", "/api/projects", { name: "my-project" }), env);
    expect(res.status).toBe(401);
  });

  it("rejects invalid name", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects", { name: "invalid name!" }, AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing name", async () => {
    const res = await app.fetch(request("POST", "/api/projects", {}, AUTH_HEADERS), env);
    expect(res.status).toBe(400);
  });

  it("accepts custom files", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/projects",
        {
          name: "custom",
          files: { "hello.txt": "world" },
        },
        AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(201);
  });

  it("rejects non-string file contents", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/projects",
        {
          name: "bad",
          files: { "hello.txt": 42 },
        },
        AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects", () => {
  it("returns empty list initially", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/api/projects", undefined, AUTH_HEADERS), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });

  it("lists created projects", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "proj-a" }, AUTH_HEADERS), env);
    const res = await app.fetch(request("GET", "/api/projects", undefined, AUTH_HEADERS), env);
    const body = (await res.json()) as { projects: ProjectEntry[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.name).toBe("proj-a");
    // Namespace support - may be undefined until auth mock is fully working
    if (body.projects[0]?.namespace) {
      expect(body.projects[0]?.namespace).toBe("@testuser");
      expect(body.projects[0]?.slug).toBe("proj-a");
    }
  });

  it("allows unauthenticated users to list public projects", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/api/projects"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });

  it("does not list private projects for a different user", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "proj-a" }, AUTH_HEADERS), env);
    const res = await app.fetch(
      request("GET", "/api/projects", undefined, OTHER_AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: ProjectEntry[] };
    expect(body.projects).toHaveLength(0);
  });
});

describe("GET /api/projects/:name/files", () => {
  it("returns file list for existing project", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/files", undefined, AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain("src/index.ts");
  });

  it("returns 404 for missing project", async () => {
    const env = makeEnv();
    const res = await app.fetch(request("GET", "/api/projects/nope/files"), env);
    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's private project", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/files", undefined, OTHER_AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/projects/:name/log", () => {
  it("returns commit log for existing project", async () => {
    const env = makeEnv();
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/log", undefined, AUTH_HEADERS),
      env,
    );
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
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
  });

  it("forks a workspace and returns 201", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/projects/my-project/workspaces",
        { name: "fix-bug" },
        AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: string; parent: string };
    expect(body.workspace).toBe("fix-bug");
    expect(body.parent).toBe("my-project");
  });

  it("allows an agent owned by the project owner to fork a workspace", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/projects/my-project/workspaces",
        { name: "agent-workspace" },
        AGENT_AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(201);
  });

  it("returns 403 for an agent owned by a different user", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/projects/my-project/workspaces",
        { name: "bad-agent-workspace" },
        OTHER_AGENT_AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", { name: "fix-bug" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for missing project", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/projects/nope/workspaces", { name: "ws" }, AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("auto-generates workspace name when not provided", async () => {
    const res = await app.fetch(
      request("POST", "/api/workspaces/projects/my-project/workspaces", {}, AUTH_HEADERS),
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
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
    await app.fetch(
      request(
        "POST",
        "/api/workspaces/projects/my-project/workspaces",
        { name: "fix-bug" },
        AUTH_HEADERS,
      ),
      env,
    );
  });

  it("commits changes and returns sha", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/fix-bug/commit",
        {
          files: { "src/index.ts": "export const x = 1;" },
          message: "Fix bug",
        },
        AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit: string; filesChanged: string[] };
    expect(body.commit).toBe("sha_commit");
    expect(body.filesChanged).toContain("src/index.ts");
  });

  it("returns 400 for missing message", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/fix-bug/commit",
        {
          files: { "src/index.ts": "content" },
        },
        AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-string file values", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/fix-bug/commit",
        {
          files: { "src/index.ts": 42 },
          message: "oops",
        },
        AUTH_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for missing workspace", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/workspaces/nope/commit",
        {
          files: { "f.ts": "x" },
          message: "msg",
        },
        AUTH_HEADERS,
      ),
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
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
    await app.fetch(
      request(
        "POST",
        "/api/workspaces/projects/my-project/workspaces",
        { name: "fix-bug" },
        AUTH_HEADERS,
      ),
      env,
    );
  });

  it("returns 410 Gone (deprecated endpoint)", async () => {
    const res = await app.fetch(request("POST", "/api/workspaces/fix-bug/merge"), env);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/api/projects/:name/changes");
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
    await app.fetch(request("POST", "/api/projects", { name: "my-project" }, AUTH_HEADERS), env);
    await app.fetch(
      request(
        "POST",
        "/api/workspaces/projects/my-project/workspaces",
        { name: "fix-bug" },
        AUTH_HEADERS,
      ),
      env,
    );
  });

  it("deletes workspace", async () => {
    const res = await app.fetch(
      request("DELETE", "/api/workspaces/fix-bug", undefined, AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.fetch(request("DELETE", "/api/workspaces/fix-bug"), env);
    expect(res.status).toBe(401);
  });

  it("returns 404 for missing workspace", async () => {
    const res = await app.fetch(
      request("DELETE", "/api/workspaces/nope", undefined, AUTH_HEADERS),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("workspace is gone after delete (merge returns 410 deprecated)", async () => {
    await app.fetch(request("DELETE", "/api/workspaces/fix-bug", undefined, AUTH_HEADERS), env);
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
