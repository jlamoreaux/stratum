# Stratum

A code collaboration platform for the AI engineering era. Built on Cloudflare Workers with Artifacts, D1, KV, and Queues.

**Live Instances:**
- Production: https://stratum.jlmx.workers.dev
- Staging: https://stratum-staging.jlmx.workers.dev

## What is Stratum?

Stratum is a GitHub alternative where both humans and AI agents are first-class citizens. It provides:

- **Git repository hosting** via Cloudflare Artifacts (fast, serverless Git)
- **Workspace forking** - Create isolated branches for changes
- **Evaluation-gated merges** - Automated code review before merging
- **Agent identities** - Register and authenticate AI agents
- **Provenance tracking** - Know which AI model made what change
- **Read-only web UI** - Browse repos, changes, and evaluation results

## Current Capabilities

### ✅ Working Now

- **Repository Management**: Create, import from GitHub, browse files and commit history
- **Workspaces**: Fork workspaces from projects, commit changes, merge back
- **Changes**: Propose changes (like PRs) with evaluation gates
- **Authentication**: GitHub OAuth for humans, API tokens for agents
- **Evaluators**:
  - Secret scanning (detects AWS keys, GitHub tokens, etc.)
  - Diff analysis (measures change size, restricted paths)
  - Webhook integration (call external CI/CD)
  - LLM review (when AI is configured)
  - Sandbox execution (when Sandboxes are available)
- **Web UI**: Browse projects, file trees, changes, and evaluation evidence

### 🚧 Known Limitations

- **Authorization**: Project-level access control is minimal; auth middleware resolves users but doesn't enforce ownership on all routes
- **Merge semantics**: Squash merge only; true merge commits not yet supported
- **Diff accuracy**: Current diff format shows full file rewrites rather than precise hunks
- **Scale**: Git operations run in-memory; large repos will hit Worker limits

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
git clone https://github.com/jlamoreaux/stratum.git
cd stratum

# Install dependencies
npm install

# Authenticate with Cloudflare
npx wrangler login

# Set up required secrets
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put POSTHOG_API_KEY  # optional, for analytics
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

**GitHub OAuth (for humans):**
```bash
# Initiate login
curl https://stratum.jlmx.workers.dev/auth/github

# After OAuth callback, you'll have a session cookie
```

**API Tokens (for agents):**
```bash
# Create an agent identity (via web UI or API)
# Then use the token in requests:
curl https://stratum.jlmx.workers.dev/api/projects \
  -H "Authorization: Bearer stm_agent_xxxxx"
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
  "remote": "https://github.com/user/repo",
  "token": "ghp_xxxx"
}

# Import from GitHub
POST /api/projects/:name/import
{
  "url": "https://github.com/facebook/react",
  "branch": "main",
  "depth": 10
}

# Get project files
GET /api/projects/:name/files

# Get commit log
GET /api/projects/:name/log
```

#### Workspaces
```bash
# Fork workspace
POST /api/projects/:name/workspaces
{
  "name": "fix-bug",
  "parent": "main"
}

# Commit changes
POST /api/workspaces/:name/commit
{
  "files": {
    "src/index.ts": "export const fixed = true;"
  },
  "message": "Fix the bug"
}
```

#### Changes
```bash
# Create change (proposes workspace for merge)
POST /api/workspaces/:id/changes
{
  "title": "Fix N+1 query",
  "description": "Optimizes database access"
}

# List changes
GET /api/projects/:name/changes

# Get change details
GET /api/changes/:id

# Merge change (after evaluation passes)
POST /api/changes/:id/merge
```

#### Agents
```bash
# Create agent identity
POST /api/agents
{
  "name": "code-reviewer",
  "model": "claude-sonnet-4-20250514",
  "capabilities": ["typescript", "review"]
}

# List agents
GET /api/agents
```

### Evaluation

Changes must pass evaluation before merging. Configure evaluators in `.stratum/policy.yaml`:

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
        - "migrations/**"

    - id: ci
      type: webhook
      url: "https://ci.example.com/evaluate"
      timeout_seconds: 300
      headers:
        Authorization: "Bearer ${CI_TOKEN}"

    - id: llm_review
      type: llm
      model: "claude-sonnet-4-20250514"
      criteria: |
        Does this change match the objective?
        Does it follow existing patterns?
      min_score: 0.7

  composite:
    pass_requires: all_required_pass

merge:
  auto_merge:
    enabled: false
```

## Web UI

The web UI provides a read-only view of your repositories:

- **`/ui`** - Dashboard with project list
- **`/ui/projects/:name`** - Repository browser (files + commit log)
- **`/ui/projects/:name/changes`** - List of changes
- **`/ui/changes/:id`** - Change detail with evaluation results
- **`/ui/projects/:name/workspaces`** - Active workspaces

The UI is server-rendered HTML with no client-side JavaScript. It uses a dark theme with monospace headings (inspired by the landing page design).

## Deployment

### Automatic (GitHub Actions)

The repository includes GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`): Runs tests, lint, and typecheck on PRs
- **Deploy Staging**: Auto-deploys to staging on every push to `main`
- **Deploy Production** (`.github/workflows/deploy-production.yml`): Manual trigger for production deploys
- **D1 Migrations** (`.github/workflows/d1-migrate.yml`): Apply database migrations

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

## Project Structure

```
stratum/
├── src/
│   ├── index.ts              # Worker entry point
│   ├── routes/
│   │   ├── auth.ts           # OAuth routes
│   │   ├── projects.ts       # Project API
│   │   ├── workspaces.ts     # Workspace API
│   │   ├── changes.ts        # Changes API
│   │   ├── agents.ts         # Agent management
│   │   ├── orgs.ts           # Organizations
│   │   └── ui.tsx            # Web UI routes
│   ├── evaluation/
│   │   ├── index.ts          # Evaluation orchestrator
│   │   ├── diff-evaluator.ts
│   │   ├── secret-scanner.ts
│   │   ├── webhook-evaluator.ts
│   │   ├── llm-evaluator.ts
│   │   └── sandbox-evaluator.ts
│   ├── storage/
│   │   ├── git-ops.ts        # Git operations
│   │   ├── changes.ts        # D1 queries
│   │   └── state.ts          # KV operations
│   ├── queue/
│   │   ├── merge-queue.ts    # Durable Object for merges
│   │   └── events.ts         # Queue handling
│   ├── middleware/
│   │   ├── auth.ts           # Auth middleware
│   │   ├── rate-limit.ts
│   │   └── analytics.ts
│   └── ui/
│       ├── pages/            # JSX page components
│       └── styles.ts         # CSS
├── migrations/               # D1 migrations
├── tests/                    # Vitest tests
├── .github/workflows/        # CI/CD
└── wrangler.toml            # Cloudflare config
```

## Development Roadmap

See [docs/stratum-master-plan-v2.md](docs/stratum-master-plan-v2.md) for the full implementation plan.

### Phase 0 ✅
- Basic fork/commit/merge loop on Artifacts
- GitHub import

### Phase 1 ✅ (Current)
- Persistent storage (D1)
- Authentication (OAuth + API tokens)
- Evaluation engine (diff, webhook, secret scanning)
- Basic web UI

### Phase 2 (Next)
- LLM evaluator via AI Gateway
- Sandbox execution
- Event-driven evaluation pipeline
- OAuth login for web UI
- Durable Object merge queue
- Provenance tracking

### Phase 3
- Organizations and teams
- CLI tool (`@stratum/cli`)
- Reference agent integration
- Bidirectional GitHub sync
- Issue tracker

### Phase 4
- Stratum Cloud (managed offering)
- Load testing and hardening
- Billing and multi-tenancy

## Contributing

This is currently a personal exploration project. The codebase has known issues (see [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md) for a detailed review). Key areas needing work:

1. **Authorization**: Enforce project-level access control
2. **Diff accuracy**: Produce real unified diffs instead of full-file comparisons
3. **Merge semantics**: Handle conflicts properly, support true merges
4. **Scale**: Move git operations off the Worker to Containers or a backend service

## License

MIT

## Acknowledgments

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Hono](https://hono.dev/)
- [isomorphic-git](https://isomorphic-git.org/)
