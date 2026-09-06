import type { Env } from "../types";
import type { Logger } from "../utils/logger";

/**
 * Deployment-level limits on the `llm` evaluator.
 *
 * The evaluator calls the Workers AI binding of the account the instance is
 * deployed to, so on a hosted instance every run is inference the *operator*
 * pays for, requested by a policy file the *project owner* writes. Nothing in
 * `.stratum/policy.yaml` bounds that: a policy chooses the model, and a change
 * can be re-evaluated as often as the request rate limit allows.
 *
 * Both limits are off unless the deployment sets them, so a self-hoster — whose
 * account is their own — sees no change.
 */
export interface LLMBudget {
  /**
   * Model ids this deployment permits. Empty means no restriction.
   *
   * `model` in a policy is passed to the AI binding as written, and Workers AI
   * prices models very differently, so an unrestricted hosted instance lets a
   * project pick how expensive its own reviews are.
   */
  allowedModels: string[];
  /**
   * Consume one unit of the project's daily allowance, or report that it is
   * spent. Absent when the deployment sets no cap.
   */
  reserve?: () => Promise<LLMReservation>;
}

export interface LLMReservation {
  allowed: boolean;
  /** Calls permitted per day. Reported so a blocked run can name the number. */
  limit: number;
  /** Calls already made in the current window, at the moment of the check. */
  used: number;
}

/** How long a daily counter outlives its window, so a clock skew cannot resurrect one. */
const COUNTER_TTL_SECONDS = 172_800;

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCap(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  // A zero or negative cap would mean "no llm evaluation is ever allowed",
  // which is a thing to express by removing the binding, not by a limit that
  // blocks every merge on every project.
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read the deployment's `llm` limits and bind them to one project's counter.
 *
 * The counter is a per-day KV key, the same read-increment-write shape the
 * request rate limiter uses. KV is not atomic, so concurrent evaluations of the
 * same project can overshoot the cap by roughly the number in flight. That is
 * accepted deliberately: this bounds a runaway, and paying for a distributed
 * counter to make the boundary exact would cost more than the handful of calls
 * it saves.
 */
export function llmBudgetForProject(env: Env, projectName: string, logger: Logger): LLMBudget {
  const allowedModels = parseAllowlist(env.LLM_MODEL_ALLOWLIST);
  const limit = parseCap(env.LLM_EVALS_PER_PROJECT_PER_DAY);
  if (limit === undefined) return { allowedModels };

  const reserve = async (): Promise<LLMReservation> => {
    const dayBucket = Math.floor(Date.now() / 86_400_000);
    const key = `llmquota:${projectName}:${dayBucket}`;
    try {
      const raw = await env.STATE.get(key);
      const used = raw !== null ? Number.parseInt(raw, 10) : 0;
      const count = Number.isFinite(used) && used > 0 ? used : 0;
      if (count >= limit) {
        logger.warn("Daily llm evaluation cap reached", { projectName, limit, used: count });
        return { allowed: false, limit, used: count };
      }
      await env.STATE.put(key, String(count + 1), { expirationTtl: COUNTER_TTL_SECONDS });
      return { allowed: true, limit, used: count + 1 };
    } catch (error) {
      // A counter this evaluator could not read is not a reason to hand out an
      // unmetered call: the whole point of the cap is that the operator, not
      // the caller, is billed for what happens next.
      logger.error(
        "Could not read the llm evaluation counter, refusing the call",
        error instanceof Error ? error : new Error(String(error)),
        { projectName },
      );
      return { allowed: false, limit, used: limit };
    }
  };

  return { allowedModels, reserve };
}
