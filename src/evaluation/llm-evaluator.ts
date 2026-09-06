import type { AiBinding } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_THRESHOLD,
  DEFAULT_MAX_DIFF_CHARS,
  MAX_DIFF_CHARS_CEILING,
  MAX_DIFF_CHARS_FLOOR,
  MAX_POLICY_CONTEXT_CHARS,
} from "./defaults";
import type { LLMBudget } from "./llm-budget";
import { sanitizePolicy } from "./sanitize-policy";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

const SYSTEM_PROMPT = [
  "You are a rigorous code reviewer acting as an automated merge gate.",
  "Review the diff for correctness bugs, security vulnerabilities, leaked credentials,",
  "and violations of the supplied policy context.",
  "Score 1.0 means safe to merge; 0.0 means must not merge.",
  "Respond with ONLY a JSON object and no other text:",
  '{"score": <0.0-1.0>, "passed": <bool>, "reason": "<one sentence>", "issues": ["<finding>"]}',
].join(" ");

export class LLMEvaluator implements Evaluator {
  /**
   * `budget` carries the deployment's limits, not the policy's. On a hosted
   * instance the inference is billed to the operator's Cloudflare account while
   * the policy asking for it belongs to the project, so the ceiling has to come
   * from the side paying. Omitted (self-host default) means unrestricted.
   */
  constructor(
    private ai: AiBinding,
    private budget: LLMBudget = { allowedModels: [] },
  ) {}

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
      const model = config?.model ?? DEFAULT_LLM_MODEL;
      // Clamped, not trusted as written: a threshold above 1 is unreachable and
      // would block every change, and a negative one makes `score >= threshold`
      // true for every score the model can return — silently reducing this gate
      // to whatever `passed` the model happened to emit.
      const threshold =
        typeof config?.threshold === "number" && Number.isFinite(config.threshold)
          ? Math.min(1, Math.max(0, config.threshold))
          : DEFAULT_LLM_THRESHOLD;
      const maxDiffChars =
        typeof config?.maxDiffChars === "number" && Number.isFinite(config.maxDiffChars)
          ? Math.min(
              Math.max(Math.floor(config.maxDiffChars), MAX_DIFF_CHARS_FLOOR),
              MAX_DIFF_CHARS_CEILING,
            )
          : DEFAULT_MAX_DIFF_CHARS;

      logger.debug("LLM config", { model, threshold, maxDiffChars });

      // Refused before the allowance is touched: a policy naming a model this
      // deployment does not offer has not spent anything, and charging it a
      // unit of quota would let a typo burn the project's day.
      const { allowedModels } = this.budget;
      if (allowedModels.length > 0 && !allowedModels.includes(model)) {
        logger.warn("Policy names a model this deployment does not allow", { model });
        return ok({
          score: 0,
          passed: false,
          reason: `LLM evaluator failed closed: this deployment does not allow the model "${model}". Allowed: ${allowedModels.join(", ")}.`,
        });
      }

      if (this.budget.reserve) {
        const reservation = await this.budget.reserve();
        if (!reservation.allowed) {
          // Fails closed rather than skipping, so exhausting the allowance
          // cannot be a way to switch this gate off and merge unreviewed.
          return ok({
            score: 0,
            passed: false,
            reason: `LLM evaluator failed closed: this project has used its ${reservation.limit} LLM evaluations for today. The allowance resets at 00:00 UTC.`,
          });
        }
      }

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
