import type { AiBinding } from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";

/**
 * One turn of the conversation handed to a provider. Structurally identical to
 * the shape `AiBinding.run` already takes, so `WorkersAiProvider` forwards it
 * unchanged.
 */
export interface Message {
  role: string;
  content: string;
}

/** Token counts a provider actually reported. Never an estimate — see `LlmResponse.usage`. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  /** The assistant's text. Empty string when the provider returned a well-formed
   * response carrying no text, which the evaluator then fails closed on. */
  text: string;
  /**
   * Present only when the provider reported real token counts. Its absence is
   * load-bearing: the evaluator falls back to the `~4 chars/token` estimate and
   * marks the cost sample `estimated`. That distinction is **per provider, not
   * per source** — Workers AI reports nothing, and an OpenAI-compatible
   * endpoint that omits `usage` is estimated too.
   */
  usage?: LlmUsage;
}

/**
 * The seam between the LLM evaluator and whoever actually runs the model.
 *
 * Errors are values: a provider never throws across this boundary. Two error
 * shapes are distinguished, because they mean different things to the gate:
 * `LlmProviderResponseError` for a response that arrived but cannot be used
 * (which fails the evaluation closed with a readable reason), and any other
 * `AppError` for a transport failure.
 */
export interface LlmProvider {
  run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>>;
}

/**
 * The provider answered, but the answer is unusable — a non-2xx status, a body
 * that is not JSON, a JSON body of the wrong shape, or a stream where a
 * completion was expected.
 *
 * **The message is metadata only.** It reaches the user: `runEvaluation`
 * (`services/change-flow.ts`) copies `error.message` straight into the recorded
 * `EvalResult.reason`. A provider's error body can quote the request — which
 * contains the diff — and some providers echo the credential that failed, so
 * the body is never interpolated into it. Status codes and byte counts only.
 */
export class LlmProviderResponseError extends AppError {
  constructor(message: string) {
    super(message, "LLM_PROVIDER_RESPONSE", 502);
    this.name = "LlmProviderResponseError";
  }
}

function transportError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return new ExternalServiceError(
    "LLM",
    message,
    error instanceof Error ? error : undefined,
  ) as AppError;
}

/**
 * The Workers AI binding, and the default. Behaviour here is deliberately
 * identical to what `LLMEvaluator` did inline before the seam existed:
 * a `ReadableStream` is rejected rather than consumed, and a response object
 * with no `response` field yields `""` so the evaluator fails it closed as
 * unparseable output rather than treating it as a distinct condition.
 *
 * It reports no token usage, which is why the Workers AI path keeps the
 * `~4 chars/token` estimate and `estimated: true`.
 */
export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: AiBinding) {}

  async run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>> {
    let raw: Awaited<ReturnType<AiBinding["run"]>>;
    try {
      raw = await this.ai.run(model, { messages });
    } catch (error) {
      return err(transportError(error));
    }

    if (raw instanceof ReadableStream) {
      return err(new LlmProviderResponseError("unexpected stream response"));
    }

    return ok({ text: raw.response ?? "" });
  }
}

/** How long a hosted provider gets before the gate gives up on it. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpProviderOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Credentials and endpoints for both HTTP providers are **constructor
 * arguments supplied by the caller** — never read from `env` here, and never
 * taken from `.stratum/policy.yaml`.
 *
 * The omission is deliberate, not a gap. A base URL a repository's own policy
 * file can choose turns this Worker into a request-forgery primitive aimed at
 * whatever host the policy names, and the prompt it would receive contains the
 * diff (PRD §7). Resolving a provider name against an operator-configured
 * allowlist is Task 7's job; these classes only take what they are handed.
 */
abstract class HttpLlmProvider implements LlmProvider {
  constructor(
    protected readonly baseUrl: string,
    protected readonly apiKey: string,
    protected readonly options: HttpProviderOptions = {},
  ) {}

  abstract run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>>;

  /**
   * POST a JSON body and parse a JSON response, converting every failure into
   * a `Result`. Returns the decoded body as `unknown`: each provider validates
   * its own shape, because a body that parsed is not a body that can be read.
   */
  protected async post(path: string, headers: Record<string, string>, body: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The status, never the body: an error body can echo the API key that
        // failed, and this message becomes a user-visible evaluation reason.
        return err(
          new LlmProviderResponseError(`provider returned HTTP ${response.status}`) as AppError,
        );
      }

      try {
        return ok((await response.json()) as unknown);
      } catch {
        return err(
          new LlmProviderResponseError("provider response was not valid JSON") as AppError,
        );
      }
    } catch (error) {
      return err(transportError(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Anthropic's Messages API: `POST {baseUrl}/messages`, `x-api-key` plus the
 * required `anthropic-version` header, assistant text in `content[]` blocks of
 * type `text`, real token counts in `usage.input_tokens` / `usage.output_tokens`.
 *
 * Docs: https://platform.claude.com/docs/en/api/messages/create and
 * https://platform.claude.com/docs/en/api/overview (headers table).
 */
export class AnthropicProvider extends HttpLlmProvider {
  /** Pinned rather than configurable: the API is versioned by this header, and
   * a value the caller could vary is a shape this code has not been written for. */
  static readonly API_VERSION = "2023-06-01";
  /** The evaluator asks for one small JSON verdict; `max_tokens` is required. */
  static readonly MAX_TOKENS = 1024;

  async run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>> {
    // Anthropic takes the system prompt as a top-level parameter, not as a
    // message with role "system" — a system-role message is rejected.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages.filter((m) => m.role !== "system");

    const posted = await this.post(
      "/messages",
      {
        "x-api-key": this.apiKey,
        "anthropic-version": AnthropicProvider.API_VERSION,
      },
      {
        model,
        max_tokens: AnthropicProvider.MAX_TOKENS,
        ...(system.length > 0 ? { system } : {}),
        messages: turns,
      },
    );
    if (!posted.success) return posted;

    const body = posted.data as {
      content?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    } | null;

    if (body === null || typeof body !== "object" || !Array.isArray(body.content)) {
      return err(
        new LlmProviderResponseError("provider response had no content array") as AppError,
      );
    }

    const text = body.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");

    return ok({ text, ...usageOrNothing(body.usage?.input_tokens, body.usage?.output_tokens) });
  }
}

/**
 * The OpenAI Chat Completions shape, which OpenAI, OpenRouter, Groq, Together
 * and a self-hosted vLLM server all speak: `POST {baseUrl}/chat/completions`
 * with `Authorization: Bearer`, assistant text at `choices[0].message.content`,
 * token counts at `usage.prompt_tokens` / `usage.completion_tokens`.
 *
 * Docs: https://developers.openai.com/api/reference/chat-completions/overview,
 * https://openrouter.ai/docs/api-reference/chat-completion,
 * https://console.groq.com/docs/api-reference,
 * https://docs.vllm.ai/en/latest/serving/openai_compatible_server/.
 */
export class OpenAiCompatibleProvider extends HttpLlmProvider {
  async run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>> {
    // No `max_tokens`: the four vendors this one endpoint serves disagree about
    // it (newer OpenAI models take `max_completion_tokens` and reject
    // `max_tokens`), and an unrecognised field is a 400 from the strict ones.
    const posted = await this.post(
      "/chat/completions",
      { authorization: `Bearer ${this.apiKey}` },
      { model, messages },
    );
    if (!posted.success) return posted;

    const body = posted.data as {
      choices?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null;

    if (body === null || typeof body !== "object" || !Array.isArray(body.choices)) {
      return err(
        new LlmProviderResponseError("provider response had no choices array") as AppError,
      );
    }

    const content = (body.choices[0] as { message?: { content?: unknown } } | undefined)?.message
      ?.content;
    if (typeof content !== "string") {
      return err(
        new LlmProviderResponseError("provider response had no assistant message text") as AppError,
      );
    }

    return ok({
      text: content,
      ...usageOrNothing(body.usage?.prompt_tokens, body.usage?.completion_tokens),
    });
  }
}

/**
 * Report usage only when both counts are real numbers. A partial or malformed
 * `usage` object is treated as absent rather than half-trusted: a wrong token
 * count recorded as exact is worse than an estimate labelled as one.
 */
function usageOrNothing(input: unknown, output: unknown): { usage?: LlmUsage } {
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isFinite(input) ||
    !Number.isFinite(output)
  ) {
    return {};
  }
  return { usage: { inputTokens: input, outputTokens: output } };
}
