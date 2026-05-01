import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession, deleteSession } from "../storage/sessions";
import { createUser, getUserByEmail } from "../storage/users";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

// GET /auth/email - Show login form
app.get("/", (c) => {
  const error = c.req.query("error");
  const success = c.req.query("success");

  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Sign In — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
        <style>{`
          .auth-container {
            max-width: 400px;
            margin: 4rem auto;
            padding: 2rem;
            background: var(--bg-secondary);
            border-radius: 8px;
            border: 1px solid var(--border);
          }
          .auth-title {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
            color: var(--text-primary);
          }
          .auth-subtitle {
            color: var(--text-secondary);
            margin-bottom: 2rem;
            font-size: 0.9rem;
          }
          .form-group {
            margin-bottom: 1.5rem;
          }
          .form-label {
            display: block;
            margin-bottom: 0.5rem;
            color: var(--text-secondary);
            font-size: 0.9rem;
          }
          .form-input {
            width: 100%;
            padding: 0.75rem;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 1rem;
            box-sizing: border-box;
          }
          .form-input:focus {
            outline: none;
            border-color: var(--accent);
          }
          .btn {
            width: 100%;
            padding: 0.75rem;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 1rem;
            cursor: pointer;
            font-weight: 500;
          }
          .btn:hover {
            opacity: 0.9;
          }
          .alert {
            padding: 1rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
          }
          .alert-error {
            background: rgba(248, 113, 113, 0.1);
            border: 1px solid rgba(248, 113, 113, 0.3);
            color: #f87171;
          }
          .alert-success {
            background: rgba(74, 222, 128, 0.1);
            border: 1px solid rgba(74, 222, 128, 0.3);
            color: #4ade80;
          }
          .auth-divider {
            text-align: center;
            margin: 1.5rem 0;
            color: var(--text-secondary);
            font-size: 0.85rem;
            position: relative;
          }
          .auth-divider::before,
          .auth-divider::after {
            content: "";
            position: absolute;
            top: 50%;
            width: 40%;
            height: 1px;
            background: var(--border);
          }
          .auth-divider::before { left: 0; }
          .auth-divider::after { right: 0; }
          .auth-link {
            color: var(--accent);
            text-decoration: none;
          }
          .auth-link:hover {
            text-decoration: underline;
          }
          .auth-note {
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
            font-size: 0.85rem;
            color: var(--text-secondary);
            line-height: 1.5;
          }
        `}</style>
      </head>
      <body>
        <nav class="nav">
          <a class="nav-brand" href="/">stratum</a>
        </nav>
        <main class="main">
          <div class="auth-container">
            <h1 class="auth-title">Sign in to Stratum</h1>
            <p class="auth-subtitle">Enter your email to receive a magic link</p>

            {error && (
              <div class="alert alert-error">{error}</div>
            )}

            {success && (
              <div class="alert alert-success">{success}</div>
            )}

            <form method="post" action="/auth/email/send">
              <div class="form-group">
                <label class="form-label" for="email">Email address</label>
                <input
                  class="form-input"
                  type="email"
                  id="email"
                  name="email"
                  placeholder="you@example.com"
                  required
                  autoFocus
                />
              </div>
              <button type="submit" class="btn">Send Magic Link</button>
            </form>

            <div class="auth-divider">or</div>

            <a href="/auth/github" class="btn" style={{ background: '#333', display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Continue with GitHub
            </a>

            <div class="auth-note">
              <strong>No password required.</strong> We'll send you a secure link to sign in instantly. The link expires in 15 minutes.
            </div>
          </div>
        </main>
      </body>
    </html>
  );
});

// POST /auth/email/send - Send magic link
app.post("/send", async (c) => {
  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email || !email.includes("@")) {
    return c.redirect("/auth/email?error=Please enter a valid email address");
  }

  // Check if email sending is configured
  if (!c.env.EMAIL) {
    console.error("[email-auth] Email sending not configured");
    return c.redirect("/auth/email?error=Email authentication is not configured. Please contact the administrator.");
  }

  const fromAddress = c.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    console.error("[email-auth] EMAIL_FROM_ADDRESS secret not set");
    return c.redirect("/auth/email?error=Email authentication is not fully configured. Please contact the administrator.");
  }

  try {
    // Generate magic link token
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Store token in KV
    await c.env.STATE.put(
      `magic_link:${token}`,
      JSON.stringify({ email, createdAt: Date.now() }),
      { expirationTtl: 15 * 60 } // 15 minutes TTL
    );

    // Build magic link URL
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const magicLink = `${baseUrl}/auth/email/verify?token=${token}`;

    // Send email
    const emailResult = await c.env.EMAIL.send({
      to: email,
      from: { email: fromAddress, name: "Stratum" },
      subject: "Sign in to Stratum",
      text: `Click this link to sign in to Stratum:\n\n${magicLink}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
      html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to Stratum</title>
</head>
<body style="margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #e5e5e5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #0f0f0f;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table width="100%" max-width="400" cellpadding="0" cellspacing="0" style="max-width: 400px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333;">
          <tr>
            <td style="padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0 0 10px; font-size: 24px; color: #e5e5e5;">Sign in to Stratum</h1>
              <p style="margin: 0 0 30px; color: #888; font-size: 14px;">Click the button below to sign in instantly.</p>
              
              <a href="${magicLink}" style="display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; text-decoration: none; border-radius: 4px; font-weight: 500; font-size: 16px;">Sign In to Stratum</a>
              
              <p style="margin: 30px 0 0; color: #666; font-size: 12px; line-height: 1.5;">
                This link expires in 15 minutes.<br>
                If you didn't request this, you can safely ignore this email.
              </p>
              
              <p style="margin: 20px 0 0; color: #444; font-size: 11px;">
                Or copy and paste this URL:<br>
                <code style="color: #666; word-break: break-all;">${magicLink}</code>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    console.log(`[email-auth] Magic link sent to ${email}`);

    return c.redirect(
      `/auth/email?success=Check your email! We've sent a magic link to ${email}. It expires in 15 minutes.`
    );
  } catch (err) {
    console.error("[email-auth] Failed to send magic link:", err);
    return c.redirect("/auth/email?error=Failed to send email. Please try again later.");
  }
});

// GET /auth/email/verify - Verify magic link and create session
app.get("/verify", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.redirect("/auth/email?error=Invalid or expired link");
  }

  try {
    // Retrieve token data from KV
    const tokenData = await c.env.STATE.get(`magic_link:${token}`);

    if (!tokenData) {
      return c.redirect("/auth/email?error=This link has expired or already been used");
    }

    const { email } = JSON.parse(tokenData);

    // Delete the token so it can't be reused
    await c.env.STATE.delete(`magic_link:${token}`);

    // Get or create user
    let user = await getUserByEmail(c.env.DB, email);

    if (!user) {
      // Create new user
      const { user: newUser } = await createUser(c.env.DB, email);
      user = newUser;
      console.log(`[email-auth] Created new user: ${user.id} (${email})`);
    }

    // Create session
    const session = await createSession(c.env.DB, user.id);

    // Set session cookie
    setCookie(c, "stratum_session", session.id, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 2592000, // 30 days
      path: "/",
    });

    console.log(`[email-auth] User signed in: ${user.id} (${email})`);

    // Redirect to home or the page they were trying to access
    const redirectTo = getCookie(c, "redirect_after_login") || "/";
    deleteCookie(c, "redirect_after_login", { path: "/" });

    return c.redirect(redirectTo);
  } catch (err) {
    console.error("[email-auth] Failed to verify magic link:", err);
    return c.redirect("/auth/email?error=Failed to sign in. Please try again.");
  }
});

export { app as emailAuthRouter };
