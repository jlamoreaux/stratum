/**
 * Every default and bound `.stratum/policy.yaml` leaves to Stratum, in one
 * place.
 *
 * These values are part of the product's public contract: a project owner who
 * omits `maxLines` is choosing 500, and the policy reference
 * (`docs/api/policy.md`) prints that number. They lived as private constants in
 * five evaluator modules, which meant the docs restated them from a reading of
 * the code and nothing noticed when the two diverged.
 *
 * Two rules keep that from happening again:
 *
 * 1. An evaluator imports its default from here rather than declaring its own.
 *    `DEFAULT_MIN_SCORE` is the reason this matters — it was written out three
 *    times (`diff-evaluator`, `sandbox-evaluator`, `DEFAULT_POLICY`), so
 *    changing the aggregate pass threshold meant finding all three.
 * 2. `tests/policy-reference-docs.test.ts` compares this module against the
 *    table in the policy reference and fails on drift, in either direction.
 *
 * Sandbox timing lives in `./limits` instead, because the policy loader clamps
 * those values and must not import an evaluator to do it; the sandbox entries
 * are re-exported here so the reference has a single import to check against.
 */

export {
  DEFAULT_COMMAND as DEFAULT_SANDBOX_COMMAND,
  DEFAULT_INSTALL_TIMEOUT_MS as DEFAULT_SANDBOX_INSTALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS as DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS as DEFAULT_SANDBOX_TOTAL_BUDGET_MS,
  MAX_COMMAND_LENGTH as MAX_SANDBOX_COMMAND_LENGTH,
  MAX_PHASE_TIMEOUT_MS,
  MAX_TOTAL_BUDGET_MS,
  MIN_PHASE_TIMEOUT_MS,
  MIN_TOTAL_BUDGET_MS,
} from "./limits";

/** Aggregate verdict demands every evaluator pass, rather than any one. */
export const DEFAULT_REQUIRE_ALL = true;

/**
 * Pass threshold the scoring evaluators (`diff`, `sandbox`) compare against.
 *
 * Note what this is not: the `llm` evaluator has its own `threshold`, because
 * its score means something different (a reviewer's confidence, not a count of
 * violations).
 */
export const DEFAULT_MIN_SCORE = 0.7;

/** `diff`: changed lines (added + removed) allowed before a violation. */
export const DEFAULT_MAX_LINES = 500;

/** `diff`: files in the change allowed before a violation. */
export const DEFAULT_MAX_FILES = 20;

/**
 * `diff`: paths that count as a violation when no `forbiddenPatterns` is set.
 *
 * A default rather than an empty list because the three of them are what an
 * agent most often commits by accident, and a project that has not written a
 * policy is exactly the one that will not have noticed.
 */
export const DEFAULT_FORBIDDEN_PATTERNS = ["*.lock", "node_modules/", ".env"];

/** `diff`: score subtracted per violation, from a starting 1.0. */
export const DIFF_VIOLATION_PENALTY = 0.25;

/** `llm`: the Workers AI model reviewing the diff when the policy names none. */
export const DEFAULT_LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** `llm`: minimum score the model must return for the evaluator to pass. */
export const DEFAULT_LLM_THRESHOLD = 0.7;

/** `llm`: diff characters sent for review when the policy sets no window. */
export const DEFAULT_MAX_DIFF_CHARS = 24_000;

/**
 * `llm`: ceiling on a policy-supplied `maxDiffChars`, so a hostile policy
 * cannot blow the model's context or the Worker's memory.
 */
export const MAX_DIFF_CHARS_CEILING = 100_000;

/**
 * `llm`: floor on a policy-supplied `maxDiffChars`. Without it a tiny value
 * would feed the model an effectively empty diff that it would still score.
 */
export const MAX_DIFF_CHARS_FLOOR = 1_000;

/**
 * `llm`: the serialized policy shares the model's input budget with the diff,
 * so an oversize one fails closed before any model call.
 */
export const MAX_POLICY_CONTEXT_CHARS = 8_000;

/** `webhook`: wait for the external verdict when the policy sets no timeout. */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/** `merge`: timeout for `postMergeCommand` when the policy sets none. */
export const DEFAULT_POST_MERGE_TIMEOUT_MS = 60_000;

/** `merge`: human approvals required when the policy sets none. */
export const DEFAULT_REQUIRED_APPROVALS = 0;
