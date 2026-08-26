/**
 * `resolveDefaultBranch` runs inline on the import request, so an unresponsive
 * provider API must not hold that request open. These pin that the lookup is
 * bounded and that a timeout degrades to the documented "main" fallback rather
 * than failing the import.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultBranch } from "../src/storage/git-providers";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("resolveDefaultBranch bounds the provider lookup", () => {
  it("passes an abort signal to the provider metadata request", async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(
        JSON.stringify({ name: "r", full_name: "o/r", default_branch: "trunk" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const branch = await resolveDefaultBranch("https://github.com/o/r", {}, logger);

    expect(branch).toBe("trunk");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to main when the lookup aborts rather than propagating", async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Reject the way an aborted fetch does, so the caller's catch is exercised.
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      init?.signal?.throwIfAborted?.();
      throw err;
    }) as unknown as typeof fetch;

    await expect(resolveDefaultBranch("https://github.com/o/r", {}, logger)).resolves.toBe("main");
  });
});
