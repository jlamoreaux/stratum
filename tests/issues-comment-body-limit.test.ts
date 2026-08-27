import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { issuesRouter } from "../src/routes/issues";
import type { Env, ProjectEntry } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

// Same stubbing approach as workspaces-commit-body-limit.test.ts: everything up
// to the body read is exercised for real (auth, project load, issue lookup) and
// only the write is stubbed, so `addIssueComment` not being called is proof the
// request died at the cap rather than somewhere downstream.
vi.mock("../src/storage/issue-comments", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/issue-comments")>();
  return {
    ...actual,
    addIssueComment: vi.fn(actual.addIssueComment),
  };
});

import { addIssueComment } from "../src/storage/issue-comments";

const OWNER_TOKEN = "stratum_user_ownertoken0000000000000000";
const OWNER_AUTH = { Authorization: `Bearer ${OWNER_TOKEN}` };
const PROJECT_ID = "proj_body_limit";
const ISSUES_API = "/api/projects/testns/my-project/issues";

/** Route-level cap in src/routes/issues.ts (MAX_COMMENT_BODY_BYTES). */
const COMMENT_CAP_BYTES = 1024 * 1024;

/**
 * Builds the app over a real SQLite D1 with a real user, project and issue, so
 * the request reaches the body-parse step through the genuine auth and lookup
 * path. Stubbing those out would let a 401 or 404 masquerade as the 413 this
 * file is meant to pin down.
 */
async function makeApp() {
  const { db, raw } = makeSqliteD1();
  const now = "2026-01-01T00:00:00.000Z";
  raw
    .prepare(
      "INSERT INTO users (id, email, username, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("user_owner", "owner@example.com", "owner", await hashToken(OWNER_TOKEN), now);

  const project = {
    id: PROJECT_ID,
    name: "my-project",
    slug: "my-project",
    namespace: "testns",
    ownerId: "user_owner",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/my-project",
    createdAt: now,
    visibility: "private",
  } as ProjectEntry;
  const kv = makeFakeKV();
  await kv.put("project:testns:my-project", JSON.stringify(project));

  const env = { DB: db, STATE: kv } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/projects", issuesRouter);

  const openIssue = async () => {
    const res = await app.fetch(
      new Request(`http://localhost${ISSUES_API}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_AUTH },
        body: JSON.stringify({ title: "Something is broken" }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as { issue: { number: number } };
    return parsed.issue.number;
  };

  return { app, env, openIssue };
}

/**
 * Streams `totalBytes` of filler in 64 KiB chunks, deliberately WITHOUT a
 * Content-Length header — the "chunked / unknown length" case that only the
 * streaming cap can catch, since the cheap declared-length pre-check has
 * nothing to look at.
 */
function streamingCommentRequest(issueNumber: number, totalBytes: number): Request {
  const chunkSize = 64 * 1024;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(120)); // 'x' filler, deliberately not valid JSON
      sent += n;
    },
  });
  return new Request(`http://localhost${ISSUES_API}/${issueNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER_AUTH },
    body,
    duplex: "half",
  } as RequestInit);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/projects/:ns/:slug/issues/:number/comments — pre-parse body-size cap (issue #264)", () => {
  it("rejects a body over the 1 MiB pre-parse cap with 413 before parsing — even with no Content-Length header", async () => {
    const { app, env, openIssue } = await makeApp();
    const number = await openIssue();
    vi.mocked(addIssueComment).mockClear();

    const req = streamingCommentRequest(number, COMMENT_CAP_BYTES + 64 * 1024);
    expect(req.headers.get("content-length")).toBeNull();

    const res = await app.fetch(req, env);

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    // The filler is not valid JSON, so an uncapped read would fall into the
    // route's `.catch(() => ({}))` and answer 400 "body is required" — a 400
    // here means the body was fully buffered and parsed after all.
    expect(vi.mocked(addIssueComment)).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects an oversized body on the declared-Content-Length fast path with 413", async () => {
    const { app, env, openIssue } = await makeApp();
    const number = await openIssue();
    vi.mocked(addIssueComment).mockClear();

    // `new Request(...)` does not populate Content-Length itself, so set it
    // explicitly — otherwise this would silently retest the streaming path.
    const payload = JSON.stringify({ body: "x".repeat(COMMENT_CAP_BYTES + 1024) });
    const req = new Request(`http://localhost${ISSUES_API}/${number}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(payload).byteLength),
        ...OWNER_AUTH,
      },
      body: payload,
    });
    expect(req.headers.get("content-length")).not.toBeNull();

    const res = await app.fetch(req, env);

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(vi.mocked(addIssueComment)).not.toHaveBeenCalled();
  }, 20_000);

  it("a normal comment body well under the cap still succeeds", async () => {
    const { app, env, openIssue } = await makeApp();
    const number = await openIssue();
    vi.mocked(addIssueComment).mockClear();

    const res = await app.fetch(
      new Request(`http://localhost${ISSUES_API}/${number}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_AUTH },
        body: JSON.stringify({ body: "looks fine to me" }),
      }),
      env,
    );

    expect(res.status).toBe(201);
    expect(vi.mocked(addIssueComment)).toHaveBeenCalledOnce();
  });
});
