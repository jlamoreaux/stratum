import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * A `Response` whose body reports whether it was cancelled.
 *
 * Whether a retry released its connection is invisible to any assertion about
 * the call's final result, so these cases observe the stream itself: a real
 * `ReadableStream` whose `cancel` callback records the release. A response
 * built from a plain string would be indistinguishable from one left open.
 */
function observableResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status, headers }),
    wasCancelled: () => cancelled,
  };
}

/** A rate-limit 403 whose window resets `secondsFromNow` in the future. */
function rateLimited(secondsFromNow: number) {
  return observableResponse("rate limited", 403, {
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + secondsFromNow),
  });
}

beforeEach(() => {
  resetCircuitBreakersForTests();
  vi.unstubAllGlobals();
});

describe("GitHubClient retry paths settle the response they abandon", () => {
  it("cancels the body of a retried 5xx before backing off", async () => {
    const failed = observableResponse("down", 502);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failed.response)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.getRepo("acme", "widgets");

    expect(result).toEqual({ success: true, default_branch: "main" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failed.wasCancelled()).toBe(true);
    expect(failed.response.bodyUsed).toBe(true);
  }, 10000);

  it("cancels the body of a retried rate-limit 403 before waiting out the window", async () => {
    const limited = rateLimited(1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(limited.response)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.getRepo("acme", "widgets");

    expect(result).toEqual({ success: true, default_branch: "main" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limited.wasCancelled()).toBe(true);
  }, 10000);

  it("cancels the body of a rate-limit 403 it gives up on rather than retries", async () => {
    // A reset further out than MAX_DELAY_MS (32s) is not worth waiting for, so
    // the client returns instead of retrying — abandoning the response on a
    // path with no sleep to blame for holding it.
    const limited = rateLimited(600);
    const fetchMock = vi.fn().mockResolvedValueOnce(limited.response);
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.getRepo("acme", "widgets");

    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(limited.wasCancelled()).toBe(true);
  });

  it("still settles each attempt when every retry in the budget fails", async () => {
    const attempts = [
      observableResponse("down", 502),
      observableResponse("down", 502),
      observableResponse("down", 502),
    ];
    const fetchMock = vi.fn();
    for (const attempt of attempts) fetchMock.mockResolvedValueOnce(attempt.response);
    // The final attempt is not abandoned: the non-ok path reads it with
    // `response.text()` to build the error message, which settles it already.
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.getRepo("acme", "widgets");

    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const attempt of attempts) {
      expect(attempt.wasCancelled()).toBe(true);
    }
  }, 30000);

  it("does not fail the retry when cancelling the abandoned body throws", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("down"));
      },
      cancel() {
        throw new Error("stream already errored");
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(stream, { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.getRepo("acme", "widgets");

    expect(result).toEqual({ success: true, default_branch: "main" });
    expect(logger.debug).toHaveBeenCalledWith(
      "Could not cancel an abandoned GitHub response body",
      expect.objectContaining({ endpoint: "/repos/acme/widgets" }),
    );
  }, 10000);
});
