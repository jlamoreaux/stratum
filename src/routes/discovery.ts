import { Hono } from "hono";
import type { Env } from "../types";

/**
 * Agent discovery surface: /auth.md plus the OAuth discovery documents that
 * point agents at it. Everything here is public, read-only metadata — the
 * documents describe how to obtain credentials but never issue any themselves.
 *
 * All URLs are derived from the request origin so the same code serves the
 * hosted instance, staging, and any self-hosted deployment unchanged.
 *
 * Companion pieces:
 * - docs/runbooks/dns-aid.md — the DNS-AID (`_agents` namespace) records that
 *   make this endpoint discoverable from the bare domain
 * - scripts/publish-dns-aid.ts — publishes those records via the Cloudflare API
 */

const app = new Hono<{ Bindings: Env }>();

/** Shared cache policy: public metadata, safe to cache for an hour. */
const CACHE_CONTROL = "public, max-age=3600";

/**
 * Stratum's two bearer-credential classes, advertised as scope identifiers.
 * These are not requestable OAuth scopes (Stratum has no authorization
 * endpoint); they name the credential classes documented in /auth.md.
 */
const SCOPES = ["api", "api:agent"];

const AGENTS_DOC_URL =
  "https://github.com/stratum-eng/stratum/blob/main/docs/api/endpoints/agents.md";

function authMd(origin: string): string {
  return `# auth.md — agent authentication for Stratum

This document tells AI agents (and the humans operating them) how to obtain and
use credentials for the Stratum instance at ${origin}.

Machine-readable companions:

- \`${origin}/.well-known/oauth-protected-resource\`
- \`${origin}/.well-known/oauth-authorization-server\` (see its \`agent_auth\` block)

## Who this is for

Stratum is a governance layer for AI-written code. Agents are **first-class,
named identities**: they authenticate as themselves, and every write they make
is attributed to them in provenance records. One invariant is load-bearing and
worth knowing before you register:

> **Agents can never approve changes.** Approvals are a human-only gate, on
> every surface (REST, git, MCP). An agent token can propose, commit, and
> request changes — it cannot approve anything, including its own work.

## Credential classes

| Credential | Prefix | Who holds it | Powers |
|---|---|---|---|
| User token | \`stratum_user_\` | A human operator | Full API for that account, including approvals |
| Agent token | \`stratum_agent_\` | An agent | Scoped to the owning user's access; **cannot approve** |

Both are bearer tokens sent as \`Authorization: Bearer <token>\`. Treat them as
secrets; they are shown once at creation.

## Registration

Agent registration is **operator-mediated** (\`service_auth\` in the
\`agent_auth\` metadata): an existing account credential is required, so a
passive scan or anonymous request can never mint credentials.

1. **Operator account.** A human signs up at ${origin}/auth/signup
   (email magic link, GitHub, or Google).
2. **Operator token.** Create/rotate a user API token from the settings UI or
   \`POST ${origin}/api/users/me/rotate-token\`.
3. **Register the agent:**

   \`\`\`bash
   curl -X POST ${origin}/api/agents \\
     -H "Authorization: Bearer stratum_user_..." \\
     -H "Content-Type: application/json" \\
     -d '{"name": "my-agent", "model": "your-model-id", "description": "what it does"}'
   \`\`\`

   The response contains the agent identity and a one-time-visible
   \`stratum_agent_...\` token. \`model\`, \`description\`, and \`promptHash\`
   are optional but feed provenance records — set them if you can.
4. **Use it.** Send \`Authorization: Bearer stratum_agent_...\` on API calls,
   git-over-HTTP, or via the MCP server (\`@stratum/mcp\`, \`STRATUM_API_KEY\`).

## Revocation

- Delete the agent (revokes its token): \`DELETE ${origin}/api/agents/{agent_id}\`
  with the owner's user token.
- Rotate a compromised **user** token: \`POST ${origin}/api/users/me/rotate-token\`.

## Notes for OAuth-speaking clients

Stratum is not an OAuth authorization server: there is no authorization or
token endpoint, and no dynamic client registration. The
\`oauth-authorization-server\` document exists to carry the \`agent_auth\`
registration metadata above; its grant lists are intentionally empty.

Full API reference: ${AGENTS_DOC_URL}
`;
}

app.get("/auth.md", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(authMd(origin), 200, {
    "Content-Type": "text/markdown; charset=UTF-8",
    "Cache-Control": CACHE_CONTROL,
  });
});

/** OAuth 2.0 Protected Resource Metadata (RFC 9728). */
app.get("/.well-known/oauth-protected-resource", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      resource: origin,
      authorization_servers: [origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Stratum",
      resource_documentation: `${origin}/auth.md`,
    },
    200,
    { "Cache-Control": CACHE_CONTROL },
  );
});

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414), published for its
 * `agent_auth` extension (https://github.com/workos/auth.md). Stratum runs no
 * OAuth flows as an authorization server — tokens are provisioned over the
 * API — so the standard grant/response lists are honestly empty rather than
 * pointing at endpoints that do not exist.
 */
app.get("/.well-known/oauth-authorization-server", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      issuer: origin,
      service_documentation: `${origin}/auth.md`,
      scopes_supported: SCOPES,
      grant_types_supported: [],
      response_types_supported: [],
      token_endpoint_auth_methods_supported: [],
      agent_auth: {
        skill: `${origin}/auth.md`,
        register_uri: `${origin}/api/agents`,
        identity_types_supported: ["service_auth"],
        credential_types_supported: ["bearer_token"],
        registration_methods: [
          {
            identity_type: "service_auth",
            method: "POST",
            uri: `${origin}/api/agents`,
            auth: "Authorization: Bearer <stratum_user_... operator token>",
            request_fields: {
              name: "required — agent display name",
              model: "optional — model identifier, recorded in provenance",
              description: "optional",
              promptHash: "optional — hash of the system prompt, recorded in provenance",
            },
            credential: {
              type: "bearer_token",
              prefix: "stratum_agent_",
              usage: "Authorization: Bearer <token>",
              constraints: "Scoped to the owning user; can never approve changes",
            },
          },
        ],
        claim_uri: `${origin}/auth/signup`,
        revocation_uri: `${origin}/api/agents/{agent_id}`,
        revocation_method: "DELETE",
        documentation: AGENTS_DOC_URL,
      },
    },
    200,
    { "Cache-Control": CACHE_CONTROL },
  );
});

export { app as discoveryRouter };
