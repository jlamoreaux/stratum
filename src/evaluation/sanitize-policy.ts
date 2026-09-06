import type { EvalPolicy, EvaluatorConfig } from "./types";

/**
 * Fields whose *name* says the value is a credential.
 *
 * Matched on the key rather than the value because there is no reliable way to
 * recognise a secret by its bytes, and this runs on repository content: whatever
 * a user wrote in the policy file, under whatever key they chose.
 */
const CREDENTIAL_WORDS = new Set([
  "secret",
  "secrets",
  "token",
  "password",
  "passwd",
  "credential",
  "credentials",
  "authorization",
  "bearer",
  "key",
  "apikey",
  "signature",
]);

/**
 * Split a field name into words on camelCase and separator boundaries, so
 * `apiKey`, `api_key` and `API-KEY` are all recognised while `monkeys` — which
 * merely contains "key" — is not.
 */
function words(key: string): string[] {
  return key
    .split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** Keys stripped from every evaluator entry regardless of shape. */
function isStrippedKey(key: string): boolean {
  // The provider *name* is not a credential, but it names the operator's
  // infrastructure to a third party the operator did not choose — and the model
  // has no use for it. It costs nothing to withhold, and withholding it is what
  // makes adding a provider to a policy free against
  // `MAX_POLICY_CONTEXT_CHARS`: the serialized policy does not grow, so a
  // project that fits today cannot start failing its gate closed by opting into
  // BYOK.
  if (key === "provider") return true;
  return words(key).some((word) => CREDENTIAL_WORDS.has(word));
}

/**
 * Strip credentials from a policy before it leaves the Worker (serialized into
 * an LLM prompt, or a webhook request body).
 *
 * This is the last thing that runs before the policy is handed to a third
 * party, so it strips by key shape rather than by known field. `webhook.secret`
 * — the one field this used to handle — is used to sign outgoing requests and
 * must never appear in a payload itself. The general rule exists because
 * `sanitizeEvaluator` copies an entry of an unmodelled `type` through whole
 * (a policy naming a future evaluator), so a credential-shaped field on such an
 * entry would otherwise reach the model verbatim. `sanitizeLlmConfig`'s
 * whitelist already keeps one off an `llm` entry; this is the backstop for
 * every entry it does not model.
 *
 * Note what this is *not*: a defence against the model seeing secrets in the
 * diff. The diff is the thing being reviewed, and `redactSecrets`
 * (`deploy/redact.ts`) is explicit that literal-substring redaction is a
 * backstop. The structural control is upstream — provider output never reaches
 * `EvalResult.reason` (`llm-evaluator.ts`).
 */
export function sanitizePolicy(policy: EvalPolicy): EvalPolicy {
  return {
    ...policy,
    evaluators: policy.evaluators.map((cfg: EvaluatorConfig) => {
      const entries = Object.entries(cfg).filter(([key]) => !isStrippedKey(key));
      return Object.fromEntries(entries) as EvaluatorConfig;
    }),
  };
}
