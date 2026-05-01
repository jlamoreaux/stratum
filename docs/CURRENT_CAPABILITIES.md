# Stratum Current Capabilities

## Implemented now

- Cloudflare Worker API using Hono, Artifacts, KV, D1, Queues, and a merge Durable Object binding.
- User and agent API tokens with hashed storage, plus GitHub OAuth session login plumbing.
- Project creation/import, workspace fork/commit/delete, change creation, evaluation-gated merge, and provenance records.
- Per-change evaluator evidence for secret scanning, diff checks, webhook checks, LLM checks when AI is configured, and sandbox checks when Sandboxes are configured.
- Read-only web UI for projects, files, commit logs, workspaces, changes, evaluator evidence, and merge provenance.

## Not yet production-complete

- Project/workspace identity still lives in KV; D1 stores changes and provenance only.
- Authorization is owner-based and intentionally minimal; org/team permissions are not wired into project access yet.
- Git operations still run inside the Worker with in-memory repositories.
- The merge coordinator serializes merges but is not a full async queue with retries or dead-letter behavior.
- Sandbox execution depends on Cloudflare Sandboxes access and fails closed when the binding is absent.

## Public-copy gap to revisit before early access

- The product can support evaluated agent changes, but behavioral artifacts beyond evaluator evidence are not built yet.
- Provenance tracks agent/change/workspace/commit/evaluation score, but not full prompts, model metadata, or reasoning traces.
- The UI is a functional review surface, not a full GitHub-class code browser or diff viewer.
