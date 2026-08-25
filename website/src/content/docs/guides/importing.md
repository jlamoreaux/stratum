---
title: Importing from GitHub
description: Import a repository from GitHub, GitLab, or Bitbucket, track progress, and keep the project in sync with its source.
---

Stratum imports repositories from **GitHub, GitLab, and Bitbucket**. Imports run
as background jobs, so large repositories don't block the request. The complete
request/response contract for every endpoint on this page is in the
[OpenAPI specification](/reference/openapi/).

Examples use the hosted instance and a user API token — substitute your own
host and token:

```bash
export STRATUM_HOST=https://app.usestratum.dev
export STRATUM_API_KEY=stratum_user_xxxxx
```

## Start an import

```bash
curl -X POST "$STRATUM_HOST/api/projects/@username/repo/import" \
  -H "Authorization: Bearer $STRATUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/owner/repo", "branch": "main"}'
```

The body requires `url`; `branch` (default `main`), `depth` (clone depth), and
`visibility` (`private`, the default, or `public`) are optional. A successful
request returns `201` with an `importId` and `status: "queued"`. Imports are
rate limited (3 per minute per user, 1 concurrent import per project) and only
allowed into your own namespace. If the project already exists with an
incomplete import, the import is re-triggered and `200` is returned.

## Track progress

Poll the status endpoint:

```bash
curl -H "Authorization: Bearer $STRATUM_API_KEY" \
  "$STRATUM_HOST/api/projects/@username/repo/import/status"
```

This returns an `ImportProgress` object: a `status` (`queued`, `cloning`,
`processing`, `completed`, `failed`, `cancelled`, …), a `progress` object
(`totalFiles`, `processedFiles`, `currentFile`, `bytesTransferred`,
`totalBytes`), and any `errors` and `logs`. Polling also recovers imports that
have stalled for more than 5 minutes.

Or subscribe to Server-Sent Events instead of polling — the stream emits the
same `ImportProgress` JSON as an SSE `data:` line every 2 seconds until the
import completes, fails, or is cancelled:

```bash
curl -N -H "Authorization: Bearer $STRATUM_API_KEY" \
  "$STRATUM_HOST/api/projects/@username/repo/import/stream"
```

A failed import can be retried with
`POST …/import/retry` (rate limited like the initial import), and an ongoing
one cancelled with `POST …/import/cancel`.

## Sync

Keep an imported project in sync with its source repository. Trigger a sync
check — when the source has new commits, a background sync is queued:

```bash
curl -X POST "$STRATUM_HOST/api/projects/@username/repo/sync" \
  -H "Authorization: Bearer $STRATUM_API_KEY"
```

The response reports `hasUpdates`, `commitsBehind`, `latestCommit`, and
`lastSyncedCommit`, plus an `importId` and `status: "queued"` when a sync was
actually started.

Check state with `GET …/sync/status`, which returns a `SyncStatus` object
(`lastSyncStatus`: `success` / `failed` / `in_progress` / `idle`,
`lastSyncedAt`, `commitsBehind`, `autoSyncEnabled`, and an `importProgress`
object while a sync is active), or follow it live over SSE with
`GET …/sync/stream` — the sync-status object is emitted every 2 seconds until
the sync succeeds or fails, and the stream self-closes after 5 minutes.

Enable automatic syncing with:

```bash
curl -X POST "$STRATUM_HOST/api/projects/@username/repo/sync/settings" \
  -H "Authorization: Bearer $STRATUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"autoSyncEnabled": true, "syncFrequency": 60}'
```

`syncFrequency` is in minutes. Past runs are listed by
`GET …/sync/history` (paginated with `limit`/`offset`).

Bidirectional GitHub sync — inbound webhooks and outbound PR promotion, i.e.
**layer mode** — is covered in
[Getting started](/guides/getting-started/#choose-your-level-of-buy-in-layer-mode-vs-alternative-mode).

## Unsupported content

**Git submodules are not supported.** A repository containing a gitlink tree
entry (the `160000` mode git uses for a submodule reference) or a
`.gitmodules` file is detected up front and the import fails with
`status: "failed"` and a `SUBMODULES_UNSUPPORTED` error — before the project
is ever marked imported. The same check runs on a gated push to a project's
default branch, so a workspace containing a submodule can't be merged either.

This is deliberate: git's checkout silently drops a gitlink entry when
Stratum's server-side git layer materializes a working tree, so partially
importing a repo with submodules would let a later merge quietly corrupt it
rather than fail loudly. Remove submodules (or flatten them into the repo)
before importing, or push to a workspace remote for content that never
touches the default branch. Full submodule support (recursive clone and
browsing) is tracked for later.
