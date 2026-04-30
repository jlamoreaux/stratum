import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession, deleteSession } from "../storage/sessions";
import { upsertGitHubUser } from "../storage/users";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/github", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  const redirectUri = c.env.OAUTH_REDIRECT_URI;

  if (!clientId || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: "GitHub OAuth is not configured" }, 501);
  }

  const state = crypto.randomUUID().replace(/-/g, "");
  await c.env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri ?? "",
    scope: "user:email",
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get("/github/callback", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  const clientSecret = c.env.GITHUB_CLIENT_SECRET;
  const redirectUri = c.env.OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return c.json({ error: "GitHub OAuth is not configured" }, 501);
  }

  const { code, state, next } = c.req.query();

  if (!state) {
    return c.json({ error: "Missing state parameter" }, 400);
  }

  const stateKey = `oauth_state:${state}`;
  const storedState = await c.env.STATE.get(stateKey);
  if (!storedState) {
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  await c.env.STATE.delete(stateKey);

  if (!code) {
    return c.json({ error: "Missing code parameter" }, 400);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "stratum",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    return c.json({ error: "Failed to exchange code for token" }, 502);
  }

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    return c.json({ error: "GitHub OAuth error" }, 502);
  }

  const accessToken = tokenData.access_token;

  const [userRes, emailsRes] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "stratum",
        Accept: "application/vnd.github+json",
      },
    }),
    fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "stratum",
        Accept: "application/vnd.github+json",
      },
    }),
  ]);

  if (!userRes.ok || !emailsRes.ok) {
    return c.json({ error: "Failed to fetch GitHub user data" }, 502);
  }

  const githubUser = await userRes.json<{ id: number; login: string }>();
  const emails = await emailsRes.json<{ email: string; primary: boolean; verified: boolean }[]>();

  const primaryEmail =
    emails.find((e) => e.primary && e.verified)?.email ??
    emails.find((e) => e.verified)?.email ??
    emails[0]?.email;

  if (!primaryEmail) {
    return c.json({ error: "No verified email found on GitHub account" }, 422);
  }

  const user = await upsertGitHubUser(c.env.DB, {
    githubId: String(githubUser.id),
    email: primaryEmail,
    username: githubUser.login,
  });

  const session = await createSession(c.env.DB, user.id);

  setCookie(c, "stratum_session", session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 2592000,
    path: "/",
  });

  let redirectTo = "/";
  if (next && typeof next === "string") {
    try {
      const url = new URL(next, "http://localhost");
      if (url.hostname === "localhost" || url.hostname === "") {
        redirectTo = url.pathname + url.search;
      }
    } catch {
      // invalid next param — fall back to /
    }
  }

  return c.redirect(redirectTo);
});

app.get("/logout", async (c) => {
  const sessionId = getCookie(c, "stratum_session");

  if (sessionId) {
    await deleteSession(c.env.DB, sessionId);
  }

  deleteCookie(c, "stratum_session", { path: "/" });

  return c.redirect("/");
});

export { app as authRouter };
