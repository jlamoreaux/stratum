/**
 * `GET /profile`: account identity plus the caller's own invite codes.
 *
 * Before this page the only copy of a user's codes was the one best-effort
 * email sent at signup — an email that is skipped entirely when no email
 * binding is configured. These assertions cover the whole route: the session
 * guard, the referral lookup, and the three states the code list can be in
 * (codes, none, service unreachable).
 *
 * `vitest.config.ts` restricts coverage to `src/**\/*.ts`, so the `.tsx` route
 * and page contribute nothing to the ratchet — these assertions are the only
 * thing policing them.
 */
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { ProfilePage } from "../src/ui/pages/profile";

vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(),
  rotateUserToken: vi.fn(),
  disableLegacyToken: vi.fn(),
  setUserTelemetryOptOut: vi.fn(),
}));
vi.mock("../src/storage/agents", () => ({
  listAgents: vi.fn(async () => ({ success: true, data: [] })),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
}));

import { uiRouter } from "../src/routes/ui";
import { getUser } from "../src/storage/users";

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    ...overrides,
  } as Env;
}

// `null`, not `undefined`, marks the anonymous case: `undefined` would trigger
// the default parameter and silently authenticate the request.
function makeApp(userId: string | null = "usr_1", via: "session" | "token" = "session") {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (userId) {
      c.set("userId", userId);
      c.set("authVia", via);
    }
    await next();
  });
  app.route("/", uiRouter);
  return app;
}

const get = () => new Request("http://localhost/profile");

function codesResponse(codes: unknown[]): Response {
  return new Response(JSON.stringify({ codes }), { status: 200 });
}

describe("GET /profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });
  });

  it("sends an anonymous visitor to sign in", async () => {
    const res = await makeApp(null).fetch(get(), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/email");
  });

  // Same rule as /settings (#254): the page lists shareable codes, so a leaked
  // read-only API token must not be able to enumerate and spend them.
  it("refuses an API-token caller", async () => {
    const res = await makeApp("usr_1", "token").fetch(get(), makeEnv());
    expect(res.status).toBe(403);
  });

  it("shows account identity", async () => {
    const res = await makeApp().fetch(get(), makeEnv());
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("@alice");
    expect(html).toContain("a@b.com");
    expect(html).toContain("Member since");
  });

  it("omits the invite section entirely when no referral service is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(html).not.toContain("Invite codes");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists codes with share links and redemption status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      codesResponse([
        { code: "AAA111" },
        { code: "BBB222", redeemedAt: "2026-02-03T00:00:00Z", redeemedBy: "bob" },
      ]),
    );
    const html = await (
      await makeApp().fetch(get(), makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }))
    ).text();

    expect(html).toContain("AAA111");
    expect(html).toContain("https://ref.example/?ref=AAA111");
    expect(html).toContain("Available");
    expect(html).toContain("bob");
    expect(html).toContain("1 of 2 codes are still available");
  });

  // The gate being off does not retract codes already minted: production runs
  // BETA_GATE = "0" with the service still configured, and those users' codes
  // must remain visible to them.
  it("lists codes even when the beta gate is switched off", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(codesResponse(["AAA111"]));
    const html = await (
      await makeApp().fetch(
        get(),
        makeEnv({ BETA_GATE: "0", REFERRAL_SERVICE_URL: "https://ref.example" }),
      )
    ).text();
    expect(html).toContain("AAA111");
  });

  it("says 'no codes' only when the service actually answered with none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(codesResponse([]));
    const html = await (
      await makeApp().fetch(get(), makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }))
    ).text();
    expect(html).toContain("You have no invite codes");
    expect(html).not.toContain("could not be loaded");
  });

  it("says the codes could not be loaded — not that there are none — on an outage", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const html = await (
      await makeApp().fetch(get(), makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }))
    ).text();
    expect(html).toContain("could not be loaded");
    expect(html).toContain("have not been lost");
    expect(html).not.toContain("You have no invite codes");
  });

  it("still renders the page when the referral service is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const res = await makeApp().fetch(
      get(),
      makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("@alice");
  });
});

describe("ProfilePage rendering", () => {
  const user = {
    id: "usr_1",
    email: "a@b.com",
    username: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("offers a copy button only for codes that are still available", () => {
    const html = renderToString(
      <ProfilePage
        user={user}
        invites={{
          status: "ok",
          codes: [
            { code: "AAA111", redeemedAt: null, redeemedBy: null },
            { code: "BBB222", redeemedAt: "2026-02-03T00:00:00Z", redeemedBy: "bob" },
          ],
        }}
        shareBaseUrl="https://ref.example"
        nonce="n1"
      />,
    );
    expect([...html.matchAll(/data-copy-target=/g)]).toHaveLength(1);
  });

  it("shows the bare code when there is no share origin to build a link from", () => {
    const html = renderToString(
      <ProfilePage
        user={user}
        invites={{ status: "ok", codes: [{ code: "AAA111", redeemedAt: null, redeemedBy: null }] }}
        nonce="n1"
      />,
    );
    expect(html).toContain("AAA111");
    expect(html).not.toContain("?ref=");
  });

  it("links a connected GitHub account and omits the row otherwise", () => {
    const withGitHub = renderToString(
      <ProfilePage user={{ ...user, githubUsername: "alice-gh" }} />,
    );
    expect(withGitHub).toContain("https://github.com/alice-gh");
    expect(renderToString(<ProfilePage user={user} />)).not.toContain("github.com");
  });

  // #161: with `script-src 'nonce-…'`, an un-nonced script and any inline
  // handler are both blocked outright.
  it("carries the CSP nonce on its script and uses no inline handlers", () => {
    const html = renderToString(
      <ProfilePage
        user={user}
        invites={{ status: "ok", codes: [{ code: "AAA111", redeemedAt: null, redeemedBy: null }] }}
        shareBaseUrl="https://ref.example"
        nonce="n1"
      />,
    );
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((tag) => !tag.includes('nonce="n1"'))).toEqual([]);
    expect([...html.matchAll(/\son[a-z]+="/g)]).toEqual([]);
  });

  // The copy script reads the value out of the DOM; a code must never be
  // interpolated into a script body, where one escaping slip is an XSS.
  it("keeps codes out of the script body and escapes them in markup", () => {
    const html = renderToString(
      <ProfilePage
        user={user}
        invites={{
          status: "ok",
          codes: [{ code: "</script><img src=x>", redeemedAt: null, redeemedBy: null }],
        }}
        shareBaseUrl="https://ref.example"
        nonce="n1"
      />,
    );
    const scriptBody = html.slice(html.indexOf("<script"));
    expect(scriptBody).not.toContain("<img src=x>");
    expect(html).not.toContain("<img src=x>");
  });
});
