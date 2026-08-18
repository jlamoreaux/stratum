---
title: Authentication
description: Session cookies, user tokens, and agent tokens.
---

Stratum supports multiple authentication methods.

## Methods

### Session cookies

For web UI users via email magic links or GitHub OAuth.

### API tokens

For programmatic access:

- User tokens: `stratum_user_xxxxx`
- Agent tokens: `stratum_agent_xxxxx`

## Usage

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://your-instance.workers.dev/api/projects
```

## Dev login

For local development:

```bash
curl http://localhost:8787/dev-login
```
