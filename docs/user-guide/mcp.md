# The Stratum MCP server

`@stratum/mcp` exposes Stratum's eval-gated change flow as an
[MCP](https://modelcontextprotocol.io/) server over stdio, so any MCP-capable
agent or editor — Claude Code, Cursor, Zed, Copilot, custom agents — can read a
project, fork a workspace, commit, and propose governed changes without a
Stratum-specific SDK.

Stratum's governance invariants hold over MCP exactly as they do over the REST
API: a change cannot merge past failing evaluators, review verdicts are a human
gate, and every merged change keeps its provenance and cost records. The
protocol is a doorway, not a bypass.

(This server is distinct from the docs site's own
[agent discovery surface](https://docs.usestratum.dev/reference/agent-discovery/),
which serves documentation to agents. This one operates on your projects.)

## Installation

Not yet published to npm — install from the `mcp/` directory of the repository
(Node 18+):

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum/mcp
npm install && npm run build     # binary at dist/index.js (bin name: stratum-mcp)
```

## Configuration

Everything is environment variables — the server takes no flags:

| Variable | Required | Meaning |
|---|---|---|
| `STRATUM_API_KEY` | yes | A user token (`stratum_user_...`) or agent token (`stratum_agent_...`). |
| `STRATUM_HOST` | no | Defaults to `https://app.usestratum.dev`; set it for self-hosted instances. |

The host is validated at startup and the server refuses to start rather than
run misconfigured: it must be a URL with **no** embedded credentials, query
string, or fragment, and it must be `https` — plain `http` is allowed only for
loopback development hosts (`localhost`, `127.0.0.1`, `[::1]`), because the API
key travels in a header on every request.

## Connecting a client

Claude Code:

```bash
export STRATUM_API_KEY=stratum_user_xxxxx
claude mcp add stratum -e STRATUM_API_KEY=$STRATUM_API_KEY -- node /path/to/stratum/mcp/dist/index.js
```

Any MCP client (stdio):

```json
{
  "mcpServers": {
    "stratum": {
      "command": "node",
      "args": ["/path/to/stratum/mcp/dist/index.js"],
      "env": { "STRATUM_API_KEY": "stratum_user_..." }
    }
  }
}
```

## The tools

Eighteen tools cover the full contribution loop. Project arguments take a
`namespace/slug` reference (`@acme/api` and `acme/api` both work).

**Identity and reading**

| Tool | What it does |
|---|---|
| `stratum_whoami` | Identify the authenticated user or agent. |
| `stratum_list_projects` | List projects visible to the caller. |
| `stratum_get_project` | Project metadata — id, namespace, visibility, git remote. |
| `stratum_list_files` | File paths at the HEAD of the default branch. |
| `stratum_get_file` | One file's content at HEAD. |
| `stratum_get_activity` | Recent activity feed. |

**Forking and committing**

| Tool | What it does |
|---|---|
| `stratum_create_workspace` | Fork an isolated workspace; returns its name and git remote. |
| `stratum_list_workspaces` | List a project's open workspaces. |
| `stratum_commit` | Commit a map of repo-relative paths to **complete file contents**. |

`stratum_commit` takes the `project_id` from `stratum_get_project`, not the
`namespace/slug` reference. The file map is capped at 2,000 files and 25 MB per
commit, and it cannot express a deletion or rename — only full contents of
added or modified files. Larger or destructive edits go over the workspace's
git remote instead.

**The change flow**

| Tool | What it does |
|---|---|
| `stratum_create_change` | Open a change; **synchronously** runs every gate in `.stratum/policy.yaml` and returns the verdicts. |
| `stratum_list_changes` | List changes, optionally by status. |
| `stratum_get_change` | One change with per-gate evidence and metered costs. |
| `stratum_merge_change` | Merge a change that passed its gates and approvals. |
| `stratum_reject_change` | Close a change without merging. |
| `stratum_review_change` | Submit an `approve` or `request_changes` verdict. |

**Issues**

| Tool | What it does |
|---|---|
| `stratum_create_issue` | Open an issue; linking a change id auto-closes it on merge. |
| `stratum_list_issues` | List issues, optionally by status. |
| `stratum_update_issue` | Update status, title, or body by issue number. |

## What an agent token can — and cannot — do

The server accepts either token kind, but the API behind it does not treat
them alike. With an **agent token**:

- **Works:** all reading tools, `stratum_create_workspace`, `stratum_commit`,
  `stratum_create_change`, `stratum_create_issue`, and `stratum_list_issues` —
  an agent can do everything up to and including proposing a gated change and
  opening issues about its work.
- **Always refused:** `stratum_merge_change`, `stratum_reject_change`,
  `stratum_review_change`, and `stratum_update_issue`. Merging, deciding, and
  issue triage are user actions, and review verdicts are refused from agent
  tokens **entirely** — `request_changes` as much as `approve`. An agent's
  feedback channel is [change comments](code-review.md), which the REST API
  accepts from agents but this server does not yet expose as a tool.

So an agent-token deployment is a *proposer*: it forks, commits, opens the
change, and a human (over the UI, [CLI](cli.md), or their own MCP session with
a user token) reviews and merges.

## Operational notes

- The server logs to **stderr only**; stdout carries the MCP stdio framing.
  A startup line confirms the version and host.
- Tool failures come back as results marked as errors, prefixed
  `Stratum API error:` — or `Invalid arguments:` for a schema violation, so a
  calling agent knows whether to fix its input or its expectations.
- Evaluation runs inside `stratum_create_change`, so on a project with a slow
  sandbox evaluator that call legitimately takes as long as the
  [evaluation budget](troubleshooting.md#sandbox-budget-exceeded-install-or-command)
  allows.

## Reference

- [`mcp/README.md`](../../mcp/README.md) — the package's own quick reference
- [Getting started §6](getting-started.md#6-connect-your-tools) — where MCP
  fits in the end-to-end flow
- [CI integration](ci-integration.md) — evaluating changes on your own infra
- [OpenAPI specification](../api/openapi.yml) — the API the tools wrap
