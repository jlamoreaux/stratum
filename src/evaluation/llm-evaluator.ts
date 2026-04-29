import type { EvalResult, EvalPolicy, Evaluator } from './types';
import type { AiBinding } from '../types';

export class LLMEvaluator implements Evaluator {
  constructor(private ai: AiBinding) {}

  async evaluate(diff: string, policy: EvalPolicy): Promise<EvalResult> {
    try {
      const config = policy.evaluators.find((e) => e.type === 'llm') as
        | { type: 'llm'; model?: string; threshold?: number }
        | undefined;
      const model = config?.model ?? '@cf/meta/llama-3.1-8b-instruct';
      const threshold = config?.threshold ?? 0.7;

      const messages = [
        {
          role: 'system',
          content:
            'You are a code reviewer. Evaluate the following diff and respond ONLY with a JSON object: {"score": <0.0-1.0>, "passed": <bool>, "reason": "<string>", "issues": ["<string>"]}',
        },
        {
          role: 'user',
          content: `Policy context: ${JSON.stringify(policy)}\n\nDiff to review:\n${diff.slice(0, 8000)}`,
        },
      ];

      const raw = await this.ai.run(model, { messages });

      if (raw instanceof ReadableStream) {
        return { score: 0, passed: false, reason: 'LLM evaluator error: unexpected stream response' };
      }

      const responseText = raw.response;

      let parsed: { score: unknown; passed: unknown; reason: unknown; issues?: unknown };
      try {
        parsed = JSON.parse(responseText ?? '') as {
          score: unknown;
          passed: unknown;
          reason: unknown;
          issues?: unknown;
        };
      } catch {
        const fallbackScore = responseText?.includes('LGTM') ? 0.8 : 0.3;
        return {
          score: fallbackScore,
          passed: false,
          reason: responseText?.slice(0, 200) ?? 'No response',
        };
      }

      if (
        typeof parsed.score !== 'number' ||
        typeof parsed.passed !== 'boolean' ||
        typeof parsed.reason !== 'string'
      ) {
        const fallbackScore = responseText?.includes('LGTM') ? 0.8 : 0.3;
        return {
          score: fallbackScore,
          passed: false,
          reason: responseText?.slice(0, 200) ?? 'No response',
        };
      }

      const score = Math.min(1, Math.max(0, parsed.score));
      const passed = score >= threshold;
      const issues =
        Array.isArray(parsed.issues) && parsed.issues.every((i) => typeof i === 'string')
          ? (parsed.issues as string[])
          : undefined;

      return {
        score,
        passed,
        reason: parsed.reason,
        ...(issues !== undefined ? { issues } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { score: 0, passed: false, reason: `LLM evaluator error: ${message}` };
    }
  }
}
