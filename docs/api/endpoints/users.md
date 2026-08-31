# Users API

Token management is covered in full — scopes, expiry, limits, and the legacy
credential — in [Authentication](../authentication.md).

## Get Current User
`GET /api/users`

Returns the authenticated user's profile.

## API tokens

All four endpoints below accept the **browser session cookie only**. An API
token calling them gets `403 SESSION_REQUIRED`, whatever its scope — a token
that could mint or revoke tokens would make revocation meaningless.

### List Tokens
`GET /api/users/me/tokens`

Shows each token's name, scope, expiry, `lastUsedAt`, and non-secret prefix.
The plaintext is never listed again.

### Create Token
`POST /api/users/me/tokens`

```json
{ "name": "buildkite", "scope": "read", "expiresInDays": 90 }
```

`scope` is `read` (default) or `read_write`. `expiresInDays` is 1–365; omit for
a token that never expires. The plaintext is returned **exactly once**, by this
call, with `Cache-Control: no-store`. `409 TOKEN_LIMIT_REACHED` past 20 active
tokens.

### Revoke Token
`DELETE /api/users/me/tokens/{id}`

Revoked rows are kept, so the audit trail survives revocation, and they do not
count toward the 20-token limit.

### Disable the Legacy Token
`POST /api/users/me/legacy-token/disable`

Permanently disables the single unnamed credential accounts had before scoped
tokens. Named tokens are unaffected. **Cannot be undone** — move anything still
using it onto a named token first.

### Rotate the Legacy Token
`POST /api/users/me/rotate-token`

Accepts a browser session or the legacy credential itself, but refuses a
**scoped** token with `SESSION_REQUIRED`.

## Delete Account
`DELETE /api/users/me`

GDPR-grade account erasure. Deletes the caller's account and **all** owned
projects, revokes all tokens/sessions (and the user's agents), and **anonymizes**
the user's contributions to *other* people's projects (author set to a
`deleted-user` tombstone — the contribution stays, the identity is removed).
Requires confirmation with the caller's own username:

```json
{ "confirm": "<your-username>" }
```

Setting deletion **immediately invalidates the caller's credentials** (subsequent
requests return `401`). Returns `202 Accepted` with
`{ "status": "deleting", "jobId": "del_…" }`; the cascade runs asynchronously and
always completes (org sole-ownership is auto-resolved, never blocking erasure). A
mismatched `confirm` returns `400`.
