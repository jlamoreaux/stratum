import { describe, expect, it } from "vitest";
import { SecretScanEvaluator } from "../src/evaluation/secret-scanner";
import type { EvalPolicy } from "../src/evaluation/types";

const evaluator = new SecretScanEvaluator();
const policy: EvalPolicy = { evaluators: [], requireAll: true, minScore: 0.7 };

function makeDiff(addedLines: string[], removedLines: string[] = []): string {
  const header = [
    "diff --git a/src/index.ts b/src/index.ts",
    "--- a/src/index.ts",
    "+++ b/src/index.ts",
  ];
  const removed = removedLines.map((l) => `-${l}`);
  const added = addedLines.map((l) => `+${l}`);
  return [...header, ...removed, ...added].join("\n");
}

describe("SecretScanEvaluator", () => {
  it("passes a clean diff with no secrets", async () => {
    const diff = makeDiff(["const x = 1;", "export default x;"]);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.reason).toBe("No secrets detected");
    expect(result.issues).toBeUndefined();
  });

  it("detects AWS access key in added line", async () => {
    const diff = makeDiff(['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toContain("AWS Access Key");
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.issues?.[0]).toContain("AWS Access Key");
  });

  it("detects GitHub classic token in added line", async () => {
    const diff = makeDiff([`const token = "ghp_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("GitHub Token (Classic)");
  });

  it("detects GitHub app token in added line", async () => {
    const diff = makeDiff([`const token = "ghs_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("GitHub App Token");
  });

  it("detects GitHub refresh token in added line", async () => {
    const diff = makeDiff([`const token = "ghr_${"a".repeat(76)}";`]);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("GitHub Refresh Token");
  });

  it("detects Stratum user token in added line", async () => {
    const diff = makeDiff([`const token = "stratum_user_${"a".repeat(32)}";`]);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Stratum User Token");
  });

  it("detects Stratum agent token in added line", async () => {
    const diff = makeDiff([`const token = "stratum_agent_${"a".repeat(32)}";`]);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Stratum Agent Token");
  });

  it("does not scan removed lines (starting with -)", async () => {
    const diff = makeDiff(["const safe = true;"], ['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(true);
  });

  it("does not false-positive on +++ header lines", async () => {
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "+const x = 1;",
    ].join("\n");
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(true);
  });

  it("reports issue with correct line number", async () => {
    const diff = makeDiff(["const safe = true;", 'const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy);
    expect(result.passed).toBe(false);
    expect(result.issues?.[0]).toMatch(/line \d+/);
  });

  it("ignores policy configuration — always runs", async () => {
    const diff = makeDiff(['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const resultWithNull = await evaluator.evaluate(diff, policy);
    const resultWithPolicy = await evaluator.evaluate(diff, { evaluators: [], requireAll: false });
    expect(resultWithNull.passed).toBe(false);
    expect(resultWithPolicy.passed).toBe(false);
  });
});
