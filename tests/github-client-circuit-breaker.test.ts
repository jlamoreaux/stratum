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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const duplicateHead = () =>
  jsonResponse(
    {
      message: "Validation Failed",
      errors: [{ message: "A pull request already exists for acme:stratum/chg_1." }],
    },
    422,
  );

const existingPr = () =>
  jsonResponse([{ number: 9, html_url: "https://github.com/acme/widgets/pull/9" }], 200);

const opts = {
  owner: "acme",
  repo: "widgets",
  title: "Stratum: chg_1",
  body: "body",
  head: "stratum/chg_1",
  base: "main",
};

const acceptAny = () => true;

/** The breaker opens on this many consecutive counted failures. */
const CIRCUIT_BREAKER_THRESHOLD = 5;

beforeEach(() => {
  resetCircuitBreakersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("circuit-breaker failure policy", () => {
  it("reuses on duplicate-head even when the breaker is one failure from opening", async () => {
    // The reachable shape of the reported bug. A run of duplicate-head 422s
    // alone does NOT open the breaker, because each round's successful reuse
    // lookup zeroes the consecutive-failure tally between rounds. What does
    // reach it is a duplicate-head 422 arriving on top of an existing failure
    // run against the same repository — the breaker is per-repository, so any
    // caller's failures count. Before this policy the 422 was that run's fifth
    // failure, the reuse lookup it recovers through was short-circuited with a
    // 503, and a benign "PR already exists" became a failed promotion.
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubClient("tok", logger);

    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      await client.getRepo("acme", "widgets");
    }

    fetchMock.mockResolvedValueOnce(duplicateHead()).mockResolvedValueOnce(existingPr());
    const result = await client.createOrReusePR(opts, acceptAny);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.reused).toBe(true);
      expect(result.pr).toEqual({ number: 9, html_url: "https://github.com/acme/widgets/pull/9" });
    }
  });

  it("does not let a run of duplicate-head promotions open the breaker", async () => {
    const fetchMock = vi.fn();
    const rounds = CIRCUIT_BREAKER_THRESHOLD + 2;
    for (let i = 0; i < rounds; i++) {
      fetchMock.mockResolvedValueOnce(duplicateHead()).mockResolvedValueOnce(existingPr());
    }
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    for (let i = 0; i < rounds; i++) {
      const result = await client.createOrReusePR(opts, acceptAny);
      expect(result.success, `round ${i + 1} should still reuse`).toBe(true);
    }
    // Two fetches per round throughout: nothing was ever short-circuited.
    expect(fetchMock).toHaveBeenCalledTimes(rounds * 2);
  });

  it("still opens the breaker on repeated 404s, the case it was written for", async () => {
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      await client.getRepo("acme", "widgets");
    }
    fetchMock.mockClear();

    const afterThreshold = await client.getRepo("acme", "widgets");
    expect(afterThreshold).toEqual({
      success: false,
      error: "Service temporarily unavailable (circuit open)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a request-scoped 422 as neutral, neither counting it nor clearing the tally", async () => {
    // A 422 must not reset an in-progress run of genuine failures: the counter
    // measures CONSECUTIVE repository failures, and a 422 says nothing about
    // the repository either way.
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubClient("tok", logger);

    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      await client.getRepo("acme", "widgets");
    }

    // A 422 that is NOT duplicate-head, so it takes the generic path and makes
    // exactly one request.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "Validation Failed", errors: [{ message: "base is invalid" }] }, 422),
    );
    const validationFailure = await client.createOrReusePR(opts, acceptAny);
    expect(validationFailure.success).toBe(false);

    // One more counted failure reaches the threshold. Had the 422 reset the
    // tally, this would be failure #1 of 5 and the next call would go through.
    await client.getRepo("acme", "widgets");
    fetchMock.mockClear();

    const afterThreshold = await client.getRepo("acme", "widgets");
    expect(afterThreshold).toEqual({
      success: false,
      error: "Service temporarily unavailable (circuit open)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not open the breaker on 422s alone, however many arrive", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Validation Failed", errors: [{ message: "base is invalid" }] }, 422),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD + 3; i++) {
      const result = await client.createOrReusePR(opts, acceptAny);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Still GitHub's own answer, never the breaker's 503.
        expect(result.status).toBe(422);
      }
    }
  });
});
