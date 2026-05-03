import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { rateLimitMiddleware } from "../../src/middleware/rate-limit";
import type { Env } from "../../src/types";

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

function makeEnv(kv?: KVNamespace): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: kv ?? makeKV(),
    DB: {} as D1Database,
  };
}

function makeApp(opts?: { requestsPerMinute?: number }) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", rateLimitMiddleware(opts));
  app.get("/test", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

function makeAuthApp(opts?: { requestsPerMinute?: number }) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("userId", "usr_test");
    await next();
  });
  app.use("*", rateLimitMiddleware(opts));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

function req(path: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, headers ? { headers } : {});
}

describe("rateLimitMiddleware", () => {
  let kv: KVNamespace;
  let env: Env;

  beforeEach(() => {
    kv = makeKV();
    env = makeEnv(kv);
  });

  it("first request passes", async () => {
    const app = makeApp({ requestsPerMinute: 5 });
    const res = await app.fetch(req("/test"), env);
    expect(res.status).toBe(200);
  });

  it("sets KV entry after first request", async () => {
    const app = makeApp({ requestsPerMinute: 5 });
    await app.fetch(req("/test"), env);
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:anonymous:${minuteBucket}`;
    const raw = await kv.get(key);
    expect(raw).toBe("1");
  });

  it("request within limit passes", async () => {
    const app = makeApp({ requestsPerMinute: 5 });
    for (let i = 0; i < 4; i++) {
      const res = await app.fetch(req("/test"), env);
      expect(res.status).toBe(200);
    }
  });

  it("request at limit returns 429", async () => {
    const app = makeApp({ requestsPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      await app.fetch(req("/test"), env);
    }
    const res = await app.fetch(req("/test"), env);
    expect(res.status).toBe(429);
  });

  it("429 response includes Retry-After header", async () => {
    const app = makeApp({ requestsPerMinute: 1 });
    await app.fetch(req("/test"), env);
    const res = await app.fetch(req("/test"), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "0", 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("429 response includes X-RateLimit-Limit and X-RateLimit-Remaining: 0", async () => {
    const app = makeApp({ requestsPerMinute: 1 });
    await app.fetch(req("/test"), env);
    const res = await app.fetch(req("/test"), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("passing response includes X-RateLimit-* headers", async () => {
    const app = makeApp({ requestsPerMinute: 10 });
    const res = await app.fetch(req("/test"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    const reset = Number.parseInt(res.headers.get("X-RateLimit-Reset") ?? "0", 10);
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("authenticated users use identifier from userId", async () => {
    const app = makeAuthApp({ requestsPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      await app.fetch(req("/test"), env);
    }
    const res = await app.fetch(req("/test"), env);
    expect(res.status).toBe(429);
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:usr_test:${minuteBucket}`;
    const raw = await kv.get(key);
    expect(raw).toBe("3");
  });

  it("anonymous users default to 60 req/min limit", async () => {
    const app = makeApp();
    const res = await app.fetch(req("/test"), env);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("authenticated users default to 1000 req/min limit", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(req("/test"), env);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("/health skips rate limiting", async () => {
    const app = makeApp({ requestsPerMinute: 0 });
    const res = await app.fetch(req("/health"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("uses CF-Connecting-IP when available", async () => {
    const app = makeApp({ requestsPerMinute: 5 });
    await app.fetch(req("/test", { "CF-Connecting-IP": "1.2.3.4" }), env);
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:1.2.3.4:${minuteBucket}`;
    const raw = await kv.get(key);
    expect(raw).toBe("1");
  });

  it("allows request through when KV throws", async () => {
    const brokenKV = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {
        throw new Error("KV unavailable");
      },
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;

    const app = makeApp({ requestsPerMinute: 1 });
    const res = await app.fetch(req("/test"), makeEnv(brokenKV));
    expect(res.status).toBe(200);
  });
});
