/**
 * First-party reverse proxy for PostHog.
 *
 * ## Why this exists
 *
 * Three reasons, in descending order of honesty about their weight.
 *
 * 1. **Reliability.** The audience is developers, and a large share of them run
 *    content blockers. Analytics loaded from a PostHog origin is measured only
 *    on the users who do not block it, which biases every number toward the
 *    less technical half of the user base. Same-origin requests are not
 *    matched by those lists.
 * 2. **Page weight and pinning.** Serving the SDK from this origin lets it be
 *    version-pinned and cached immutably, so it is fetched once per release
 *    rather than re-validated on every full page load. See `SDK_PATH`.
 * 3. **CSP.** A nonce'd same-origin `<script src>` needs no `'self'` and no
 *    change to `script-src`. (`connect-src` turns out to be ungoverned
 *    already, because `contentSecurityPolicy` omits `default-src`, so the
 *    proxy is not required for the POSTs themselves.)
 *
 * Reason 1 deserves stating plainly rather than being left implicit in a
 * neutral-looking path: this is an MIT project, anyone can read this file, and
 * a reader who discovers the intent for themselves is entitled to conclude it
 * was hidden. `docs/user-guide/faq.md` names it, and `respect_dnt` is on.
 *
 * ## What this is not
 *
 * Not an open relay. Everything below the prefix is checked against a path
 * allowlist and a method allowlist before anything is forwarded, because the
 * alternative is an unauthenticated laundering endpoint running under this
 * origin and billed to whoever deployed it.
 */
import { Hono } from "hono";
import { PROXY_PREFIX, isSelfReferential, resolvePostHogRegion } from "../analytics/web";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "PostHogProxy" });

/**
 * PostHog ingestion paths this proxy will forward, and nothing else.
 *
 * `/e/` and `/i/v0/e/` are event capture, `/decide/` and `/flags/` are the
 * per-pageview config call, `/batch/` is the batched form. Session replay's
 * `/s/` is deliberately absent: replay is not shipped, so a request for it is
 * a bug or an abuse attempt, not traffic to relay.
 */
const INGEST_PREFIXES = ["/e", "/i/v0/e", "/decide", "/flags", "/batch"] as const;

/** Beacons and config calls only. */
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS"]);

/**
 * Cap on a forwarded body. Comfortably above a batched pageview payload and far
 * below anything worth relaying through someone else's Worker.
 */
const MAX_BODY_BYTES = 1_000_000;

/** Marks a request this proxy has already forwarded once; see `guardLoop`. */
const HOP_HEADER = "X-Stratum-Proxy";

/** Immutable: the URL carries the SDK version, so the bytes at it never change. */
const SDK_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Where the pinned SDK bundle is fetched from.
 *
 * jsDelivr rather than PostHog's asset host because the latter serves only a
 * floating `array.js`: pinning is what makes the response immutable-cacheable
 * and stops the bundle growing in a release nobody here chose. Verified
 * byte-identical in size to PostHog's current floating build.
 */
function sdkUpstream(version: string): string {
  return `https://cdn.jsdelivr.net/npm/posthog-js@${version}/dist/array.js`;
}

/**
 * Headers never forwarded upstream.
 *
 * `Cookie` is the load-bearing one. This proxy is same-origin by design, so the
 * browser attaches the Stratum session cookie to every analytics request;
 * httpOnly protects it from the SDK, not from us. Forwarding it would hand a
 * live session credential to a third party on every pageview.
 *
 * `Referer` is the subtle one, and it defeats every guarantee the snippet
 * makes. `Referrer-Policy: strict-origin-when-cross-origin` — which
 * `securityHeadersMiddleware` sets — sends the FULL url on a same-origin
 * subresource request, and this proxy is same-origin. So each capture POST
 * would arrive at PostHog carrying
 * `/@alice/private-repo/blob/main/src/secret.ts?ref=deadbeef` in a header,
 * bypassing `before_send` entirely at the transport layer.
 */
const STRIPPED_REQUEST_HEADERS = ["cookie", "authorization", "x-stratum-token", "referer"];

/** A telemetry beacon must never fail a page, so failures answer 204. */
function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Reject a request this proxy has already handled.
 *
 * `isSelfReferential` catches `POSTHOG_HOST` pointing at this origin, but not a
 * distinct hostname that CNAMEs back to the same Worker route — a normal
 * reverse-proxy arrangement that would otherwise loop until the subrequest
 * limit killed it.
 */
function guardLoop(request: Request): boolean {
  return request.headers.get(HOP_HEADER) !== null;
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  headers.delete("host");

  // Without this every event geolocates to whichever Cloudflare colo served it,
  // making country and region breakdowns meaningless. It is a deliberate choice
  // to forward one more piece of client data than strictly necessary, and it is
  // documented in the FAQ rather than made silently.
  // Dropped before the conditional set below: an inbound value is caller-chosen,
  // and forwarding it would let anyone pick their own country in PostHog. Behind
  // Cloudflare this is unreachable because the edge rewrites the header, but a
  // self-hoster behind a different proxy — or local dev — is not behind that.
  headers.delete("x-forwarded-for");
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);
  headers.set(HOP_HEADER, "1");
  return headers;
}

/** Strip anything that would let the upstream set state on this origin. */
function sanitizedResponse(upstream: Response, extra?: Record<string, string>): Response {
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const posthogProxyRouter = new Hono<{ Bindings: Env }>();

/**
 * The pinned SDK bundle.
 *
 * The version is in the path rather than read from `SDK_VERSION` directly so a
 * stale cached page requesting the previous version still gets a working
 * bundle through a deploy, instead of a 404 that silently ends analytics.
 */
posthogProxyRouter.get("/static/:version/array.js", async (c) => {
  const version = c.req.param("version");
  // Anything that is not a plain semver would be attacker-controlled path
  // material in a CDN URL.
  if (!/^\d+\.\d+\.\d+$/.test(version)) return c.notFound();

  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  let upstream: Response;
  try {
    upstream = await fetch(sdkUpstream(version));
  } catch (err) {
    logger.warn("SDK bundle fetch failed", { version, error: String(err) });
    return noContent();
  }
  if (!upstream.ok) {
    logger.warn("SDK bundle unavailable upstream", { version, status: upstream.status });
    return noContent();
  }

  const response = sanitizedResponse(upstream, {
    "Cache-Control": SDK_CACHE_CONTROL,
    "Content-Type": "application/javascript; charset=UTF-8",
  });
  // Cloudflare's cache is per-colo, so this is a hit-rate improvement rather
  // than a guarantee; the immutable Cache-Control above is what actually keeps
  // the byte count down, by keeping it in the user's browser.
  // The only awaited call here that is not already funnelled to 204. An
  // uncacheable upstream response makes `put` reject, and an unhandled
  // rejection would turn the SDK script into a 500.
  try {
    await cache?.put(cacheKey, response.clone());
  } catch (err) {
    logger.debug("Could not cache the SDK bundle", { error: String(err) });
  }
  return response;
});

/** Event capture and the per-pageview config call. */
posthogProxyRouter.all("/*", async (c) => {
  const request = c.req.raw;
  if (!ALLOWED_METHODS.has(request.method)) {
    logger.warn("Refused a non-beacon method", { method: request.method });
    return noContent();
  }
  if (guardLoop(request)) {
    logger.warn("Refusing a request this proxy already forwarded");
    return noContent();
  }

  const url = new URL(request.url);
  // The path below the prefix, e.g. "/e" from "/_ph/e".
  const suffix = url.pathname.slice(PROXY_PREFIX.length) || "/";
  const allowed = INGEST_PREFIXES.some((p) => suffix === p || suffix.startsWith(`${p}/`));
  if (!allowed) {
    // One of the three abuse signals this allowlist exists for. Logged so an
    // operator can see someone probing the prefix as a relay, rather than
    // finding out from a bill.
    logger.warn("Refused a path outside the ingestion allowlist", { suffix });
    return noContent();
  }

  const region = resolvePostHogRegion(c.env.POSTHOG_HOST);
  if (isSelfReferential(region.ingest, url.origin)) {
    logger.error("POSTHOG_HOST resolves to this instance; refusing to forward");
    return noContent();
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      logger.warn("Refused an oversized beacon", { bytes: body.byteLength });
      return noContent();
    }
  }

  const target = `${region.ingest}${suffix}${url.search}`;
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: forwardedHeaders(request),
      ...(body !== undefined ? { body } : {}),
    });
    return sanitizedResponse(upstream);
  } catch (err) {
    // Deliberately not rethrown. Reaching `app.onError` would emit an
    // `error_occurred` event per failed beacon — a telemetry storm caused by
    // telemetry being down.
    logger.warn("PostHog ingestion unreachable", { error: String(err) });
    return noContent();
  }
});

/**
 * Is this a request to the analytics proxy?
 *
 * Read by `analyticsMiddleware`, `csrfMiddleware` and `rateLimitMiddleware`,
 * each of which must leave this path alone for a different reason — see the
 * call sites.
 */
export function isPostHogProxyPath(path: string): boolean {
  return path === PROXY_PREFIX || path.startsWith(`${PROXY_PREFIX}/`);
}

/**
 * Is this the SDK bundle route, as opposed to an ingestion beacon?
 *
 * The distinction exists for the rate limiter. Ingestion must be exempt, or a
 * busy session rate-limits itself out of the app. The bundle route must NOT be:
 * it takes any semver, and a version jsDelivr does not have returns 204 without
 * caching, so an exempt route would be an unauthenticated outbound-fetch
 * amplifier billed to whoever deployed it.
 */
export function isPostHogSdkPath(path: string): boolean {
  return path.startsWith(`${PROXY_PREFIX}/static/`);
}
