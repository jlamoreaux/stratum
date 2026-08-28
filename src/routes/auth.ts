import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { betaGateEnabled } from "../beta/gate";
import { recordAudit } from "../storage/audit";
import { getIdentityByIssuerSubject, upsertIdentity } from "../storage/identities";
import { createSession, deleteSession, getSession } from "../storage/sessions";
import {
  createUser,
  getUser,
  getUserByEmail,
  getUserByGitHubId,
  upsertGitHubUser,
} from "../storage/users";
import type { Env } from "../types";
import { constantTimeEqual } from "../utils/crypto";
import { NotFoundError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

const OAUTH_STATE_COOKIE = "stratum_oauth_state";
const OAUTH_STATE_TTL_SECONDS = 600;

// Canonical issuer values for the identities table (see src/storage/identities.ts).
// RESERVED: the OIDC connection-registration flow (org SSO) must reject these
// issuers — an org-supplied connection claiming either could re-point rows in
// the GitHub/Google identity namespace via upsertIdentity's ON CONFLICT.
const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Record the external identity for a completed OAuth sign-in. Non-fatal by
 * design: identity rows are forward-provisioning for SSO (backfilled lazily at
 * login), while GitHub login is still keyed off users.github_id and Google
 * falls back to email match — so a storage blip here must not lock anyone out.
 * The next successful login retries the upsert.
 */
async function recordOAuthIdentity(
  db: D1Database,
  logger: Logger,
  input: {
    userId: string;
    provider: "github" | "google";
    issuer: string;
    subject: string;
    email: string;
  },
): Promise<void> {
  const result = await upsertIdentity(db, logger, input);
  if (!result.success) {
    logger.error("Failed to upsert OAuth identity; continuing login", result.error, {
      provider: input.provider,
      userId: input.userId,
    });
  }
}

/**
 * Mint an OAuth state, persist it in KV (replay prevention), and bind it to
 * the initiating browser via a short-lived cookie (login-CSRF prevention).
 */
async function issueOAuthState(
  c: Parameters<typeof setCookie>[0],
  kv: KVNamespace,
): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, "");
  await kv.put(`oauth_state:${state}`, "1", { expirationTtl: OAUTH_STATE_TTL_SECONDS });
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: OAUTH_STATE_TTL_SECONDS,
    path: "/auth",
  });
  return state;
}

/**
 * Validate a callback's state: it must match the browser's state cookie
 * (constant-time) AND exist in KV. Consumes both on success.
 */
async function consumeOAuthState(
  c: Parameters<typeof getCookie>[0] & Parameters<typeof deleteCookie>[0],
  kv: KVNamespace,
  state: string,
): Promise<boolean> {
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  if (!cookieState || !constantTimeEqual(cookieState, state)) {
    return false;
  }
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/auth" });

  const stateKey = `oauth_state:${state}`;
  const stored = await kv.get(stateKey);
  if (!stored) return false;
  await kv.delete(stateKey);
  return true;
}

app.get("/github", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GITHUB_CLIENT_ID;
  const redirectUri = c.env.OAUTH_REDIRECT_URI;

  if (!clientId || !c.env.GITHUB_CLIENT_SECRET) {
    logger.warn("GitHub OAuth not configured");
    return c.json({ error: "GitHub OAuth is not configured" }, 501);
  }

  const state = await issueOAuthState(c, c.env.STATE);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri ?? "",
    scope: "user:email",
    state,
  });

  logger.debug("Redirecting to GitHub OAuth");
  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get("/github/callback", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GITHUB_CLIENT_ID;
  const clientSecret = c.env.GITHUB_CLIENT_SECRET;
  const redirectUri = c.env.OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    logger.warn("GitHub OAuth not configured");
    return c.json({ error: "GitHub OAuth is not configured" }, 501);
  }

  const { code, state } = c.req.query();

  if (!state) {
    logger.warn("Missing state parameter");
    return c.json({ error: "Missing state parameter" }, 400);
  }

  if (!(await consumeOAuthState(c, c.env.STATE, state))) {
    logger.warn("Invalid, expired, or unbound state", { statePrefix: state.slice(0, 8) });
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  if (!code) {
    logger.warn("Missing code parameter");
    return c.json({ error: "Missing code parameter" }, 400);
  }

  logger.debug("Exchanging code for token");
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
    logger.error("Failed to exchange code for token");
    return c.json({ error: "Failed to exchange code for token" }, 502);
  }

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    logger.error("GitHub OAuth error", undefined, { error: tokenData.error });
    return c.json({ error: "GitHub OAuth error" }, 502);
  }

  const accessToken = tokenData.access_token;

  logger.debug("Fetching GitHub user data");
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
    logger.error("Failed to fetch GitHub user data");
    return c.json({ error: "Failed to fetch GitHub user data" }, 502);
  }

  const githubUser = await userRes.json<{ id: number; login: string }>();
  const emailsBody = await emailsRes.json<unknown>();
  // A 200 with a non-array body (proxy error page, API drift) must not throw —
  // the empty list already has correct semantics on every path below.
  const emails = (Array.isArray(emailsBody) ? emailsBody : []) as {
    email: string;
    primary: boolean;
    verified: boolean;
  }[];

  // A returning linked user's credential is the GitHub account id itself, so
  // resolve by github_id before any email requirement applies.
  const byGithub = await getUserByGitHubId(c.env.DB, String(githubUser.id), logger);

  // Email match and account creation trust GitHub emails only when GitHub has
  // verified them — an unverified address is attacker-claimable and would let
  // someone link onto (or squat) another person's account. Lowercased so the
  // match hits accounts stored via the magic-link flow, which normalizes.
  const verifiedEmail = (
    emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email
  )
    ?.trim()
    .toLowerCase();

  let primaryEmail: string;
  if (verifiedEmail) {
    primaryEmail = verifiedEmail;
  } else if (byGithub.success) {
    primaryEmail = byGithub.data.email;
  } else {
    logger.warn("No verified email found on GitHub account", { githubId: githubUser.id });
    return c.json({ error: "No verified email found on GitHub account" }, 422);
  }

  const emailPrefix = primaryEmail.split("@")[0];
  logger.info("Upserting GitHub user", { githubId: githubUser.id, emailPrefix });

  const byPrimaryEmail = await getUserByEmail(c.env.DB, primaryEmail, logger);

  // Closed beta: OAuth is login-only. A brand-new account (no match by GitHub id
  // or verified email) must be created through the invite-gated magic-link flow.
  if (betaGateEnabled(c.env) && !byGithub.success && !byPrimaryEmail.success) {
    logger.warn("Blocked GitHub signup — closed beta", { githubId: githubUser.id });
    return c.redirect("/auth/signup?error=invite_required");
  }

  // A disabled (or deleting) account must not sign in — and the refusal must
  // come BEFORE upsertGitHubUser, which would otherwise link github_id onto
  // the frozen row and hand it a working login credential at re-enable time.
  // Check the same account upsertGitHubUser would match: by GitHub id, else by
  // primaryEmail.
  const existingAccount = byGithub.success
    ? byGithub.data
    : byPrimaryEmail.success
      ? byPrimaryEmail.data
      : null;
  if (existingAccount && (existingAccount.disabledAt || existingAccount.deletingAt)) {
    logger.warn("Blocked GitHub sign-in — account disabled", { userId: existingAccount.id });
    return c.redirect("/auth/login?error=account_disabled");
  }

  const userResult = await upsertGitHubUser(
    c.env.DB,
    {
      githubId: String(githubUser.id),
      email: primaryEmail,
      username: githubUser.login,
    },
    logger,
  );

  if (!userResult.success) {
    logger.error("Failed to upsert GitHub user", undefined, { githubId: githubUser.id });
    return c.json({ error: "Failed to create user" }, 500);
  }

  const user = userResult.data;

  const sessionLogger = logger.child({ userId: user.id });

  await recordOAuthIdentity(c.env.DB, sessionLogger, {
    userId: user.id,
    provider: "github",
    issuer: GITHUB_ISSUER,
    subject: String(githubUser.id),
    email: primaryEmail,
  });

  const sessionResult = await createSession(c.env.DB, user.id, sessionLogger);
  if (sessionResult.success) {
    await recordAudit(c.env.DB, sessionLogger, {
      action: "session.created",
      actorType: "user",
      actorId: user.id,
      detail: { method: "github-oauth" },
    });
  }
  if (!sessionResult.success) {
    sessionLogger.error("Failed to create session");
    return c.json({ error: "Failed to create session" }, 500);
  }

  const session = sessionResult.data;
  setCookie(c, "stratum_session", session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 2592000,
    path: "/",
  });

  sessionLogger.info("GitHub OAuth successful, session created");

  return c.redirect("/");
});

app.get("/google", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !c.env.GOOGLE_CLIENT_SECRET || !redirectUri) {
    logger.warn("Google OAuth not configured");
    return c.json({ error: "Google OAuth is not configured" }, 501);
  }

  const state = await issueOAuthState(c, c.env.STATE);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });

  logger.debug("Redirecting to Google OAuth");
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/google/callback", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    logger.warn("Google OAuth not configured");
    return c.json({ error: "Google OAuth is not configured" }, 501);
  }

  const { code, state } = c.req.query();

  if (!state) {
    return c.json({ error: "Missing state parameter" }, 400);
  }
  if (!(await consumeOAuthState(c, c.env.STATE, state))) {
    logger.warn("Invalid, expired, or unbound state", { statePrefix: state.slice(0, 8) });
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  if (!code) {
    return c.json({ error: "Missing code parameter" }, 400);
  }

  logger.debug("Exchanging code for Google token");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    logger.error("Failed to exchange code for Google token");
    return c.json({ error: "Failed to exchange code for token" }, 502);
  }

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    logger.error("Google OAuth error", undefined, { error: tokenData.error });
    return c.json({ error: "Google OAuth error" }, 502);
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) {
    logger.error("Failed to fetch Google user data");
    return c.json({ error: "Failed to fetch Google user data" }, 502);
  }

  const googleUser = await userRes.json<{
    sub?: string;
    email?: string;
    email_verified?: boolean;
  }>();

  if (!googleUser.sub) {
    logger.error("Google userinfo response missing sub");
    return c.json({ error: "Failed to fetch Google user data" }, 502);
  }

  // Lowercased so matching hits accounts stored via the magic-link flow, which
  // normalizes; identities.email is normalized the same way in storage.
  const googleEmail = googleUser.email?.trim().toLowerCase();

  // Resolve by the stable (issuer, sub) pair first — the identity persisted at
  // a prior login. The sub, not the email, is the credential for a returning
  // linked user (mirroring github_id-first above), so the verified-email
  // requirement applies only to the email-match/create paths below. Only
  // NotFound falls through to email matching; a storage failure fails the
  // login closed, because falling through could email-match (or JIT-create) a
  // duplicate account for an already-linked subject.
  const identityLookup = await getIdentityByIssuerSubject(
    c.env.DB,
    logger,
    GOOGLE_ISSUER,
    googleUser.sub,
  );
  if (!identityLookup.success && !(identityLookup.error instanceof NotFoundError)) {
    logger.error("Google identity lookup failed", identityLookup.error);
    return c.json({ error: "Failed to sign in" }, 500);
  }

  let userId: string;
  let identityEmail: string;
  if (identityLookup.success) {
    // An identity row must point at a live user (account deletion cascades
    // through deleteIdentitiesForUser) — treat a dangling row as an error, not
    // as license to fall through and mint a duplicate account.
    const identityUser = await getUser(c.env.DB, identityLookup.data.userId, logger);
    if (!identityUser.success) {
      logger.error("Google identity points at a missing user", identityUser.error, {
        identityId: identityLookup.data.id,
      });
      return c.json({ error: "Failed to sign in" }, 500);
    }
    // A disabled (or deleting) account must not sign in: refuse BEFORE minting
    // a session, so no stratum_session cookie and no session.created audit row
    // exist for it.
    if (identityUser.data.disabledAt || identityUser.data.deletingAt) {
      logger.warn("Blocked Google sign-in — account disabled", { userId: identityUser.data.id });
      return c.redirect("/auth/login?error=account_disabled");
    }
    userId = identityUser.data.id;
    // Refresh the identity email only from a verified claim; otherwise keep
    // the account's stored email.
    identityEmail =
      googleEmail && googleUser.email_verified === true ? googleEmail : identityUser.data.email;
  } else {
    // Email match and account creation trust the Google email only when
    // verified — an unverified address is attacker-claimable.
    if (!googleEmail || googleUser.email_verified !== true) {
      logger.warn("Google account has no verified email");
      return c.json({ error: "No verified email on Google account" }, 422);
    }
    identityEmail = googleEmail;
    // Unlinked Google identity maps onto the email-based account model: an
    // existing account with this (verified) email is reused, otherwise one is
    // created — the same semantics as magic-link sign-in.
    const existing = await getUserByEmail(c.env.DB, googleEmail, logger);
    if (existing.success) {
      if (existing.data.disabledAt || existing.data.deletingAt) {
        logger.warn("Blocked Google sign-in — account disabled", { userId: existing.data.id });
        return c.redirect("/auth/login?error=account_disabled");
      }
      userId = existing.data.id;
    } else {
      // Closed beta: OAuth is login-only — new accounts require an invite code.
      if (betaGateEnabled(c.env)) {
        logger.warn("Blocked Google signup — closed beta");
        return c.redirect("/auth/signup?error=invite_required");
      }
      const createdResult = await createUser(c.env.DB, googleEmail, logger);
      if (createdResult.success) {
        userId = createdResult.data.user.id;
      } else {
        // Two concurrent first logins race on users.email UNIQUE; the loser's
        // account exists now — sign it in instead of surfacing a raw 500.
        const raced = await getUserByEmail(c.env.DB, googleEmail, logger);
        if (!raced.success || raced.data.disabledAt || raced.data.deletingAt) {
          logger.error("Failed to create user from Google sign-in", createdResult.error);
          return c.json({ error: "Failed to create user" }, 500);
        }
        userId = raced.data.id;
      }
    }
  }

  await recordOAuthIdentity(c.env.DB, logger.child({ userId }), {
    userId,
    provider: "google",
    issuer: GOOGLE_ISSUER,
    subject: googleUser.sub,
    email: identityEmail,
  });

  const sessionLogger = logger.child({ userId });
  const sessionResult = await createSession(c.env.DB, userId, sessionLogger);
  if (!sessionResult.success) {
    sessionLogger.error("Failed to create session");
    return c.json({ error: "Failed to create session" }, 500);
  }
  await recordAudit(c.env.DB, sessionLogger, {
    action: "session.created",
    actorType: "user",
    actorId: userId,
    detail: { method: "google-oauth" },
  });

  setCookie(c, "stratum_session", sessionResult.data.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 2592000,
    path: "/",
  });

  sessionLogger.info("Google OAuth successful, session created");
  return c.redirect("/");
});

// Logout is state-changing, so it happens on POST (the nav renders a form and
// the CSRF middleware's same-origin check applies). A GET — old bookmarks,
// prefetchers, or a cross-site <img> — must not end the session; it just goes home.
app.get("/logout", (c) => c.redirect("/"));

app.post("/logout", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const sessionId = getCookie(c, "stratum_session");

  if (sessionId) {
    logger.debug("Deleting session", { sessionId: `${sessionId.slice(0, 8)}...` });

    // Get session to verify ownership and get userId
    const sessionResult = await getSession(c.env.DB, sessionId, logger);
    if (sessionResult.success) {
      const userId = sessionResult.data.userId;
      await deleteSession(c.env.DB, sessionId, userId, logger);
    }
  }

  deleteCookie(c, "stratum_session", { path: "/" });
  logger.info("User logged out");

  return c.redirect("/");
});

export { app as authRouter };
