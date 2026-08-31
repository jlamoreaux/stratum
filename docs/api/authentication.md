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
- **SCIM tokens**: `stratum_scim_xxxxx` — per-SSO-connection bearer accepted
  only by the SCIM endpoints under `/scim/v2` (which accept no other
  credential). Rotated by an org admin via
  `POST /api/orgs/{slug}/sso/scim-token`; the plaintext is returned exactly
  once.

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://your-instance.workers.dev/api/projects
```

## Session cookies

Signing in through the web UI (email magic link, GitHub OAuth, Google OAuth,
or single sign-on at `/auth/sso` for organizations with an enabled OIDC
connection) sets a `stratum_session` cookie, which authenticates browser
requests to the same endpoints.

## Anonymous access

Read endpoints on projects with `visibility: public` accept anonymous
requests. A small set of endpoints requires no authentication at all:

- `GET /health`, `GET /api/health`, `GET /api/health/simple` — liveness and
  dependency health checks
- `GET /api/users/check-username` — username availability
- `POST /api/webhooks/github` — the inbound GitHub webhook receiver, which is
  authenticated by HMAC signature (`X-Hub-Signature-256`) against the
  configured webhook secret rather than by a bearer token

## Admin API key

Administrator endpoints (metrics, audit, backup, restore, deletion jobs)
additionally accept an `X-Admin-API-Key` header carrying the instance's admin
API key, configured by the instance operator.

## Dev login

For local development:

```bash
curl http://localhost:8787/dev-login
```
