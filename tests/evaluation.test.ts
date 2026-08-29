import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompositeEvaluator } from "../src/evaluation/composite-evaluator";
import { DiffEvaluator } from "../src/evaluation/diff-evaluator";
import { loadPolicy } from "../src/evaluation/policy-loader";
import type { EvalPolicy, Evaluator } from "../src/evaluation/types";
import { WebhookEvaluator } from "../src/evaluation/webhook-evaluator";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

vi.mock("../src/storage/git-ops", () => ({
  readFileFromRepo: vi.fn(),
}));

// Wrap (not replace) the URL validator so individual tests can force edge-case
// return shapes; by default it calls through to the real implementation.
vi.mock("../src/utils/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/validation")>();
  return { ...actual, validateWebhookUrl: vi.fn(actual.validateWebhookUrl) };
});

import { readFileFromRepo } from "../src/storage/git-ops";
import { validateWebhookUrl } from "../src/utils/validation";
const mockReadFileFromRepo = vi.mocked(readFileFromRepo);
const mockValidateWebhookUrl = vi.mocked(validateWebhookUrl);

function makeDiff(
  opts: {
    files?: Array<{ path: string; addedLines?: number; removedLines?: number }>;
  } = {},
): string {
  const files = opts.files ?? [{ path: "src/index.ts", addedLines: 3, removedLines: 1 }];
  return files
    .map(({ path, addedLines = 1, removedLines = 0 }) => {
      const added = Array.from({ length: addedLines }, (_, i) => `+line${i + 1}`).join("\n");
      const removed = Array.from({ length: removedLines }, (_, i) => `-old${i + 1}`).join("\n");
      const lines = [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        removed,
        added,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n");
}

function makePolicy(overrides: Partial<EvalPolicy> = {}): EvalPolicy {
  return {
    evaluators: [{ type: "diff" }],
    requireAll: true,
    minScore: 0.7,
    ...overrides,
  };
}

describe("DiffEvaluator", () => {
  const evaluator = new DiffEvaluator();

  it("passes a clean small diff", async () => {
    const diff = makeDiff({ files: [{ path: "src/index.ts", addedLines: 5, removedLines: 2 }] });
    const policy = makePolicy({ evaluators: [{ type: "diff" }] });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.score).toBe(1.0);
    }
  });

  it("fails when lines exceed maxLines", async () => {
    const diff = makeDiff({
      files: [{ path: "src/big.ts", addedLines: 600, removedLines: 0 }],
    });
    const policy = makePolicy({ evaluators: [{ type: "diff", maxLines: 500 }], minScore: 1.0 });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBeLessThan(1.0);
      expect(result.data.issues).toBeDefined();
      expect(result.data.issues?.some((i) => i.includes("maxLines"))).toBe(true);
    }
  });

  it("fails when files exceed maxFiles", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      addedLines: 1,
    }));
    const diff = makeDiff({ files });
    const policy = makePolicy({ evaluators: [{ type: "diff", maxFiles: 20 }], minScore: 1.0 });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.some((i) => i.includes("maxFiles"))).toBe(true);
    }
  });

  it("fails when added file matches forbidden pattern", async () => {
    const diff = makeDiff({ files: [{ path: "yarn.lock", addedLines: 2 }] });
    const policy = makePolicy({
      evaluators: [{ type: "diff", forbiddenPatterns: ["*.lock"] }],
      minScore: 1.0,
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.some((i) => i.includes("forbidden"))).toBe(true);
    }
  });

  it("score decrements by 0.25 per violation — 2 violations yields score 0.5", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      addedLines: 600,
    }));
    const diff = makeDiff({ files });
    const policy = makePolicy({
      evaluators: [{ type: "diff", maxLines: 500, maxFiles: 20 }],
      minScore: 0.3,
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.5);
      expect(result.data.passed).toBe(true);
    }
  });

  it("fails requiredPatterns when no file matches", async () => {
    const diff = makeDiff({ files: [{ path: "src/index.ts", addedLines: 2 }] });
    const policy = makePolicy({
      evaluators: [{ type: "diff", requiredPatterns: ["tests/*"] }],
      minScore: 1.0,
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.some((i) => i.includes("required pattern"))).toBe(true);
    }
  });

  it("passes requiredPatterns when a file matches", async () => {
    const diff = makeDiff({
      files: [
        { path: "src/index.ts", addedLines: 2 },
        { path: "tests/index.test.ts", addedLines: 1 },
      ],
    });
    const policy = makePolicy({
      evaluators: [{ type: "diff", requiredPatterns: ["tests/*"] }],
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });
});

describe("WebhookEvaluator", () => {
  const evaluator = new WebhookEvaluator();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result from successful 200 response", async () => {
    const mockResponse = { score: 0.9, passed: true, reason: "Looks good" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.score).toBe(0.9);
      expect(result.data.reason).toBe("Looks good");
    }
  });

  it("returns failed result on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({}),
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("422");
    }
  });

  it("SEC-6: rejects a private-host URL without fetching (fail-closed)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "http://169.254.169.254/latest/meta-data" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toMatch(/not allowed/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SEC-6: passes redirect:manual to fetch and fails a redirect response closed", async () => {
    let capturedInit: RequestInit = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedInit = init;
        // A 3xx followed manually surfaces as an opaque redirect: ok === false.
        return Promise.resolve({ ok: false, status: 302, json: async () => ({}) });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(capturedInit.redirect).toBe("manual");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
    }
  });

  it("returns failed result when fetch throws (timeout)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted")));

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", timeoutMs: 1 }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("The operation was aborted");
    }
  });

  it("adds X-Stratum-Signature header when secret is configured", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1.0, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", secret: "mysecret" }],
    });
    await evaluator.evaluate("diff content", policy, mockLogger);

    expect(capturedHeaders["X-Stratum-Signature"]).toBeDefined();
    expect(capturedHeaders["X-Stratum-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("fails closed with a generic reason when URL validation reports no detail", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockValidateWebhookUrl.mockReturnValueOnce({ success: false, error: [] });

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("invalid URL");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when no webhook configuration is present", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const policy = makePolicy({ evaluators: [{ type: "diff" }] });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("no configuration");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  function stubFetchJson(payload: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      }),
    );
  }

  async function evaluateWithStub(payload: unknown) {
    stubFetchJson(payload);
    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    return result.data;
  }

  it("SEC: fails closed when `passed` is a truthy string instead of a boolean", async () => {
    const data = await evaluateWithStub({ score: 0.9, passed: "no", reason: "nope" });
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/failed closed/i);
  });

  it("fails closed when `score` is not a number", async () => {
    const data = await evaluateWithStub({ score: "0.9", passed: true, reason: "ok" });
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/failed closed/i);
  });

  it("fails closed when `score` is not finite", async () => {
    const data = await evaluateWithStub({
      score: Number.POSITIVE_INFINITY,
      passed: true,
      reason: "ok",
    });
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
  });

  it("fails closed when verdict fields are missing entirely", async () => {
    const data = await evaluateWithStub({});
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/failed closed/i);
  });

  it("fails closed when the response JSON is not an object", async () => {
    const data = await evaluateWithStub(null);
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/not an object/i);
  });

  it("fails closed when the response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toMatch(/not valid JSON/i);
    }
  });

  it("clamps an out-of-range score into [0, 1]", async () => {
    const high = await evaluateWithStub({ score: 999, passed: true, reason: "ok" });
    expect(high.score).toBe(1);
    expect(high.passed).toBe(true);

    const low = await evaluateWithStub({ score: -5, passed: false, reason: "bad" });
    expect(low.score).toBe(0);
    expect(low.passed).toBe(false);
  });

  it("defaults `reason` to a string when the response omits it", async () => {
    const data = await evaluateWithStub({ score: 1, passed: true });
    expect(data.passed).toBe(true);
    expect(data.score).toBe(1);
    expect(data.reason).toBe("Webhook returned no reason.");
  });

  it("wraps a non-Error fetch rejection in an ExternalServiceError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("socket hangup"));

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("socket hangup");
    }
  });

  it("SEC: strips webhook.secret from the outgoing request body", async () => {
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", secret: "super-secret" }],
    });
    await evaluator.evaluate("diff content", policy, mockLogger);

    expect(capturedBody).not.toContain("super-secret");
    expect(capturedBody).not.toContain("secret");
    const payload = JSON.parse(capturedBody) as { diff: string; policy: EvalPolicy };
    expect(payload.diff).toBe("diff content");
    expect(payload.policy.evaluators).toEqual([
      { type: "webhook", url: "https://example.com/eval" },
    ]);
  });

  /** Captures what the evaluator actually put on the wire. */
  function stubFetchCapture(): { body: () => string; signature: () => string } {
    let capturedBody = "";
    let capturedSignature = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        capturedSignature = (init.headers as Record<string, string>)["X-Stratum-Signature"] ?? "";
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );
    return { body: () => capturedBody, signature: () => capturedSignature };
  }

  const webhookPolicy = makePolicy({
    evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
  });

  it("carries the diff's base commit in the request body (#274)", async () => {
    const captured = stubFetchCapture();

    await evaluator.evaluate("diff content", webhookPolicy, mockLogger, {
      baseSha: "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
    });

    const payload = JSON.parse(captured.body()) as { diff: string; baseSha?: string };
    expect(payload.baseSha).toBe("9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3");
    expect(payload.diff).toBe("diff content");
  });

  it("omits baseSha entirely when no base was pinned (#274)", async () => {
    const captured = stubFetchCapture();

    await evaluator.evaluate("diff content", webhookPolicy, mockLogger);

    // Omitted, not null and not "": a receiver's `if (!body.baseSha) reject()`
    // must be able to tell "no base pinned" from "base is the empty string".
    const payload = JSON.parse(captured.body()) as Record<string, unknown>;
    expect("baseSha" in payload).toBe(false);
    expect(payload.diff).toBe("diff content");
  });

  it("signs the exact body, so baseSha is covered by the HMAC (#274)", async () => {
    const captured = stubFetchCapture();
    const secret = "shared-secret";
    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", secret }],
    });

    await evaluator.evaluate("diff content", policy, mockLogger, { baseSha: "abc123" });

    const body = captured.body();
    expect((JSON.parse(body) as { baseSha?: string }).baseSha).toBe("abc123");

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(captured.signature()).toBe(`sha256=${hex}`);
  });
});

describe("CompositeEvaluator", () => {
  function makePassingEvaluator(score = 1.0): Evaluator {
    return {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score,
          passed: true,
          reason: "passed",
        },
      }),
    };
  }

  function makeFailingEvaluator(score = 0.2): Evaluator {
    return {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score,
          passed: false,
          reason: "failed",
          issues: ["something went wrong"],
        },
      }),
    };
  }

  it("requireAll=true: fails if any evaluator fails", async () => {
    const composite = new CompositeEvaluator([makePassingEvaluator(), makeFailingEvaluator()]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
    }
  });

  it("requireAll=true: passes when all evaluators pass", async () => {
    const composite = new CompositeEvaluator([makePassingEvaluator(), makePassingEvaluator()]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("requireAll=false: passes if any evaluator passes", async () => {
    const composite = new CompositeEvaluator([makeFailingEvaluator(), makePassingEvaluator()]);
    const policy = makePolicy({ requireAll: false });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("requireAll=false: fails if all evaluators fail", async () => {
    const composite = new CompositeEvaluator([makeFailingEvaluator(), makeFailingEvaluator()]);
    const policy = makePolicy({ requireAll: false });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
    }
  });

  it("runs all evaluators in parallel (spy on evaluate calls)", async () => {
    const e1 = makePassingEvaluator();
    const e2 = makePassingEvaluator();
    const composite = new CompositeEvaluator([e1, e2]);
    const policy = makePolicy();
    await composite.evaluate("diff", policy, mockLogger);
    expect(e1.evaluate).toHaveBeenCalledOnce();
    expect(e2.evaluate).toHaveBeenCalledOnce();
  });

  it("aggregates scores as average when requireAll=true", async () => {
    const composite = new CompositeEvaluator([
      makePassingEvaluator(0.8),
      makePassingEvaluator(0.6),
    ]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBeCloseTo(0.7);
    }
  });

  it("aggregates scores as max when requireAll=false", async () => {
    const composite = new CompositeEvaluator([
      makeFailingEvaluator(0.2),
      makePassingEvaluator(0.9),
    ]);
    const policy = makePolicy({ requireAll: false });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.9);
    }
  });

  it("collects issues from all evaluators", async () => {
    const e1: Evaluator = {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score: 0.5,
          passed: false,
          reason: "fail1",
          issues: ["issue A"],
        },
      }),
    };
    const e2: Evaluator = {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score: 0.5,
          passed: false,
          reason: "fail2",
          issues: ["issue B"],
        },
      }),
    };
    const composite = new CompositeEvaluator([e1, e2]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toContain("issue A");
      expect(result.data.issues).toContain("issue B");
    }
  });

  it('reason is "All evaluators passed." when all pass', async () => {
    const composite = new CompositeEvaluator([makePassingEvaluator(), makePassingEvaluator()]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("All evaluators passed.");
    }
  });
});

describe("loadPolicy", () => {
  beforeEach(() => {
    mockReadFileFromRepo.mockReset();
  });

  it("returns DEFAULT_POLICY when readFileFromRepo returns null", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: true,
      data: null as unknown as string,
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
    expect(policy.requireAll).toBe(true);
    expect(policy.minScore).toBe(0.7);
  });

  it("parses valid stratum.config.json", async () => {
    const config = {
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
      requireAll: false,
      minScore: 0.5,
    };
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify(config),
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.requireAll).toBe(false);
    expect(policy.minScore).toBe(0.5);
    expect(policy.evaluators[0]?.type).toBe("webhook");
  });

  it("merges parsed config with defaults", async () => {
    const config = { evaluators: [{ type: "diff", maxLines: 100 }] };
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify(config),
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.requireAll).toBe(true);
    expect(policy.minScore).toBe(0.7);
    expect(policy.evaluators[0]).toMatchObject({ type: "diff", maxLines: 100 });
  });

  it("fails closed (configError) on a present-but-invalid JSON policy", async () => {
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: "not { valid json",
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    // Evaluators still default so the change flow works, but the merge gate is
    // marked failed-closed rather than silently downgraded.
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
    expect(policy.configError).toMatch(/invalid/i);
  });

  it("does NOT set configError when the policy file is simply absent", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: false,
      error: new AppError("missing", "NOT_FOUND", 404),
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.configError).toBeUndefined();
  });

  it("fails closed when a present policy is missing 'evaluators'", async () => {
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify({ minScore: 0.5 }),
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
    expect(policy.configError).toBeDefined();
  });

  it("returns DEFAULT_POLICY when readFileFromRepo throws", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: false,
      error: new AppError("Network error", "NETWORK_ERROR", 500),
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
  });

  it("parses .stratum/policy.yaml before stratum.config.json", async () => {
    mockReadFileFromRepo.mockImplementation(async (_remote, _token, _path, _logger) => {
      if (_path === ".stratum/policy.yaml") {
        return {
          success: true,
          data: [
            "evaluators:",
            "  - type: diff",
            "    maxLines: 42",
            "requireAll: false",
            "minScore: 0.4",
          ].join("\n"),
        };
      }
      return {
        success: true,
        data: JSON.stringify({
          evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
        }),
      };
    });

    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.requireAll).toBe(false);
    expect(policy.minScore).toBe(0.4);
    expect(policy.evaluators[0]).toMatchObject({ type: "diff", maxLines: 42 });
    expect(mockReadFileFromRepo).toHaveBeenCalledTimes(1);
  });
});
