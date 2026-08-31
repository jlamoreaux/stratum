# Issues API

Issues are numbered per project and addressed by that number. See the
[Issues user guide](../../user-guide/issues.md) for the concepts, and the
[OpenAPI specification](../openapi.yml) for exact schemas.

## Open an Issue
`POST /api/projects/{namespace}/{slug}/issues`

Read access is enough to open an issue. Also accepts form-encoded bodies,
which redirect on success instead of returning JSON.

```json
{ "title": "…", "body": "…", "linkedChangeId": "chg_123" }
```

`title` max 200 chars, `body` max 20,000. `linkedChangeId` must reference a
change in the same project. `409 TARGET_DELETING` if the project is being
deleted.

## List Issues
`GET /api/projects/{namespace}/{slug}/issues`

Anonymous on public projects. Query parameters, all combinable:

| Parameter | Meaning |
|---|---|
| `status` | `open` or `closed` |
| `label` | Issues carrying this exact label |
| `assignee` | Issues assigned to this user id |
| `q` | Case-insensitive substring over title + body, max 200 chars (`%` and `_` are literal) |
| `limit` | Default 100, max 500 |
| `offset` | Rows to skip |

Ordered newest-first by issue number.

## Get an Issue
`GET /api/projects/{namespace}/{slug}/issues/{number}`

## Update an Issue
`PATCH /api/projects/{namespace}/{slug}/issues/{number}`

Requires **write** access. Only the fields present are written.

```json
{ "title": "…", "body": "…", "status": "closed",
  "assignee": "usr_abc", "labels": ["bug"], "linkedChangeId": null }
```

`labels` replaces the entire set (max 20 per issue, 50 chars each).
`assignee` and `linkedChangeId` accept `null` to clear.

## Close an Issue
`POST /api/projects/{namespace}/{slug}/issues/{number}/close`

Requires **write** access. No body. A convenience for the common case of
`PATCH {"status": "closed"}`.

Issues linked to a change also close **automatically** when that change merges,
attributed to `system`.

## Add a Comment
`POST /api/projects/{namespace}/{slug}/issues/{number}/comments`

Read access is enough. `body` max 20,000 chars.

## List Comments
`GET /api/projects/{namespace}/{slug}/issues/{number}/comments`

Paginated with `limit` (default 100, max 500) and `offset`.
