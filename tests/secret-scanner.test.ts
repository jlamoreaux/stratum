import { describe, expect, it, vi } from "vitest";
import { SecretScanEvaluator, scanContentForSecrets } from "../src/evaluation/secret-scanner";
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

// Detector-positive fixtures are assembled at runtime so the raw test file
// never contains a complete credential-shaped literal — otherwise this very
// diff would be blocked by the scanner it is testing (and by GitHub push
// protection / SAST). Keep every fixture split across at least two parts.
const AWS_KEY = `${"AKIA"}IOSFODNN7EXAMPLE`;
const AWS_TEMP_KEY = `${"ASIA"}IOSFODNN7EXAMPLE`;
const AWS_SECRET = `${"wJalrXUtnFEMIK7MDENG"}bPxRfiCYEXAMPLEKEYaa`;
const SLACK_TOKEN = `${"xoxb"}-123456789012-abcdefghijkl`;
const PEM_RSA = `-----BEGIN RSA ${"PRIVATE KEY"}-----`;
const PEM_OPENSSH = `-----BEGIN OPENSSH ${"PRIVATE KEY"}-----`;
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join(
  ".",
);
const PG_URL = `${"postgres"}://admin:${"hunter2"}@db.internal:5432/prod`;
const MONGO_URL = `${"mongodb+srv"}://svc:${"p4ssw0rd"}@cluster.example.net`;
const ENTROPY_MIXED = `${"hR8s2Kd91mZqLpXw"}4Yv7NbT3cFgJ6aQe`;
const ENTROPY_HEX = `${"9f8e7d6c5b4a3928"}1706e5d4c3b2a190`;

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
    const diff = makeDiff([`const key = "${AWS_KEY}";`]);
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
    const diff = makeDiff(["const safe = true;"], [`const key = "${AWS_KEY}";`]);
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
    const diff = makeDiff(["const safe = true;", `const key = "${AWS_KEY}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toMatch(/line \d+/);
    }
  });

  it.each([
    ["AWS Access Key", `const key = "${AWS_TEMP_KEY}";`],
    ["AWS Secret Key", `aws_secret_access_key = "${AWS_SECRET}"`],
    ["GitHub OAuth Token", `const t = "gho_${"a".repeat(36)}";`],
    ["GitHub User-to-Server Token", `const t = "ghu_${"a".repeat(36)}";`],
    ["GitHub Fine-Grained PAT", `const t = "github_pat_${"a".repeat(82)}";`],
    ["GitLab Personal Access Token", `const t = "glpat-${"a".repeat(20)}";`],
    ["Slack Token", `const t = "${SLACK_TOKEN}";`],
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
    ["Private Key Block", PEM_RSA],
    ["Private Key Block", PEM_OPENSSH],
    ["JSON Web Token", `const jwt = "${JWT}";`],
    ["Connection String Credential", `DB = "${PG_URL}"`],
    ["Connection String Credential", `DB = "${MONGO_URL}"`],
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
    const diff = makeDiff([`const a = "${AWS_KEY}"; const b = "ghp_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toHaveLength(1);
    }
  });

  it("ignores policy configuration — always runs", async () => {
    const diff = makeDiff([`const key = "${AWS_KEY}";`]);
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
    const diff = makeDiff([`const apiToken = "${ENTROPY_MIXED}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toContain("High-Entropy Credential");
    }
  });

  it("flags a random hex value at the lower hex threshold", async () => {
    const diff = makeDiff([`const secretKey = "${ENTROPY_HEX}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toContain("High-Entropy Credential");
    }
  });

  it("flags a typed TypeScript credential assignment", async () => {
    const diff = makeDiff([`const apiToken: string = "${ENTROPY_MIXED}";`]);
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
    const diff = makeDiff([`const digest = "${ENTROPY_MIXED}";`]);
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

  it("does not flag a keyword buried inside an unrelated identifier (monkey)", async () => {
    // `key` occurs inside `monkey` with no snake/camel boundary — a high-entropy
    // value here must not create a blocking false positive.
    const diff = makeDiff([`const monkey = "${ENTROPY_MIXED}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("scans every assignment on a line — a low-entropy first match can't mask a later secret", async () => {
    const diff = makeDiff([
      `const token = "aaaaaaaaaaaaaaaaaaaaaaaa"; const apiKey = "${ENTROPY_MIXED}";`,
    ]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.join("\n")).toContain("High-Entropy Credential");
    }
  });
});

describe("added lines whose own text starts with ++", () => {
  const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

  it("scans an added line rendered as +++text (not a file header)", async () => {
    // A source line of `++const k = "…"` appears in a unified diff as
    // `+++const k = "…"`. Skipping every line starting with a bare `+++`
    // treated that as the `+++ b/path` header and never scanned it.
    const diff = makeDiff([`++const k = "${AWS_KEY}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.join("\n")).toContain("AWS Access Key");
    }
  });

  it("scans an added line rendered as +++ text, where a trailing space is not enough", async () => {
    // The one-character tightening ("+++ " with the space) closes the case
    // above but not this one: a source line of `++ const k = "…"` renders as
    // `+++ const k = "…"`, which still looks exactly like a header to any
    // prefix test. Position is what tells them apart.
    const diff = makeDiff([`++ const k = "${AWS_KEY}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.join("\n")).toContain("AWS Access Key");
    }
  });

  it("still skips the real +++ b/path file header", async () => {
    // The header carries the path only; a path that happens to contain a
    // secret-shaped substring must not be reported as content. Git always
    // emits the `--- `/`+++ ` pair adjacently, which is what marks this one as
    // a header rather than content.
    const result = await evaluator.evaluate(
      `diff --git a/${AWS_KEY}.ts b/${AWS_KEY}.ts\n--- a/${AWS_KEY}.ts\n+++ b/${AWS_KEY}.ts\n@@ -0,0 +1 @@\n+const ok = 1;`,
      policy,
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("scans an unpaired +++ line, erring toward detection when it cannot be a header", async () => {
    // A `+++ ` line with no `--- ` before it is not where git puts a header,
    // so it is treated as content. That direction is deliberate for a blocking
    // security gate: a false positive is a blocked change with a stated
    // reason, a false negative is a leaked credential. A real diff always
    // carries the pair, so a genuine header is never caught by this.
    const result = await evaluator.evaluate(`+++ const k = "${AWS_KEY}";`, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(false);
  });

  it("does not carry header state across files in a multi-file diff", async () => {
    const clean = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const a = 1;";
    // Second file: the added line's own text starts with "++ ", so it renders
    // as "+++ …" inside the hunk body — content, not a header.
    const sneaky = `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+++ const k = "${AWS_KEY}";`;
    const result = await evaluator.evaluate(`${clean}\n${sneaky}`, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.join("\n")).toContain("AWS Access Key");
    }
  });

  it("does not mistake a removed line starting with -- for a file header", async () => {
    // A deleted SQL/Lua comment renders as "--- …" inside a hunk. It must not
    // set up header state that then swallows the next added line.
    const diff = `diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1 +1 @@\n--- legacy comment\n+++ const k = "${AWS_KEY}";`;
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.join("\n")).toContain("AWS Access Key");
    }
  });
});

describe("scanContentForSecrets", () => {
  const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

  it("finds a secret regardless of what the line starts with", () => {
    for (const prefix of ["", "+", "++", "+++", "+++ ", "---"]) {
      expect(
        scanContentForSecrets([{ file: "a.ts", content: `${prefix}const k = "${AWS_KEY}";` }]),
      ).toEqual(["AWS Access Key: a.ts line 1"]);
    }
  });

  it("reports the file and a content-relative line number", () => {
    const issues = scanContentForSecrets([
      { file: "clean.ts", content: "const a = 1;" },
      { file: "dirty.ts", content: `line one\nline two\nconst k = "${AWS_KEY}";` },
    ]);
    expect(issues).toEqual(["AWS Access Key: dirty.ts line 3"]);
  });

  it("returns no issues for clean content", () => {
    expect(scanContentForSecrets([{ file: "a.ts", content: "export const x = 1;\n" }])).toEqual([]);
  });
});
