import type { Context, MiddlewareHandler } from "hono";
import { isGitHttpPath } from "../routes/git-http";
import type { Env } from "../types";

/**
 * CSP for the server-rendered UI and API. Exported so the request middleware and
 * the error boundary (src/index.ts) share ONE source of truth — a 500 response
 * must carry the same policy as a 200, and duplicating the string let them drift.
 */
export const CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'";

/**
 * Apply the static HTML security headers (content-type sniffing, framing,
 * referrer, CSP). Used by both the middleware and the error boundary so the two
 * paths stay identical. HSTS is applied separately — it is conditional on HTTPS.
 */
export function setHtmlSecurityHeaders(c: Context<{ Bindings: Env }>): void {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
}

/**
 * Response security headers for the server-rendered UI and API.
 *
 * The CSP is deliberately limited to directives that do NOT restrict inline
 * scripts: the UI ships inline `onclick` handlers and inline `<script>` blocks
 * (file-tree, conflict-resolution, import-progress), and inline event-handler
 * attributes cannot be nonce'd — a `script-src` policy would break them. So we
 * ship the script-safe subset now and defer `script-src` behind an
 * inline-handler nonce refactor (tracked in issue #161).
 *
 * `form-action 'self'` and `frame-src 'none'` are safe to add without that
 * refactor (all forms post same-origin; the UI embeds no iframes) and add real
 * defense-in-depth: they stop a would-be injection from exfiltrating via a
 * cross-origin form target or a smuggled iframe.
 *
 * Git smart-HTTP responses are left untouched — they are not HTML and must not
 * carry frame/CSP headers that could confuse git clients or proxies.
 */
export const securityHeadersMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Register headers BEFORE next() so they survive on the response even if a
  // downstream handler throws and the error boundary produces the 500. Git
  // smart-HTTP responses are not HTML and must stay untouched, so they are
  // skipped — the single await next() below still runs for them.
  if (!isGitHttpPath(c.req.path)) {
    setHtmlSecurityHeaders(c);

    // HSTS only over HTTPS (a plain-HTTP response with HSTS is ignored by
    // browsers and pointless; local http dev must stay usable).
    if (new URL(c.req.url).protocol === "https:") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  }

  await next();
};
