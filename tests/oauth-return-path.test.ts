import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByGitHubId: vi.fn(),
  upsertGitHubUser: vi.fn(),
}));

vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue({ success: true, data: undefined }),
}));

import { createSession } from "../src/storage/sessions";
import { getUserByEmail, upsertGitHubUser } from "../src/storage/users";

const fetchMock = vi.fn();

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth", authRouter);
  return app;
}

/** In-memory KV that also exposes the raw store, so a test can read the state value. */
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(state: KVNamespace): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: state,
    DB: {} as D1Database,
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    OAUTH_REDIRECT_URI: "https://app.example.com/auth/github/callback",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "https://app.example.com/auth/google/callback",
  } as Env;
}

/** The `state` an authorize redirect minted, read back off its Location header. */
function stateFrom(res: Response): string {
  const location = res.headers.get("Location") ?? "";
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error(`No state in ${location}`);
  return state;
}

function mockGoogleIdentity() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(
        JSON.stringify({ sub: "g-1", email: "user@example.com", email_verified: true }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.mocked(getUserByEmail).mockResolvedValue({
    success: true,
    data: {
      id: "usr_1",
      email: "user@example.com",
      username: "user",
      tokenHash: "h",
      createdAt: "",
    },
  });
}

function mockGitHubIdentity() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 });
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(
        JSON.stringify([{ email: "user@example.com", primary: true, verified: true }]),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.mocked(upsertGitHubUser).mockResolvedValue({
    success: true,
    data: {
      id: "usr_1",
      email: "user@example.com",
      username: "octocat",
      tokenHash: "h",
      createdAt: "",
    },
  });
}

describe("OAuth post-login return path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_1", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The destination cannot ride the URL: an authorization server echoes back
  // only `code` and `state`, so it has to be carried by the state record.
  it.each([
    ["github", "/auth/github"],
    ["google", "/auth/google"],
  ])("stores the requested destination alongside the %s state", async (_provider, path) => {
    const { kv, store } = makeKv();
    const res = await makeApp().fetch(
      new Request(`http://localhost${path}?next=/projects/acme%2Fweb`),
      makeEnv(kv),
    );

    expect(store.get(`oauth_state:${stateFrom(res)}`)).toBe("/projects/acme/web");
  });

  it("returns a GitHub sign-in to the page it started from", async () => {
    mockGitHubIdentity();
    const { kv } = makeKv();
    const env = makeEnv(kv);
    const app = makeApp();

    const start = await app.fetch(new Request("http://localhost/auth/github?next=/settings"), env);
    const state = stateFrom(start);

    const res = await app.fetch(
      new Request(`http://localhost/auth/github/callback?code=ok&state=${state}`, {
        headers: { Cookie: `stratum_oauth_state=${state}` },
      }),
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings");
  });

  it("returns a Google sign-in to the page it started from", async () => {
    mockGoogleIdentity();
    const { kv } = makeKv();
    const env = makeEnv(kv);
    const app = makeApp();

    const start = await app.fetch(new Request("http://localhost/auth/google?next=/settings"), env);
    const state = stateFrom(start);

    const res = await app.fetch(
      new Request(`http://localhost/auth/google/callback?code=ok&state=${state}`, {
        headers: { Cookie: `stratum_oauth_state=${state}` },
      }),
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings");
  });

  // An open redirect out of the sign-in flow is a credible phishing primitive:
  // the victim lands on the attacker's page having just authenticated for real.
  it.each(["https://evil.example/pwn", "//evil.example/pwn", "http://evil.example"])(
    "refuses to carry the off-origin destination %s",
    async (next) => {
      const { kv, store } = makeKv();
      const res = await makeApp().fetch(
        new Request(`http://localhost/auth/google?next=${encodeURIComponent(next)}`),
        makeEnv(kv),
      );

      expect(store.get(`oauth_state:${stateFrom(res)}`)).toBe("1");
    },
  );

  it("sends a sign-in that asked for nothing to the home page", async () => {
    mockGoogleIdentity();
    const { kv } = makeKv();
    const env = makeEnv(kv);
    const app = makeApp();

    const state = stateFrom(await app.fetch(new Request("http://localhost/auth/google"), env));

    const res = await app.fetch(
      new Request(`http://localhost/auth/google/callback?code=ok&state=${state}`, {
        headers: { Cookie: `stratum_oauth_state=${state}` },
      }),
      env,
    );

    expect(res.headers.get("Location")).toBe("/");
  });

  // A state minted by the previous revision holds the literal "1"; one still in
  // flight when this deploy lands must validate rather than 400.
  it("accepts a state minted before destinations were carried", async () => {
    mockGoogleIdentity();
    const { kv } = makeKv({ "oauth_state:legacy": "1" });

    const res = await makeApp().fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=legacy", {
        headers: { Cookie: "stratum_oauth_state=legacy" },
      }),
      makeEnv(kv),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});
