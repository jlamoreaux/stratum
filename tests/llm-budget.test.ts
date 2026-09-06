import { describe, expect, it, vi } from "vitest";
import { llmBudgetForProject } from "../src/evaluation/llm-budget";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import type { EvalPolicy } from "../src/evaluation/types";
import type { AiBinding, Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const VERDICT = JSON.stringify({ score: 1, passed: true, reason: "Fine", issues: [] });

function makeAi(): AiBinding {
  return { run: vi.fn().mockResolvedValue({ response: VERDICT }) };
}

/** A KV stand-in that records what the counter did. */
function makeState(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
  };
}

function makeEnv(vars: Partial<Env>, state?: ReturnType<typeof makeState>): Env {
  return { STATE: (state ?? makeState()).kv, ...vars } as unknown as Env;
}

const policy = (overrides: Record<string, unknown> = {}): EvalPolicy => ({
  evaluators: [{ type: "llm", ...overrides }],
});

describe("llmBudgetForProject", () => {
  it("is unrestricted when the deployment sets neither limit", () => {
    // The self-host default: the account being billed is the account running
    // the projects, so there is nothing to defend against.
    const budget = llmBudgetForProject(makeEnv({}), "proj", mockLogger);
    expect(budget.allowedModels).toEqual([]);
    expect(budget.reserve).toBeUndefined();
  });

  it("parses a comma-separated allowlist, ignoring blanks and padding", () => {
    const budget = llmBudgetForProject(
      makeEnv({ LLM_MODEL_ALLOWLIST: " @cf/a , ,@cf/b " }),
      "proj",
      mockLogger,
    );
    expect(budget.allowedModels).toEqual(["@cf/a", "@cf/b"]);
  });

  it.each(["0", "-5", "not-a-number"])("treats a cap of %s as no cap", (raw) => {
    // A cap that blocks every call is a thing to express by removing the AI
    // binding, not by a limit that silently blocks every merge.
    const budget = llmBudgetForProject(
      makeEnv({ LLM_EVALS_PER_PROJECT_PER_DAY: raw }),
      "proj",
      mockLogger,
    );
    expect(budget.reserve).toBeUndefined();
  });

  it("counts per project per day and refuses once the cap is spent", async () => {
    const state = makeState();
    const env = makeEnv({ LLM_EVALS_PER_PROJECT_PER_DAY: "2" }, state);
    const budget = llmBudgetForProject(env, "proj", mockLogger);

    expect(await budget.reserve?.()).toEqual({ allowed: true, limit: 2, used: 1 });
    expect(await budget.reserve?.()).toEqual({ allowed: true, limit: 2, used: 2 });
    expect(await budget.reserve?.()).toEqual({ allowed: false, limit: 2, used: 2 });

    const [key] = [...state.store.keys()];
    expect(key).toMatch(/^llmquota:proj:\d+$/);
  });

  it("keeps a separate allowance per project", async () => {
    const state = makeState();
    const env = makeEnv({ LLM_EVALS_PER_PROJECT_PER_DAY: "1" }, state);

    expect(await llmBudgetForProject(env, "a", mockLogger).reserve?.()).toMatchObject({
      allowed: true,
    });
    expect(await llmBudgetForProject(env, "b", mockLogger).reserve?.()).toMatchObject({
      allowed: true,
    });
    expect(await llmBudgetForProject(env, "a", mockLogger).reserve?.()).toMatchObject({
      allowed: false,
    });
  });

  it("refuses the call when the counter cannot be read", async () => {
    // An unreadable counter must not hand out an unmetered call: the operator,
    // not the caller, is billed for whatever happens next.
    const state = makeState();
    state.kv.get.mockRejectedValueOnce(new Error("KV down"));
    const budget = llmBudgetForProject(
      makeEnv({ LLM_EVALS_PER_PROJECT_PER_DAY: "10" }, state),
      "proj",
      mockLogger,
    );

    expect(await budget.reserve?.()).toMatchObject({ allowed: false });
  });
});

describe("LLMEvaluator — deployment limits", () => {
  it("refuses a model outside the allowlist without calling the binding", async () => {
    const ai = makeAi();
    const evaluator = new LLMEvaluator(ai, { allowedModels: ["@cf/cheap"] });

    const result = await evaluator.evaluate("diff", policy({ model: "@cf/expensive" }), mockLogger);

    expect(ai.run).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("@cf/expensive");
      expect(result.data.reason).toContain("@cf/cheap");
    }
  });

  it("does not spend a unit of the allowance on a disallowed model", async () => {
    // Otherwise a typo in `model` burns the project's day before anyone reads
    // the reason.
    const reserve = vi.fn();
    const evaluator = new LLMEvaluator(makeAi(), { allowedModels: ["@cf/cheap"], reserve });

    await evaluator.evaluate("diff", policy({ model: "@cf/expensive" }), mockLogger);

    expect(reserve).not.toHaveBeenCalled();
  });

  it("allows the default model when the allowlist names it", async () => {
    const ai = makeAi();
    const evaluator = new LLMEvaluator(ai, {
      allowedModels: ["@cf/meta/llama-3.1-8b-instruct"],
    });

    const result = await evaluator.evaluate("diff", policy(), mockLogger);

    expect(ai.run).toHaveBeenCalled();
    expect(result.success && result.data.passed).toBe(true);
  });

  it("fails closed rather than skipping when the allowance is spent", async () => {
    // Skipping would make exhausting the quota a way to switch this gate off
    // and merge unreviewed — a cost control that becomes a bypass.
    const ai = makeAi();
    const evaluator = new LLMEvaluator(ai, {
      allowedModels: [],
      reserve: async () => ({ allowed: false, limit: 200, used: 200 }),
    });

    const result = await evaluator.evaluate("diff", policy(), mockLogger);

    expect(ai.run).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("200");
    }
  });

  it("is unrestricted when constructed without a budget", async () => {
    const ai = makeAi();
    const evaluator = new LLMEvaluator(ai);

    const result = await evaluator.evaluate("diff", policy({ model: "@cf/anything" }), mockLogger);

    expect(ai.run).toHaveBeenCalledWith("@cf/anything", expect.anything());
    expect(result.success && result.data.passed).toBe(true);
  });
});
