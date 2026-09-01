/**
 * The `WWW-Authenticate` challenge the MCP endpoint answers with (#349).
 *
 * RFC 9728 makes this header the whole discovery story for a protected
 * resource: a client that gets a bare 401 knows only that it failed, while a
 * client that gets one carrying `resource_metadata` knows exactly where to go
 * to register and authorize. That is what lets someone paste a URL into their
 * editor and have the OAuth flow start on its own, with nothing else
 * configured — so this header is load-bearing UX, not decoration.
 */

/** Where the protected-resource metadata lives, derived from the request so a
 * self-hosted instance advertises its own origin rather than the maintainer's.
 */
export function protectedResourceMetadataUrl(requestUrl: string): string {
  return new URL("/.well-known/oauth-protected-resource", requestUrl).toString();
}

/** Where the authorization-server metadata lives (RFC 8414). */
export function authorizationServerMetadataUrl(requestUrl: string): string {
  return new URL("/.well-known/oauth-authorization-server", requestUrl).toString();
}

/** The canonical resource identifier clients pass as RFC 8707 `resource`. */
export function mcpResourceIdentifier(requestUrl: string): string {
  return new URL("/mcp", requestUrl).toString();
}

/**
 * Builds a `Bearer` challenge.
 *
 * Values are emitted as quoted-strings, so anything that would terminate one —
 * a quote or a backslash — is stripped rather than escaped. A description is
 * assembled from our own message strings today, but stripping means a future
 * caller that passes something client-controlled cannot inject a second
 * auth-param, and losing a character from an English sentence costs nothing.
 */
export function buildAuthenticateChallenge(
  requestUrl: string,
  error: "invalid_token" | "insufficient_scope" | "invalid_request",
  description: string,
): string {
  const quoted = (value: string) => `"${value.replace(/["\\]/g, "")}"`;
  return [
    "Bearer",
    [
      `error=${quoted(error)}`,
      `error_description=${quoted(description)}`,
      `resource_metadata=${quoted(protectedResourceMetadataUrl(requestUrl))}`,
    ].join(", "),
  ].join(" ");
}
