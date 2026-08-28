import { MagicLinkRateLimiter } from "../../src/queue/magic-link-limiter";
import type { Env } from "../../src/types";
import { type FakeDurableObjectStorage, makeFakeDurableObjects } from "./fake-durable-object";

export interface FakeMagicLinkLimiters {
  /** Typed exactly as `Env` declares the binding, so no call site casts. */
  namespace: NonNullable<Env["MAGIC_LINK_LIMITER"]>;
  instances: Map<string, MagicLinkRateLimiter>;
  storages: Map<string, FakeDurableObjectStorage>;
  calls: string[];
}

/**
 * A fake namespace backed by real {@link MagicLinkRateLimiter} instances.
 *
 * The one cast lives here rather than at each call site. `makeFakeDurableObjects`
 * is generic and cannot know the RPC brand of whichever class it constructs, so
 * something has to assert it; doing that once means a signature change in the
 * Durable Object is a compile error in the tests instead of being absorbed by
 * four separate hand-written stub types.
 *
 * @param opts - `gated` (default true) models workerd's input gate
 * @returns The namespace plus the harness's instances, storages, and RPC log
 */
export function makeMagicLinkLimiters(opts: { gated?: boolean } = {}): FakeMagicLinkLimiters {
  const fake = makeFakeDurableObjects((ctx) => new MagicLinkRateLimiter(ctx, {} as Env), opts);
  return {
    ...fake,
    namespace: fake.namespace as unknown as NonNullable<Env["MAGIC_LINK_LIMITER"]>,
  };
}
