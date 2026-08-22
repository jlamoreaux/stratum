import type { EvalPolicy, EvaluatorConfig } from "./types";

/**
 * Strip credentials from a policy before it leaves the Worker (serialized into
 * an LLM prompt or a webhook request body). The webhook secret is used to sign
 * outgoing requests; it must never appear in a payload itself.
 */
export function sanitizePolicy(policy: EvalPolicy): EvalPolicy {
  return {
    ...policy,
    evaluators: policy.evaluators.map((cfg: EvaluatorConfig) => {
      if (cfg.type === "webhook") {
        const { secret: _secret, ...rest } = cfg;
        return rest;
      }
      return cfg;
    }),
  };
}
