import { describe, expect, it, vi } from 'vitest';
import { LLMEvaluator } from '../src/evaluation/llm-evaluator';
import type { AiBinding } from '../src/types';
import type { EvalPolicy } from '../src/evaluation/types';

function makeMockAi(response: string): AiBinding {
  return {
    run: vi.fn().mockResolvedValue({ response }),
  };
}

function makePolicy(overrides: Partial<EvalPolicy> = {}): EvalPolicy {
  return {
    evaluators: [{ type: 'llm' }],
    ...overrides,
  };
}

describe('LLMEvaluator — valid JSON responses', () => {
  it('score 0.9 with threshold 0.7 → passed: true', async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: 'Looks good', issues: [] }));
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(0.9);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('Looks good');
  });

  it('score 0.5 with default threshold 0.7 → passed: false', async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.5, passed: true, reason: 'Mediocre', issues: [] }));
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it('score 0.5 with explicit threshold 0.4 → passed: true', async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.5, passed: true, reason: 'OK', issues: [] }));
    const evaluator = new LLMEvaluator(ai);
    const policy = makePolicy({ evaluators: [{ type: 'llm', threshold: 0.4 }] });
    const result = await evaluator.evaluate('diff content', policy);
    expect(result.passed).toBe(true);
  });
});

describe('LLMEvaluator — non-JSON fallback', () => {
  it('AI returns non-JSON text → fallback logic applies, no throw', async () => {
    const ai = makeMockAi('This diff looks fine overall.');
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(0.3);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('This diff looks fine overall.');
  });

  it('"LGTM" in non-JSON response → fallback score 0.8', async () => {
    const ai = makeMockAi('LGTM, no issues found.');
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(0.8);
    expect(result.passed).toBe(false);
  });
});

describe('LLMEvaluator — error handling', () => {
  it('AI run() throws → returns failed EvalResult without rethrowing', async () => {
    const ai: AiBinding = {
      run: vi.fn().mockRejectedValue(new Error('network failure')),
    };
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('LLM evaluator error');
    expect(result.reason).toContain('network failure');
  });
});

describe('LLMEvaluator — score clamping', () => {
  it('score above 1 is clamped to 1', async () => {
    const ai = makeMockAi(JSON.stringify({ score: 1.5, passed: true, reason: 'Great' }));
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(1);
  });

  it('score below 0 is clamped to 0', async () => {
    const ai = makeMockAi(JSON.stringify({ score: -0.2, passed: false, reason: 'Terrible' }));
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});

describe('LLMEvaluator — issues array', () => {
  it('issues array included in result when present in JSON', async () => {
    const issues = ['Missing tests', 'Hardcoded secret'];
    const ai = makeMockAi(JSON.stringify({ score: 0.4, passed: false, reason: 'Problems found', issues }));
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.issues).toEqual(issues);
  });

  it('issues omitted from result when not present in JSON', async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: 'Clean' }));
    const evaluator = new LLMEvaluator(ai);
    const result = await evaluator.evaluate('diff content', makePolicy());
    expect(result.issues).toBeUndefined();
  });
});

describe('LLMEvaluator — diff truncation', () => {
  it('diff longer than 8000 chars is truncated before being sent to AI', async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: 'OK' }));
    const evaluator = new LLMEvaluator(ai);
    const longDiff = 'a'.repeat(10000);
    await evaluator.evaluate(longDiff, makePolicy());

    const runMock = ai.run as ReturnType<typeof vi.fn>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const calledMessages = (runMock.mock.calls[0] as [string, { messages: Array<{ role: string; content: string }> }])[1].messages;
    const userMessage = calledMessages.find((m) => m.role === 'user');
    if (!userMessage) throw new Error('user message not found');
    const parts = userMessage.content.split('Diff to review:\n');
    const diffPortion = parts[1] ?? '';
    expect(diffPortion.length).toBeLessThanOrEqual(8000);
  });
});
