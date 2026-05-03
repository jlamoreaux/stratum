import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailAuthRouter } from "../src/routes/email-auth";
import type { Env } from "../src/types";

vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn().mockResolvedValue({
    id: "ses_abc123",
    userId: "user_abc123",
    expiresAt: "2026-06-01T00:00:00.000Z",
  }),
}));

vi.mock("../src/storage/users", () => ({
  createUser: vi.fn().mockResolvedValue({
    user: {
      id: "user_abc123",
      email: "user@example.com",
      tokenHash: "hash",
      createdAt: "2026-05-02T00:00:00.000Z",
    },
  }),
  getUserByEmail: vi.fn().mockResolvedValue(null),
}));

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth/email", emailAuthRouter);
  return app;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
    ...overrides,
  };
}

function formRequest(path: string, fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("email auth redirects", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it("redirects invalid email with a short error code", async () => {
    const res = await app.fetch(
      formRequest("/auth/email/send", { email: "not-an-email" }),
      makeEnv(),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/email?error=invalid_email");
  });

  it("redirects missing email configuration with a short error code", async () => {
    const res = await app.fetch(
      formRequest("/auth/email/send", { email: "person@example.com" }),
      makeEnv(),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/email?error=auth_config_missing");
  });

  it("does not include the submitted email in the success redirect", async () => {
    const res = await app.fetch(
      formRequest("/auth/email/send", { email: "person@example.com" }),
      makeEnv({
        EMAIL_FROM_ADDRESS: "noreply@example.com",
        EMAIL: {
          send: vi.fn().mockResolvedValue({ messageId: "msg_abc123" }),
        },
      }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe("/auth/email?success=email_sent");
    expect(location).not.toContain("person%40example.com");
    expect(location).not.toContain("person@example.com");
  });

  it("renders fixed messages from known status codes", async () => {
    const res = await app.fetch(
      new Request("http://localhost/auth/email?success=email_sent"),
      makeEnv(),
    );
    const html = await res.text();

    expect(html).toContain("Check your email. We sent a magic link that expires in 15 minutes.");
  });
});
