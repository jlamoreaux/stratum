import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { isPostHogProxyPath } from "../src/routes/posthog-proxy";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: { get: vi.fn(), create: vi.fn() } as unknown as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
    POSTHOG_HOST: "https://app.posthog.com",
    ...overrides,
  } as unknown as Env;
}

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** Replace global fetch, recording what the proxy forwarded. */
function stubUpstream(response: () => Response | Promise<Response>): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.url, init });
    return response();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPostHogProxyPath", () => {
  it("matches the prefix and everything under it, and nothing else", () => {
    expect(isPostHogProxyPath("/_ph")).toBe(true);
    expect(isPostHogProxyPath("/_ph/e")).toBe(true);
    expect(isPostHogProxyPath("/_phony")).toBe(false);
    expect(isPostHogProxyPath("/api/_ph")).toBe(false);
  });
});

describe("ingestion forwarding", () => {
  it("forwards an allowlisted capture path to the region's ingestion host", async () => {
    const calls = stubUpstream(() => new Response("ok", { status: 200 }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e?ver=1", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe("https://us.i.posthog.com/e?ver=1");
  });

  it("routes an EU instance to the EU ingestion host", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv({ POSTHOG_HOST: "https://eu.posthog.com" }),
    );
    expect(calls[0]?.url).toBe("https://eu.i.posthog.com/e");
  });

  it("never forwards the session cookie or an Authorization header", async () => {
    // The proxy is same-origin, so the browser attaches the Stratum session
    // cookie to every analytics request. Forwarding it would hand a live
    // credential to a third party on every pageview.
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: {
          cookie: "stratum_session=secret-session-value",
          authorization: "Bearer secret-token",
        },
      }),
      makeEnv(),
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it("forwards the client IP so events do not all geolocate to one datacentre", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
      makeEnv(),
    );
    expect(new Headers(calls[0]?.init?.headers).get("X-Forwarded-For")).toBe("203.0.113.7");
  });

  it("strips upstream Set-Cookie so PostHog cannot set state on this origin", async () => {
    stubUpstream(() => new Response("ok", { headers: { "set-cookie": "ph_session=1; Path=/" } }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses any path outside the ingestion allowlist", async () => {
    // An unrestricted prefix is an unauthenticated relay running under this
    // origin and billed to whoever deployed it.
    const calls = stubUpstream(() => new Response("ok"));
    for (const path of ["/_ph/admin", "/_ph/s", "/_ph/anything"]) {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, { method: "POST" }),
        makeEnv(),
      );
      expect(res.status, path).toBe(204);
    }
    // Traversal is normalised away by URL parsing before routing, so it never
    // reaches the proxy at all — the property that matters is that no such
    // request is forwarded, whatever status the app ends up returning.
    await app.fetch(new Request("http://localhost/_ph/../secret", { method: "POST" }), makeEnv());
    expect(calls).toHaveLength(0);
  });

  it("refuses methods that are not beacons or config calls", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await app.fetch(new Request("http://localhost/_ph/e", { method }), makeEnv());
      expect(res.status, method).toBe(204);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a request it has already forwarded once", async () => {
    // Catches a POSTHOG_HOST that CNAMEs back to this same Worker route, which
    // same-origin comparison alone cannot see.
    const calls = stubUpstream(() => new Response("ok"));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: { "X-Stratum-Proxy": "1" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("refuses to forward when POSTHOG_HOST points back at this instance", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv({ POSTHOG_HOST: "http://localhost" }),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("answers 204 rather than 500 when PostHog is unreachable", async () => {
    // Reaching the error boundary would emit an `error_occurred` event per
    // failed beacon: a telemetry storm caused by telemetry being down.
    stubUpstream(() => {
      throw new Error("network down");
    });
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
  });
});

describe("SDK bundle", () => {
  it("serves the pinned bundle immutably", async () => {
    const calls = stubUpstream(() => new Response("/* sdk */", { status: 200 }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/static/1.427.2/array.js"),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(calls[0]?.url).toBe("https://cdn.jsdelivr.net/npm/posthog-js@1.427.2/dist/array.js");
  });

  it("refuses a version that is not plain semver", async () => {
    // The version is interpolated into a CDN URL, so it must never be
    // attacker-controlled path material.
    const calls = stubUpstream(() => new Response("/* sdk */"));
    for (const version of ["../../evil", "latest", "1.2", "1.2.3;x"]) {
      const res = await app.fetch(
        new Request(`http://localhost/_ph/static/${encodeURIComponent(version)}/array.js`),
        makeEnv(),
      );
      expect(res.status, version).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("answers 204 when the bundle cannot be fetched", async () => {
    stubUpstream(() => new Response("nope", { status: 500 }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/static/1.427.2/array.js"),
      makeEnv(),
    );
    expect(res.status).toBe(204);
  });
});
