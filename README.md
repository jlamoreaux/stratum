# Stratum

[![CI Status](https://github.com/stratum-eng/stratum/actions/workflows/ci.yml/badge.svg)](https://github.com/stratum-eng/stratum/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A code collaboration platform for the AI engineering era. Built on Cloudflare Workers with Artifacts, D1, KV, and Queues.

Stratum is self-hostable on your own Cloudflare account — see [Quick Start](#quick-start). Examples
below use `https://your-instance.workers.dev` as a placeholder for your deployment.

## What is Stratum?

Stratum is the **governance layer for AI-written code** — the control plane that decides
what agent output is allowed to merge, wherever your code lives. Humans and AI agents are
both first-class citizens, with different powers by design:

- **Evaluation-gated merges** - Policy-as-code (`.stratum/policy.yaml`) blocks merges on
  secret scans, diff rules, sandboxed tests, external CI, and LLM review
- **Provenance & cost tracking** - Every merged commit records which agent, model, and
  prompt produced it, its evaluation score, and what it cost (LLM tokens, sandbox time)
- **Agent identities with a hard invariant** - Agents authenticate as themselves and can
  never approve work; approvals are a human gate
- **Any agent, any editor** - REST API, CLI, and MCP server: Claude Code, Cursor, Copilot,
  or your own agents all speak to the same gate. No editor subscription required
- **Two ways to run it** - As a **layer over GitHub** (keep your repos and PRs; eval
  verdicts land as PR comments and commit statuses) or as a **standalone forge** (Git
  hosting on Cloudflare Artifacts, workspace forking, issues, orgs, server-rendered UI)

## Features

### Core Features

| Feature | Status | Description |
|---------|--------|-------------|
| Git Repository Hosting | ✅ | Serverless Git via Cloudflare Artifacts |
| Workspace Forking | ✅ | Isolated development environments |
| Changes (PRs) | ✅ | Proposals with evaluation gates |
| GitHub Import | ✅ | Import and sync with GitHub |
| Web UI | ✅ | Server-rendered, no client JS |
| Email Authentication | ✅ | Magic links, no GitHub required |
| GitHub OAuth | ✅ | Alternative auth method |
| API Tokens | ✅ | For programmatic access |
| Agent Identities | ✅ | First-class AI agent support |

### Evaluators

| Evaluator | Status | Description |
|-----------|--------|-------------|
| Secret Scanner | ✅ | Detects API keys, tokens |
| Diff Analysis | ✅ | Change size limits |
| Webhook | ✅ | External CI/CD integration |
| LLM Review | ✅ | AI-powered review (optional) |
| Sandbox | ✅ | Test execution (optional) |

### Management

| Feature | Status | Description |
|---------|--------|-------------|
| Organizations | ✅ | Org-owned projects, members, and role-based access |
| Teams | ✅ | Team-based write permissions within an org |
| Issue Tracker | ✅ | Per-project issues, auto-close on linked-change merge |
| Bidirectional GitHub Sync | ✅ | Inbound webhooks + outbound PR promotion |
| CLI Tool | 🚧 | `@stratum/cli` at full API parity; install from `cli/` (not yet published to npm) |
| MCP Server | 🚧 | `@stratum/mcp` — any MCP-capable agent or editor can drive the eval-gated change flow; install from `mcp/` (not yet published to npm) |

**Legend:** ✅ Working | 🚧 In Progress | 📋 Planned

## Quick Start

### Prerequisites

- Node.js 20+
- Cloudflare account with access to:
  - Workers
  - Artifacts (beta)
  - D1
  - KV
  - Queues
  - AI Gateway (optional, for LLM evaluator)

### Installation

```bash
# Clone the repository
git clone https://github.com/stratum-eng/stratum.git
cd stratum

# Install dependencies
npm install

# Authenticate with Cloudflare
npx wrangler login

# Set up required secrets (pick authentication method)

# For email magic links (recommended - no external dependencies):
npx wrangler email sending enable yourdomain.com
npx wrangler secret put EMAIL_FROM_ADDRESS  # e.g., noreply@yourdomain.com

# Or for GitHub OAuth:
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# Optional:
npx wrangler secret put POSTHOG_API_KEY  # for analytics
```

### Local Development

```bash
# Start local dev server
npm run dev

# Run tests
npm test

# Run linting
npm run lint

# Type check
npm run typecheck
```

Visit http://localhost:8787 after starting the dev server.

### Database Setup

```bash
# Create D1 database (if not already created)
npx wrangler d1 create stratum

# Run migrations
npx wrangler d1 migrations apply stratum --local   # for local dev
npx wrangler d1 migrations apply stratum --remote  # for production
```

## Documentation

### User Documentation

- [Getting Started Guide](docs/user-guide/getting-started.md) - Your first project
- [Importing from GitHub](docs/user-guide/importing.md) - Import and sync repositories
- [Troubleshooting](docs/user-guide/troubleshooting.md) - Common issues and solutions
- [FAQ](docs/user-guide/faq.md) - Frequently asked questions

### API Documentation

- [OpenAPI Specification](docs/api/openapi.yml) - Complete API reference
- [Authentication](docs/api/authentication.md) - Auth methods and tokens
- [Endpoints](docs/api/endpoints/README.md) - Detailed endpoint docs

### Developer Documentation

- [Architecture Overview](docs/developer/architecture.md) - System design
- [Local Setup](docs/developer/local-setup.md) - Development environment
- [Database Schema](docs/developer/database.md) - Data model
- [Queue System](docs/developer/queues.md) - Background jobs
- [Testing](docs/developer/testing.md) - Testing guide
- [Deployment](docs/developer/deployment.md) - Deploy procedures

### Architecture Decisions

- [ADR 001: Namespace Support](docs/adr/001-namespace-support.md)
- [ADR 002: Queue-Based Imports](docs/adr/002-queue-based-imports.md)
- [ADR 003: D1 for Import State](docs/adr/003-d1-for-import-state.md)
- [ADR 004: High-Frequency Agent Commits](docs/adr/004-high-frequency-agent-commits.md)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Hono API  │  │   Web UI    │  │  Queue Consumer │ │
│  │   Routes    │  │   (JSX)     │  │                 │ │
│  └─────────────┘  └─────────────┘  └─────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Auth      │  │  Evaluation │  │  Merge Queue    │ │
│  │ Middleware  │  │   Engine    │  │  (Durable Obj)  │ │
│  └─────────────┘  └─────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
     ┌─────────────────────┼─────────────────────┐
     ▼                     ▼                     ▼
┌─────────┐        ┌──────────┐         ┌──────────┐
│   D1    │        │    KV    │         │ Artifacts│
│(SQLite) │        │(Tokens,  │         │  (Git)   │
│         │        │  State)  │         │          │
└─────────┘        └──────────┘         └──────────┘
```

### Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolates)
- **Web Framework**: Hono
- **Git Operations**: isomorphic-git with in-memory filesystem
- **Database**: D1 (SQLite)
- **Caching/State**: KV
- **Git Hosting**: Cloudflare Artifacts
- **UI**: Server-rendered JSX (no client JS)
- **Styling**: CSS-in-JSX

## API Usage

### Authentication

Stratum supports multiple authentication methods:

**Email Magic Links (Recommended):**
```bash
# Visit the login page
curl https://your-instance.workers.dev/auth/email

# Enter your email and click "Send Magic Link"
# Check your inbox and click the secure link to sign in
```

**GitHub OAuth:**
```bash
# Initiate login
curl https://your-instance.workers.dev/auth/github

# After OAuth callback, you'll have a session cookie
```

**API Tokens:**
```bash
# Create an agent identity (via web UI or API)
# Then use the token in requests:
curl https://your-instance.workers.dev/api/projects \
  -H "Authorization: Bearer stratum_agent_xxxxx"
```

### Core Endpoints

#### Projects
```bash
# List projects
GET /api/projects

# Create project
POST /api/projects
{
  "name": "my-project",
  "visibility": "private"
}

# Import from GitHub
POST /api/projects/:namespace/:slug/import
{
  "url": "https://github.com/facebook/react",
  "branch": "main"
}
```

#### Workspaces
```bash
# Create workspace
POST /api/projects/:namespace/:slug/workspaces
{
  "name": "feature-branch"
}

# Commit changes
POST /api/workspaces/:name/commit
{
  "files": {
    "src/index.ts": "export const fixed = true;"
  },
  "message": "Fix the bug",
  "projectId": "..."
}
```

#### Changes
```bash
# Create change
POST /api/projects/:name/changes
{
  "workspace": "feature-branch"
}

# Merge change
POST /api/changes/:id/merge
```

See [full API documentation](docs/api/openapi.yml) for complete reference.

## Evaluation Configuration

Configure evaluators in `.stratum/policy.yaml`:

```yaml
evaluation:
  evaluators:
    - id: secrets
      type: secret_scan
      required: true

    - id: diff_check
      type: diff
      max_files_changed: 30
      restricted_paths:
        - "src/auth/**"

    - id: ci
      type: webhook
      url: "https://ci.example.com/evaluate"
      timeout_seconds: 300

merge:
  auto_merge:
    enabled: false
```

## Deployment

### Automatic (GitHub Actions)

The repository includes GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`): Runs tests, lint, and typecheck on PRs
- **Deploy Staging**: Auto-deploys to staging on every push to `main`
- **Deploy Production**: Manual trigger for production deploys

### Manual

```bash
# Deploy to staging
npx wrangler deploy --env=staging

# Deploy to production
npx wrangler deploy

# Apply database migrations
npx wrangler d1 migrations apply stratum --remote
npx wrangler d1 migrations apply stratum-staging --env=staging --remote
```

See [Deployment Guide](docs/developer/deployment.md) for detailed instructions.

## Known Limitations

- **Authorization**: Project-level access control is minimal; auth middleware resolves users but doesn't enforce ownership on all routes
- **Merge semantics**: Squash merge only; true merge commits not yet supported
- **Diff limits**: Diffs are hunk-level with unified and split views, but binary files are not diffed and very large files are rendered whole
- **Scale**: Git operations run in-memory; large repos will hit Worker limits

See [CURRENT_CAPABILITIES.md](docs/CURRENT_CAPABILITIES.md) for more details.

## Artifacts Operating Policy

To align with Cloudflare Artifacts best practices:

- **Environment namespace separation**: production and staging must use distinct Artifacts namespaces.
- **Isolation unit**: each Stratum project maps to a dedicated Git repository in Artifacts.
- **Metadata strategy**: commit/evaluation provenance that should not alter tree contents is **planned to be stored** as Git notes (Phase 2 design decision); relational/query metadata remains in D1.
- **Scaling**: when namespace traffic grows, shard by workload class (for example: `stratum-prod-realtime` and `stratum-prod-batch`) and migrate new projects to shard-specific namespaces.

### Namespace checklist

- Production namespace: `stratum-prod`
- Staging namespace: `stratum-staging`
- Never share a namespace between environments.

### Namespace change safety

Before changing `[[artifacts]]` / `[[env.staging.artifacts]]` namespace values in `wrangler.toml`, perform a pre-deploy audit and migrate existing repos from the old namespace using the Artifacts REST API so data is not orphaned. Track project-to-namespace migration in the runbook at `docs/runbooks/artifacts-scaling.md`.

## Development Roadmap

For the authoritative, current state see [docs/CURRENT_CAPABILITIES.md](docs/CURRENT_CAPABILITIES.md);
open items are tracked in [docs/REMAINING_WORK.md](docs/REMAINING_WORK.md).

### Phase 0 ✅

- Basic fork/commit/merge loop on Artifacts
- GitHub import

### Phase 1 ✅

- Persistent storage (D1)
- Authentication (OAuth + API tokens + email)
- Evaluation engine (diff, webhook, secret scanning)
- Basic web UI

### Phase 2 ✅

- LLM evaluator via AI Gateway
- Sandbox execution
- Event-driven evaluation pipeline
- OAuth login for web UI
- Durable Object merge queue
- Provenance tracking

### Phase 3 ✅

- Organizations and teams
- CLI tool (`@stratum/cli`) — built at full parity, not yet published to npm
- Reference agent integration
- Bidirectional GitHub sync
- Issue tracker

### Phase 4 (Current)

- ✅ Security & durability hardening (audit trail, backup/restore, deletion jobs)
- 📋 Stratum Cloud (managed offering)
- 📋 Billing and multi-tenancy

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

Key areas needing work:

1. **Authorization**: Enforce project-level access control
2. **Diff accuracy**: Produce real unified diffs instead of full-file comparisons
3. **Merge semantics**: Handle conflicts properly, support true merges
4. **Scale**: Move git operations off the Worker to Containers or a backend service

## License

MIT - See [LICENSE](LICENSE) for details.

## Acknowledgments

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Hono](https://hono.dev/)
- [isomorphic-git](https://isomorphic-git.org/)
