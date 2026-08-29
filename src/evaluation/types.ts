import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";

export interface EvalResult {
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
  /** Resource usage the evaluator incurred, recorded for cost tracking. */
  costs?: Array<{ kind: "llm_tokens" | "sandbox_ms"; quantity: number; estimated?: boolean }>;
}

/**
 * Provenance about the revision under evaluation, for evaluators that must name
 * it to a third party. Read-only because one instance is shared across the
 * evaluator fan-out in `runEvaluation`.
 */
export interface EvaluationContext {
  /**
   * The project commit the diff was computed against, resolved from the same
   * clone that produced the diff (`getDiffBetweenRepos`).
   *
   * NOT `change.baseSha`: that one comes from `resolveProjectHead`, a separate
   * KV-snapshot read taken before the diff clone, and the two can disagree.
   * Sending the wrong one would tell a receiver it can reproduce a base the
   * diff was never computed against (#274).
   */
  readonly baseSha?: string;
}

export interface Evaluator {
  evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
    context?: EvaluationContext,
  ): Promise<Result<EvalResult, AppError>>;
}

export interface EvalPolicy {
  evaluators: EvaluatorConfig[];
  requireAll?: boolean;
  minScore?: number;
  merge?: MergePolicy;
  /** Set when a policy file is present but malformed. The merge gate treats this
   * as fail-closed (blocks) rather than silently running on the default, so a
   * typo in a stricter policy can't quietly downgrade governance. */
  configError?: string;
}

/**
 * Branch-protection rules enforced at the merge step.
 * Configured under `merge:` in .stratum/policy.yaml.
 */
export interface MergePolicy {
  /** Human approvals required before a change can merge. Default 0. */
  requiredApprovals?: number;
  /** Evaluator types whose latest run must have passed (e.g. ["secret_scan", "diff"]). */
  requiredEvaluators?: string[];
  /** The ?force=true override is rejected unless this is explicitly true. Default false. */
  allowForce?: boolean;
  /** When true, a change whose recorded base is behind project HEAD cannot merge. */
  requireFreshBase?: boolean;
  /** Smoke command run in a sandbox against the merged HEAD (e.g. "npm test"). */
  postMergeCommand?: string;
  /** Timeout for the post-merge command. Default 60s. */
  postMergeTimeoutMs?: number;
  /** Revert the merge commit when the post-merge command fails. Default true. */
  autoRevert?: boolean;
}

export type EvaluatorConfig =
  | {
      type: "diff";
      maxLines?: number;
      maxFiles?: number;
      forbiddenPatterns?: string[];
      requiredPatterns?: string[];
    }
  | { type: "webhook"; url: string; secret?: string; timeoutMs?: number }
  | { type: "sandbox"; command?: string; timeoutMs?: number; installTimeoutMs?: number }
  | { type: "llm"; model?: string; threshold?: number; maxDiffChars?: number };
