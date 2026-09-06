/**
 * The 80% banner: the same crossing the email announces, shown on the pages a
 * signed-in user actually visits (PRD §8, Task 9.3).
 *
 * ## Why it is a stored receipt and not a computed check
 *
 * "Are you near a limit?" is a question about D1 (`usage_periods`) and the
 * billing service, and asking it on every page render would put a database
 * read and an entitlements lookup in front of every dashboard, project and
 * change page — for a banner that is absent for almost everyone, almost
 * always. So nothing is computed here. `usage-notifications.ts` already
 * detects the crossing exactly once, on the write that causes it, from the
 * totals `upsertUsage` returns; {@link recordUsageBanner} stores what it
 * found, and rendering costs **one KV `get`** and no D1 at all.
 *
 * The cost is bounded further: {@link loadUsageBanner} returns immediately —
 * with no KV read whatsoever — when there is no signed-in user or when
 * `entitlementsEnabled` is false, so a self-hoster's pages are byte-for-byte
 * as cheap as before.
 *
 * ## Users only
 *
 * There is no org UI in this application, so an org's threshold reaches its
 * actor by email alone (PRD §8). A banner is therefore written only when the
 * enforcement subject IS a user, and is keyed on that user.
 *
 * ## What it costs in freshness, stated rather than discovered
 *
 * The stored notice is a snapshot of the crossing. Usage cannot go down within
 * a period, so it never becomes optimistic; it can become pessimistic if the
 * account's limit is RAISED mid-period, in which case the banner overstates
 * until the period rolls. That is the same staleness the email's receipt
 * already accepts, and the alternative — re-reading entitlements per page —
 * is the cost this design exists to avoid.
 */
import type { MeterKey } from "../storage/usage";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import { entitlementsEnabled } from "./entitlements";

/** What a rendered banner says. Stored verbatim; every field is display data. */
export interface UsageBannerNotice {
  meter: MeterKey;
  /** Hosted consumption at the moment of the crossing. */
  used: number;
  /** The limit in force then. See the freshness note in the module doc. */
  limit: number;
  /** The threshold that was crossed, as a percentage (80). */
  percent: number;
  /** 'YYYY-MM' UTC — the period the figures belong to. */
  period: string;
}

/** Versioned like the entitlements cache: a shape change must not read back as the old shape. */
const BANNER_PREFIX = "usage-banner:v1:";

/**
 * A month plus the grace the meter itself allows. The period is IN the key, so
 * a new month silently reads as "no banner" without anything sweeping the old
 * one; the TTL is only what stops KV accumulating them forever.
 */
const BANNER_TTL_SECONDS = 40 * 24 * 60 * 60;

function bannerKey(userId: string, period: string): string {
  return `${BANNER_PREFIX}${userId}:${period}`;
}

/**
 * Store the crossing so the next page render can show it.
 *
 * Best-effort by contract, like everything on the notification path: a banner
 * that cannot be written must never fail the merge whose usage produced it.
 */
export async function recordUsageBanner(
  env: Env,
  logger: Logger,
  userId: string,
  notice: UsageBannerNotice,
): Promise<void> {
  if (!env.STATE || !userId) return;
  try {
    await env.STATE.put(bannerKey(userId, notice.period), JSON.stringify(notice), {
      expirationTtl: BANNER_TTL_SECONDS,
    });
  } catch (error) {
    logger.warn("Usage banner could not be stored", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The banner to render for this user right now, or `null`.
 *
 * One KV read, and none at all when the seam is off or nobody is signed in.
 * Every failure and every unrecognised value resolves to `null`: a page is not
 * worth failing for a notice, and a half-parsed one would render nonsense.
 *
 * @param userId - The signed-in user; agents are not shown pages
 * @param period - 'YYYY-MM' UTC; the caller passes the period it is rendering
 */
export async function loadUsageBanner(
  env: Env,
  logger: Logger,
  userId: string | undefined,
  period: string,
): Promise<UsageBannerNotice | null> {
  if (!userId) return null;
  if (!entitlementsEnabled(env)) return null;
  if (!env.STATE) return null;
  try {
    const raw = await env.STATE.get(bannerKey(userId, period));
    if (!raw) return null;
    return parseNotice(JSON.parse(raw), period);
  } catch (error) {
    logger.debug("Usage banner unreadable; rendering without it", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Validated on the way out, not trusted because we wrote it: the entry outlives
 * deploys, and a notice from an older shape must vanish rather than render as
 * "NaN% of undefined".
 */
function parseNotice(value: unknown, period: string): UsageBannerNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { meter, used, limit, percent } = record;
  if (typeof meter !== "string") return null;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || !Number.isFinite(percent)) return null;
  if ((limit as number) <= 0) return null;
  return {
    meter: meter as MeterKey,
    used: used as number,
    limit: limit as number,
    percent: percent as number,
    // The key already pins the period; echoing the caller's keeps a mismatched
    // stored value from being displayed against the month it was not about.
    period,
  };
}
