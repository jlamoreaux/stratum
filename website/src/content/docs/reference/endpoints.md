---
title: Endpoints
description: The Stratum REST API surface — projects, workspaces, changes, agents, users, and organizations.
---

An overview of the REST API by resource. The complete, authoritative surface —
request/response schemas included — is the
[OpenAPI specification](/reference/openapi/).

## Projects

### List projects

`GET /api/projects`

### Create project

`POST /api/projects`

### Get project

`GET /api/projects/{namespace}/{slug}`

### Import from GitHub

`POST /api/projects/{namespace}/{slug}/import`

### Delete project

`DELETE /api/projects/{namespace}/{slug}`

Permanently deletes a project and **all** associated data (repo + workspace
forks, changes, issues, events, metrics, webhooks). **Owner-only.** The request
body must confirm the exact path:

```json
{ "confirm": "@namespace/slug" }
```

Returns `202 Accepted` with `{ "status": "deleting", "jobId": "del_…" }` — the
cascade runs asynchronously and is idempotent/resumable. A mismatched `confirm`
returns `400`; a non-owner returns `404`.

## Workspaces

### List workspaces

`GET /api/projects/{namespace}/{slug}/workspaces`

### Create workspace

`POST /api/projects/{namespace}/{slug}/workspaces`

### Commit changes

`POST /api/workspaces/{name}/commit`

## Changes

### List changes

`GET /api/projects/{name}/changes`

### Create change

`POST /api/projects/{name}/changes`

### Merge change

`POST /api/changes/{id}/merge`

## Agents

### List agents

`GET /api/agents`

### Create agent

`POST /api/agents`

### Get agent

`GET /api/agents/{id}`

## Users

### Get current user

`GET /api/users`

Returns the authenticated user's profile.

### Delete account

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

## Organizations

### List organizations

`GET /api/orgs`

### Create organization

`POST /api/orgs`
