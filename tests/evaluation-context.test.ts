import { describe, expect, it, vi } from "vitest";
import type { EvalPolicy, EvaluationContext, Evaluator } from "../src/evaluation/types";
import { runEvaluation } from "../src/services/change-flow";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const policy: EvalPolicy = {
  evaluators: [{ type: "diff" }],
  requireAll: true,
  minScore: 0.7,
};

function makeEvaluator() {
  const evaluate = vi.fn().mockResolvedValue(ok({ score: 1, passed: true, reason: "ok" }));
  return { evaluate } satisfies Evaluator;
}

describe("runEvaluation evaluation context (#274)", () => {
  it("forwards the context to every evaluator in the set", async () => {
    const secretScan = makeEvaluator();
    const webhook = makeEvaluator();
    const context: EvaluationContext = { baseSha: "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3" };

    await runEvaluation(
      [
        { type: "secret_scan", evaluator: secretScan },
        { type: "webhook", evaluator: webhook },
      ],
      "the diff",
      policy,
      mockLogger,
      context,
    );

    // Every evaluator, not just the one that happens to use it today — an
    // evaluator that silently received no context would fail open, reporting a
    // verdict against an unpinned base.
    expect(secretScan.evaluate).toHaveBeenCalledWith("the diff", policy, mockLogger, context);
    expect(webhook.evaluate).toHaveBeenCalledWith("the diff", policy, mockLogger, context);
  });

  it("passes undefined when the caller supplies no context", async () => {
    const evaluator = makeEvaluator();

    await runEvaluation([{ type: "diff", evaluator }], "the diff", policy, mockLogger);

    expect(evaluator.evaluate).toHaveBeenCalledWith("the diff", policy, mockLogger, undefined);
  });
});
