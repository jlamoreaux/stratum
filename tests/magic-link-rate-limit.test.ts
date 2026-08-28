import { describe, expect, it } from "vitest";
import { MagicLinkRateLimiter } from "../src/queue/magic-link-limiter";
import type { Env } from "../src/types";
import { makeFakeDurableObjects } from "./helpers/fake-durable-object";

const WINDOW = 60 * 60;
const HOUR_MS = WINDOW * 1000;

function makeLimiters(opts: { gated?: boolean } = {}) {
  return makeFakeDurableObjects((ctx) => new MagicLinkRateLimiter(ctx, {} as Env), opts);
}

/** RPC surface of the limiter, as the route sees it through a stub. */
interface LimiterStub {
  reserve(
    limit: number,
    windowSeconds: number,
    nowMs: number,
  ): Promise<{ admitted: boolean; count: number }>;
  refund(windowSeconds: number, nowMs: number): Promise<void>;
}

function stubFor(namespace: DurableObjectNamespace, name: string): LimiterStub {
  return namespace.get(namespace.idFromName(name)) as unknown as LimiterStub;
}

describe("MagicLinkRateLimiter", () => {
  it("admits up to the limit and then refuses", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    const outcomes = [];
    for (let i = 0; i < 7; i++) outcomes.push(await stub.reserve(5, WINDOW, now));

    expect(outcomes.map((o) => o.admitted)).toEqual([true, true, true, true, true, false, false]);
    expect(outcomes.map((o) => o.count)).toEqual([1, 2, 3, 4, 5, 5, 5]);
  });

  it("resets the counter when the window rolls", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    for (let i = 0; i < 5; i++) await stub.reserve(5, WINDOW, now);
    expect((await stub.reserve(5, WINDOW, now)).admitted).toBe(false);

    expect((await stub.reserve(5, WINDOW, now + HOUR_MS)).admitted).toBe(true);
  });

  it("gives a reservation back on refund", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    for (let i = 0; i < 5; i++) await stub.reserve(5, WINDOW, now);
    expect((await stub.reserve(5, WINDOW, now)).admitted).toBe(false);

    await stub.refund(WINDOW, now);
    expect((await stub.reserve(5, WINDOW, now)).admitted).toBe(true);
    // ...and only one was given back.
    expect((await stub.reserve(5, WINDOW, now)).admitted).toBe(false);
  });

  it("ignores a refund whose window has already rolled", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    await stub.reserve(5, WINDOW, now);
    // A refund stamped in the NEXT window must not decrement that window's
    // (zero) count, which would otherwise carry a credit forward.
    await stub.refund(WINDOW, now + HOUR_MS);

    const next = await stub.reserve(5, WINDOW, now + HOUR_MS);
    expect(next.count).toBe(1);
  });

  it("does not drive a counter below zero", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    await stub.refund(WINDOW, now);
    await stub.refund(WINDOW, now);

    expect((await stub.reserve(1, WINDOW, now)).count).toBe(1);
    expect((await stub.reserve(1, WINDOW, now)).admitted).toBe(false);
  });

  it("refuses rather than throws on a malformed limit or window", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    // A throw would reach the caller's catch, which fails OPEN — so a bad
    // constant has to refuse instead of turning the endpoint unlimited.
    expect((await stub.reserve(0, WINDOW, now)).admitted).toBe(false);
    expect((await stub.reserve(-1, WINDOW, now)).admitted).toBe(false);
    expect((await stub.reserve(1.5, WINDOW, now)).admitted).toBe(false);
    expect((await stub.reserve(Number.NaN, WINDOW, now)).admitted).toBe(false);
    expect((await stub.reserve(5, 0, now)).admitted).toBe(false);
  });

  it("arms an alarm past the end of the live window and erases on it", async () => {
    const { namespace, instances, storages } = makeLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    await stub.reserve(5, WINDOW, now);
    const instance = instances.get("email:a");
    const storage = storages.get("email:a");
    if (!instance || !storage) throw new Error("instance not created");

    const alarm = await storage.getAlarm();
    const windowEndMs = (Math.floor(now / 1000 / WINDOW) + 1) * HOUR_MS;
    expect(alarm).toBeGreaterThan(windowEndMs);

    await instance.alarm();
    expect(await storage.getAlarm()).toBeNull();
    // Storage erased, so the next window starts from nothing.
    expect((await stub.reserve(5, WINDOW, now)).count).toBe(1);
  });
});

describe("MagicLinkRateLimiter concurrency", () => {
  it("holds the cap when 50 reservations run concurrently", async () => {
    const { namespace } = makeLimiters();
    const stub = stubFor(namespace, "ip:203.0.113.7");
    const now = Date.now();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => stub.reserve(20, WINDOW, now)),
    );

    expect(outcomes.filter((o) => o.admitted)).toHaveLength(20);
    // Counts are 1..20 with no repeats — no two admissions read the same value.
    expect(
      outcomes
        .filter((o) => o.admitted)
        .map((o) => o.count)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("over-admits without the input gate, proving the assertion above is not vacuous", async () => {
    // Same 50 concurrent reservations against an UNGATED instance: this is the
    // Workers KV failure mode the Durable Object replaces. If this ever stops
    // over-admitting, the harness has stopped modelling concurrency and the
    // test above no longer proves anything.
    const { namespace } = makeLimiters({ gated: false });
    const stub = stubFor(namespace, "ip:203.0.113.7");
    const now = Date.now();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => stub.reserve(20, WINDOW, now)),
    );

    expect(outcomes.filter((o) => o.admitted).length).toBeGreaterThan(20);
  });
});
