import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import {
  AnthropicProvider,
  type LlmProvider,
  LlmProviderResponseError,
  OpenAiCompatibleProvider,
  WorkersAiProvider,
} from "../src/evaluation/llm-provider";
import type { EvalPolicy } from "../src/evaluation/types";
import type { AiBinding } from "../src/types";
import { ExternalServiceError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const POLICY: EvalPolicy = { evaluators: [{ type: "llm" }] };

/** A JSON body from a provider, as `fetch` would hand it back. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A response whose body is not JSON — `json()` rejects, as the real one does. */
function nonJsonResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  };
}

function lastFetchCall() {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
    string,
    { method: string; headers: Record<string, string>; body: string },
  ];
  return { url, init, body: JSON.parse(init.body) as Record<string, unknown> };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("WorkersAiProvider", () => {
  it("returns the binding's response text and reports no usage", async () => {
    const ai: AiBinding = { run: vi.fn().mockResolvedValue({ response: "hello" }) };
    const result = await new WorkersAiProvider(ai).run("@cf/model", [
      { role: "user", content: "hi" },
    ]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.text).toBe("hello");
    // Absent usage is what keeps the Workers AI path on the char estimate.
    expect(result.data.usage).toBeUndefined();
  });

  it("forwards the model and messages to the binding unchanged", async () => {
    const ai: AiBinding = { run: vi.fn().mockResolvedValue({ response: "{}" }) };
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ];
    await new WorkersAiProvider(ai).run("@cf/meta/llama", messages);
    expect(ai.run).toHaveBeenCalledWith("@cf/meta/llama", { messages });
  });

  it("a response object with no `response` field yields empty text, not an error", async () => {
    const ai: AiBinding = { run: vi.fn().mockResolvedValue({}) };
    const result = await new WorkersAiProvider(ai).run("@cf/model", []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.text).toBe("");
  });

  it("rejects a ReadableStream response rather than consuming it", async () => {
    const ai: AiBinding = {
      run: vi.fn().mockResolvedValue(new ReadableStream()),
    };
    const result = await new WorkersAiProvider(ai).run("@cf/model", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(LlmProviderResponseError);
    expect(result.error.message).toBe("unexpected stream response");
  });

  it("a throwing binding becomes a transport error, not a response error", async () => {
    const ai: AiBinding = { run: vi.fn().mockRejectedValue(new Error("network failure")) };
    const result = await new WorkersAiProvider(ai).run("@cf/model", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).not.toBeInstanceOf(LlmProviderResponseError);
    expect(result.error.message).toContain("network failure");
  });

  it("a non-Error rejection still becomes a readable transport error", async () => {
    const ai: AiBinding = { run: vi.fn().mockRejectedValue("boom") };
    const result = await new WorkersAiProvider(ai).run("@cf/model", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("boom");
  });
});

describe("AnthropicProvider — request shape", () => {
  it("POSTs /messages with the api-key, version header and required body fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: "verdict" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );

    const provider = new AnthropicProvider("https://api.anthropic.com/v1", "sk-ant-secret");
    await provider.run("claude-sonnet-4-5", [
      { role: "system", content: "be strict" },
      { role: "user", content: "review this" },
    ]);

    const { url, init, body } = lastFetchCall();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(typeof body.max_tokens).toBe("number");
    // The system prompt is a top-level parameter; a system-role message is rejected.
    expect(body.system).toBe("be strict");
    expect(body.messages).toEqual([{ role: "user", content: "review this" }]);
  });

  it("omits `system` entirely when no system message was supplied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "x" }] })),
    );
    await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", [
      { role: "user", content: "u" },
    ]);
    expect(lastFetchCall().body).not.toHaveProperty("system");
  });

  it("strips a trailing slash from the base URL rather than doubling it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "x" }] })),
    );
    await new AnthropicProvider("https://api.anthropic.com/v1/", "k").run("m", []);
    expect(lastFetchCall().url).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("AnthropicProvider — response handling", () => {
  it("joins every text block and maps usage to real token counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      ),
    );
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.text).toBe("part one part two");
    expect(result.data.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("a content array with no text blocks yields empty text, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: "tool_use", id: "t" }] })),
    );
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.text).toBe("");
  });

  it("non-200 fails with the status only — never the error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          error: { message: "invalid x-api-key: sk-ant-LEAKED" },
        }),
      ),
    );
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(LlmProviderResponseError);
    expect(result.error.message).toBe("provider returned HTTP 401");
    expect(result.error.message).not.toContain("sk-ant-LEAKED");
  });

  it("a 200 whose body is not JSON fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(nonJsonResponse()));
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(LlmProviderResponseError);
    expect(result.error.message).toBe("provider response was not valid JSON");
  });

  it("a 200 of the wrong shape fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { completion: "text" })));
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider response had no content array");
  });

  it("a 200 whose body is JSON `null` fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, null)));
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider response had no content array");
  });

  it("a response with no usage object reports no usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "x" }] })),
    );
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.usage).toBeUndefined();
  });

  it("a half-filled usage object is treated as absent, never half-trusted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 100 },
        }),
      ),
    );
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.usage).toBeUndefined();
  });

  it("a non-finite token count is treated as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: Number.NaN, output_tokens: 5 },
        }),
      ),
    );
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.usage).toBeUndefined();
  });

  it("a network failure becomes a transport error, not a response error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const result = await new AnthropicProvider("https://api.anthropic.com/v1", "k").run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).not.toBeInstanceOf(LlmProviderResponseError);
    expect(result.error.message).toContain("fetch failed");
  });

  it("aborts a request that outlives the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );
    const provider = new AnthropicProvider("https://api.anthropic.com/v1", "k", { timeoutMs: 5 });
    const result = await provider.run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("aborted");
  });
});

describe("OpenAiCompatibleProvider — request shape", () => {
  it("POSTs /chat/completions with a bearer token and the messages verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [{ message: { content: "verdict" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      ),
    );

    const messages = [
      { role: "system", content: "be strict" },
      { role: "user", content: "review this" },
    ];
    await new OpenAiCompatibleProvider("https://api.openai.com/v1", "sk-secret").run(
      "gpt-4o-mini",
      messages,
    );

    const { url, init, body } = lastFetchCall();
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer sk-secret");
    expect(body.model).toBe("gpt-4o-mini");
    // Unlike Anthropic, the system turn stays in the messages array.
    expect(body.messages).toEqual(messages);
  });

  it("works against a self-hosted base URL with a trailing slash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "x" } }] })),
    );
    await new OpenAiCompatibleProvider("http://vllm.internal:8000/v1/", "token-abc").run("m", []);
    expect(lastFetchCall().url).toBe("http://vllm.internal:8000/v1/chat/completions");
  });
});

describe("OpenAiCompatibleProvider — response handling", () => {
  it("reads the first choice's message content and maps usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [{ message: { content: "the verdict" } }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
      ),
    );
    const result = await new OpenAiCompatibleProvider("https://api.groq.com/openai/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.text).toBe("the verdict");
    expect(result.data.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
  });

  it("non-200 fails with the status only — never the error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(429, { error: { message: "rate limited for key sk-live-LEAKED" } }),
        ),
    );
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider returned HTTP 429");
    expect(result.error.message).not.toContain("sk-live-LEAKED");
  });

  it("a body that is not JSON fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(nonJsonResponse()));
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider response was not valid JSON");
  });

  it("a 200 with no choices array fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { object: "error" })));
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider response had no choices array");
  });

  it("an empty choices array fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { choices: [] })));
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider response had no assistant message text");
  });

  it("a non-string message content fails closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { choices: [{ message: { content: [{ type: "text" }] } }] }),
        ),
    );
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("provider response had no assistant message text");
  });

  it("a response with no usage reports none, keeping the caller on an estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "x" } }] })),
    );
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.usage).toBeUndefined();
  });

  it("a network failure becomes a transport error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const result = await new OpenAiCompatibleProvider("https://api.openai.com/v1", "k").run(
      "m",
      [],
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).not.toBeInstanceOf(LlmProviderResponseError);
    expect(result.error.message).toContain("fetch failed");
  });

  it("aborts a request that outlives the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );
    const provider = new OpenAiCompatibleProvider("https://api.openai.com/v1", "k", {
      timeoutMs: 5,
    });
    const result = await provider.run("m", []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("aborted");
  });
});

const VERDICT = JSON.stringify({ score: 0.9, passed: true, reason: "Looks good" });

/** A provider that answers with a fixed verdict and whatever usage it is given. */
function stubProvider(usage?: { inputTokens: number; outputTokens: number }): LlmProvider {
  return { run: vi.fn().mockResolvedValue(ok({ text: VERDICT, usage })) };
}

describe("LLMEvaluator — cost accounting is per provider, not per source", () => {
  it("a provider reporting usage yields exact counts with no `estimated` flag", async () => {
    const evaluator = new LLMEvaluator(stubProvider({ inputTokens: 900, outputTokens: 100 }));
    const result = await evaluator.evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.costs).toEqual([{ kind: "llm_tokens", quantity: 1000 }]);
    expect(result.data.costs?.[0]?.estimated).toBeUndefined();
  });

  it("a provider omitting usage stays on the ~4 chars/token estimate", async () => {
    const evaluator = new LLMEvaluator(stubProvider());
    const result = await evaluator.evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.costs?.[0]?.estimated).toBe(true);
    expect(result.data.costs?.[0]?.quantity).toBeGreaterThan(0);
  });

  it("Workers AI, which reports nothing, is on the estimate", async () => {
    const ai: AiBinding = { run: vi.fn().mockResolvedValue({ response: VERDICT }) };
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.costs?.[0]?.estimated).toBe(true);
  });
});

describe("LLMEvaluator — provider failures fail the gate closed", () => {
  it("an unusable provider response scores 0 and does not pass", async () => {
    const provider: LlmProvider = {
      run: vi.fn().mockResolvedValue({
        success: false,
        error: new LlmProviderResponseError("provider returned HTTP 503"),
      }),
    };
    const result = await new LLMEvaluator(provider).evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.score).toBe(0);
    expect(result.data.passed).toBe(false);
    expect(result.data.reason).toBe("LLM evaluator error: provider returned HTTP 503");
  });

  it("a transport failure surfaces as an error, still never a pass", async () => {
    const provider: LlmProvider = {
      run: vi.fn().mockResolvedValue({
        success: false,
        error: new ExternalServiceError("LLM", "connection reset"),
      }),
    };
    const result = await new LLMEvaluator(provider).evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("connection reset");
  });

  it("a provider error body carrying an API key never reaches the evaluation result", async () => {
    // The whole HTTP path, not a stub: a real 401 body with a credential in it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          error: { message: "Incorrect API key provided: sk-live-DEADBEEF12345" },
        }),
      ),
    );
    const provider = new OpenAiCompatibleProvider(
      "https://api.openai.com/v1",
      "sk-live-DEADBEEF12345",
    );
    const result = await new LLMEvaluator(provider).evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reason).toBe("LLM evaluator error: provider returned HTTP 401");
    expect(JSON.stringify(result.data)).not.toContain("sk-live-DEADBEEF12345");
    expect(JSON.stringify(result.data)).not.toContain("Incorrect API key");
  });

  it("a stream response from Workers AI fails closed with the historical reason", async () => {
    const ai: AiBinding = { run: vi.fn().mockResolvedValue(new ReadableStream()) };
    const result = await new LLMEvaluator(new WorkersAiProvider(ai)).evaluate(
      "diff content",
      POLICY,
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.score).toBe(0);
    expect(result.data.passed).toBe(false);
    expect(result.data.reason).toBe("LLM evaluator error: unexpected stream response");
    // Byte-identical to the pre-seam behaviour: no costs on this path.
    expect(result.data.costs).toBeUndefined();
  });

  it("a provider that throws is caught rather than escaping the evaluator", async () => {
    const provider: LlmProvider = {
      run: vi.fn().mockRejectedValue(new Error("isolate exceeded CPU")),
    };
    const result = await new LLMEvaluator(provider).evaluate("diff content", POLICY, mockLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("isolate exceeded CPU");
  });
});
