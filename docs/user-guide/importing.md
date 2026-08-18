# Importing from GitHub

## Quick Import

```bash
curl -X POST /api/projects/@username/repo/import \
  -d '{"url": "https://github.com/owner/repo"}'
```

GitLab (`gitlab.com`) and Bitbucket (`bitbucket.org`) URLs work the same way.

### Options

| Field    | Default                    | Description                                                                                                              |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `url`    | (required)                 | Repository URL on github.com, gitlab.com, or bitbucket.org.                                                              |
| `branch` | provider's default branch  | Branch to import. When omitted, Stratum asks the provider API for the repository's real default branch; if that lookup fails, the import falls back to `main` (fail-open) and logs a warning. |
| `depth`  | `10`                       | Shallow clone depth: an integer from 1 to 1000, or `0` / `"full"` to import the branch's full history.                    |
| `visibility` | `private`              | `private` or `public`.                                                                                                   |

Imports are single-branch clones: only the selected branch's history (up to
`depth` commits) is imported.

## Track Progress

Check status via polling (`GET /api/projects/@username/repo/import/status`) or
the SSE stream. Progress reports phase transitions (`queued` → `cloning` →
`processing` → `completed`) and, once the clone lands, the real imported file
count.

## Failure notifications

If an import fails, Stratum emails the user who started the import, with a copy
to the instance admin (`ADMIN_EMAIL`) when one is configured.

## Sync

Keep your Stratum project in sync with GitHub.

## Current limitations

Honest list of what import does **not** do yet:

- **Public repositories only.** Imports clone anonymously — provider tokens are
  not used for the clone, and GitHub sign-in only requests the `user:email`
  OAuth scope. Token-authenticated clones of private repositories are future
  work.
- **Git data only.** Issues, pull requests, releases, and tags are not
  imported — only the selected branch's commit history and files.
- **Single branch.** Only one branch is imported per project.
- **No GitHub Enterprise Server.** Only `github.com`, `gitlab.com`, and
  `bitbucket.org` URLs are recognized; self-hosted instances are not supported.
