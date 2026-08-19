# Authentication

Most API endpoints accept a Stratum API token as an
`Authorization: Bearer <token>` header. Browser requests may instead be
authenticated by the `stratum_session` cookie. The
[OpenAPI specification](openapi.yml) marks the exact security requirements per
endpoint.

## API tokens

For programmatic access:

- **User tokens**: `stratum_user_xxxxx` — created and rotated from the
  settings UI (or `POST /api/users/me/rotate-token`).
- **Agent tokens**: `stratum_agent_xxxxx` — short-lived, scoped to the owning
  user, and attributed to the agent in provenance. Agent tokens can never
  approve changes, on any surface.

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://your-instance.workers.dev/api/projects
```

## Session cookies

Signing in through the web UI (email magic link, GitHub OAuth, or Google
OAuth) sets a `stratum_session` cookie, which authenticates browser requests
to the same endpoints.

## Anonymous access

Read endpoints on projects with `visibility: public` accept anonymous
requests. A small set of endpoints requires no authentication at all:

- `GET /health`, `GET /api/health`, `GET /api/health/simple` — liveness and
  dependency health checks
- `GET /api/users/check-username` — username availability
- `POST /api/webhooks/github` — the inbound GitHub webhook receiver, which is
  authenticated by HMAC signature (`X-Hub-Signature-256`) against the
  configured webhook secret rather than by a bearer token
- `GET /auth.md`, `GET /.well-known/oauth-protected-resource`,
  `GET /.well-known/oauth-authorization-server` — public agent-discovery
  metadata (see [Agent discovery](#agent-discovery))

## Agent discovery

Agents that land on an instance cold can bootstrap without prior knowledge:

- **`/auth.md`** — a Markdown guide to registering an agent identity and using
  Stratum credentials, with all URLs derived from the instance's own origin.
- **`/.well-known/oauth-protected-resource`** ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728))
  and **`/.well-known/oauth-authorization-server`** ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)) —
  machine-readable metadata; the latter carries an `agent_auth` block
  ([auth.md](https://github.com/workos/auth.md)) describing the registration
  endpoint (`POST /api/agents`), identity/credential types, and revocation.
  Stratum runs no OAuth flows as an authorization server, so the standard
  grant lists are intentionally empty.

At the DNS layer, DNS-AID records under `_agents.<domain>` point agents at the
instance before any HTTP request — see
[docs/runbooks/dns-aid.md](../runbooks/dns-aid.md).

## Admin API key

Administrator endpoints (metrics, audit, backup, restore, deletion jobs)
additionally accept an `X-Admin-API-Key` header carrying the instance's admin
API key, configured by the instance operator.

## Dev login

For local development:

```bash
curl http://localhost:8787/dev-login
```
