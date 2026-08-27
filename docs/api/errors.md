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

## Machine-readable error codes

- `AUTH_REQUIRED` — authentication needed
- `PROJECT_NOT_FOUND` — project doesn't exist
- `RATE_LIMITED` — too many requests
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
- `SUBMODULES_UNSUPPORTED` — a gitlink entry and/or `.gitmodules` file was
  found on import, or in the workspace a change is being created from — a
  gated push and `POST /api/projects/{name}/changes` alike, since both run the
  same scan; git submodules are not supported
  (see [Importing from GitHub](../user-guide/importing.md#unsupported-content))
