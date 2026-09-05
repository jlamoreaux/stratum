/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// The published policy reference, imported raw (not via node:fs) so this suite
// type-checks under the Workers tsconfig — the same approach changelog.test.ts
// takes with CHANGELOG.md.
import POLICY_REFERENCE from "../docs/api/policy.md?raw";
import * as defaults from "../src/evaluation/defaults";

/**
 * The policy reference prints every default `.stratum/policy.yaml` leaves to
 * Stratum. Those numbers are the product's contract with a project owner, and
 * until now they were transcribed from a reading of the code: nothing failed
 * when a default moved and the table did not follow, so a reader could
 * configure against a number that had not been true for months.
 *
 * This suite makes the table a checked artifact. It fails in both directions —
 * a default that changes without the doc, and a doc row naming a setting the
 * code does not have — so neither copy can drift silently.
 */

const TABLE = /<!-- BEGIN:policy-defaults -->([\s\S]*?)<!-- END:policy-defaults -->/;

/** Strip the backticks the table wraps every value in. */
const unquote = (cell: string) => cell.trim().replace(/^`(.*)`$/, "$1");

function documentedDefaults(): Map<string, { value: string; bounds: string }> {
  const section = TABLE.exec(POLICY_REFERENCE)?.[1];
  if (!section) throw new Error("policy.md: the policy-defaults table markers are missing");

  const rows = new Map<string, { value: string; bounds: string }>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1);
    if (cells.length !== 3) continue;
    const setting = unquote(cells[0] ?? "");
    // The header row and its `---` separator survive the cell-count filter.
    if (!setting || setting === "Setting" || /^-+$/.test(setting)) continue;
    rows.set(setting, { value: unquote(cells[1] ?? ""), bounds: unquote(cells[2] ?? "") });
  }
  return rows;
}

/** What each documented row must equal, rendered the way the table renders it. */
const EXPECTED: Record<string, { value: string; bounds: string }> = {
  requireAll: { value: String(defaults.DEFAULT_REQUIRE_ALL), bounds: "—" },
  minScore: { value: String(defaults.DEFAULT_MIN_SCORE), bounds: "[0, 1]" },
  "diff.maxLines": { value: String(defaults.DEFAULT_MAX_LINES), bounds: "—" },
  "diff.maxFiles": { value: String(defaults.DEFAULT_MAX_FILES), bounds: "—" },
  "diff.forbiddenPatterns": {
    value: JSON.stringify(defaults.DEFAULT_FORBIDDEN_PATTERNS).replace(/","/g, '", "'),
    bounds: "—",
  },
  "`diff` score cost per violation": {
    value: String(defaults.DIFF_VIOLATION_PENALTY),
    bounds: "—",
  },
  "llm.model": { value: defaults.DEFAULT_LLM_MODEL, bounds: "—" },
  "llm.threshold": { value: String(defaults.DEFAULT_LLM_THRESHOLD), bounds: "[0, 1]" },
  "llm.maxDiffChars": {
    value: String(defaults.DEFAULT_MAX_DIFF_CHARS),
    bounds: `[${defaults.MAX_DIFF_CHARS_FLOOR}, ${defaults.MAX_DIFF_CHARS_CEILING}]`,
  },
  "`llm` policy context ceiling": {
    value: String(defaults.MAX_POLICY_CONTEXT_CHARS),
    bounds: "—",
  },
  "sandbox.command": {
    value: defaults.DEFAULT_SANDBOX_COMMAND,
    bounds: `max ${defaults.MAX_SANDBOX_COMMAND_LENGTH} chars`,
  },
  "sandbox.timeoutMs": {
    value: String(defaults.DEFAULT_SANDBOX_TIMEOUT_MS),
    bounds: `[${defaults.MIN_PHASE_TIMEOUT_MS}, ${defaults.MAX_PHASE_TIMEOUT_MS}]`,
  },
  "sandbox.installTimeoutMs": {
    value: String(defaults.DEFAULT_SANDBOX_INSTALL_TIMEOUT_MS),
    bounds: `[${defaults.MIN_PHASE_TIMEOUT_MS}, ${defaults.MAX_PHASE_TIMEOUT_MS}]`,
  },
  "sandbox.totalBudgetMs": {
    value: String(defaults.DEFAULT_SANDBOX_TOTAL_BUDGET_MS),
    bounds: `[${defaults.MIN_TOTAL_BUDGET_MS}, ${defaults.MAX_TOTAL_BUDGET_MS}]`,
  },
  "webhook.timeoutMs": {
    value: String(defaults.DEFAULT_WEBHOOK_TIMEOUT_MS),
    bounds: `[${defaults.MIN_PHASE_TIMEOUT_MS}, ${defaults.MAX_PHASE_TIMEOUT_MS}]`,
  },
  "merge.requiredApprovals": {
    value: String(defaults.DEFAULT_REQUIRED_APPROVALS),
    bounds: "—",
  },
  "merge.postMergeTimeoutMs": {
    value: String(defaults.DEFAULT_POST_MERGE_TIMEOUT_MS),
    bounds: "—",
  },
};

describe("policy reference — defaults table", () => {
  it("documents every setting this suite knows about, and nothing else", () => {
    // Catches a row deleted from the doc as well as one added to it without a
    // matching expectation here.
    expect([...documentedDefaults().keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("documents %s correctly", (setting, expected) => {
    const documented = documentedDefaults().get(setting);
    expect(documented, `${setting} is missing from the table`).toBeDefined();
    expect(documented?.value, `${setting}: documented default`).toBe(expected.value);
    expect(documented?.bounds, `${setting}: documented bounds`).toBe(expected.bounds);
  });
});

describe("policy reference — prose claims", () => {
  it("names both policy filenames the loader reads", () => {
    // Reading only `.stratum/policy.yaml` and finding nothing is a silent
    // no-gate state, so the fallback name has to be discoverable.
    expect(POLICY_REFERENCE).toContain(".stratum/policy.yaml");
    expect(POLICY_REFERENCE).toContain("stratum.config.json");
  });

  it("states that a malformed policy blocks merges", () => {
    expect(POLICY_REFERENCE).toMatch(/fails closed/i);
    expect(POLICY_REFERENCE).toMatch(/\*\*Blocked\*\*|blocked/i);
  });

  it("records that a single diff violation still passes the default minScore", () => {
    // The trap most likely to be discovered in production: 1 - 0.25 = 0.75,
    // which clears the 0.7 default. If either number moves, this sentence is
    // wrong and the arithmetic below stops holding.
    expect(1 - defaults.DIFF_VIOLATION_PENALTY).toBeGreaterThan(defaults.DEFAULT_MIN_SCORE);
    expect(1 - 2 * defaults.DIFF_VIOLATION_PENALTY).toBeLessThan(defaults.DEFAULT_MIN_SCORE);
    // Whitespace-tolerant: the sentence is prose and wraps wherever the line
    // length puts it.
    expect(POLICY_REFERENCE).toMatch(
      /single\*\s+violation\s+scores\s+0\.75\s+and\s+still\s+passes/,
    );
  });

  it("documents the two per-phase sandbox defaults summing to the total budget", () => {
    // The reference says an unconfigured project never has its command
    // truncated by a budget it did not choose, which is only true while this
    // holds.
    expect(defaults.DEFAULT_SANDBOX_TIMEOUT_MS + defaults.DEFAULT_SANDBOX_INSTALL_TIMEOUT_MS).toBe(
      defaults.DEFAULT_SANDBOX_TOTAL_BUDGET_MS,
    );
  });
});
