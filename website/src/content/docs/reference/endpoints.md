---
title: Endpoints
description: "The Stratum REST API surface — projects, branches, workspaces, changes, reviews, issues, deployments, agents, users, and organizations."
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

See [Importing from GitHub](/guides/importing/) for options, progress
tracking, and sync.

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

## Branches

### List branches

`GET /api/projects/{namespace}/{slug}/branches`

Returns `{ defaultBranch, branches: [{ name, oid }], truncated, totalBranchCount }`.
Read from the remote's ref advertisement, so the cost does not grow with the
branch count. Capped at 200 — `truncated` says so explicitly, and the default
branch is never the entry dropped.

### Create branch

`POST /api/projects/{namespace}/{slug}/branches`

```json
{ "name": "release/2.x", "startPoint": "trunk" }
```

`startPoint` may be a branch name or a full 40-character commit sha, and
defaults to the default branch's tip. Short shas and **tag names** are refused.
The new ref can only point at an object the repository already holds, so branch
creation cannot introduce content that has not passed the change gate.

**Writers only** (a non-writer gets `404`). Three distinct `409`s:
`BRANCH_EXISTS`, `BRANCH_NAME_CONFLICT` (a collision with an existing ref path —
`release` when `release/2.x` exists), and `NO_DEFAULT_BRANCH`.

### Delete branch

`DELETE /api/projects/{namespace}/{slug}/branches/{name}`

Hierarchical names are passed as real path segments
(`.../branches/release/2.x`). **Writers only.** The default branch cannot be
deleted — `409 DEFAULT_BRANCH_PROTECTED`.

### Browsing a branch

`GET .../files`, `.../content`, and `.../log` accept `?ref=<branch>`, defaulting
to the project's default branch. Branch names only: an unknown ref is a `404`
(never a silent fall back to the default), and a name that is both a branch and
a tag is a `409 AMBIGUOUS_REF`. The response echoes the `ref` actually read.

## Workspaces

### List workspaces

`GET /api/workspaces/{namespace}/{slug}/workspaces`

### Create workspace

`POST /api/workspaces/{namespace}/{slug}/workspaces`

### Commit changes

`POST /api/workspaces/{name}/commit`

## Changes

### List changes

`GET /api/projects/{name}/changes`

### Create change

`POST /api/projects/{name}/changes`

Evaluation runs **synchronously** at creation.

### Get change

`GET /api/changes/{id}`

### Re-evaluate

`POST /api/changes/{id}/evaluate`

Users only. Merged, rejected, and promoted changes cannot be re-evaluated.
Re-evaluation runs under the current evaluator defaults, so a change that passed
under older limits may fail.

### Reject

`POST /api/changes/{id}/reject`

Users only. Merged changes cannot be rejected.

### Merge change

`POST /api/changes/{id}/merge`

Runs the full merge gate. See [Error codes](/reference/errors/) for
`STALE_BASE`, `STALE_WORKSPACE`, `PROTECTION_BLOCKED`, and `MERGE_CONFLICT`.

### Merge a batch

`POST /api/projects/{name}/changes/merge-batch`

Policy-gates every change, then merges the eligible ones with a single push. At
most 80 per request; requires the RepoDO backend. `force` is deny-by-default.

### Promote to a GitHub PR

`POST /api/changes/{id}/github-pr`

Users only. Creates a (draft by default) PR from `stratum/{changeId}` and marks
the change `promoted`. The PR base is **always the project's own recorded
default branch** and is not accepted from the request body, because this
endpoint acts with the instance-wide GitHub token.

## Reviews and comments

See [Code review](/guides/code-review/) for the concepts.

### Add a comment

`POST /api/changes/{id}/comments`

Read access is enough — users **and agents** may comment. Pass `file` + `line`
together to anchor to a diff line (`side` and `commitSha` only alongside such an
anchor), or `parentCommentId` to reply into a thread.

### List comments

`GET /api/changes/{id}/comments`

### Resolve / unresolve a thread

`POST /api/changes/{id}/comments/{commentId}/resolve`
`POST /api/changes/{id}/comments/{commentId}/unresolve`

Project writers or the comment's author. Only a thread **root** can be resolved.

### Submit a review

`POST /api/changes/{id}/reviews`

**Users only** — agent tokens are refused on every surface. Requires write
access. `verdict` is `approve`, `request_changes`, or `comment`; a `comment`
verdict requires a `comment` body, never counts toward required approvals, and
never replaces an existing verdict by the same reviewer.

The **change author's own approval never counts** toward `requiredApprovals`.

### List reviews

`GET /api/changes/{id}/reviews`

## Issues

See [Issues](/guides/issues/) for the concepts.

### Open an issue

`POST /api/projects/{namespace}/{slug}/issues`

Read access is enough to open one; editing, closing, and labelling require
write access **and a user identity** — agent tokens are refused.

### List issues

`GET /api/projects/{namespace}/{slug}/issues`

Filter with `status`, `label`, `assignee`, and `q` (case-insensitive substring
over title + body). Paginate with `limit` (default 100, max 500) and `offset`.

### Get / update / close an issue

`GET /api/projects/{namespace}/{slug}/issues/{number}`
`PATCH /api/projects/{namespace}/{slug}/issues/{number}`
`POST /api/projects/{namespace}/{slug}/issues/{number}/close`

`PATCH` accepts `title`, `body`, `status`, `assignee`, `labels`, and
`linkedChangeId`. `labels` replaces the whole set. `/close` is a **toggle** —
it flips an open issue closed and a closed issue back open — and answers with
a `302` redirect, not JSON.

Issues linked to a change close **automatically** when that change merges.

### Issue comments

`POST /api/projects/{namespace}/{slug}/issues/{number}/comments`
`GET /api/projects/{namespace}/{slug}/issues/{number}/comments`

## Deployments and deploy secrets

Post-merge deployments and the encrypted per-project secret store that feeds
them. See [Deployments](/guides/deployments/) for the `deploys:` policy block,
the targets, and the limits.

**No endpoint returns a stored secret value**, and every secret route refuses
agent identities — even an agent whose owner is a project admin.

### List secret names

`GET /api/projects/{namespace}/{slug}/secrets`

Project admin only. Names and metadata, never values.

### Create or replace a secret

`PUT /api/projects/{namespace}/{slug}/secrets/{name}`
`POST /api/projects/{namespace}/{slug}/secrets` (form-friendly)

Names match `^[A-Z][A-Z0-9_]{0,63}$`; values are capped at 4096 bytes.

### Delete a secret

`DELETE /api/projects/{namespace}/{slug}/secrets/{name}`
`POST /api/projects/{namespace}/{slug}/secrets/{name}/delete` (form-friendly)

### List deployments

`GET /api/projects/{namespace}/{slug}/deployments`

Readable by anyone who can read the project. Filter with `name`, `status`,
`limit` (default 50, max 200) and `offset`. `logTail` is included only for
project writers.

### Get a deployment

`GET /api/deployments/{id}`

### Approve a deployment

`POST /api/deployments/{id}/approve`

Releases a `pending_approval` deployment. Requires project write access and a
**user** identity — agent tokens are refused.

### Retry a deployment

`POST /api/deployments/{id}/retry`

Re-runs a finished deployment as a new attempt. Agents are allowed here.

## Agents

### List agents

`GET /api/agents`

### Create agent

`POST /api/agents`

Returns the agent token once. Agent tokens do **not** expire — revoke one by
deleting the agent.

### Get agent

`GET /api/agents/{id}`

### Delete agent

`DELETE /api/agents/{id}`

The only way to revoke an agent's token.

## Users

### Get current user

`GET /api/users/me`

Returns the authenticated user's profile.

### API tokens

`GET /api/users/me/tokens`
`POST /api/users/me/tokens`
`DELETE /api/users/me/tokens/{id}`
`POST /api/users/me/legacy-token/disable`

All accept the **browser session cookie only** — an API token calling them gets
`403 SESSION_REQUIRED`, whatever its scope. Creating a token returns the
plaintext exactly once. See [Authentication](/reference/authentication/) for
scopes, expiry, and limits.

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

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — see the
[OpenAPI specification](/reference/openapi/).
