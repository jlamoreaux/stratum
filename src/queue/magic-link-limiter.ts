import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/** The single storage key holding this bucket's window id and its count. */
const BUCKET_KEY = "bucket";

/**
 * How long after a window closes the object waits before erasing itself. A
 * counter is worthless once its window has rolled, but the grace period keeps a
 * steadily-used bucket from thrashing delete/recreate against clock skew
 * between the alarm and the next request.
 */
const CLEANUP_GRACE_MS = 60_000;

interface Bucket {
  /** `floor(epochSeconds / windowSeconds)` — the fixed window this count belongs to. */
  window: number;
  count: number;
}

export interface ReserveOutcome {
  admitted: boolean;
  /** The count after this call. Reported for logging; callers gate on `admitted`. */
  count: number;
}

/**
 * A serialized fixed-window counter, one instance per rate-limit subject (an
 * email-address digest, or a source IP).
 *
 * This exists because the counter it replaces was a Workers KV
 * read-modify-write: concurrent magic-link sends read the same value and each
 * wrote back `value + 1`, so N simultaneous requests advanced the counter by
 * one and the cap bounded sequential traffic only. A Durable Object closes that
 * window — the runtime's input gate holds incoming events while a storage
 * operation is in flight, so the read and the write below cannot interleave
 * with another request against the same instance.
 *
 * Serialization is per instance, and an instance is per subject, so magic-link
 * sends for different addresses (and from different IPs) still run in parallel.
 *
 * `limit` and `windowSeconds` are supplied by the caller rather than baked in
 * here so the policy numbers stay next to the endpoint that enforces them.
 * That is safe only because DO RPC is reachable from Worker code alone — no
 * request can name its own limit. Do not expose this class over `fetch`.
 */
export class MagicLinkRateLimiter extends DurableObject<Env> {
  /**
   * Atomically admits or rejects one send against this subject's cap.
   *
   * @param limit - Maximum admissions per window
   * @param windowSeconds - Fixed window length
   * @param nowMs - Caller's clock, so a single request stamps both of its counters identically
   * @returns Whether the send was admitted, and the resulting count
   */
  async reserve(limit: number, windowSeconds: number, nowMs: number): Promise<ReserveOutcome> {
    // A malformed limit can only come from a bug in our own Worker, never from
    // a request. Refusing (rather than throwing) keeps the failure out of the
    // caller's catch block, which fails *open* — a throw here would turn a
    // typo into a silently unlimited endpoint.
    if (!isPositiveInteger(limit) || !isPositiveInteger(windowSeconds)) {
      return { admitted: false, count: 0 };
    }
    const window = windowId(nowMs, windowSeconds);
    const count = await this.currentCount(window);
    if (count >= limit) return { admitted: false, count };
    await this.ctx.storage.put<Bucket>(BUCKET_KEY, { window, count: count + 1 });
    // Re-armed on every reserve so the erase always trails the live window.
    await this.ctx.storage.setAlarm((window + 1) * windowSeconds * 1000 + CLEANUP_GRACE_MS);
    return { admitted: true, count: count + 1 };
  }

  /**
   * Returns one reservation to this subject's bucket.
   *
   * A send is admitted only when it clears *both* the per-email and the per-IP
   * cap, and the two caps live in different instances — so the first reservation
   * has to be given back when the second refuses. Between the two, a concurrent
   * request can see the not-yet-refunded count and be rejected; that direction
   * (over-refusing, briefly) is the safe one, and the caps are never exceeded.
   *
   * @param windowSeconds - Fixed window length, matching the `reserve` that took it
   * @param nowMs - Caller's clock
   */
  async refund(windowSeconds: number, nowMs: number): Promise<void> {
    if (!isPositiveInteger(windowSeconds)) return;
    const window = windowId(nowMs, windowSeconds);
    const bucket = await this.ctx.storage.get<Bucket>(BUCKET_KEY);
    // A rolled window already discarded the reservation; a zero count means
    // there is nothing to give back. Neither is worth clamping below zero.
    if (bucket?.window !== window || bucket.count <= 0) return;
    await this.ctx.storage.put<Bucket>(BUCKET_KEY, { window, count: bucket.count - 1 });
  }

  /**
   * Erases the counter once its window has closed, so a subject seen once does
   * not leave durable state behind forever. This is what `expirationTtl` did
   * for the KV keys this replaces.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async currentCount(window: number): Promise<number> {
    const bucket = await this.ctx.storage.get<Bucket>(BUCKET_KEY);
    // A bucket from an earlier window reads as zero rather than being deleted:
    // the `put` below overwrites it, so the stale row costs nothing.
    return bucket?.window === window ? bucket.count : 0;
  }
}

function windowId(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / 1000 / windowSeconds);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
