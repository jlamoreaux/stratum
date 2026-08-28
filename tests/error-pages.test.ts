import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

// The global notFound/onError handlers content-negotiate (#299): browsers get a
// real HTML 404 page, while API paths and non-HTML clients keep the JSON contract.

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

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
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
  } as Env;
}

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("global 404 content negotiation", () => {
  it("serves an HTML 404 page to browsers", async () => {
    const res = await app.fetch(
      new Request("http://localhost/definitely/not/a/route", {
        headers: { Accept: HTML_ACCEPT },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Page not found");
    expect(html).toContain("Go to dashboard");
  });

  it("keeps JSON for requests without an HTML Accept header", async () => {
    const res = await app.fetch(new Request("http://localhost/definitely/not/a/route"), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("keeps JSON for Accept: application/json", async () => {
    const res = await app.fetch(
      new Request("http://localhost/definitely/not/a/route", {
        headers: { Accept: "application/json" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("keeps JSON on /api paths even when the client accepts HTML", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/definitely-not-a-route", {
        headers: { Accept: HTML_ACCEPT },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("keeps JSON for non-GET requests even when the client accepts HTML", async () => {
    const res = await app.fetch(
      new Request("http://localhost/definitely/not/a/route", {
        method: "POST",
        headers: { Accept: HTML_ACCEPT, Origin: "http://localhost" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("routes a malformed project URL through the negotiated 404", async () => {
    const res = await app.fetch(
      new Request("http://localhost/not-a-namespace/project", {
        headers: { Accept: HTML_ACCEPT },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("Page not found");
  });
});
