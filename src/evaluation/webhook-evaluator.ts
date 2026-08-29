import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import { validateWebhookUrl } from "../utils/validation";
import { sanitizePolicy } from "./sanitize-policy";
import type { EvalPolicy, EvalResult, EvaluationContext, Evaluator } from "./types";

async function computeHmacSha256(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class WebhookEvaluator implements Evaluator {
  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
    context?: EvaluationContext,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting webhook evaluation");

    const config = policy.evaluators.find((e) => e.type === "webhook");
    if (!config || config.type !== "webhook") {
      logger.warn("No webhook configuration found");
      return ok({ score: 0, passed: false, reason: "Webhook: no configuration found." });
    }

    // The URL comes from the repo's own policy file, so it must pass the same
    // private-host / SSRF filter as delivery webhooks. Fail the evaluation
    // closed (score 0, not passed) rather than fetch an internal address.
    const urlCheck = validateWebhookUrl(config.url, logger);
    if (!urlCheck.success) {
      logger.warn("Webhook evaluator URL rejected", { url: config.url });
      return ok({
        score: 0,
        passed: false,
        reason: `Webhook: URL not allowed (${urlCheck.error[0]?.message ?? "invalid URL"}).`,
      });
    }

    const timeoutMs = config.timeoutMs ?? 10000;
    // The payload leaves the Worker, so strip credentials (webhook secrets)
    // from the policy first — the secret signs the request, it is not content.
    //
    // `baseSha` names the commit the diff was computed against so the receiver
    // can pin its mirror to that exact revision instead of evaluating against
    // whatever its default branch points at when the request lands (#274).
    // JSON.stringify drops an undefined value, so an unpinned base yields the
    // byte-identical body — and therefore the identical HMAC — that shipped
    // before this field existed.
    const body = JSON.stringify({
      diff,
      baseSha: context?.baseSha,
      policy: sanitizePolicy(policy),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (config.secret) {
      const hex = await computeHmacSha256(config.secret, body);
      headers["X-Stratum-Signature"] = `sha256=${hex}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.debug("Sending webhook request", { url: config.url, timeoutMs });

      const response = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        // Never follow a redirect to a (possibly internal) address; a 3xx here
        // is treated as a failed evaluation below via !response.ok.
        redirect: "manual",
      });

      if (!response.ok) {
        logger.error("Webhook evaluation failed", new Error(`HTTP ${response.status}`));
        return ok({ score: 0, passed: false, reason: `Webhook failed: HTTP ${response.status}` });
      }

      // A gate whose verdict can't be read has not passed. The endpoint is
      // external, so never trust its shape: require a real boolean `passed`
      // and a finite numeric `score`, and fail closed otherwise — a truthy
      // string like {"passed":"no"} must not open the gate.
      const failClosed = (why: string): Result<EvalResult, AppError> => {
        logger.warn("Webhook response unusable, failing closed", { why });
        return ok({ score: 0, passed: false, reason: `Webhook evaluator failed closed: ${why}` });
      };

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return failClosed("response was not valid JSON");
      }

      if (parsed === null || typeof parsed !== "object") {
        return failClosed("response JSON was not an object");
      }

      const verdict = parsed as { score?: unknown; passed?: unknown; reason?: unknown };
      if (
        typeof verdict.score !== "number" ||
        !Number.isFinite(verdict.score) ||
        typeof verdict.passed !== "boolean"
      ) {
        return failClosed("response JSON missing a finite numeric `score` or boolean `passed`");
      }

      const score = Math.min(1, Math.max(0, verdict.score));
      const reason =
        typeof verdict.reason === "string" ? verdict.reason : "Webhook returned no reason.";

      logger.info("Webhook evaluation complete", { score, passed: verdict.passed });
      return ok({ score, passed: verdict.passed, reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        "Webhook evaluation failed",
        error instanceof Error ? error : new Error(message),
      );
      return err(
        new ExternalServiceError(
          "Webhook",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
