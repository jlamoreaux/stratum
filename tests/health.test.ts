import { describe, expect, it } from "vitest";
import { CRITICAL_TABLES, healthRouter } from "../src/routes/health";
import type { Env } from "../src/types";

const ALL_TABLES = [...CRITICAL_TABLES];

function makeDb(opts: { tables?: string[]; fail?: boolean } = {}): D1Database {
  const tables = opts.tables ?? ALL_TABLES;
  const prepare = (sql: string) => {
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      all: async () => {
        if (opts.fail) throw new Error("D1_ERROR: database unreachable");
        if (sql.includes("health_check")) return { results: [{ health_check: 1 }] };
        if (sql.includes("sqlite_master")) return { results: tables.map((name) => ({ name })) };
        return { results: [] };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

function makeKv(opts: { fail?: boolean } = {}): KVNamespace {
  const store = new Map<string, string>();
  return {
    put: async (k: string, v: string) => {
      if (opts.fail) throw new Error("KV unreachable");
      store.set(k, v);
    },
    get: async (k: string) => {
      if (opts.fail) throw new Error("KV unreachable");
      return store.get(k) ?? null;
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

function makeQueue(opts: { fail?: boolean } = {}): Queue<unknown> {
  return {
    metrics: async () => {
      if (opts.fail) throw new Error("Queue unreachable");
      return {};
    },
  } as unknown as Queue<unknown>;
}

function makeArtifacts(opts: { fail?: boolean } = {}): Env["ARTIFACTS"] {
  return {
    list: async () => {
      if (opts.fail) throw new Error("Artifacts unreachable");
      return { objects: [] };
    },
  } as unknown as Env["ARTIFACTS"];
}

function makeEnv(
  overrides: {
    db?: Parameters<typeof makeDb>[0];
    kv?: Parameters<typeof makeKv>[0];
    queue?: Parameters<typeof makeQueue>[0];
    artifacts?: Parameters<typeof makeArtifacts>[0];
  } = {},
): Env {
  return {
    DB: makeDb(overrides.db),
    STATE: makeKv(overrides.kv),
    IMPORT_QUEUE: makeQueue(overrides.queue),
    ARTIFACTS: makeArtifacts(overrides.artifacts),
  } as unknown as Env;
}

type Check = { status: string; message?: string };

async function getHealth(env: Env) {
  const res = await healthRouter.request("/", {}, env);
  const body = (await res.json()) as {
    status: string;
    checks: { database: Check; kv: Check; queue: Check; artifacts: Check };
  };
  return { status: res.status, body };
}

describe("GET /api/health", () => {
  it("returns 200 healthy when every dependency is up", async () => {
    const { status, body } = await getHealth(makeEnv());
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks.database.status).toBe("ok");
    expect(body.checks.kv.status).toBe("ok");
    expect(body.checks.queue.status).toBe("ok");
    expect(body.checks.artifacts.status).toBe("ok");
  });

  it("returns 503 unhealthy when the database is unreachable (critical)", async () => {
    const { status, body } = await getHealth(makeEnv({ db: { fail: true } }));
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.database.status).toBe("error");
  });

  it("returns 503 and names the missing table when the schema is unmigrated (#118)", async () => {
    // events table absent — the exact #118 failure mode a shallow SELECT 1 misses.
    const env = makeEnv({ db: { tables: ["users", "sessions", "changes"] } });
    const { status, body } = await getHealth(env);
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.database.status).toBe("error");
    expect(body.checks.database.message).toContain("events");
  });

  it("returns 503 when KV is down (critical)", async () => {
    const { status, body } = await getHealth(makeEnv({ kv: { fail: true } }));
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.kv.status).toBe("error");
  });

  it("returns 503 when artifacts are down (critical)", async () => {
    const { status, body } = await getHealth(makeEnv({ artifacts: { fail: true } }));
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.artifacts.status).toBe("error");
  });

  it("returns 200 degraded when only the (non-critical) queue is down", async () => {
    const { status, body } = await getHealth(makeEnv({ queue: { fail: true } }));
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.queue.status).toBe("error");
    expect(body.checks.database.status).toBe("ok");
  });
});
