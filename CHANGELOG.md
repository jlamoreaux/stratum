# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Workspace commit/delete now require project write access (was unauthenticated in practice).
- Bulk import enforces own-namespace ownership (no more namespace squatting).
- Merge gate binds the merged code to the evaluated revision across every backend; force-merge
  is now **deny-by-default** (opt in with `merge.allowForce: true`).
- Magic-link tokens are single-use atomically (moved to D1); webhook SSRF filter blocks
  obfuscated IP encodings; malformed policy files fail the merge gate closed.

### Breaking
- **Force merge is deny-by-default.** Existing projects **without** a policy file that relied on
  `?force=true` will now have it rejected. Set `merge.allowForce: true` in `.stratum/policy.yaml`
  to restore it.

### Added
- `@stratum/mcp` (`mcp/`): MCP server exposing the full eval-gated change flow —
  projects, workspaces, commits, changes, reviews, merges, and issues — so any
  MCP-capable agent or editor (Claude Code, Cursor, Zed, Copilot, custom agents)
  can work against Stratum without a bespoke integration.
- Secret scanner now covers 25+ credential patterns (GitHub fine-grained PATs, GitLab,
  Slack, Stripe, OpenAI, Anthropic, Google, npm, PyPI, Hugging Face, SendGrid, Twilio,
  Azure, private-key blocks, JWTs, connection-string credentials) plus Shannon-entropy
  detection for generic high-entropy credentials in keyword context.
- LLM evaluator: review window is configurable via `maxDiffChars` in the policy
  (default raised 8k → 24k chars, capped at 100k); truncated evaluations say so in
  their result issues; the evaluator now sends a real reviewer system prompt.

- Open-source onboarding: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`,
  issue and pull-request templates.
- Enforced test-coverage thresholds in `vitest.config.ts`.
- High-frequency agent commits via the Durable-Object SQLite hot index (ADR 004).

### Changed
- **LLM evaluator fails closed.** An unparseable model response now scores 0 and blocks,
  instead of inferring a 0.8 score from "LGTM" prose.

## [0.1.0] - 2026-06-11

### Added
- Initial platform: Git hosting on Cloudflare Artifacts, workspace forking, evaluation-gated
  changes, GitHub import/sync, server-rendered web UI, email and GitHub OAuth authentication,
  API tokens, agent identities, and provenance tracking.

[Unreleased]: https://github.com/stratum-eng/stratum/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stratum-eng/stratum/releases/tag/v0.1.0
