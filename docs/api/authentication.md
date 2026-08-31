# Authentication

Most API endpoints accept a Stratum API token as an
`Authorization: Bearer <token>` header. Browser requests may instead be
authenticated by the `stratum_session` cookie. The
[OpenAPI specification](openapi.yml) marks the exact security requirements per
endpoint.

## API tokens

For programmatic access:

- **User tokens**: `stratum_user_xxxxx` — named, scoped, independently
  revocable, and optionally expiring. Created from the settings UI or
  `POST /api/users/me/tokens`.
- **Agent tokens**: `stratum_agent_xxxxx` — issued to an agent, tied to the
  owning user's access, and attributed to the agent in provenance. They do
  **not** expire and are not scoped. Within the access they inherit they can
  read, fork workspaces, commit, open changes, comment, and open issues — but
  every **deciding** endpoint requires a user identity and refuses an agent
  token: review verdicts (approve and request-changes alike), merge, reject,
  re-evaluate, GitHub PR promotion, and issue editing/closing. Session-only
  endpoints (token management) refuse agent and scoped tokens alike — the one
  exception is `rotate-token`, [below](#the-legacy-token). Revoke one by
  deleting the agent (settings UI, or `DELETE /api/agents/{id}`).

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://your-instance.workers.dev/api/projects
```

### Scopes

Every user token carries exactly one scope, chosen when it is created:

| Scope | What it can do |
|---|---|
| `read` (default) | `GET` and `HEAD` requests, and `git clone` / `git fetch` over HTTPS. Nothing else. |
| `read_write` | Everything its owner can do through the API and git. |

A `read` token is refused on **every** request that is not a `GET` or a `HEAD`,
with `403` and the code `TOKEN_SCOPE_INSUFFICIENT`. The check runs before
routing, on an allow-list of methods, so no endpoint can forget it and a reason
expressed as a `POST` gets no exception. Over git, the same rule is applied to
the operation the server resolves rather than to the URL: a `read` token clones
and fetches, and is refused on `git push` to both the project and the workspace
remote — including the `info/refs?service=git-receive-pack` advertisement that
precedes it.

Read-only bounds *damage*, not *exposure*: a `read` token still reads every
private project its owner can read. Sessions and agent tokens are unaffected by
scopes.

### Expiry and limits

- `expiresInDays` is an integer from **1 to 365**; omit it for a token that
  never expires. Expiry is checked on every authentication, against the time of
  the request.
- An expired or revoked token is a `401` everywhere — API and git alike.
  Revoked rows are kept, so the audit trail survives revocation.
- Each user may hold **20 active tokens**. The 21st is a `409`
  (`TOKEN_LIMIT_REACHED`). Revoked tokens do not count towards the limit, so
  rotating never locks you out.
- `lastUsedAt` records when a token last authenticated, written at most once an
  hour. It is **not** written on the git smart-HTTP path, which has no
  execution context to defer the write to — so a token used only for `git
  clone` can show as never used.

### Managing tokens requires a session

`GET|POST /api/users/me/tokens`, `DELETE /api/users/me/tokens/{id}` and
`POST /api/users/me/legacy-token/disable` accept the `stratum_session` cookie
**only**. An API token calling them gets `403 SESSION_REQUIRED`, whatever its
scope. A token that could mint tokens, revoke its siblings, or turn off the
legacy credential would make revocation meaningless — a lost machine would
simply issue itself a replacement.

The plaintext is returned exactly once, by the call that creates it, with
`Cache-Control: no-store`. It is never stored and never listed again; a listing
shows only the non-secret prefix (e.g. `stratum_user_1a2b3c4d`), which is enough
to recognise a credential sitting in a CI config.

```bash
# Create a read-only token that expires in 90 days (session cookie required)
curl -X POST https://your-instance.workers.dev/api/users/me/tokens \
  -b "stratum_session=..." -H "Content-Type: application/json" \
  -d '{"name":"buildkite","scope":"read","expiresInDays":90}'
```

### The legacy token

**Every** account carries a single unnamed credential on the user row — it is
minted at signup, though the plaintext is discarded unseen, so on a new account
it sits inert until `POST /api/users/me/rotate-token` mints and returns a fresh
one. Only accounts from before scoped tokens may have seen theirs. The
credential works with `read_write` access and never expires. It is legacy for a
reason: it has no name, no scope, no expiry, and no last-used record, rotating
it invalidates whatever else is using it — and any account can activate it, so
"we predate scoped tokens" is not the only way to end up depending on one.
Prefer named scoped tokens for everything.

`POST /api/users/me/legacy-token/disable` (or the button in the settings UI)
makes it permanently unusable, by rotating it to a value that is never returned
to anyone. Named API tokens are unaffected. Move anything still using the legacy
credential onto a named token first — disabling it cannot be undone, though
`rotate-token` will mint a fresh legacy credential if you truly need one.

`rotate-token` accepts a browser session or the legacy credential itself, but
refuses a **scoped** token with `SESSION_REQUIRED`. The key it mints never
expires and cannot be revoked one at a time, so letting a scoped token rotate it
would mean revoking that token contained nothing — it could have issued itself a
permanent replacement on the way out.

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

## Admin API key

Administrator endpoints (metrics, audit, backup, restore, deletion jobs)
additionally accept an `X-Admin-API-Key` header carrying the instance's admin
API key, configured by the instance operator.

## Dev login

For local development:

```bash
curl http://localhost:8787/dev-login
```
