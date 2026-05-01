import type { EvalPolicy, EvalResult, Evaluator } from "./types";

export class CompositeEvaluator {
  constructor(private evaluators: Evaluator[]) {}

  async evaluate(diff: string, policy: EvalPolicy): Promise<EvalResult[]> {
    return Promise.all(this.evaluators.map((e) => e.evaluate(diff, policy)));
  }

  async evaluateAndAggregate(diff: string, policy: EvalPolicy): Promise<EvalResult> {
    const results = await this.evaluate(diff, policy);
    return this.aggregate(results, policy);
  }

  aggregate(results: EvalResult[], policy: EvalPolicy): EvalResult {
    if (results.length === 0) {
      return { score: 0, passed: false, reason: "No evaluators ran." };
    }

    const requireAll = policy.requireAll ?? true;

    const passed = requireAll ? results.every((r) => r.passed) : results.some((r) => r.passed);

    const score = requireAll
      ? results.reduce((sum, r) => sum + r.score, 0) / (results.length || 1)
      : Math.max(...results.map((r) => r.score));

    const failingReasons = results.filter((r) => !r.passed).map((r) => r.reason);
    const reason =
      failingReasons.length === 0 ? "All evaluators passed." : failingReasons.join(" ");

    const issues = results.flatMap((r) => r.issues ?? []);

    return {
      score,
      passed,
      reason,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
}
