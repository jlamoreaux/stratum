import { describe, expect, it, vi } from "vitest";
import { SecretScanEvaluator } from "../src/evaluation/secret-scanner";
import type { EvalPolicy } from "../src/evaluation/types";
import type { Logger } from "../src/utils/logger";

const evaluator = new SecretScanEvaluator();
const policy: EvalPolicy = { evaluators: [], requireAll: true, minScore: 0.7 };

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

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
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.score).toBe(1);
      expect(result.data.reason).toBe("No secrets detected");
      expect(result.data.issues).toBeUndefined();
    }
  });

  it("detects AWS access key in added line", async () => {
    const diff = makeDiff(['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("AWS Access Key");
      expect(result.data.issues?.length).toBeGreaterThan(0);
      expect(result.data.issues?.[0]).toContain("AWS Access Key");
    }
  });

  it("detects GitHub classic token in added line", async () => {
    const diff = makeDiff([`const token = "ghp_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("GitHub Token (Classic)");
    }
  });

  it("detects GitHub app token in added line", async () => {
    const diff = makeDiff([`const token = "ghs_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("GitHub App Token");
    }
  });

  it("detects GitHub refresh token in added line", async () => {
    const diff = makeDiff([`const token = "ghr_${"a".repeat(76)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("GitHub Refresh Token");
    }
  });

  it("detects Stratum user token in added line", async () => {
    const diff = makeDiff([`const token = "stratum_user_${"a".repeat(32)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("Stratum User Token");
    }
  });

  it("detects Stratum agent token in added line", async () => {
    const diff = makeDiff([`const token = "stratum_agent_${"a".repeat(32)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("Stratum Agent Token");
    }
  });

  it("does not scan removed lines (starting with -)", async () => {
    const diff = makeDiff(["const safe = true;"], ['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("does not false-positive on +++ header lines", async () => {
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "+const x = 1;",
    ].join("\n");
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("reports issue with correct line number", async () => {
    const diff = makeDiff(["const safe = true;", 'const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toMatch(/line \d+/);
    }
  });

  it.each([
    ["AWS Access Key", 'const key = "ASIAIOSFODNN7EXAMPLE";'],
    ["AWS Secret Key", 'aws_secret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYaa"'],
    ["GitHub OAuth Token", `const t = "gho_${"a".repeat(36)}";`],
    ["GitHub User-to-Server Token", `const t = "ghu_${"a".repeat(36)}";`],
    ["GitHub Fine-Grained PAT", `const t = "github_pat_${"a".repeat(82)}";`],
    ["GitLab Personal Access Token", `const t = "glpat-${"a".repeat(20)}";`],
    ["Slack Token", 'const t = "xoxb-123456789012-abcdefghijkl";'],
    // Assembled from parts so GitHub push protection doesn't flag the fixture
    // itself as a leaked webhook.
    [
      "Slack Webhook URL",
      `url = https://hooks.slack${".com"}/services/T0000000000/B0000000000/${"X".repeat(24)}`,
    ],
    ["Stripe Live Key", `const t = "sk_live_${"a1".repeat(12)}";`],
    ["OpenAI API Key (Legacy)", `const t = "sk-${"a".repeat(20)}T3BlbkFJ${"a".repeat(20)}";`],
    ["OpenAI API Key (Project)", `const t = "sk-proj-${"a1".repeat(24)}";`],
    ["Anthropic API Key", `const t = "sk-ant-api03-${"a1".repeat(20)}";`],
    ["Google API Key", `const t = "AIza${"a1".repeat(17)}b";`],
    ["npm Access Token", `const t = "npm_${"a1".repeat(18)}";`],
    ["PyPI Upload Token", `const t = "pypi-AgEIcHlwaS5vcmc${"a1".repeat(12)}";`],
    ["Hugging Face Token", `const t = "hf_${"a1".repeat(17)}";`],
    ["SendGrid API Key", `const t = "SG.${"a".repeat(22)}.${"a".repeat(43)}";`],
    ["Twilio API Key", `const t = "SK${"0123456789abcdef".repeat(2)}";`],
    ["Private Key Block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["Private Key Block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    [
      "JSON Web Token",
      'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";',
    ],
    ["Connection String Credential", 'DB = "postgres://admin:hunter2@db.internal:5432/prod"'],
    ["Connection String Credential", 'DB = "mongodb+srv://svc:p4ssw0rd@cluster.example.net"'],
    ["Azure Storage Account Key", `conn = "AccountKey=${"A1b2".repeat(11)}=="`],
  ])("detects %s", async (name, line) => {
    const diff = makeDiff([line]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.issues?.[0]).toContain(name);
    }
  });

  it("does not flag a test-mode Stripe key", async () => {
    const diff = makeDiff([`const t = "sk_test_${"a1".repeat(12)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("reports one issue per line even when several patterns match", async () => {
    const diff = makeDiff([`const a = "AKIAIOSFODNN7EXAMPLE"; const b = "ghp_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toHaveLength(1);
    }
  });

  it("ignores policy configuration — always runs", async () => {
    const diff = makeDiff(['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const resultWithNull = await evaluator.evaluate(diff, policy, mockLogger);
    const resultWithPolicy = await evaluator.evaluate(
      diff,
      { evaluators: [], requireAll: false },
      mockLogger,
    );
    expect(resultWithNull.success).toBe(true);
    expect(resultWithPolicy.success).toBe(true);
    if (resultWithNull.success && resultWithPolicy.success) {
      expect(resultWithNull.data.passed).toBe(false);
      expect(resultWithPolicy.data.passed).toBe(false);
    }
  });
});

describe("SecretScanEvaluator — entropy detection", () => {
  it("flags a high-entropy value assigned to a credential-ish name", async () => {
    const diff = makeDiff(['const apiToken = "hR8s2Kd91mZqLpXw4Yv7NbT3cFgJ6aQe";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toContain("High-Entropy Credential");
    }
  });

  it("flags a random hex value at the lower hex threshold", async () => {
    const diff = makeDiff(['const secretKey = "9f8e7d6c5b4a39281706e5d4c3b2a190";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toContain("High-Entropy Credential");
    }
  });

  it("does not flag a low-entropy value with a credential-ish name", async () => {
    const diff = makeDiff(['const apiToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("does not flag an English-word value with a credential-ish name", async () => {
    const diff = makeDiff(['const tokenName = "authenticationTokenBuilder";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("does not flag a high-entropy value without credential context", async () => {
    const diff = makeDiff(['const digest = "hR8s2Kd91mZqLpXw4Yv7NbT3cFgJ6aQe";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("does not flag short values even with credential context", async () => {
    const diff = makeDiff(['const apiKey = "hR8s2Kd91mZqLpXw";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });
});
