/**
 * Issue #254: the token management API.
 *
 * The property under test that is easy to lose: these routes require a browser
 * SESSION. A read_write token that could mint tokens, revoke its siblings, and
 * rotate the legacy credential makes the feature circular — the "revoke the lost
 * laptop" story fails if the lost laptop can issue itself a replacement.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
vi.mock("../src/storage/api-tokens", () => ({
  MIN_TOKEN_EXPIRY_DAYS: 1,
  MAX_TOKEN_EXPIRY_DAYS: 365,
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
}));
vi.mock("../src/storage/users", () => ({
  disableLegacyToken: vi.fn(async () => ({ success: true, data: undefined })),
  getUser: vi.fn(),
  getUserByUsername: vi.fn(),
  markUserDeleting: vi.fn(),
  rotateUserToken: vi.fn(async () => ({ success: true, data: "stratum_user_new" })),
}));
vi.mock("../src/storage/deletion-jobs", () => ({ createDeletionJob: vi.fn() }));

import { usersRouter } from "../src/routes/users";
import { createApiToken, listApiTokens, revokeApiToken } from "../src/storage/api-tokens";
import { recordAudit } from "../src/storage/audit";
import { disableLegacyToken } from "../src/storage/users";

const env = { DB: {} } as unknown as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** Mounts the router with an injected identity, so each test controls how the
 * caller authenticated without standing up real auth. */
function makeApp(identity: { userId?: string; authVia?: "token" | "session" }) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (identity.userId) c.set("userId", identity.userId);
    if (identity.authVia) c.set("authVia", identity.authVia);
    await next();
  });
  app.route("/api/users", usersRouter);
  return app;
}

const SESSION = { userId: "usr_1", authVia: "session" as const };
const TOKEN = { userId: "usr_1", authVia: "token" as const };

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("token management requires a session", () => {
  const cases: Array<{ label: string; method: string; path: string; body?: unknown }> = [
    { label: "list", method: "GET", path: "/api/users/me/tokens" },
    { label: "create", method: "POST", path: "/api/users/me/tokens", body: { name: "ci" } },
    { label: "revoke", method: "DELETE", path: "/api/users/me/tokens/tok_1" },
    { label: "disable legacy", method: "POST", path: "/api/users/me/legacy-token/disable" },
  ];

  it.each(cases)("403s an API token on $label", async ({ method, path, body }) => {
    const res = await makeApp(TOKEN).fetch(req(method, path, body), env, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "SESSION_REQUIRED" });
    expect(createApiToken).not.toHaveBeenCalled();
    expect(revokeApiToken).not.toHaveBeenCalled();
    expect(disableLegacyToken).not.toHaveBeenCalled();
  });

  it.each(cases)("401s an unauthenticated caller on $label", async ({ method, path, body }) => {
    const res = await makeApp({}).fetch(req(method, path, body), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/users/me/tokens", () => {
  beforeEach(() => {
    vi.mocked(createApiToken).mockResolvedValue({
      success: true,
      data: {
        token: {
          id: "tok_1",
          name: "ci",
          tokenPrefix: "stratum_user_abcd1234",
          scope: "read",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        plaintext: "stratum_user_abcd1234abcd1234abcd1234abcd1234",
      },
    } as never);
  });

  it("returns the plaintext once, and forbids caching it", async () => {
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/tokens", { name: "ci" }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    // The plaintext exists nowhere else after this response.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { plaintext: string };
    expect(body.plaintext).toMatch(/^stratum_user_/);
  });

  it("defaults to the WEAKER scope when the caller does not say", async () => {
    await makeApp(SESSION).fetch(req("POST", "/api/users/me/tokens", { name: "ci" }), env, ctx);
    expect(createApiToken).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ scope: "read" }),
    );
  });

  it("audits the creation", async () => {
    await makeApp(SESSION).fetch(req("POST", "/api/users/me/tokens", { name: "ci" }), env, ctx);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "token.created", actorId: "usr_1" }),
    );
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { name: "   " }],
    ["an unknown scope", { name: "ci", scope: "admin" }],
    ["a non-integer expiry", { name: "ci", expiresInDays: 1.5 }],
    ["a zero expiry", { name: "ci", expiresInDays: 0 }],
    ["an over-long expiry", { name: "ci", expiresInDays: 400 }],
    ["a non-numeric expiry", { name: "ci", expiresInDays: "30" }],
  ])("400s %s", async (_label, body) => {
    const res = await makeApp(SESSION).fetch(req("POST", "/api/users/me/tokens", body), env, ctx);
    expect(res.status).toBe(400);
    expect(createApiToken).not.toHaveBeenCalled();
  });

  it("400s a JSON body of null rather than throwing", async () => {
    const res = await makeApp(SESSION).fetch(
      new Request("http://localhost/api/users/me/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("409s at the token cap", async () => {
    vi.mocked(createApiToken).mockResolvedValue({
      success: false,
      error: { message: "too many", code: "TOKEN_LIMIT_REACHED", statusCode: 409 },
    } as never);
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/tokens", { name: "ci" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
  });
});

describe("GET and DELETE", () => {
  it("lists without exposing a hash", async () => {
    vi.mocked(listApiTokens).mockResolvedValue({
      success: true,
      data: [
        {
          id: "tok_1",
          name: "ci",
          tokenPrefix: "stratum_user_abcd1234",
          scope: "read",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    const res = await makeApp(SESSION).fetch(req("GET", "/api/users/me/tokens"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("hash");
  });

  it("404s another user's token id without disclosing that it exists", async () => {
    vi.mocked(revokeApiToken).mockResolvedValue({
      success: false,
      error: { message: "not found", code: "NOT_FOUND", statusCode: 404 },
    } as never);
    const res = await makeApp(SESSION).fetch(
      req("DELETE", "/api/users/me/tokens/tok_someone_else"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("revokes and audits", async () => {
    vi.mocked(revokeApiToken).mockResolvedValue({ success: true, data: undefined } as never);
    const res = await makeApp(SESSION).fetch(
      req("DELETE", "/api/users/me/tokens/tok_1"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "token.revoked" }),
    );
  });
});

describe("legacy token disable", () => {
  it("disables and audits", async () => {
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/legacy-token/disable"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(disableLegacyToken).toHaveBeenCalledWith(env.DB, "usr_1", expect.any(Object));
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "token.legacy_disabled" }),
    );
  });
});

describe("rotate-token stays token-accessible", () => {
  it("still works with an API token, so existing automation is not broken", async () => {
    const res = await makeApp(TOKEN).fetch(req("POST", "/api/users/me/rotate-token"), env, ctx);
    // Deliberately NOT session-gated: it predates this change and restricting it
    // would break callers that rely on it today.
    expect(res.status).toBe(200);
  });
});
