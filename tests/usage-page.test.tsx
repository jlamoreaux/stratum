/**
 * `GET /settings/usage` — the page itself.
 *
 * `vitest.config.ts` restricts coverage to `src/**\/*.ts`, so the `.tsx` route
 * and page contribute nothing to the ratchet; the data behind them is covered
 * by `usage-visibility.test.ts`. What these assertions police is the part a
 * type checker cannot: that the route is reachable, that it is an account page
 * (session only, like every other one), and that a self-hoster — for whom
 * every limit is unlimited — gets a page that reads sensibly instead of one
 * that looks broken.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { uiRouter } from "../src/routes/ui";
import type { Env } from "../src/types";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

let env: Env;

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

const get = (path = "/settings/usage") => new Request(`http://localhost${path}`);

beforeEach(async () => {
  const db = makeSqliteD1().db;
  env = { DB: db, STATE: makeFakeKV(), ARTIFACTS: {} } as unknown as Env;
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "alice@test", "alice", "hash")
    .run();
});

describe("GET /settings/usage", () => {
  it("sends an anonymous visitor to sign in", async () => {
    const res = await makeApp(null).fetch(get(), env);
    expect(res.status).toBe(302);
  });

  it("refuses an API token, like every other account page", async () => {
    const res = await makeApp("usr_1", "token").fetch(get(), env);
    expect(res.status).toBe(403);
  });

  it("renders unlimited allowances as words, with no progress bar to misread", async () => {
    const res = await makeApp().fetch(get(), env);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Usage");
    expect(html).toContain("LLM tokens");
    expect(html).toContain("Unlimited");
    // A self-hosted instance says why everything is unlimited rather than
    // leaving the reader to conclude the page failed to load.
    expect(html).toContain("not configured with a billing service");
    // The bar only exists where a fraction exists.
    expect(html).not.toContain("progress-fill");
    // Server-rendered: this page carries no script of any kind.
    expect(html).not.toContain("<script");
  });
});
