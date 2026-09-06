/**
 * Task 9: usage visibility — the `/settings/usage` read, the 80% banner, and
 * the `stratum_get_usage` MCP tool.
 *
 * The markup is deliberately untested: `vitest.config.ts` includes only `.ts`
 * files in coverage, so a `.tsx` page earns none, and a snapshot of JSX proves
 * nothing the type checker has not already. What is tested is
 * everything the page and the tool BOTH depend on being right — whose rows are
 * summed, which `source` is counted, and how an unlimited limit reads — plus
 * the tool end to end through the real Worker, because "scoped to the caller"
 * is a claim about authorization and not about a data structure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUsageBanner } from "../src/billing/usage-banner";
import { noticeUsageThresholds } from "../src/billing/usage-notifications";
import { buildUsageReport } from "../src/billing/usage-report";
import app from "../src/index";
import type { StratumClient } from "../src/mcp/client";
import { buildTools } from "../src/mcp/tools";
import { upsertUsage, usagePeriod } from "../src/storage/usage";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";
const USER_TOKEN = "stratum_user_11111111111111111111111111111111";
const PERIOD = "2026-09";
const AT = new Date("2026-09-15T00:00:00.000Z");

let db: D1Database;
let kv: ReturnType<typeof makeFakeKV>;

/** A self-hosted instance: no billing service, so nothing is metered. */
function selfHosted(): Env {
  return { DB: db, STATE: kv } as unknown as Env;
}

/** A cloud instance with the billing seam configured. */
function cloud(): Env {
  return {
    DB: db,
    STATE: kv,
    BILLING_SERVICE_URL: "https://billing.test",
    BILLING_SERVICE_SECRET: "s3cret",
  } as unknown as Env;
}

/**
 * Seed the entitlements cache directly. `forOwner` is a cached read that never
 * fetches, so this is the only way a limit reaches a reader — and it is exactly
 * how one reaches it in production, where `warmEntitlements` writes the entry.
 */
async function cacheLimits(ownerId: string, meters: Record<string, number>): Promise<void> {
  await kv.put(
    `entitlements:v2:user:${ownerId}`,
    JSON.stringify({
      plan: "free",
      pooled: false,
      meters: { llm_tokens_month: -1, sandbox_ms_month: -1, deploys_month: -1, ...meters },
      counts: { private_projects: -1 },
      rates: { requests_per_minute: 1000, evaluations_per_hour: 60 },
    }),
  );
}

async function record(
  ownerId: string,
  meter: "llm_tokens_month" | "sandbox_ms_month",
  quantity: number,
  source: "platform" | "byok",
  period = PERIOD,
): Promise<void> {
  const result = await upsertUsage(db, logger, { ownerId, ownerType: "user" }, period, [
    { meter, quantity, source },
  ]);
  if (!result.success) throw new Error("usage seed failed");
}

beforeEach(async () => {
  db = makeSqliteD1().db;
  kv = makeFakeKV();
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "alice@test", "alice", await hashToken(USER_TOKEN))
    .run();
});

describe("buildUsageReport", () => {
  it("states an unlimited limit as unlimited rather than as an empty bar", async () => {
    // The self-hoster's whole experience of this page: every limit is -1, and a
    // renderer handed a percentage would draw three empty bars and look broken.
    await record("usr_1", "llm_tokens_month", 4200, "platform");

    const report = await buildUsageReport(selfHosted(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.metered).toBe(false);
    expect(report.data.period).toBe(PERIOD);
    expect(report.data.resetsAt).toBe("2026-10-01T00:00:00.000Z");

    const llm = report.data.meters.find((m) => m.meter === "llm_tokens_month");
    expect(llm).toMatchObject({ used: 4200, limit: -1, unlimited: true, blocked: false });
    // Not 0, not 100, not Infinity — there is no fraction of "no limit".
    expect(llm?.percentUsed).toBeNull();
    expect(llm?.remaining).toBeNull();
    // Every meter, so no row on the page can quietly render a bar.
    expect(report.data.meters.every((m) => m.unlimited && m.percentUsed === null)).toBe(true);
    expect(report.data.rates.every((r) => r.unlimited)).toBe(true);
  });

  it("measures consumption against a finite limit", async () => {
    await cacheLimits("usr_1", { llm_tokens_month: 1000 });
    await record("usr_1", "llm_tokens_month", 800, "platform");

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.metered).toBe(true);
    expect(report.data.plan).toBe("free");
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")).toMatchObject({
      used: 800,
      limit: 1000,
      unlimited: false,
      percentUsed: 80,
      remaining: 200,
    });
    expect(report.data.rates.find((r) => r.rate === "evaluations_per_hour")).toMatchObject({
      limit: 60,
      unlimited: false,
    });
  });

  it("reads a hard block of 0 as a block, not as 'unset'", async () => {
    await cacheLimits("usr_1", { deploys_month: 0 });

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.meters.find((m) => m.meter === "deploys_month")).toMatchObject({
      limit: 0,
      blocked: true,
      unlimited: false,
      percentUsed: null,
      remaining: null,
    });
  });

  it("does not count BYOK spend as hosted consumption", async () => {
    // Goal 5: a project paying its own provider bill must not see that spend
    // eat an allowance it never touched. Migration 049 keys `source` into the
    // primary key precisely so this sum can exclude it.
    await cacheLimits("usr_1", { llm_tokens_month: 1000 });
    await record("usr_1", "llm_tokens_month", 100, "platform");
    await record("usr_1", "llm_tokens_month", 50_000, "byok");

    const report = await buildUsageReport(cloud(), logger, {
      actorUserId: "usr_1",
      at: AT,
      includeByok: true,
    });
    if (!report.success) throw report.error;

    const llm = report.data.meters.find((m) => m.meter === "llm_tokens_month");
    expect(llm?.used).toBe(100);
    expect(llm?.percentUsed).toBe(10);
    expect(llm?.remaining).toBe(900);
    // Reported, clearly apart, and never folded into `used`.
    expect(llm?.byok).toBe(50_000);
  });

  it("omits the BYOK read entirely when the caller did not ask for it", async () => {
    await record("usr_1", "llm_tokens_month", 7, "byok");

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")).toMatchObject({
      used: 0,
      byok: 0,
    });
  });

  it("reads the actor's own rows and nobody else's", async () => {
    await record("usr_1", "llm_tokens_month", 11, "platform");
    await record("usr_2", "llm_tokens_month", 9_999, "platform");

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;
    expect(report.data.subject).toEqual({ ownerId: "usr_1", ownerType: "user" });
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")?.used).toBe(11);
  });

  it("refuses to report usage for nobody", async () => {
    const report = await buildUsageReport(cloud(), logger, { actorUserId: "", at: AT });
    expect(report.success).toBe(false);
  });
});

describe("the 80% banner", () => {
  /** Drive one write's totals through the notification path and settle its work. */
  async function notice(quantity: number, added: number): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    noticeUsageThresholds(cloud(), logger, {
      recorded: { ownerId: "usr_1", ownerType: "user" },
      actorUserId: "usr_1",
      period: PERIOD,
      totals: [{ meter: "llm_tokens_month", source: "platform", quantity, added }],
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
  }

  beforeEach(async () => {
    await cacheLimits("usr_1", { llm_tokens_month: 1000 });
  });

  it("appears on the crossing at 80%", async () => {
    await notice(800, 800);

    const banner = await loadUsageBanner(cloud(), logger, "usr_1", PERIOD);
    expect(banner).toMatchObject({
      meter: "llm_tokens_month",
      used: 800,
      limit: 1000,
      percent: 80,
      period: PERIOD,
    });
  });

  it("does not appear below 80%", async () => {
    await notice(799, 799);
    expect(await loadUsageBanner(cloud(), logger, "usr_1", PERIOD)).toBeNull();
  });

  it("does not appear for a month it was not about", async () => {
    // The period is in the key, so a new month reads as "no banner" with
    // nothing sweeping the old one.
    await notice(900, 900);
    expect(await loadUsageBanner(cloud(), logger, "usr_1", "2026-10")).toBeNull();
  });

  it("is never shown on a self-hosted instance, and costs no read there", async () => {
    await notice(900, 900);
    const env = selfHosted();
    const get = vi.spyOn(kv, "get");
    expect(await loadUsageBanner(env, logger, "usr_1", PERIOD)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("costs no read at all for a signed-out visitor", async () => {
    const get = vi.spyOn(kv, "get");
    expect(await loadUsageBanner(cloud(), logger, undefined, PERIOD)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
});

describe("stratum_get_usage", () => {
  it("is a read-only tool that says so, and has no billing-mutating sibling", async () => {
    const tools = buildTools({} as StratumClient);
    const usage = tools.find((t) => t.name === "stratum_get_usage");

    expect(usage).toBeDefined();
    // No arguments: it reports on the caller, so there is nothing to pass and
    // nothing to point at somebody else.
    expect(Object.keys(usage?.schema ?? {})).toHaveLength(0);
    expect(usage?.description).toContain("Read-only");
    expect(usage?.description).toMatch(/cannot raise a limit|nothing here can raise a limit/i);

    // PRD §4c: an agent that can raise its own limit does not have one.
    for (const forbidden of [
      "stratum_upgrade_plan",
      "stratum_buy_topup",
      "stratum_set_provider_key",
    ]) {
      expect(tools.map((t) => t.name)).not.toContain(forbidden);
    }
  });

  it("returns the caller's own meters, limits, period and reset over MCP", async () => {
    // End to end through the real Worker: "scoped to the caller" is a claim
    // about authorization, and a fake client would prove nothing about it.
    // The tool reports the CURRENT period, which is whatever month the suite
    // runs in — seeding a fixed one would pass in September and fail in October.
    const now = usagePeriod();
    await record("usr_1", "llm_tokens_month", 321, "platform", now);
    await record("usr_2", "llm_tokens_month", 9_999, "platform", now);

    const env = { DB: db, STATE: undefined, ARTIFACTS: undefined } as unknown as Env;
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "stratum_get_usage", arguments: {} },
        }),
      }),
      env,
    );

    const reply = (await response.json()) as {
      result?: { content?: Array<{ text: string }>; isError?: boolean };
    };
    expect(reply.result?.isError).toBeUndefined();
    const body = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as {
      subject: { ownerId: string };
      period: string;
      resetsAt: string;
      meters: Array<{ meter: string; used: number; unlimited: boolean }>;
      rates: Array<{ rate: string }>;
    };

    expect(body.subject.ownerId).toBe("usr_1");
    expect(body.period).toBe(now);
    expect(Date.parse(body.resetsAt)).not.toBeNaN();
    expect(body.meters.map((m) => m.meter)).toEqual([
      "llm_tokens_month",
      "sandbox_ms_month",
      "deploys_month",
    ]);
    expect(body.rates.map((r) => r.rate)).toEqual(["requests_per_minute", "evaluations_per_hour"]);
    // usr_2's 9,999 belongs to usr_2. Only a row keyed on the caller may show up.
    expect(body.meters.find((m) => m.meter === "llm_tokens_month")?.used).toBe(321);
    expect(body.meters.every((m) => m.used !== 9_999)).toBe(true);
  });
});
