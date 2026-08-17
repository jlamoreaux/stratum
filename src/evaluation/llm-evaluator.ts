import type { AiBinding } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator, EvaluatorConfig } from "./types";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MAX_DIFF_CHARS = 24_000;
// Policy-supplied window bounds: the ceiling stops a hostile policy blowing the
// model's context or the Worker's memory; the floor stops a tiny/fractional
// value feeding the model an effectively empty diff that it would still score.
const MAX_DIFF_CHARS_CEILING = 100_000;
const MAX_DIFF_CHARS_FLOOR = 1_000;
// The serialized policy shares the model's input budget with the diff; a
// pathological policy must not blow the context (or starve the diff), so an
// oversize one fails closed before any model call.
const MAX_POLICY_CONTEXT_CHARS = 8_000;

const SYSTEM_PROMPT = [
  "You are a rigorous code reviewer acting as an automated merge gate.",
  "Review the diff for correctness bugs, security vulnerabilities, leaked credentials,",
  "and violations of the supplied policy context.",
  "Score 1.0 means safe to merge; 0.0 means must not merge.",
  "Respond with ONLY a JSON object and no other text:",
  '{"score": <0.0-1.0>, "passed": <bool>, "reason": "<one sentence>", "issues": ["<finding>"]}',
].join(" ");

function sanitizePolicy(policy: EvalPolicy): EvalPolicy {
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

export class LLMEvaluator implements Evaluator {
  constructor(private ai: AiBinding) {}

  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting LLM evaluation");

    try {
      const config = policy.evaluators.find((e) => e.type === "llm") as
        | { type: "llm"; model?: string; threshold?: number; maxDiffChars?: number }
        | undefined;
      const model = config?.model ?? DEFAULT_MODEL;
      const threshold = config?.threshold ?? DEFAULT_THRESHOLD;
      const maxDiffChars =
        typeof config?.maxDiffChars === "number" && Number.isFinite(config.maxDiffChars)
          ? Math.min(
              Math.max(Math.floor(config.maxDiffChars), MAX_DIFF_CHARS_FLOOR),
              MAX_DIFF_CHARS_CEILING,
            )
          : DEFAULT_MAX_DIFF_CHARS;

      logger.debug("LLM config", { model, threshold, maxDiffChars });

      const truncated = diff.length > maxDiffChars;
      const truncationNote = truncated
        ? `Diff truncated for review: evaluated first ${maxDiffChars} of ${diff.length} chars`
        : undefined;

      const policyContext = JSON.stringify(sanitizePolicy(policy));
      if (policyContext.length > MAX_POLICY_CONTEXT_CHARS) {
        logger.warn("Policy context too large for LLM evaluation, failing closed", {
          policyChars: policyContext.length,
        });
        return ok({
          score: 0,
          passed: false,
          reason: `LLM evaluator failed closed: policy context is ${policyContext.length} chars (limit ${MAX_POLICY_CONTEXT_CHARS})`,
        });
      }

      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Policy context: ${policyContext}\n\nDiff to review:\n${diff.slice(0, maxDiffChars)}`,
        },
      ];

      const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
      const raw = await this.ai.run(model, { messages });

      if (raw instanceof ReadableStream) {
        logger.error("LLM evaluation failed: unexpected stream response");
        return ok({
          score: 0,
          passed: false,
          reason: "LLM evaluator error: unexpected stream response",
        });
      }

      const responseText = raw.response;
      // Workers AI does not report token usage; ~4 chars/token is the standard estimate.
      const estimatedTokens = Math.ceil((promptChars + (responseText?.length ?? 0)) / 4);
      const costs: EvalResult["costs"] = [
        { kind: "llm_tokens", quantity: estimatedTokens, estimated: true },
      ];

      // A gate whose verdict can't be read has not passed. Never infer a score
      // from prose ("LGTM") — that let unparseable output half-approve a merge.
      // Never echo raw model output into the result: the model can quote the
      // diff, and the diff can contain exactly the secrets this gate catches.
      const failClosed = (why: string): Result<EvalResult, AppError> => {
        logger.warn("LLM response unusable, failing closed", { why });
        return ok({
          score: 0,
          passed: false,
          reason: `LLM evaluator failed closed: ${why}`,
          issues: [
            `Model response (${responseText?.length ?? 0} chars) was not a valid verdict object`,
            ...(truncationNote ? [truncationNote] : []),
          ],
          costs,
        });
      };

      let parsed: { score: unknown; passed: unknown; reason: unknown; issues?: unknown };
      try {
        parsed = JSON.parse(responseText ?? "") as {
          score: unknown;
          passed: unknown;
          reason: unknown;
          issues?: unknown;
        };
      } catch {
        return failClosed("response was not valid JSON");
      }

      if (
        typeof parsed.score !== "number" ||
        !Number.isFinite(parsed.score) ||
        typeof parsed.passed !== "boolean" ||
        typeof parsed.reason !== "string"
      ) {
        return failClosed("response JSON missing score/passed/reason fields");
      }

      const score = Math.min(1, Math.max(0, parsed.score));
      const passed = parsed.passed && score >= threshold;
      const modelIssues =
        Array.isArray(parsed.issues) && parsed.issues.every((i) => typeof i === "string")
          ? (parsed.issues as string[])
          : [];
      const issues = truncationNote ? [...modelIssues, truncationNote] : modelIssues;

      logger.info("LLM evaluation complete", { score, passed, truncated });

      return ok({
        score,
        passed,
        reason: parsed.reason,
        ...(issues.length > 0 ? { issues } : {}),
        costs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("LLM evaluation failed", error instanceof Error ? error : new Error(message));
      return err(
        new ExternalServiceError(
          "LLM",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    }
  }
}
