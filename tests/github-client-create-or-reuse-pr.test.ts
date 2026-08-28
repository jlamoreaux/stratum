import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, resetCircuitBreakersForTests } from "../src/github/client";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

/**
 * Builds a real `Response` for a stubbed `fetch`.
 *
 * The client consumes the response object itself — `response.status`, its
 * headers, and `response.json()`/`response.text()` — so these tests have to
 * hand it the genuine article rather than a plain object shaped like one.
 * Cases that exercise the malformed-body path deliberately bypass this helper
 * and construct their own non-JSON `Response`.
 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetCircuitBreakersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubClient.createPR", () => {
  it("forwards draft through to the request body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ number: 1, title: "t", body: "b", state: "open", html_url: "u" }, 201),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createPR({
      owner: "acme",
      repo: "widgets",
      title: "t",
      body: "b",
      head: "feature",
      base: "main",
      draft: true,
    });

    expect(result.success).toBe(true);
    const payload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload.draft).toBe(true);
  });
});

describe("GitHubClient.createOrReusePR", () => {
  /**
   * A predicate that accepts any lookup hit.
   *
   * These cases are about the create/lookup/error plumbing, not about what a
   * caller trusts, so they accept whatever the lookup returns. The predicate
   * is a required argument precisely so that choice is visible here rather
   * than inherited from a default (the promotion route passes
   * isUsableGithubPr instead).
   */
  const acceptAny = () => true;

  const opts = {
    owner: "acme",
    repo: "widgets",
    title: "Stratum: chg_1",
    body: "body",
    head: "stratum/chg_1",
    base: "main",
    draft: true,
  };

  it("creates the PR and reports reused: false on a clean 201", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { number: 7, html_url: "https://github.com/acme/widgets/pull/7", state: "open" },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(result).toEqual({
      success: true,
      reused: false,
      status: 201,
      pr: { number: 7, html_url: "https://github.com/acme/widgets/pull/7", state: "open" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload.draft).toBe(true);
  });

  it("reuses the open PR GitHub already has for the head on a duplicate-head 422", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for acme:stratum/chg_1." }],
          },
          422,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          [{ number: 9, html_url: "https://github.com/acme/widgets/pull/9", state: "open" }],
          200,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(result).toEqual({
      success: true,
      reused: true,
      status: 200,
      pr: { number: 9, html_url: "https://github.com/acme/widgets/pull/9", state: "open" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/acme/widgets/pulls?head=acme:stratum/chg_1&state=open",
      expect.anything(),
    );
  });

  it("falls back to the original create error when the lookup hit is rejected by the caller's predicate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for acme:stratum/chg_1." }],
          },
          422,
        ),
      )
      // The lookup finds something, but the caller won't accept it (e.g. it's closed).
      .mockResolvedValueOnce(
        jsonResponse(
          [{ number: 9, html_url: "https://github.com/acme/widgets/pull/9", state: "closed" }],
          200,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, () => false);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(422);
      expect(result.networkError).toBe(false);
      expect(result.githubMessage).toBe("Validation Failed");
      expect(result.errors[0]?.message).toContain("pull request already exists");
    }
  });

  it("reuses a later lookup entry when the caller's predicate rejects the first", async () => {
    // `GET /pulls?head=` is head-only, so it can return an open PR that
    // belongs to a repository this promotion is not pushing to — a project
    // migrated between GitHub repos is the real case. The predicate is what
    // tells them apart, so the accepted one may not be first.
    const wrongRepoPr = { number: 4, html_url: "https://github.com/acme/legacy/pull/4" };
    const rightRepoPr = { number: 9, html_url: "https://github.com/acme/widgets/pull/9" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for acme:stratum/chg_1." }],
          },
          422,
        ),
      )
      .mockResolvedValueOnce(jsonResponse([wrongRepoPr, rightRepoPr], 200));
    vi.stubGlobal("fetch", fetchMock);

    const belongsToWidgets = vi.fn(
      (pr: unknown) =>
        (pr as { html_url?: string }).html_url === "https://github.com/acme/widgets/pull/9",
    );

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, belongsToWidgets);

    expect(result).toEqual({ success: true, reused: true, status: 200, pr: rightRepoPr });
    expect(belongsToWidgets).toHaveBeenCalledWith(wrongRepoPr, 0, [wrongRepoPr, rightRepoPr]);
    expect(belongsToWidgets).toHaveBeenCalledWith(rightRepoPr, 1, [wrongRepoPr, rightRepoPr]);
  });

  it("falls back to the original create error when the predicate rejects every lookup entry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for acme:stratum/chg_1." }],
          },
          422,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          [
            { number: 4, html_url: "https://github.com/acme/legacy/pull/4" },
            { number: 5, html_url: "https://github.com/acme/other/pull/5" },
          ],
          200,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, () => false);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(422);
      expect(result.errors[0]?.message).toContain("pull request already exists");
    }
  });

  it("does not look up a duplicate head when the 422 is not a duplicate-head failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { message: "Validation Failed", errors: [{ field: "base", code: "invalid" }] },
          422,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(422);
      expect(result.errors).toEqual([{ field: "base", code: "invalid" }]);
    }
  });

  it("reports a network error distinctly, without retrying, on a request-level failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(fetchMock).toHaveBeenCalledTimes(1); // maxRetries: 0 — no automatic retry
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.networkError).toBe(true);
    }
  });

  // createOrReusePR passes maxRetries: 0 deliberately — a create call isn't
  // safe to retry blindly (see the method's doc comment) — unlike the
  // client's other methods, which retry 5xx by default.
  it("does not retry a 5xx from PR creation (unlike the client's default retry behavior)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.status).toBe(502);
  });

  it("treats a 2xx response with an unparseable body as a failure carrying the 2xx status, not a network error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.networkError).toBe(false);
      expect(result.status).toBe(201);
    }
  });
});

describe("GitHubClient default retry behavior (unaffected by createOrReusePR's opt-out)", () => {
  it("retries a 5xx up to the default budget for a call that doesn't override maxRetries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.getRepo("acme", "widgets");

    expect(result).toEqual({ success: true, default_branch: "main" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10000);
});

describe("resetCircuitBreakersForTests", () => {
  it("clears a tripped breaker so the next call reaches fetch again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    // Trip the breaker: 5 consecutive failures against the same owner/repo key.
    for (let i = 0; i < 5; i++) {
      await client.getRepo("acme", "widgets");
    }
    fetchMock.mockClear();

    const openResult = await client.getRepo("acme", "widgets");
    expect(openResult).toEqual({
      success: false,
      error: "Service temporarily unavailable (circuit open)",
    });
    expect(fetchMock).not.toHaveBeenCalled(); // short-circuited before reaching fetch

    resetCircuitBreakersForTests();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
    );
    const afterReset = await client.getRepo("acme", "widgets");
    expect(afterReset).toEqual({ success: true, default_branch: "main" });
    expect(fetchMock).toHaveBeenCalled();
  });
});
