import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { LICENSE_URL, STRATUM_SOURCE_URL } from "../ui/components/source-footer";

/**
 * The AGPL-3.0 §13 source offer for callers who never receive an HTML page.
 *
 * The page footer covers browsers. It does not cover the REST API, the `/mcp`
 * endpoint, or anything else that answers with JSON — and §13 reaches "all
 * users interacting with [the Program] remotely through a computer network",
 * not only the ones looking at markup. An agent driving Stratum entirely over
 * `/mcp` is such a user, and before this middleware it was offered nothing.
 *
 * Headers, because they are the only channel every response shares:
 *
 * - `Link: <…>; rel="license"` is the registered relation for this (RFC 8288 /
 *   RFC 4946), and points at the license text.
 * - `X-Source-Code` carries where to obtain the Corresponding Source. There is
 *   no registered relation that means "the source of the running program", and
 *   inventing a `rel` would be less legible than a header that says what it is.
 *   Several AGPL services use this same name.
 *
 * A self-hoster running modifications repoints `STRATUM_SOURCE_URL` and both
 * this and the footer follow; there is nothing separate to configure.
 *
 * Git smart-HTTP responses are skipped for the same reason
 * `securityHeadersMiddleware` skips them: git clients and proxies get exactly
 * the bytes they expect, and a `git clone` is already receiving the source.
 */
const isGitHttpPath = (path: string): boolean =>
  path.endsWith("/info/refs") ||
  path.endsWith("/git-upload-pack") ||
  path.endsWith("/git-receive-pack");

export const sourceOfferMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Set before next() so the offer survives a downstream throw and rides on the
  // error response too — an error page is still a network interaction.
  if (!isGitHttpPath(c.req.path)) {
    c.header("Link", `<${LICENSE_URL}>; rel="license"`);
    c.header("X-Source-Code", STRATUM_SOURCE_URL);
  }

  await next();
};
