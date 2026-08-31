# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Agent discovery metadata on the docs site.** `docs.usestratum.dev` now publishes an ARD
  capability manifest (`/.well-known/ai-catalog.json`), an Agent Skills Discovery v0.2.0 index
  with three `SKILL.md` artifacts and `sha256` digests, `/auth.md` describing the agent
  registration contract, and WebMCP tools registered on page load. DNS-AID SVCB records live
  in `website/dns/agents.zone` for the operator to publish.
  No OAuth authorization-server, OIDC, or RFC 9728 protected-resource document is published:
  Stratum issues opaque bearer tokens and has no `token_endpoint` or `jwks_uri`, and RFC 9728
  metadata is resolved from the API origin, which these docs do not serve. Advertising either
  would send agents to a URL that cannot answer them.
- **Per-user telemetry opt-out.** Settings → Privacy now has a switch to stop sending product
  analytics for your account, alongside a plain-language disclosure of exactly what is sent.
  An agent inherits its owner's choice. Telemetry remains on by default; the existing
  instance-wide `STRATUM_TELEMETRY_DISABLED` still overrides every account's preference.
- **Named, scoped, expiring API tokens.** Mint any number of named tokens from
  Settings, each `read` or `read_write`, each with an optional 1-365 day expiry,
  each revocable on its own and each showing when it was last used. A read-only
  token still clones over git but is refused on every write — enforced before
  routing on the HTTP method, and on the resolved scope at all four git write
  entry points, so a route added later inherits the rule.
- **`POST /api/users/me/legacy-token/disable`** (and a button in Settings) turns
  off the single unnamed key accounts were given before scoped tokens existed.
  Named tokens are unaffected. Move anything still using the legacy credential
  onto a named token first — disabling cannot be undone.

### Fixed
- `STRATUM_TELEMETRY_DISABLED` had no effect on `deploy:production` or `deploy:staging`. It was
  declared only under top-level `[vars]`, which named wrangler environments replace rather than
  inherit, so self-hosters who set it were still sending telemetry. It is now declared per
  environment.
- The active-token cap counted expired tokens, so a user whose tokens had all
  lapsed could not create a replacement without first revoking each dead row by
  hand. Expired and revoked tokens now both free their slot.

### Changed
- Repository-activity analytics events no longer carry `project`, the concrete project name; they
  carry the opaque `projectId` instead. Dashboards grouping on `project` must switch to
  `projectId` — old `project` references receive no new data. Events for projects created before
  `projectId` dual-write carry no project property at all, so they group under nothing rather
  than under a name.

### Security
- Sandbox evaluation of a pinned commit no longer clones a workspace's entire reachable
  history into memory: `readRepoFiles` now clones shallow and grows the fetch window only
  as far as needed to reach the pinned commit, capped at 500 commits, instead of an
  unbounded full-history clone (#246).
- Every network call in `src/storage/git-ops.ts` — `git clone`, `git fetch`, `git push`,
  and `git getRemoteInfo` (clone, tag enumeration/fetches, workspace merge fetches and
  pushes, pinned-commit deepening, GitHub sync, backup restore) — now has a wall-clock
  timeout, so a stalling remote can no longer hold a request open indefinitely (#332).
- `readTreeAtCommit` now caps the total bytes it will materialize across a commit's tree
  at 50 MB, on top of the existing 10 MB per-file cap — bounds tree *size*, independent of
  the history-depth bound #246 already added (#333).
- Backup restore's rollback no longer deletes a freshly restored repo when a push merely
  timed out rather than being confirmed rejected — a timeout doesn't cancel the underlying
  push, so it could still land after the timeout fired, and deleting on that ambiguous a
  signal risked destroying already-landed `main`/tags. `pushMain`/`pushTags` now surface a
  distinctly-coded `PUSH_TIMEOUT` error so the caller can tell the two cases apart (#332).
- **A scoped token can no longer mint a credential that outlives its own
  revocation.** `POST /settings/rotate-token` and `POST /api/users/me/rotate-token`
  refuse a scoped token, because the legacy key they mint never expires and cannot
  be revoked individually. Browser sessions and the legacy credential itself still
  rotate, so existing automation is unaffected.
- **Token management requires a browser session, not an API token.** A
  `read_write` token that could mint siblings and revoke them would make
  revocation circular. `GET /settings` requires a session too — it previously
  rendered token metadata to a caller the JSON routes refused.

## [0.2.0] - 2026-08-29

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
- **A release process.** `CHANGELOG.md` is now the source of truth for the version:
  `npm run release:prepare` moves `Unreleased` into a dated section, infers the SemVer
  bump from which groups are present, rewrites the compare links, and bumps
  `package.json`; the `Release` workflow tags the result and publishes a GitHub release
  whose notes are that section. `npm run release:check` (and `npm test`) fail on a
  changelog that would produce a dead link. See `docs/developer/releasing.md`.
- **Gated `git push` (ADR 005 slice 2b), staging-flagged.** With
  `GIT_PUSH_GATED_ENABLED`, pushing to a project's default branch lands the pack
  on a server-managed workspace fork and opens an eval-gated change through the
  same pipeline as the REST route (now extracted to
  `src/services/change-flow.ts`); the client gets a truthful per-ref `ng`
  carrying the change id and eval verdict — main only moves through the merge
  gate. On staging, off in production until validated end-to-end.
- `.stratum/policy.yaml` for this repository — the dogfood merge policy (diff
  limits, LLM review at 0.6, one human approval, fresh-base required,
  force-merge denied).
- Split/unified diff toggle on the change review page — instant, pure-CSS switch
  (no client-side JavaScript, no reload; GitHub/GitLab need a full reload).
- `git push` to a project URL now fails **in-protocol**: the receive-pack
  advertisement is served, and each ref update is answered with a legible `ng`
  report-status plus sideband guidance pointing at workspace remotes — instead of
  an opaque HTTP 403. The pkt-line/report-status machinery
  (`src/utils/git-protocol.ts`) is the groundwork for the gated default-branch
  push (ADR 005 slice 2b, #115).
- Complete OpenAPI 3.1 specification (`docs/api/openapi.yml`): 72 paths / 91
  operations generated from the route code, replacing the 4-path stub.
- Real user documentation: a full getting-started walkthrough and a 15-question
  FAQ (`docs/user-guide/`).
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

- **Production signup is open.** The closed-beta invite gate is off in the
  production config (`BETA_GATE = "0"`); staging keeps it on so the invite path
  stays exercised. Takes effect on the next production deploy.
- **LLM evaluator fails closed.** An unparseable model response now scores 0 and blocks,
  instead of inferring a 0.8 score from "LGTM" prose. Non-finite scores (JSON
  `1e999`) fail closed rather than clamping to a pass, and `maxDiffChars` is
  floored/bounded to [1000, 100k] so a tiny or fractional window can never send
  the model an empty diff.
- README repositioned around the control plane: Stratum is the governance layer
  for AI-written code on top of wherever code lives, usable from any agent or
  editor.
- CLI and MCP clients reject project references with extra path segments instead
  of silently truncating; the MCP client enforces a request deadline (default
  120s) so a stalled API can't hang a tool call forever.

## [0.1.0] - 2026-06-11

### Added
- Initial platform: Git hosting on Cloudflare Artifacts, workspace forking, evaluation-gated
  changes, GitHub import/sync, server-rendered web UI, email and GitHub OAuth authentication,
  API tokens, agent identities, and provenance tracking.

[Unreleased]: https://github.com/stratum-eng/stratum/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/stratum-eng/stratum/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/stratum-eng/stratum/releases/tag/v0.1.0
