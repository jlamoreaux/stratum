# auth.md — agent registration for Stratum

This document tells an AI agent how to obtain credentials for the Stratum API
and what those credentials are allowed to do.

## Audience

Autonomous coding agents, MCP clients, and CI integrations that need to read
projects, open changes, and merge approved work through the Stratum API at
`https://app.usestratum.dev`. Human contributors should use the
[web UI](https://app.usestratum.dev) instead.

## Read this first: Stratum is not an OAuth authorization server

Stratum issues **opaque bearer tokens**, not OAuth access tokens. There is no
`authorization_endpoint`, no `token_endpoint`, and no `jwks_uri`, which is why
no `/.well-known/oauth-authorization-server` document is published. Do not
attempt an OAuth authorization-code or client-credentials flow against this API —
it will fail. Follow the registration flow below instead.

GitHub OAuth and Google OAuth appear in Stratum only as *inbound sign-in
providers* for humans. They do not issue tokens for the Stratum API.

## Registration is delegated, not self-service

Agent identities are created by a human account holder. There is no anonymous
self-registration endpoint, and none is planned: an agent's authority in Stratum
is derived from a human's, and that link is the point.

**Do not probe `POST /api/agents` speculatively.** It creates a real identity and
issues a real credential. Only call it when a human has asked you to.

### Flow

1. **A human obtains a user token.** They sign in at
   `https://app.usestratum.dev` — email magic link, GitHub OAuth, or Google
   OAuth — and create or rotate a `stratum_user_...` token from the settings UI
   (`POST /api/users/me/rotate-token`).

2. **The human registers the agent identity.**

   ```bash
   curl -X POST https://app.usestratum.dev/api/agents \
     -H "Authorization: Bearer stratum_user_xxxxx" \
     -H "Content-Type: application/json" \
     -d '{"name": "refactor-bot"}'
   ```

   The response carries a short-lived `stratum_agent_...` token.

3. **The agent receives the token out of band** — an environment variable, a
   secret store, an MCP server `env` block. It is never transmitted to the agent
   by Stratum directly.

## Using the credential

| | |
|---|---|
| Credential type | Opaque bearer token |
| Prefix | `stratum_agent_` (agents), `stratum_user_` (humans) |
| Transport | `Authorization: Bearer <token>` header |
| Alternative | `stratum_session` cookie — browsers only, not for agents |
| Scopes | None. Stratum has no scope model; authority is the owning user's access. |
| Lifetime | Short-lived. Re-request on `401`; never retry a stale token in a loop. |

```bash
curl -H "Authorization: Bearer $STRATUM_API_KEY" \
  https://app.usestratum.dev/api/projects
```

Call `GET /api/users/me` once at startup to confirm which identity you hold.

## Revocation

Revoke an agent credential with `DELETE /api/agents/{agent_id}`, authenticated as
the owning user. That is the only thing that revokes it:

- **`POST /api/users/me/rotate-token` does not.** It replaces the *user's* token
  and leaves every agent credential the account owns working.
- **Agent credentials do not expire.** There is no TTL on them; they are valid
  until the agent is deleted or the owning account is.
- **An agent cannot revoke itself.** An `stratum_agent_…` credential does not
  authenticate as a user, so both endpoints above answer it with `401`.

There is no webhook for revocation events; treat a `401` as authoritative and
stop.

## What the credential may not do

- **It can never approve a change.** Reviews are human-only across REST, CLI, and
  MCP. There is no configuration that relaxes this, and no user token you may
  hold for another purpose makes it acceptable to route around.
- **It cannot exceed the owning user's access**, including org access.
- **It cannot force-merge past a failing gate** unless the project's
  `.stratum/policy.yaml` sets `allowForce: true`. Force-merge is deny-by-default.

## No credential required

`GET /health`, `GET /api/health`, `GET /api/health/simple`,
`GET /api/users/check-username`, and read endpoints on projects with
`visibility: public`.

`POST /api/webhooks/github` is authenticated by HMAC signature
(`X-Hub-Signature-256`), not by a bearer token.

## Skills

- [Getting a Stratum agent identity](https://docs.usestratum.dev/.well-known/agent-skills/stratum-agent-identity/SKILL.md)
- [Getting a change through the merge gate](https://docs.usestratum.dev/.well-known/agent-skills/stratum-merge-gate/SKILL.md)
- [Using Stratum over MCP](https://docs.usestratum.dev/.well-known/agent-skills/stratum-mcp/SKILL.md)

## See also

- [Authentication reference](https://docs.usestratum.dev/reference/authentication/)
- [OpenAPI specification](https://docs.usestratum.dev/openapi.yml)
- [Agent discovery index](https://docs.usestratum.dev/.well-known/ai-catalog.json)
