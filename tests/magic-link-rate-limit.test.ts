import { describe, expect, it } from "vitest";
import type { MagicLinkRateLimiter } from "../src/queue/magic-link-limiter";
import type { Env } from "../src/types";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";

const WINDOW = 60 * 60;
const HOUR_MS = WINDOW * 1000;

/**
 * The limiter's RPC surface, derived from the class rather than restated, so a
 * signature change there fails this suite instead of being absorbed by a
 * hand-written interface that has quietly gone out of date.
 */
type LimiterStub = Pick<MagicLinkRateLimiter, "reserve" | "refund">;

function stubFor(namespace: NonNullable<Env["MAGIC_LINK_LIMITER"]>, name: string): LimiterStub {
  return namespace.get(namespace.idFromName(name));
}

describe("MagicLinkRateLimiter", () => {
  it("admits up to the limit and then refuses", async () => {
    const { namespace } = makeMagicLinkLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    const outcomes = [];
    for (let i = 0; i < 7; i++) outcomes.push(await stub.reserve(5, WINDOW, now));

    expect(outcomes.map((o) => o.admitted)).toEqual([true, true, true, true, true, false, false]);
    expect(outcomes.map((o) => o.count)).toEqual([1, 2, 3, 4, 5, 5, 5]);
  });

  it("resets the counter when the window rolls", async () => {
    const { namespace } = makeMagicLinkLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    for (let i = 0; i < 5; i++) await stub.reserve(5, WINDOW, now);
    expect((await stub.reserve(5, WINDOW, now)).admitted).toBe(false);

    expect((await stub.reserve(5, WINDOW, now + HOUR_MS)).admitted).toBe(true);
  });

  it("gives a reservation back on refund", async () => {
    const { namespace } = makeMagicLinkLimiters();
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
    const { namespace } = makeMagicLinkLimiters();
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
    const { namespace } = makeMagicLinkLimiters();
    const stub = stubFor(namespace, "email:a");
    const now = Date.now();

    await stub.refund(WINDOW, now);
    await stub.refund(WINDOW, now);

    expect((await stub.reserve(1, WINDOW, now)).count).toBe(1);
    expect((await stub.reserve(1, WINDOW, now)).admitted).toBe(false);
  });

  it("refuses rather than throws on a malformed limit or window", async () => {
    const { namespace } = makeMagicLinkLimiters();
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
    const { namespace, instances, storages } = makeMagicLinkLimiters();
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

describe("fake Durable Object harness", () => {
  // The harness decides whether every test above means anything, so its two
  // fidelity properties are pinned rather than assumed.

  it("does not present a stub as a thenable", async () => {
    const { namespace } = makeMagicLinkLimiters();
    const stub = namespace.get(namespace.idFromName("email:a"));

    // A Proxy that returns a function for `.then` is a thenable: awaiting it
    // calls that as a continuation, so the await never settles to the stub.
    expect((stub as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(stub)).resolves.toBe(stub);
  });

  it("isolates stored state from the caller's references", async () => {
    const { namespace, storages } = makeMagicLinkLimiters();
    const stub = namespace.get(namespace.idFromName("email:a"));
    const now = Date.now();

    await stub.reserve(5, WINDOW, now);
    const storage = storages.get("email:a");
    if (!storage) throw new Error("storage not created");

    // Real DO storage serializes, so a handle a caller kept cannot reach back
    // into the bucket. A Map of live objects would let this mutation stick and
    // let a test pass against behaviour production does not have.
    const read = await storage.get<{ window: number; count: number }>("bucket");
    if (!read) throw new Error("bucket not written");
    read.count = 999;

    expect((await stub.reserve(5, WINDOW, now)).count).toBe(2);
  });
});

describe("MagicLinkRateLimiter concurrency", () => {
  it("holds the cap when 50 reservations run concurrently", async () => {
    const { namespace } = makeMagicLinkLimiters();
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
    const { namespace } = makeMagicLinkLimiters({ gated: false });
    const stub = stubFor(namespace, "ip:203.0.113.7");
    const now = Date.now();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => stub.reserve(20, WINDOW, now)),
    );

    expect(outcomes.filter((o) => o.admitted).length).toBeGreaterThan(20);
  });
});
