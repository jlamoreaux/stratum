# The Stratum CLI

`@stratum/cli` puts the change flow in the terminal: projects, workspaces,
commits, evaluation-gated changes, reviews, and issues, each command a thin
wrapper over the [REST API](../api/endpoints/README.md). It is built for humans
and shell scripts; agents are usually better served by the
[MCP server](mcp.md), which speaks the same surface over a protocol editors and
agent frameworks already understand.

## Installation

The package is **not yet published to npm** — install it from the `cli/`
directory of the repository (Node 18+):

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum/cli
npm install && npm run build
npm link          # puts the `stratum` binary on your PATH
```

## Authentication

```bash
stratum login --host https://app.usestratum.dev --key stratum_user_xxxxx
```

Run it with no flags to be prompted for both values. Two things to know:

- **Credentials land in `~/.stratum/config.json` as plaintext JSON.** Treat
  that file like the token itself. In CI, skip the file entirely and set
  `STRATUM_HOST` and `STRATUM_API_KEY` — the environment variables override
  the config file, each independently.
- **`login` verifies connectivity, not the key.** It checks the host's
  `/health` endpoint, which requires no authentication, so a mistyped key
  still "logs in" and only fails on the first real command. `stratum status`
  is the actual credential check — it calls the authenticated
  `GET /api/users/me`:

```bash
stratum status
# Authenticated as you@example.com (usr_...)
```

Most commands write, so use a `read_write` [API token](../api/authentication.md).
A `read`-scoped token works for the listing commands but is refused with
`403 TOKEN_SCOPE_INSUFFICIENT` on anything else. The CLI has no commands for
creating or revoking tokens — that surface is deliberately
[session-only](../api/authentication.md#managing-tokens-requires-a-session), so
it lives in the settings UI.

## Projects

```bash
stratum init billing                 # create a project in your namespace
stratum init billing --org acme      # ...or under an organization
stratum init billing --public       # public instead of the default private
stratum projects                     # list your projects
stratum activity acme/billing        # recent events (changes, merges, evals)
```

`init` prints the project's git remote when one is provisioned.

Deleting a project is owner-only, irreversible, and asks you to repeat the
project reference as a confirmation token:

```bash
stratum project delete acme/billing --confirm acme/billing
```

Deletion is enqueued (the command prints the job id) and removes the project
and everything attached to it — see the
[projects API](../api/endpoints/projects.md) for what the cascade covers.

## Workspaces and commits

A workspace is your isolated fork of the project; changes are proposed from it.

```bash
stratum workspace create acme/billing --name fix-retries
stratum workspace list acme/billing
stratum workspace delete acme/billing fix-retries
```

`stratum commit` bridges a **local git checkout** to a workspace: it reads the
files currently *staged* in your local repository (the index version, not the
working tree) and commits their full contents to the workspace:

```bash
git add src/retry.ts
stratum commit --project acme/billing --workspace fix-retries -m "Honour Retry-After"
```

Limits worth knowing, since the underlying commit API takes a map of complete
file contents: at most **2,000 files** and **25 MB** of content per commit, and
**staged deletions and renames cannot be expressed** — the command errors on a
staged deletion rather than silently dropping it. For anything the file map
cannot say, push to the workspace's git remote instead; the same change gate
applies either way.

## Changes

```bash
stratum change create --project acme/billing --workspace fix-retries
# Created change chg_abc123 (open)
# Evaluation: score 0.92, passed — all gates passed
```

Creating a change runs the project's evaluation gates **synchronously** and
prints the verdict. Then:

```bash
stratum change list acme/billing --status open
stratum change show chg_abc123        # per-evaluator evidence + metered costs
stratum change review chg_abc123 --verdict approve --comment "LGTM"
stratum change merge chg_abc123       # runs the full merge gate
stratum change merge chg_abc123 --squash
stratum change merge chg_abc123 --force   # denied unless policy allows force
stratum change reject chg_abc123
```

`review` accepts `approve` or `request_changes` (the comment-only verdict from
the [code review guide](code-review.md) is not exposed here), and the change
author's own approval never counts toward required approvals. A refused merge
prints the blocking reasons — the codes are in the
[error reference](../api/errors.md).

## Issues

```bash
stratum issue create acme/billing --title "Retry storms on 429" --body "..."
stratum issue create acme/billing --title "Retry storms" --change chg_abc123
stratum issue list acme/billing --status closed    # default is open
stratum issue close acme/billing 42
```

An issue created with `--change` auto-closes when that change merges — see
[Issues](issues.md).

## Account

```bash
stratum account delete --confirm your-username
```

Irreversible, GDPR-grade erasure of your account and owned projects, confirmed
by repeating your username. Your credentials stop working the moment the
command returns; the deletion itself runs as a background job.

## Errors and scripting

Every failure prints a single `Error: ...` line to stderr and exits non-zero,
so the CLI composes with `&&` and `set -e`. API failures carry the server's
message; the machine-readable codes behind them are catalogued in the
[error reference](../api/errors.md).

## Reference

- [`cli/README.md`](../../cli/README.md) — the package's own quick reference
- [Getting started §6](getting-started.md#6-connect-your-tools) — where the CLI
  fits in the end-to-end flow
- [OpenAPI specification](../api/openapi.yml) — the API each command wraps
