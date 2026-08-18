---
title: Importing from GitHub
description: Import an existing repository into Stratum and keep it in sync.
---

## Quick import

```bash
curl -X POST /api/projects/@username/repo/import \
  -d '{"url": "https://github.com/owner/repo"}'
```

## Track progress

Check status via polling or SSE stream.

## Sync

Keep your Stratum project in sync with GitHub.
