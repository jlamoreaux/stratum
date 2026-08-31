# Error Codes

Errors are returned as JSON: `{ "error": "<human-readable message>" }`, with a
machine-readable `code` field present on some errors. The per-endpoint status
codes are in the [OpenAPI specification](openapi.yml).

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 202 | Accepted — the work runs asynchronously (e.g. project/account deletion) |
| 302 | Redirect — form-encoded requests to form-friendly endpoints redirect instead of returning JSON |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict — merge staleness and merge conflicts (see codes below) |
| 410 | Gone — the resource was deleted |
| 422 | Unprocessable — the request was understood but cannot be applied |
| 429 | Rate Limited |
| 500 | Server Error |
| 501 | Not Implemented |
| 502 | Bad Gateway — an upstream provider call failed |
| 503 | Service Unavailable |
| 504 | Gateway Timeout — an operation exceeded its bound (see `PUSH_TIMEOUT`) |

## Machine-readable error codes

- `AUTH_REQUIRED` — authentication needed
- `PROJECT_NOT_FOUND` — project doesn't exist
- `RATE_LIMITED` — too many requests
- `TOKEN_SCOPE_INSUFFICIENT` — a `read` token was used for a write. Returned
  `403`, checked before routing on the HTTP method, and applied over git to the
  resolved operation (so `git push` and its `git-receive-pack` advertisement are
  refused too)
- `TOKEN_LIMIT_REACHED` — `409`; the account already holds 20 active tokens.
  Revoked tokens do not count toward the limit
- `SESSION_REQUIRED` — `403`; the endpoint accepts the browser session cookie
  only. Applies to token management (`/api/users/me/tokens`,
  `legacy-token/disable`) and to `rotate-token` when called with a scoped token
- `SESSION_EXPIRED` — the browser session is no longer valid
- `SYNC_DIVERGED` — the upstream and the Stratum copy have genuinely diverged in
  content. The fetch window is deepened incrementally first, so this is a real
  conflict rather than a too-shallow clone
- `PINNED_SHA_UNREACHABLE` — the pinned commit is not reachable in the clone
- `PUSH_TIMEOUT` — `504` during restore. The push **may still land** — do not
  assume it failed
- `STALE_BASE` — the change's recorded base is behind the project HEAD
  (`merge.requireFreshBase`); re-evaluate on the new base
- `STALE_WORKSPACE` — the workspace advanced after evaluation; the merge is
  rejected so unevaluated commits can never land
- `WORKSPACE_UNVERIFIABLE` — the workspace state could not be verified against
  what was evaluated
- `MERGE_CONFLICT` — the merge produced conflicts; the response includes a
  conflict id for `POST /api/projects/conflicts/{id}/resolve`
- `PROTECTION_BLOCKED` — the merge is blocked by branch protection; the
  response lists the `reasons`
- `TARGET_DELETING` — the project (or its owner) is being deleted
- `NOT_REDRIVABLE` — the deletion job is not in an incomplete state
- `GONE` — the resource was deleted
- `INVALID_PATH` — the requested path is invalid
- `AMBIGUOUS_REF` — `409`; a `?ref=` names something that is both a branch and a
  tag, so the read is refused rather than guessing
- `BRANCH_EXISTS` — `409`; a branch of that name already exists
- `BRANCH_NAME_CONFLICT` — `409`; the name collides with an existing ref *path*
  (`release` when `release/2.x` exists — git stores refs as paths)
- `NO_DEFAULT_BRANCH` — `409`; the configured default branch is not advertised
  by the remote, so there is nothing to default a start point to
- `DEFAULT_BRANCH_PROTECTED` — `409`; the default branch cannot be deleted
- `SUBMODULES_UNSUPPORTED` — a gitlink entry (any depth) and/or a root-level
  `.gitmodules` file was found on import, or in the workspace a change is being
  created from — a gated push and `POST /api/projects/{name}/changes` alike,
  since both run the same scan; git submodules are not supported
  (see [Importing from GitHub](../user-guide/importing.md#unsupported-content)).
  This code is internal and is **not** returned to API clients as a code:
  `POST /api/projects/{name}/changes` reports it as a plain 400 carrying the
  explanatory message, a gated push reports it over the git protocol as a
  per-ref `ng` reason, and an import records a `failed` queue job. Match on the
  message, not on this identifier.
