import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLlmProvider } from "../src/evaluation/llm-byok";
import { AnthropicProvider, OpenAiCompatibleProvider } from "../src/evaluation/llm-provider";
import {
  blockedHostReason,
  llmProviderCatalog,
  parseLlmProviders,
  providerSecretName,
  resetLlmProviderCache,
} from "../src/evaluation/llm-providers";
import { parsePolicyContent, sanitizeLlmConfig } from "../src/evaluation/policy-loader";
import { sanitizePolicy } from "../src/evaluation/sanitize-policy";
import type { EvalPolicy } from "../src/evaluation/types";
import { llmProvidersConfigError } from "../src/middleware/config-guard";
import { buildEvaluators, runEvaluation } from "../src/services/change-flow";
import { putSecret } from "../src/storage/project-secrets";
import type { AiBinding, Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

/**
 * Task 7 — BYOK configuration, credentials, and the threat controls.
 *
 * The threat model these test (PRD §7): the reachable attacker is a project
 * OWNER using the operator's Worker as an SSRF/exfiltration proxy, or a writer
 * whose policy edit lands at merge. Policy is loaded from the DEFAULT BRANCH, so
 * a proposed edit never governs its own evaluation — which is why the assertions
 * below are about what a *merged* policy can reach, not about live escalation.
 */

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

/** The one entry every test's operator config uses unless it is the thing under test. */
const ANTHROPIC_ENTRY = {
  name: "anthropic",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
};

const PROVIDERS_JSON = JSON.stringify([ANTHROPIC_ENTRY]);

function catalogFrom(json: string | undefined) {
  resetLlmProviderCache();
  return llmProviderCatalog({ LLM_PROVIDERS: json }, logger);
}

function project(id = "proj_byok"): ProjectEntry {
  return {
    id,
    name: "repo",
    slug: "repo",
    namespace: "@alice",
    ownerId: "user_alice",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetLlmProviderCache();
});

// ---------------------------------------------------------------------------
// 7.1 — LLM_PROVIDERS is parsed and validated once, at parse time
// ---------------------------------------------------------------------------

describe("parseLlmProviders — the allowlist is the only place an endpoint is named", () => {
  it("treats unset and blank as 'Workers AI only' rather than an error", () => {
    for (const raw of [undefined, "", "   "]) {
      const parse = parseLlmProviders(raw);
      expect(parse.status).toBe("ok");
      if (parse.status !== "ok") return;
      expect(parse.providers.size).toBe(0);
    }
  });

  it("parses a well-formed entry into a name-keyed catalog", () => {
    const parse = parseLlmProviders(PROVIDERS_JSON);
    expect(parse.status).toBe("ok");
    if (parse.status !== "ok") return;
    expect(parse.providers.get("anthropic")).toEqual({
      name: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("rejects a non-https baseUrl", () => {
    const parse = parseLlmProviders(
      JSON.stringify([{ ...ANTHROPIC_ENTRY, baseUrl: "http://api.anthropic.com" }]),
    );
    expect(parse.status).toBe("invalid");
    if (parse.status !== "invalid") return;
    expect(parse.reason).toContain("must use https");
  });

  // The whole point of the allowlist: an operator (or a compromised config) must
  // not be able to point the evaluator at something only this Worker can reach.
  it.each([
    ["https://localhost/v1", "loopback"],
    ["https://sub.localhost/v1", "loopback"],
    ["https://127.0.0.1/v1", "127.0.0.0/8"],
    ["https://127.9.9.9/v1", "127.0.0.0/8"],
    // The URL parser normalizes these to 127.0.0.1 before the check sees them.
    ["https://2130706433/v1", "127.0.0.0/8"],
    ["https://0x7f.0.0.1/v1", "127.0.0.0/8"],
    ["https://[::1]/v1", "loopback"],
    ["https://0.0.0.0/v1", "0.0.0.0/8"],
    // The cloud metadata endpoint — the single most valuable SSRF target there is.
    ["https://169.254.169.254/latest", "169.254.0.0/16"],
    ["https://10.1.2.3/v1", "10.0.0.0/8"],
    ["https://172.16.0.1/v1", "172.16.0.0/12"],
    ["https://172.31.255.254/v1", "172.16.0.0/12"],
    ["https://192.168.1.1/v1", "192.168.0.0/16"],
    ["https://[fe80::1]/v1", "link-local"],
    ["https://[fd00::1]/v1", "unique-local"],
    ["https://[::ffff:127.0.0.1]/v1", "IPv4-mapped"],
  ])("rejects %s at parse time", (baseUrl, expected) => {
    const parse = parseLlmProviders(JSON.stringify([{ ...ANTHROPIC_ENTRY, baseUrl }]));
    expect(parse.status, `${baseUrl} was accepted`).toBe("invalid");
    if (parse.status !== "invalid") return;
    expect(parse.reason).toContain(expected);
  });

  it("does not over-reject public addresses that merely look private", () => {
    // 172.32/16 is outside the 172.16/12 block, and 10.x only matches the first
    // octet — a check written as a string prefix would fail both of these.
    for (const baseUrl of ["https://172.32.0.1/v1", "https://110.0.0.1/v1"]) {
      expect(blockedHostReason(new URL(baseUrl).hostname)).toBeNull();
    }
  });

  it("rejects credentials embedded in the URL", () => {
    const parse = parseLlmProviders(
      JSON.stringify([{ ...ANTHROPIC_ENTRY, baseUrl: "https://user:pass@api.anthropic.com" }]),
    );
    expect(parse.status).toBe("invalid");
    if (parse.status !== "invalid") return;
    expect(parse.reason).toContain("must not embed credentials");
  });

  it.each([
    [[{ ...ANTHROPIC_ENTRY, baseURL: "https://x.example" }], "unrecognized field"],
    [[{ ...ANTHROPIC_ENTRY, kind: "ollama" }], '"kind" must be one of'],
    [[{ ...ANTHROPIC_ENTRY, name: "Anthropic" }], '"name" must match'],
    [[ANTHROPIC_ENTRY, { ...ANTHROPIC_ENTRY }], "duplicate provider name"],
    [[{ kind: "anthropic", name: "x" }], '"baseUrl" is required'],
    [["anthropic"], "must be an object"],
  ])("rejects a structurally wrong entry (%#)", (entries, expected) => {
    const parse = parseLlmProviders(JSON.stringify(entries));
    expect(parse.status).toBe("invalid");
    if (parse.status !== "invalid") return;
    expect(parse.reason).toContain(expected);
  });

  it("rejects a non-array and unparseable JSON", () => {
    expect(parseLlmProviders('{"name":"x"}').status).toBe("invalid");
    expect(parseLlmProviders("not json").status).toBe("invalid");
  });

  it("fails loudly rather than silently disabling BYOK", () => {
    // Loud is three things at once: the parse says why, the config guard
    // surfaces it on the first request after the deploy, and the catalog is
    // empty so every policy naming a provider blocks instead of quietly
    // running on the operator's Workers AI bill.
    const bad = '[{"name":"anthropic","kind":"anthropic","baseURL":"https://api.anthropic.com"}]';

    expect(llmProvidersConfigError({ LLM_PROVIDERS: bad })).toContain("unrecognized field");
    expect(llmProvidersConfigError({ LLM_PROVIDERS: PROVIDERS_JSON })).toBeNull();
    expect(llmProvidersConfigError({})).toBeNull();

    expect(catalogFrom(bad).size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      "LLM_PROVIDERS is invalid; BYOK providers are unavailable",
      undefined,
      expect.objectContaining({ reason: expect.stringContaining("unrecognized field") }),
    );
  });

  it("derives a secret name that satisfies SECRET_NAME_PATTERN", () => {
    expect(providerSecretName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerSecretName("my-gateway")).toBe("MY_GATEWAY_API_KEY");
    // The 32-char maximum a provider name may reach, plus the suffix, still
    // fits the 64-char store limit.
    const longest = `a${"b".repeat(31)}`;
    expect(/^[A-Z][A-Z0-9_]{0,63}$/.test(providerSecretName(longest))).toBe(true);
  });

  it("memoizes the parse per isolate but re-parses when the value changes", () => {
    resetLlmProviderCache();
    const first = llmProviderCatalog({ LLM_PROVIDERS: PROVIDERS_JSON }, logger);
    const second = llmProviderCatalog({ LLM_PROVIDERS: PROVIDERS_JSON }, logger);
    expect(second).toBe(first);
    const other = llmProviderCatalog(
      { LLM_PROVIDERS: JSON.stringify([{ ...ANTHROPIC_ENTRY, name: "other" }]) },
      logger,
    );
    expect(other.has("other")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7.2 — sanitizeLlmConfig: a whitelist, and a name the operator configured
// ---------------------------------------------------------------------------

describe("sanitizeLlmConfig — the policy may select a provider, never describe one", () => {
  const providers = () => {
    const parse = parseLlmProviders(PROVIDERS_JSON);
    if (parse.status !== "ok") throw new Error("fixture");
    return parse.providers;
  };

  function parsePolicy(policy: unknown, json = PROVIDERS_JSON) {
    return parsePolicyContent(JSON.stringify(policy), "json", logger, catalogFrom(json));
  }

  it("keeps a provider the operator configured", () => {
    const parsed = parsePolicy({ evaluators: [{ type: "llm", provider: "anthropic" }] });
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.policy.evaluators[0]).toEqual({ type: "llm", provider: "anthropic" });
    expect(parsed.policy.configError).toBeUndefined();
  });

  it("fails the whole policy CLOSED on a provider name the operator has not configured", () => {
    // The evaluator-side convention (`policy-loader.ts`'s dropped-entry check),
    // deliberately opposite to a rejected `deploys:` entry: an unresolvable
    // provider means the gate cannot run, and a gate that cannot run must not
    // pass.
    const parsed = parsePolicy({ evaluators: [{ type: "llm", provider: "evil-corp" }] });
    expect(parsed.status).toBe("malformed");
    if (parsed.status !== "malformed") return;
    expect(parsed.reason).toContain("unusable entr");
  });

  it("blocks merges rather than degrading to Workers AI", () => {
    // What "fails closed" has to mean end to end: the loaded policy carries a
    // configError, which the merge gate treats as blocking. A policy that
    // silently dropped the entry would let the change through on its remaining
    // evaluators.
    const parsed = parsePolicy({
      evaluators: [{ type: "llm", provider: "evil-corp" }, { type: "diff" }],
    });
    expect(parsed.status).toBe("malformed");
  });

  it("fails closed when NO providers are configured at all", () => {
    // Not a special case, and it must not be: an operator who never set
    // LLM_PROVIDERS has an empty catalog, which resolves no name.
    const parsed = parsePolicyContent(
      JSON.stringify({ evaluators: [{ type: "llm", provider: "anthropic" }] }),
      "json",
      logger,
      catalogFrom(undefined),
    );
    expect(parsed.status).toBe("malformed");
  });

  it("ignores a policy-supplied baseUrl entirely", () => {
    // The SSRF control. The field is not validated, not sanitized and not
    // preferred-over — it does not exist on the way through.
    const config = sanitizeLlmConfig(
      {
        type: "llm",
        provider: "anthropic",
        baseUrl: "https://evil.example.com",
        base_url: "https://evil.example.com",
        endpoint: "https://evil.example.com",
      },
      logger,
      providers(),
    );
    expect(config).toEqual({ type: "llm", provider: "anthropic" });
    expect(JSON.stringify(config)).not.toContain("evil.example.com");
  });

  it("drops an inline credential a policy tried to smuggle in", () => {
    const config = sanitizeLlmConfig(
      { type: "llm", provider: "anthropic", apiKey: "sk-ant-inline", secret: "s" },
      logger,
      providers(),
    );
    expect(JSON.stringify(config)).not.toContain("sk-ant-inline");
  });

  it("fails closed on a non-string provider", () => {
    expect(sanitizeLlmConfig({ type: "llm", provider: 7 }, logger, providers())).toBeNull();
    expect(sanitizeLlmConfig({ type: "llm", provider: {} }, logger, providers())).toBeNull();
  });

  it("keeps the three non-provider fields and clamps the threshold", () => {
    const config = sanitizeLlmConfig(
      { type: "llm", model: "claude-sonnet-4-5", threshold: 0.9, maxDiffChars: 2000 },
      logger,
      providers(),
    );
    expect(config).toEqual({
      type: "llm",
      model: "claude-sonnet-4-5",
      threshold: 0.9,
      maxDiffChars: 2000,
    });

    // A negative threshold would make every model verdict pass — the gate
    // disabled by a single character, which is why this clamps rather than
    // being copied through as it used to be.
    const hostile = sanitizeLlmConfig({ type: "llm", threshold: -5 }, logger, providers());
    expect(hostile?.threshold).toBe(0);
  });

  it("fails closed on a model that is not a usable identifier", () => {
    for (const model of [42, "", "a".repeat(129), "model\nInjected: header"]) {
      expect(sanitizeLlmConfig({ type: "llm", model }, logger, providers())).toBeNull();
    }
  });

  it("keeps the deploy asymmetry intact: a bad deploy entry does NOT block merges", () => {
    // The two conventions sit two files apart and look contradictory. This
    // pins both at once so neither is "fixed" into the other.
    const parsed = parsePolicy({
      evaluators: [{ type: "diff" }],
      deploys: [{ name: "NOT A SLUG", target: "vercel" }],
    });
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.policy.configError).toBeUndefined();
    expect(parsed.policy.deployRejections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7.3 / 7.4 — the credential, and failing closed on every way of not having it
// ---------------------------------------------------------------------------

describe("resolveLlmProvider — the credential path", () => {
  const KEY = "test-deploy-secret-key-0123456789";

  function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
    return {
      DB: db,
      DEPLOY_SECRET_KEY: KEY,
      LLM_PROVIDERS: PROVIDERS_JSON,
      ...overrides,
    } as unknown as Env;
  }

  async function withStoredKey(value = "sk-ant-real-credential", masterKey = KEY) {
    const { db } = makeSqliteD1();
    const stored = await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY: masterKey },
      { projectId: project().id, name: "ANTHROPIC_API_KEY", value, actorId: "user_alice" },
    );
    expect(stored.success).toBe(true);
    return db;
  }

  const byokPolicy: EvalPolicy = { evaluators: [{ type: "llm", provider: "anthropic" }] };

  it("skips the secret load entirely when the policy names no provider", async () => {
    // The skip is the performance requirement, so it is asserted the only way
    // that cannot be faked: a database that throws on any use at all. This is
    // the overwhelmingly common case — every project that never opted in.
    const env = makeEnv(makeThrowingD1("D1 must not be touched"));
    const selection = await resolveLlmProvider(
      env,
      project(),
      { evaluators: [{ type: "llm" }, { type: "diff" }] },
      logger,
    );
    expect(selection.status).toBe("platform");
  });

  it("builds the provider matching the configured kind", async () => {
    const db = await withStoredKey();
    const anthropic = await resolveLlmProvider(makeEnv(db), project(), byokPolicy, logger);
    expect(anthropic.status).toBe("byok");
    if (anthropic.status !== "byok") return;
    expect(anthropic.provider).toBeInstanceOf(AnthropicProvider);

    const openAiEnv = makeEnv(db, {
      LLM_PROVIDERS: JSON.stringify([
        { name: "anthropic", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
      ]),
    });
    resetLlmProviderCache();
    const openai = await resolveLlmProvider(openAiEnv, project(), byokPolicy, logger);
    expect(openai.status).toBe("byok");
    if (openai.status !== "byok") return;
    expect(openai.provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it("derives the PBKDF2 key once per isolate across evaluations", async () => {
    // 100k iterations, now on the change-creation path, which already does two
    // clones and a diff. Three operations against the same master key — the
    // write, then two evaluations — must pay for it exactly once. A master key
    // no earlier test used, so the isolate's cache starts cold for it.
    const coldKey = "a-master-key-this-test-alone-uses";
    const deriveKey = vi.spyOn(crypto.subtle, "deriveKey");

    const db = await withStoredKey("sk-ant-real-credential", coldKey);
    const env = makeEnv(db, { DEPLOY_SECRET_KEY: coldKey });
    expect((await resolveLlmProvider(env, project(), byokPolicy, logger)).status).toBe("byok");
    expect((await resolveLlmProvider(env, project(), byokPolicy, logger)).status).toBe("byok");

    expect(deriveKey).toHaveBeenCalledTimes(1);
  });

  it("fails closed with a distinct reason for each of the three secret outcomes", async () => {
    const stored = await withStoredKey();
    const empty = makeSqliteD1().db;

    const noMasterKey = await resolveLlmProvider(
      makeEnv(stored, { DEPLOY_SECRET_KEY: undefined }),
      project(),
      byokPolicy,
      logger,
    );
    const missing = await resolveLlmProvider(makeEnv(empty), project(), byokPolicy, logger);
    // A row that exists but authenticates under a different master key: exactly
    // what a DEPLOY_SECRET_KEY rotation leaves behind.
    const rotated = await resolveLlmProvider(
      makeEnv(stored, { DEPLOY_SECRET_KEY: "a-different-master-key-9876543210" }),
      project(),
      byokPolicy,
      logger,
    );

    const reasons = [noMasterKey, missing, rotated].map((selection) => {
      expect(selection.status).toBe("unavailable");
      return selection.status === "unavailable" ? selection.reason : "";
    });

    expect(reasons[0]).toContain("DEPLOY_SECRET_KEY");
    expect(reasons[1]).toContain("is not set for this project");
    expect(reasons[2]).toContain("could not be decrypted");
    expect(new Set(reasons).size).toBe(3);
    // Each reason names the secret so an operator knows what to re-enter.
    for (const reason of reasons) expect(reason).toContain("ANTHROPIC_API_KEY");
  });

  it("fails closed when the database itself is unavailable", async () => {
    const selection = await resolveLlmProvider(
      makeEnv(makeThrowingD1()),
      project(),
      byokPolicy,
      logger,
    );
    expect(selection.status).toBe("unavailable");
  });

  it("refuses a provider name that is no longer in the allowlist", async () => {
    // Reachable through the KV-cached policy: the operator removed the entry
    // after the policy was parsed. The fallback is a refusal, never Workers AI.
    const db = await withStoredKey();
    const selection = await resolveLlmProvider(
      makeEnv(db, { LLM_PROVIDERS: undefined }),
      project(),
      byokPolicy,
      logger,
    );
    expect(selection.status).toBe("unavailable");
    if (selection.status !== "unavailable") return;
    expect(selection.reason).toContain("not configured in LLM_PROVIDERS");
  });

  it("never leaks the stored credential into the reason it returns", async () => {
    const db = await withStoredKey("sk-ant-super-secret");
    const selection = await resolveLlmProvider(
      makeEnv(db, { DEPLOY_SECRET_KEY: "rotated-master-key-aaaaaaaaaaaaaaa" }),
      project(),
      byokPolicy,
      logger,
    );
    if (selection.status !== "unavailable") throw new Error("expected unavailable");
    expect(selection.reason).not.toContain("sk-ant");
  });
});

// ---------------------------------------------------------------------------
// 7.4 — the wiring: a credential failure NEVER reaches env.AI
// ---------------------------------------------------------------------------

describe("buildEvaluators — BYOK never falls back to the operator's Workers AI", () => {
  const KEY = "test-deploy-secret-key-0123456789";
  const byokPolicy: EvalPolicy = { evaluators: [{ type: "llm", provider: "anthropic" }] };

  function envWith(db: D1Database, ai: AiBinding, overrides: Partial<Env> = {}): Env {
    return {
      DB: db,
      AI: ai,
      DEPLOY_SECRET_KEY: KEY,
      LLM_PROVIDERS: PROVIDERS_JSON,
      ...overrides,
    } as unknown as Env;
  }

  /** Runs only the `llm` evaluator, since that is the one BYOK changes.
   * Cost samples ride on the eval RUN — `aggregate` does not carry them. */
  async function evaluateWith(env: Env, policy: EvalPolicy = byokPolicy) {
    const built = await buildEvaluators(env, policy, project(), logger);
    const llm = built.find((entry) => entry.type === "llm");
    expect(llm).toBeDefined();
    if (!llm) throw new Error("no llm evaluator");
    const { evalRuns, evalResult } = await runEvaluation(
      [llm],
      "diff --git a/x b/x",
      policy,
      logger,
    );
    return { evalResult, costs: evalRuns[0]?.result.costs };
  }

  it.each([
    ["the secret is missing", {} as Partial<Env>],
    ["DEPLOY_SECRET_KEY is unset", { DEPLOY_SECRET_KEY: undefined }],
    ["the allowlist no longer has the provider", { LLM_PROVIDERS: undefined }],
  ])("fails the gate closed and does not call env.AI when %s", async (_case, overrides) => {
    const ai: AiBinding = { run: vi.fn(async () => ({ response: "{}" })) } as unknown as AiBinding;
    const { db } = makeSqliteD1();
    resetLlmProviderCache();

    const { evalResult, costs } = await evaluateWith(envWith(db, ai, overrides));

    expect(evalResult.passed).toBe(false);
    expect(evalResult.score).toBe(0);
    expect(evalResult.reason).toContain("llm unavailable");
    // The whole point: the spend does not silently move back to the operator.
    expect(ai.run).not.toHaveBeenCalled();
    // …and nothing was billed to anyone, because nothing ran.
    expect(costs ?? []).toHaveLength(0);
  });

  it("marks the cost samples of a BYOK run as byok", async () => {
    // Tasks 2/3 built `source` and the entire allowance design depends on it: a
    // BYOK sample must not decrement the hosted allowance.
    const { db } = makeSqliteD1();
    const stored = await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY: KEY },
      {
        projectId: project().id,
        name: "ANTHROPIC_API_KEY",
        value: "sk-ant-real",
        actorId: "user_alice",
      },
    );
    expect(stored.success).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: '{"score":1,"passed":true,"reason":"ok"}' }],
            usage: { input_tokens: 900, output_tokens: 100 },
          }),
      })),
    );

    const ai: AiBinding = { run: vi.fn() } as unknown as AiBinding;
    const { evalResult, costs } = await evaluateWith(envWith(db, ai));

    expect(evalResult.passed).toBe(true);
    expect(costs).toEqual([{ kind: "llm_tokens", quantity: 1000, source: "byok" }]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("leaves a Workers AI run unmarked, because absent already means platform", async () => {
    const ai: AiBinding = {
      run: vi.fn(async () => ({ response: '{"score":1,"passed":true,"reason":"ok"}' })),
    } as unknown as AiBinding;
    const { db } = makeSqliteD1();

    const { costs } = await evaluateWith(envWith(db, ai), { evaluators: [{ type: "llm" }] });

    expect(ai.run).toHaveBeenCalled();
    expect(costs?.[0]).not.toHaveProperty("source");
    expect(costs?.[0]).toMatchObject({ kind: "llm_tokens", estimated: true });
  });

  it("keeps a provider error body — including an echoed API key — out of the result and the logs", async () => {
    // Some providers echo the credential that failed. `llm-provider.ts` returns
    // the status and never the body, and this is the assertion that keeps it
    // that way: the reason is user-visible (`LLMEvaluator` interpolates the
    // message into the EvalResult it fails closed with) and the logs are
    // operator-visible.
    const apiKey = "sk-ant-leaky-credential-value";
    const { db } = makeSqliteD1();
    await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY: KEY },
      { projectId: project().id, name: "ANTHROPIC_API_KEY", value: apiKey, actorId: "user_alice" },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({
            error: { message: `invalid x-api-key: ${apiKey}`, type: "authentication_error" },
          }),
      })),
    );

    const ai: AiBinding = { run: vi.fn() } as unknown as AiBinding;
    const { evalResult } = await evaluateWith(envWith(db, ai));

    expect(evalResult.passed).toBe(false);
    expect(evalResult.reason).toContain("401");
    expect(evalResult.reason).not.toContain(apiKey);
    expect(JSON.stringify(evalResult)).not.toContain(apiKey);

    const logged = JSON.stringify(
      (["trace", "debug", "info", "warn", "error", "fatal"] as const).flatMap(
        (level) => (logger[level] as unknown as { mock: { calls: unknown[] } }).mock.calls,
      ),
    );
    expect(logged).not.toContain(apiKey);
  });
});

// ---------------------------------------------------------------------------
// 7.5 — what is serialized into the prompt, and how big it is allowed to get
// ---------------------------------------------------------------------------

describe("sanitizePolicy — the strip list, and MAX_POLICY_CONTEXT_CHARS", () => {
  it("still strips the webhook secret it was written for", () => {
    const policy: EvalPolicy = {
      evaluators: [{ type: "webhook", url: "https://hook.test", secret: "shhh" }],
    };
    expect(JSON.stringify(sanitizePolicy(policy))).not.toContain("shhh");
    expect(sanitizePolicy(policy).evaluators[0]).toEqual({
      type: "webhook",
      url: "https://hook.test",
    });
  });

  it("strips the provider name and every credential-shaped field", () => {
    // `sanitizeEvaluator` copies an entry of an unmodelled type through whole,
    // so this is the only thing standing between such a field and the provider.
    const policy = {
      evaluators: [
        { type: "llm", provider: "anthropic", model: "claude-sonnet-4-5" },
        {
          type: "future_evaluator",
          apiKey: "sk-leak-1",
          api_key: "sk-leak-2",
          AUTHORIZATION: "Bearer sk-leak-3",
          token: "sk-leak-4",
          privateKey: "sk-leak-5",
          url: "https://kept.example",
        },
      ],
    } as unknown as EvalPolicy;

    const serialized = JSON.stringify(sanitizePolicy(policy));
    for (let i = 1; i <= 5; i++) expect(serialized).not.toContain(`sk-leak-${i}`);
    expect(serialized).not.toContain("anthropic");
    // Non-credential fields survive — the model still needs the policy.
    expect(serialized).toContain("claude-sonnet-4-5");
    expect(serialized).toContain("https://kept.example");
  });

  it("does not strip a field that merely contains a credential word", () => {
    const policy = {
      evaluators: [{ type: "diff", monkeys: 3, keystone: "kept" }],
    } as unknown as EvalPolicy;
    expect(JSON.stringify(sanitizePolicy(policy))).toContain("keystone");
  });

  it("makes opting into BYOK free against the 8000-char policy context", () => {
    // The interaction that would otherwise block merges on a project that works
    // today: the serialized policy shares the model's input budget and an
    // oversize one fails the gate CLOSED before any model call. Because
    // `provider` is stripped, adding it costs zero characters.
    const large: EvalPolicy = {
      evaluators: [{ type: "diff", forbiddenPatterns: [`${"x".repeat(7_500)}`] }, { type: "llm" }],
    };
    const withProvider: EvalPolicy = {
      evaluators: [
        { type: "diff", forbiddenPatterns: [`${"x".repeat(7_500)}`] },
        { type: "llm", provider: "anthropic" },
      ],
    };

    const before = JSON.stringify(sanitizePolicy(large)).length;
    const after = JSON.stringify(sanitizePolicy(withProvider)).length;
    expect(after).toBe(before);
    expect(after).toBeLessThan(8_000);
  });

  it("still fails the gate closed for a policy that is genuinely too large", async () => {
    const { LLMEvaluator } = await import("../src/evaluation/llm-evaluator");
    const ai = { run: vi.fn() };
    const { WorkersAiProvider } = await import("../src/evaluation/llm-provider");
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff", forbiddenPatterns: [`${"x".repeat(9_000)}`] }, { type: "llm" }],
    };

    const result = await new LLMEvaluator(
      new WorkersAiProvider(ai as unknown as AiBinding),
    ).evaluate("diff", policy, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.passed).toBe(false);
    expect(result.data.reason).toContain("policy context is");
    expect(ai.run).not.toHaveBeenCalled();
  });
});
