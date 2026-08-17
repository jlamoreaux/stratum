# @stratum/mcp

MCP server for [Stratum](https://github.com/stratum-eng/stratum) — gives **any**
MCP-capable agent or editor (Claude Code, Cursor, Zed, Copilot, custom agents)
access to Stratum's eval-gated change flow. No Stratum-specific SDK required:
if your tool speaks MCP, it can propose governed changes.

## What the tools cover

The full agent contribution loop:

1. **Read** — `stratum_list_projects`, `stratum_get_project`, `stratum_list_files`,
   `stratum_get_file`, `stratum_get_activity`
2. **Fork & commit** — `stratum_create_workspace`, `stratum_list_workspaces`,
   `stratum_commit`
3. **Propose** — `stratum_create_change` runs the project's evaluation gates
   (`.stratum/policy.yaml`: secret scan, diff policy, LLM review, sandbox tests)
   and returns each gate's verdict
4. **Land** — `stratum_get_change`, `stratum_list_changes`, `stratum_merge_change`,
   `stratum_reject_change`, `stratum_review_change`
5. **Track** — `stratum_create_issue`, `stratum_list_issues`, `stratum_update_issue`,
   `stratum_whoami`

Stratum's governance invariants hold over MCP exactly as they do over the REST
API: **agent tokens cannot submit approve verdicts at all** (approvals are a
human gate — an agent can only request changes, on anyone's change), merges are
blocked by failing evaluators, and every merged change keeps its provenance and
cost records.

## Setup

`@stratum/mcp` is not yet published to npm — install from source:

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum/mcp
npm install && npm run build   # binary at dist/index.js (bin name: stratum-mcp)
export STRATUM_API_KEY=stratum_user_...   # or a stratum_agent_ token
export STRATUM_HOST=https://app.usestratum.dev   # optional; also works self-hosted
```

### Claude Code

```bash
claude mcp add stratum -e STRATUM_API_KEY=$STRATUM_API_KEY -- node /path/to/stratum/mcp/dist/index.js
```

### Any MCP client (stdio)

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

(Once the package is on npm, `npm install -g @stratum/mcp` will provide a
`stratum-mcp` binary to use as the command directly.)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
