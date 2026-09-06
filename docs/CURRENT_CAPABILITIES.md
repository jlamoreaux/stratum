# Stratum Current Capabilities

Last updated: 2026-08-25 — reflects completion of the master-plan feature roadmap
(Phases 0–3 plus the code-level Phase 4 hardening items), plus the Git LFS
limitation recorded below.

## Core platform

- Cloudflare Worker (Hono) on Artifacts, KV, D1, Queues, and a merge Durable Object.
- Project create/import (GitHub/GitLab/Bitbucket), workspace fork/commit/delete,
  change creation with synchronous evaluation, evaluation-gated merge, provenance
  (records the agent, the model and prompt hash snapshotted at change creation, and
  the eval score per merged commit; full per-evaluator evidence is linked by change).
- Project resolution accepts namespace/slug refs, legacy names, and falls back to a
  scan — the change/review APIs work for all project generations.
- Org-owned projects: org membership grants read; org owner/admin role or a
  write/admin team grants write. Agents inherit their owning user's access.

## Evaluation & merge pipeline

- Evaluators: secret scan (always on, blocking), diff, webhook, LLM, sandbox
  (Sandboxes binding; fails closed when absent). The LLM evaluator runs on the
  Workers AI binding by default, or on the project's own credential against an
  operator-configured provider (`anthropic` or an OpenAI-compatible endpoint) —
  see BYOK below. Per-change evaluator evidence and resource costs (LLM tokens,
  sandbox time, git ops); token counts are the ones the provider reported, and
  fall back to a `~4 chars/token` estimate — marked `estimated` on the cost
  record — only for a response that omits them.
- Branch protection in `.stratum/policy.yaml` (`merge:`): required evaluators
  (latest run per type), required human approvals, force-merge control
  (**deny-by-default** — force is only allowed when the policy sets
  `merge.allowForce: true`), and staleness rejection: `requireFreshBase` blocks a
  moved project base (409 STALE_BASE), and a merge is rejected if the workspace
  advanced since it was evaluated (409 STALE_WORKSPACE).
- Post-merge smoke command in a sandbox with auto-revert (forward revert commit,
  change marked `reverted`, `change.reverted` event).
- Post-merge deployments in `.stratum/policy.yaml` (`deploys:`): a named list of
  deploys, each with a `target` (`cloudflare-pages`, `cloudflare-workers`,
  `vercel`), an optional `dir`, declared `secrets`, and an optional
  `requiresApproval` gate. Triggered only when the post-merge check did not
  revert or fail, run from a queue consumer against the tree at the pinned merge
  commit, with per-project AES-GCM-encrypted secrets (`DEPLOY_SECRET_KEY`
  required; project admins only, agents refused), supersession of older deploys
  of the same name, retry as a new attempt, and `deployment.requested` /
  `deployment.succeeded` / `deployment.failed` events. **No build step, no
  preview deploy, and no rollback** — see `user-guide/deployments.md`. A batch
  merge (`changes/merge-batch`) triggers neither the post-merge check nor a
  deploy. The deploy DLQ (`stratum-deploys-dlq`) has no consumer: dead-lettered
  messages sit there for manual inspection.
- Human reviews (approve / request changes) move the change state machine and are
  human-only; agents cannot approve work.

## Usage metering, entitlements, and BYOK

- Every cost record names who pays for it (`owner_id`, `owner_type`) and whether
  it was `platform` or `byok` spend, and rolls up into `usage_periods`, an
  owner-scoped monthly aggregate keyed `(owner_id, period, meter, source)`.
  Metering is **always on**, including self-hosted: it is a ledger, not a
  paywall.
- BYOK for the `llm` evaluator: an operator allowlist (`LLM_PROVIDERS`) of named
  providers (`anthropic`, `openai-compatible`), selected by name from
  `.stratum/policy.yaml`, with the project's own credential read from
  `project_secrets`. A policy can never supply a `baseUrl`. Every failure path
  fails the gate closed and none falls back to the operator's `AI` binding.
  See `adr/008-llm-provider-byok-threat-model.md`.
- A `UsageMeter` Durable Object holds the monthly reserve/settle counters and a
  bucketed sliding `evaluations_per_hour` window (a rate ceiling BYOK does not
  lift).
- An entitlements seam (`BILLING_SERVICE_URL` + `BILLING_SERVICE_SECRET`) that
  is **inert when unset** — every allowance reads as unlimited, no meter binding
  is touched, and nothing can be refused. Plan definitions and payment live
  outside this repository. Enforcement is additionally observe-only unless
  `ENTITLEMENTS_ENFORCE=1`: a decision is evaluated and recorded, and admits.
- Limits are checked against the **acting user** (an agent resolves to its
  owner), not the project's owner, so an allowance follows the person; recording
  still names the true owner, so the ledger is unaffected.
- Visibility: `/settings/usage`, an 80%-of-a-meter banner and one email per
  crossing, `stratum_get_usage` over MCP, and `GET /api/users/me/usage`. The
  billing surface is read-only everywhere — no tool or endpoint can raise a
  limit, buy capacity, or set a provider key.

## Events & integrations

- Durable event outbox in D1 → queue consumer with handler registry → 5-minute
  sweep cron re-enqueues stale events. At-least-once processing.
- Per-project activity feed (UI + API) over the event stream.
- Per-project webhooks with HMAC-SHA256-signed deliveries, event filters,
  delivery log, SSRF-guarded URLs.
- Issue tracker with per-project numbering and auto-close when a linked change
  merges. Bidirectional GitHub sync (inbound webhooks, outbound PR promotion).

## Auth & security

- Magic-link email auth, GitHub OAuth, Google OAuth (email-identity model), and
  named API tokens (`read` or `read_write`, optionally expiring, individually
  revocable); agent tokens bounded by an owning user's access.
- CSRF protection (Origin/Referer enforcement for session-cookie mutations),
  API key rotation, settings UI for key + agent token management.
- Append-only audit trail for sensitive operations with an admin query API;
  admin access requires `ADMIN_API_KEY` or the `ADMIN_EMAIL` user (fails closed).
- Rate limiting (global + import-specific), secret scanning on every change,
  workspace TTL sweep.

## UI

- Server-rendered (Hono JSX): dashboard, repo browser with collapsible file tree,
  syntax-highlighted file viewer (dependency-free lexer), commit log, changes with
  diff viewer + evaluator evidence + costs + reviews + comments, issues, activity,
  webhooks management, deployments (history, log tail for writers, Approve and
  Retry buttons), deploy-secret management in project settings, settings, and a
  per-account usage page (`/settings/usage`). Open changes poll via meta
  refresh.

## Tooling

- `cli/` — @stratum/cli at full API parity (projects, workspaces, commits,
  changes incl. review/merge, issues, activity).
- `agent/` — @stratum/agent reference agent: identity → fork → Claude edit plan
  → commit → Change with evaluation.

## Known limitations / future work

- Project/workspace identity lives in KV; changes, issues, events, costs, and
  audit live in D1. Full identity migration to D1 is future work (so is
  `workspace.deleted` event emission, blocked on an id→name index).
- Evaluation runs synchronously at change creation; the event pipeline is async
  but evaluation itself has no queue worker yet.
- Team permissions are org-wide; per-project team grants are not implemented.
- Phase 4 operational items remain: load testing at 1000+ concurrent workspaces,
  D1 hot/cold rotation, SSO/SAML, and the rest of multi-tenancy/billing for
  Stratum Cloud — the metering, entitlement and enforcement machinery above is
  in the tree, but plan definitions, checkout and subscription state are not,
  and there is no org billing UI, no seat model, and no retention or storage
  limit.
- Durability is covered: D1 and KV identity back up to R2 daily and on demand,
  along with the reachable history of a rotating slice of repos (coverage rotates
  across runs under a per-run cap), with a tested restore path
  (`docs/runbooks/backup-restore.md`).
- Git submodules are not supported (#258). A gitlink tree entry (mode 160000)
  at any depth, or a root-level `.gitmodules` file, is detected and rejected at
  the three points repo content enters Stratum — GitHub import, a gated push,
  and REST change creation (the last two share one scan, in the diff the change
  gate computes). The rejection carries the `SUBMODULES_UNSUPPORTED` code
  internally, but each entry point reports it in its own transport's terms: a
  gated push answers 200 with a per-ref `ng` reason and a permanent
  `push rejected` message, `POST /api/projects/{name}/changes` answers 400 with
  the explanatory message, and an import records the queue job as `failed`
  rather than answering any request at all. Change creation fails
  closed unconditionally: submodule content is refused, and so is a change
  whose scan could not run — that is the gate that keeps submodule content out
  of a server-side merge, which would otherwise corrupt it silently
  (isomorphic-git's checkout drops a gitlink from the materialized working
  tree). The import guard is deliberately best-effort: if the imported tree
  cannot be read at all — the read token cannot be minted, the clone fails, or
  the scan itself errors — the import proceeds with a warning and is left
  unscanned rather than failing a healthy repo on an infrastructure hiccup, so
  a completed import is not on its own proof the repo is submodule-free.
  Recursive submodule clone/browse is future work; see
  `user-guide/importing.md#unsupported-content`.

## Git LFS: not supported

Git LFS is entirely absent from Stratum:

- The git smart-HTTP router (`src/routes/git-http.ts`) exposes only
  `info/refs`, `git-upload-pack`, and `git-receive-pack` for projects and
  workspaces. There is **no `/info/lfs` route and no `objects/batch`
  endpoint**, so an LFS-enabled clone or push fails when the `git lfs` client
  calls the batch API — the request falls through to the app's 404 handler
  (`{"error": "Not found"}`).
- Nothing server-side understands LFS pointer files: browse and diff render a
  pointer file as its small text content, and imports bring over pointers,
  not the binaries behind them.
- Git push request bodies are capped at **50 MB**
  (`MAX_GIT_BODY_BYTES = 50 * 1024 * 1024` in `src/routes/git-http.ts`), so
  committing large binaries directly instead of via LFS is also blocked
  beyond that size.

Together these mean large-binary workflows are not viable on Stratum today.
Practical guidance:

- Keep binaries out of Stratum-hosted repos (generated assets, models, media
  belong in object storage referenced by URL).
- Keep LFS-dependent repos on GitHub and use **layer mode** (bidirectional
  sync) so agent work still flows through Stratum's gates.

Supporting LFS would require, at minimum: implementing the LFS batch API
(`POST <repo>.git/info/lfs/objects/batch`) plus the transfer endpoints, an R2
object store for LFS content addressed by OID, and pointer-file awareness in
the browse/diff surfaces so pointers resolve to their objects. This is
tracked as future work in `REMAINING_WORK.md`.
