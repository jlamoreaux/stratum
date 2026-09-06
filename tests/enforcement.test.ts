/**
 * Enforcement: the decision layer that turns an entitlement into an answer.
 *
 * Four claims carry this suite, and each of them is the kind that decays
 * silently if nothing asserts it:
 *
 * - **Inert by default.** With `BILLING_SERVICE_URL` unset nothing is fetched,
 *   the `USAGE_METER` binding is never touched, and no refusal can be produced.
 * - **A refusal is a FAILING gate, never an absent one.** An exhausted allowance
 *   that skipped the LLM evaluator would stop a policy requiring AI review from
 *   requiring it, exactly when someone ran out of credit.
 * - **Observe-only admits while recording.** Everything ships evaluating and
 *   logging decisions that bind only under `ENTITLEMENTS_ENFORCE=1`.
 * - **The subject is the actor** (PRD §4a), an org pools only when positively
 *   known to be paid, and every usage read for a check is `source = 'platform'`.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkGauge,
  checkMeter,
  resolveEnforcementSubject,
  settleMeter,
} from "../src/billing/enforcement";
import { type Entitlements, UNLIMITED, UnlimitedEntitlements } from "../src/billing/entitlements";
import { runDeployMessage } from "../src/deploy/runner";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import type { LlmProvider } from "../src/evaluation/llm-provider";
import type { EvalPolicy, EvaluationContext } from "../src/evaluation/types";
import { rateLimitMiddleware } from "../src/middleware/rate-limit";
import { recordCosts } from "../src/storage/costs";
import { insertDeployment } from "../src/storage/deployments";
import { setProject } from "../src/storage/state";
import { getOwnerMeterTotals, upsertUsage } from "../src/storage/usage";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";
import { makeUsageMeters } from "./helpers/usage-meter";

const PERIOD = "2026-09";
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

const logged: Array<{ message: string; meta?: Record<string, unknown> }> = [];
const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn((message: string, meta?: Record<string, unknown>) => {
    logged.push({ message, ...(meta ? { meta } : {}) });
  }),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

type Meters = ReturnType<typeof makeUsageMeters>;
type FakeKV = ReturnType<typeof makeFakeKV>;

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let kv: FakeKV;
let meters: Meters;
let scheduled: Array<Promise<unknown>>;

/** Unique per test, so the module-level "already reconciled" memo cannot leak. */
let seq = 0;
function nextUserId(): string {
  seq += 1;
  return `usr_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  kv = makeFakeKV();
  meters = makeUsageMeters();
  scheduled = [];
  logged.length = 0;
  vi.clearAllMocks();
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    STATE: kv,
    USAGE_METER: meters.namespace,
    BILLING_SERVICE_URL: "https://billing.test",
    BILLING_SERVICE_SECRET: "shh",
    ...overrides,
  } as unknown as Env;
}

/** An env with the billing service unconfigured — every self-hoster. */
function selfHostedEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({
    BILLING_SERVICE_URL: undefined,
    BILLING_SERVICE_SECRET: undefined,
    ...overrides,
  });
}

/** A plan with one monthly token allowance and everything else unlimited. */
function tokenPlan(limit: number): Entitlements {
  return plan({ meters: { ...UnlimitedEntitlements.meters, llm_tokens_month: limit } });
}

/** The plan a subject that has spent its whole monthly token allowance is on. */
function exhaustedTokens(): Entitlements {
  return tokenPlan(0);
}

function plan(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    ...UnlimitedEntitlements,
    plan: "free",
    meters: { ...UnlimitedEntitlements.meters },
    counts: { ...UnlimitedEntitlements.counts },
    rates: { ...UnlimitedEntitlements.rates },
    ...overrides,
  };
}

/** Seed the entitlements cache the way a warm would, so `forOwner` hits. */
function cachePlan(ownerType: "user" | "org", ownerId: string, entitlements: Entitlements): void {
  kv.store.set(`entitlements:v2:${ownerType}:${ownerId}`, JSON.stringify(entitlements));
}

function createUser(id: string): string {
  raw
    .prepare("INSERT INTO users (id, email, token_hash) VALUES (?, ?, ?)")
    .run(id, `${id}@example.test`, `hash-${id}`);
  return id;
}

function llmProvider(text = JSON.stringify({ score: 1, passed: true, reason: "fine" })) {
  return {
    run: vi.fn(async () => ok({ text, usage: { inputTokens: 100, outputTokens: 20 } })),
  } as unknown as LlmProvider & { run: ReturnType<typeof vi.fn> };
}

const POLICY: EvalPolicy = { evaluators: [{ type: "llm" }] };

function billingContext(ownerId: string, actorUserId?: string): EvaluationContext {
  return {
    billing: {
      ownerId,
      ownerType: "user",
      projectId: "prj_1",
      ...(actorUserId ? { actorUserId } : {}),
    },
  };
}

describe("inert with BILLING_SERVICE_URL unset (PRD Goal 3)", () => {
  it("never touches the meter binding from the LLM gate", async () => {
    const userId = nextUserId();
    // A plan that would refuse everything, cached — proving the short-circuit is
    // the missing service and not the absence of a limit.
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "platform", {
      env: selfHostedEnv(),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(meters.calls).toEqual([]);
  });

  it("never touches the meter binding from a direct check", async () => {
    const decision = await checkMeter(selfHostedEnv(), logger, {
      subject: { ownerId: nextUserId(), ownerType: "user", pooled: false },
      meter: "llm_tokens_month",
      estimate: 10_000,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });

    expect(decision).toMatchObject({ admitted: true, refused: false, checked: false });
    expect(meters.calls).toEqual([]);
  });
});

describe("the enforcement subject (PRD §4a)", () => {
  it("charges the acting user, not the org the project is recorded against", async () => {
    const actor = nextUserId();
    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: actor,
      owner: { ownerId: "org_1", ownerType: "org" },
    });

    expect(subject).toEqual({ ownerId: actor, ownerType: "user", pooled: false });
  });

  it("treats an UNCACHED org plan as free and charges the actor", async () => {
    const actor = nextUserId();
    // Nothing cached for the org: the first check for any org is always a miss,
    // because nothing warms org entitlements before this point. Reading that as
    // "the org is its own subject" is the hole this direction closes.
    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: actor,
      owner: { ownerId: "org_cold", ownerType: "org" },
      waitUntil: (promise) => scheduled.push(promise),
    });

    expect(subject?.ownerId).toBe(actor);
    // ...and the warm was scheduled, so a paid org can pool from next time.
    expect(scheduled.length).toBeGreaterThan(0);
    await Promise.allSettled(scheduled);
  });

  it("treats a cached org plan that does not pool as free", async () => {
    const actor = nextUserId();
    cachePlan("org", "org_solo", plan({ pooled: false }));

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: actor,
      owner: { ownerId: "org_solo", ownerType: "org" },
    });

    expect(subject?.ownerId).toBe(actor);
  });

  it("pools onto an org that is positively known to pool", async () => {
    cachePlan("org", "org_paid", plan({ plan: "team", pooled: true }));

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: nextUserId(),
      owner: { ownerId: "org_paid", ownerType: "org" },
    });

    expect(subject).toEqual({ ownerId: "org_paid", ownerType: "org", pooled: true });
  });

  it("walks an agent to its owning user when no actor is named", async () => {
    const owner = createUser(nextUserId());
    raw
      .prepare("INSERT INTO agents (id, name, owner_id, token_hash) VALUES (?, ?, ?, ?)")
      .run("agt_1", "bot", owner, "hash");

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      owner: { ownerId: "agt_1", ownerType: "agent" },
    });

    expect(subject).toEqual({ ownerId: owner, ownerType: "user", pooled: false });
  });

  it("names nobody when there is neither an actor nor a resolvable owner", async () => {
    expect(await resolveEnforcementSubject(makeEnv(), logger, {})).toBeNull();
  });
});

describe("reserve and settle", () => {
  it("reserves the whole bound and settles the difference back", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    cachePlan("user", userId, tokenPlan(10_000));

    const decision = await checkMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      estimate: 7_000,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });
    expect(decision).toMatchObject({ admitted: true, reserved: true, count: 7_000 });

    await settleMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      delta: 900 - 7_000,
      nowMs: NOW,
      period: PERIOD,
    });

    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(900);
  });

  it("settles in a finally, so a thrown provider call cannot leak the reservation", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, tokenPlan(100_000));
    const provider = {
      run: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    } as unknown as LlmProvider;

    const result = await new LLMEvaluator(provider, "platform", { env: makeEnv() }).evaluate(
      "diff",
      POLICY,
      logger,
      billingContext(userId, userId),
    );

    expect(result.success).toBe(false);
    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    // The whole reservation came back: nothing was spent, so nothing is charged.
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(0);
  });
});

describe("the LLM gate under an exhausted allowance", () => {
  it("returns a FAILING gate naming cause and remedies, and never calls the provider", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "platform", {
      env: makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success).toBe(true);
    if (!result.success) return;
    // A gate that ran and failed — NOT a gate that vanished. The evaluator is
    // still in the set and still reports a verdict.
    expect(result.data.passed).toBe(false);
    expect(result.data.score).toBe(0);
    expect(result.data.reason).toContain("monthly LLM token allowance");
    // Both remedies, per PRD §4c: bring your own key, or raise the plan.
    expect(result.data.reason).toContain("provider:");
    expect(result.data.reason).toContain("plan limits");
    // ...and when it resets.
    expect(result.data.reason).toContain("2026-10-01");
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("admits while recording the decision when enforcement is off", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "platform", { env: makeEnv() }).evaluate(
      "diff",
      POLICY,
      logger,
      billingContext(userId, userId),
    );

    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
    // Recorded even though it admitted: a month of observation that logs nothing
    // measures nothing.
    const decision = logged.find(
      (entry) => entry.message === "Entitlement decision" && entry.meta?.refused === true,
    );
    expect(decision?.meta).toMatchObject({ enforcing: false, admitted: true, limit: 0 });
  });

  it("refuses on the hourly evaluation rate even under BYOK (PRD §4b)", async () => {
    const userId = nextUserId();
    cachePlan(
      "user",
      userId,
      plan({ rates: { requests_per_minute: UNLIMITED, evaluations_per_hour: 0 } }),
    );
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "byok", {
      env: makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success && result.data.passed).toBe(false);
    expect(result.success && result.data.reason).toContain("hourly evaluation allowance");
    // The string says so out loud, because it is the remedy an agent reaches for.
    expect(result.success && result.data.reason).toContain("does NOT lift this one");
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("does not charge a BYOK run against the hosted token allowance", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "byok", {
      env: makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    // The token allowance is the one thing BYOK lifts: the project is paying.
    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
});

describe("usage reads for a limit check (PRD §4a, Goal 5)", () => {
  it("sums platform rows only, so BYOK spend is not charged to the hosted allowance", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    await upsertUsage(db, logger, subject, PERIOD, [
      { meter: "llm_tokens_month", quantity: 600, source: "platform" },
      { meter: "llm_tokens_month", quantity: 5_000, source: "byok" },
    ]);

    const totals = await getOwnerMeterTotals(db, logger, userId, PERIOD, "platform");
    expect(totals.success && totals.data.llm_tokens_month).toBe(600);

    // And the counter is seeded from that same filtered total, so a project on
    // its own key cannot exhaust the hosted meter.
    cachePlan("user", userId, tokenPlan(10_000));
    const decision = await checkMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      estimate: 100,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });
    expect(decision.count).toBe(700);
  });
});

describe("the private project gauge", () => {
  it("refuses one over the limit and admits under it", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    const env = makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>);
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };

    const under = await checkGauge(env, logger, {
      subject,
      count: "private_projects",
      current: 1,
      what: "Creating another private project",
    });
    const over = await checkGauge(env, logger, {
      subject,
      count: "private_projects",
      current: 2,
      what: "Creating another private project",
    });

    expect(under.admitted).toBe(true);
    expect(over.admitted).toBe(false);
    expect(over.reason).toContain("plan allows 2");
  });
});

describe("rateLimitMiddleware's default limit", () => {
  function app(env: Env, userId?: string) {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      if (userId) c.set("userId", userId);
      await next();
    });
    application.use("*", rateLimitMiddleware());
    application.get("/x", (c) => c.text("ok"));
    return (path = "/x") => application.fetch(new Request(`https://t.test${path}`), env);
  }

  it("falls back to today's 1000 when the entitlements cache misses", async () => {
    const response = await app(makeEnv(), nextUserId())();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("keeps today's numbers entirely when the billing service is unconfigured", async () => {
    const response = await app(selfHostedEnv(), nextUserId())();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("uses a cached plan's own rate when enforcement is on", async () => {
    const userId = nextUserId();
    cachePlan(
      "user",
      userId,
      plan({ rates: { requests_per_minute: 25, evaluations_per_hour: 10 } }),
    );
    const response = await app(makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>), userId)();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("25");
  });

  it("never tightens while observing: a lower plan limit does not bind", async () => {
    const userId = nextUserId();
    cachePlan(
      "user",
      userId,
      plan({ rates: { requests_per_minute: 25, evaluations_per_hour: 10 } }),
    );
    const response = await app(makeEnv(), userId)();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("leaves an agent on its own bucket at today's numbers", async () => {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      c.set("agentId", "agt_1");
      await next();
    });
    application.use("*", rateLimitMiddleware());
    application.get("/x", (c) => c.text("ok"));
    const response = await application.fetch(
      new Request("https://t.test/x"),
      makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    );
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });
});

describe("the deploy volume check", () => {
  const PROJECT_ID = "prj_deploy_enforce";
  const REMOTE = "https://acct.artifacts.cloudflare.net/git/acct/api.git";
  const SHA = "a".repeat(40);

  async function deployProject(ownerId: string): Promise<ProjectEntry> {
    const project: ProjectEntry = {
      id: PROJECT_ID,
      name: "api",
      slug: "api",
      namespace: "@alice",
      ownerId,
      ownerType: "user",
      remote: REMOTE,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const stored = await setProject(kv, project, logger);
    if (!stored.success) throw stored.error;
    return project;
  }

  it("writes a persisted failed row with a named reason, and acks", async () => {
    const userId = createUser(nextUserId());
    await deployProject(userId);
    cachePlan(
      "user",
      userId,
      plan({ meters: { ...UnlimitedEntitlements.meters, deploys_month: 0 } }),
    );

    const inserted = await insertDeployment(db, logger, {
      projectId: PROJECT_ID,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "user",
      requestedById: userId,
      now: "2026-09-15T00:00:00.000Z",
    });
    if (!inserted.success || !inserted.data.inserted) throw new Error("fixture insert failed");

    const result = await runDeployMessage(
      makeEnv({
        ENTITLEMENTS_ENFORCE: "1",
        ARTIFACTS: {
          get: async () => ({ createToken: async () => ({ plaintext: "repo-token" }) }),
        },
      } as unknown as Partial<Env>),
      { kind: "deployment", projectId: PROJECT_ID, deploymentId: inserted.data.deployment.id },
      logger,
      {
        now: () => NOW,
        readFiles: async () =>
          ok(
            new Map([
              [
                ".stratum/policy.yaml",
                new TextEncoder().encode(
                  "evaluators: []\ndeploys:\n  - name: production\n    target: vercel\n",
                ),
              ],
            ]),
          ),
        // A provider call would be a bug: the refusal happens before the claim.
        fetch: vi.fn(async () => new Response("{}", { status: 200 })),
      },
    );

    // Acked, not retried: redelivery cannot change a limit.
    expect(result.success).toBe(true);
    const row = raw
      .prepare("SELECT status, reason FROM deployments WHERE id = ?")
      .get(inserted.data.deployment.id) as { status: string; reason: string };
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("monthly deploy allowance");
  });
});

describe("the 80% threshold notification", () => {
  function envWithEmail(): { env: Env; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn(async () => undefined);
    return {
      env: makeEnv({
        EMAIL: { send } as unknown as Env["EMAIL"],
        EMAIL_FROM_ADDRESS: "noreply@stratum.test",
      }),
      send,
    };
  }

  async function spend(env: Env, ownerId: string, quantity: number): Promise<void> {
    await recordCosts(
      db,
      logger,
      {
        project: "api",
        projectId: "prj_1",
        ownerId,
        ownerType: "user",
        notify: {
          env,
          actorUserId: ownerId,
          waitUntil: (promise) => scheduled.push(promise),
        },
      },
      [{ kind: "llm_tokens", quantity }],
    );
    await Promise.allSettled(scheduled);
    scheduled.length = 0;
  }

  it("fires once on the crossing and not again inside the same period", async () => {
    const userId = createUser(nextUserId());
    const { env, send } = envWithEmail();
    cachePlan("user", userId, tokenPlan(1_000));

    // 700 of 1000 is under 80%: approaching is not crossing.
    await spend(env, userId, 700);
    expect(send).not.toHaveBeenCalled();

    // 850 crosses.
    await spend(env, userId, 150);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: `${userId}@example.test` });

    // Still past the threshold, but the edge has already been reported.
    await spend(env, userId, 50);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-arms when the limit is raised mid-period: the limit is in the receipt key", async () => {
    const userId = createUser(nextUserId());
    const { env, send } = envWithEmail();
    cachePlan("user", userId, tokenPlan(1_000));

    await spend(env, userId, 850);
    expect(send).toHaveBeenCalledTimes(1);

    // The plan is upgraded: 850 is now well under 80% of 2000, so the next
    // crossing is a real one and must not be silenced by the first receipt.
    cachePlan("user", userId, tokenPlan(2_000));
    await spend(env, userId, 800);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores BYOK spend, which is not under the allowance at all", async () => {
    const userId = createUser(nextUserId());
    const { env, send } = envWithEmail();
    cachePlan("user", userId, tokenPlan(1_000));

    await recordCosts(
      db,
      logger,
      {
        project: "api",
        ownerId: userId,
        ownerType: "user",
        notify: { env, actorUserId: userId, waitUntil: (promise) => scheduled.push(promise) },
      },
      [{ kind: "llm_tokens", quantity: 950, source: "byok" }],
    );
    await Promise.allSettled(scheduled);

    expect(send).not.toHaveBeenCalled();
  });

  it("says nothing at all when the billing service is unconfigured", async () => {
    const userId = createUser(nextUserId());
    const send = vi.fn(async () => undefined);
    const env = selfHostedEnv({
      EMAIL: { send } as unknown as Env["EMAIL"],
      EMAIL_FROM_ADDRESS: "noreply@stratum.test",
    });
    cachePlan("user", userId, tokenPlan(1_000));

    await spend(env, userId, 950);
    expect(send).not.toHaveBeenCalled();
  });
});
