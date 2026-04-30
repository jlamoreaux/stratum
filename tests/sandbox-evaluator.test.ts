import { describe, expect, it, vi } from "vitest";
import { SandboxEvaluator } from "../src/evaluation/sandbox-evaluator";
import type { EvalPolicy } from "../src/evaluation/types";
import type { SandboxBinding, SandboxInstance } from "../src/types";

function makeMockSandbox(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createThrows?: boolean;
  runThrows?: boolean;
}): SandboxBinding {
  const instance: SandboxInstance = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    run: opts.runThrows
      ? vi.fn().mockRejectedValue(new Error("Timeout"))
      : vi.fn().mockResolvedValue({
          exitCode: opts.exitCode ?? 0,
          stdout: opts.stdout ?? "",
          stderr: opts.stderr ?? "",
        }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  return {
    create: opts.createThrows
      ? vi.fn().mockRejectedValue(new Error("Sandbox unavailable"))
      : vi.fn().mockResolvedValue(instance),
  };
}

function makePolicy(overrides: Partial<EvalPolicy> = {}): EvalPolicy {
  return {
    evaluators: [{ type: "sandbox" }],
    minScore: 0.7,
    ...overrides,
  };
}

function makeDiff(files: Array<{ path: string; content: string }> = []): string {
  return files
    .map(({ path, content }) => {
      const addedLines = content
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n");
      return [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -0,0 +1 @@",
        addedLines,
      ].join("\n");
    })
    .join("\n");
}

describe("SandboxEvaluator — exit code behaviour", () => {
  it("exit code 0 → score 1.0, passed: true", async () => {
    const binding = makeMockSandbox({ exitCode: 0, stdout: "ok" });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("exit code 1 with no parseable output → score 0.0, passed: false", async () => {
    const binding = makeMockSandbox({ exitCode: 1, stdout: "something broke" });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });
});

describe("SandboxEvaluator — test output parsing", () => {
  it('"5 passed, 0 failed" → score 1.0', async () => {
    const binding = makeMockSandbox({ exitCode: 0, stdout: "5 passed, 0 failed" });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(1.0);
  });

  it('"3 passed, 2 failed" → score 0.6, passed: false (minScore 0.7)', async () => {
    const binding = makeMockSandbox({ exitCode: 1, stdout: "3 passed, 2 failed" });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy({ minScore: 0.7 }));
    expect(result.score).toBeCloseTo(0.6);
    expect(result.passed).toBe(false);
  });

  it('"0 passed, 5 failed" → score 0.0', async () => {
    const binding = makeMockSandbox({ exitCode: 1, stdout: "0 passed, 5 failed" });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('"5 passed, 1 failed" → score ~0.833, passed: true (minScore 0.7)', async () => {
    const binding = makeMockSandbox({ exitCode: 1, stdout: "5 passed, 1 failed" });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy({ minScore: 0.7 }));
    expect(result.score).toBeCloseTo(5 / 6);
    expect(result.passed).toBe(true);
  });

  it("exit code 0 with no parseable output → score 1.0", async () => {
    const binding = makeMockSandbox({ exitCode: 0, stdout: "All done." });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(1.0);
  });
});

describe("SandboxEvaluator — error handling", () => {
  it("sandbox.create() throws → returns failed EvalResult without rethrowing", async () => {
    const binding = makeMockSandbox({ createThrows: true });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Sandbox error");
    expect(result.reason).toContain("Sandbox unavailable");
  });

  it("run() throws (timeout) → returns failed EvalResult without rethrowing", async () => {
    const binding = makeMockSandbox({ runThrows: true });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Sandbox error");
    expect(result.reason).toContain("Timeout");
  });
});

describe("SandboxEvaluator — file writing", () => {
  it("writes files parsed from diff to sandbox via writeFile", async () => {
    const binding = makeMockSandbox({ exitCode: 0 });
    const instance = await (binding.create as ReturnType<typeof vi.fn>)();
    (binding.create as ReturnType<typeof vi.fn>).mockResolvedValue(instance);

    const diff = makeDiff([
      { path: "src/foo.ts", content: "export const x = 1;" },
      { path: "src/bar.ts", content: "export const y = 2;" },
    ]);

    const evaluator = new SandboxEvaluator(binding);
    await evaluator.evaluate(diff, makePolicy());

    expect(instance.writeFile).toHaveBeenCalledWith("src/foo.ts", expect.any(String));
    expect(instance.writeFile).toHaveBeenCalledWith("src/bar.ts", expect.any(String));
  });
});

describe("SandboxEvaluator — destroy lifecycle", () => {
  it("destroy() is called after successful run", async () => {
    const binding = makeMockSandbox({ exitCode: 0 });
    const instance = await (binding.create as ReturnType<typeof vi.fn>)();
    (binding.create as ReturnType<typeof vi.fn>).mockResolvedValue(instance);

    const evaluator = new SandboxEvaluator(binding);
    await evaluator.evaluate("", makePolicy());

    expect(instance.destroy).toHaveBeenCalledOnce();
  });

  it("destroy() is called even when run() throws", async () => {
    const destroyFn = vi.fn().mockResolvedValue(undefined);
    const instance: SandboxInstance = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockRejectedValue(new Error("Timeout")),
      destroy: destroyFn,
    };
    const binding: SandboxBinding = {
      create: vi.fn().mockResolvedValue(instance),
    };

    const evaluator = new SandboxEvaluator(binding);
    await evaluator.evaluate("", makePolicy());

    expect(destroyFn).toHaveBeenCalledOnce();
  });
});

describe("SandboxEvaluator — feature flag / no-op", () => {
  it("returns passed: true, score: 1.0 when no sandbox evaluator in policy", async () => {
    const binding = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding);
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff" }],
      minScore: 0.7,
    };
    const result = await evaluator.evaluate("", policy);
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
    expect(binding.create).not.toHaveBeenCalled();
  });
});

describe("SandboxEvaluator — reason field", () => {
  it("reason is first 500 chars of stdout + stderr combined", async () => {
    const longOutput = "x".repeat(600);
    const binding = makeMockSandbox({ exitCode: 0, stdout: longOutput });
    const evaluator = new SandboxEvaluator(binding);
    const result = await evaluator.evaluate("", makePolicy());
    expect(result.reason.length).toBeLessThanOrEqual(500);
  });
});
