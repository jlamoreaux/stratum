# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **GitHub sign-in no longer trusts an unverified email.** The callback picked
  the primary address, verified or not, and fell back to *any* address on the
  account. That address then matched (and linked to) an existing Stratum
  account, so anyone could add a victim's email to their own GitHub profile,
  leave it unverified, and sign in as the victim; it also created new accounts
  under addresses nobody had proven. Only a verified address is used now, for
  matching and for creation alike, and an account with none is refused (`422`).
  The closed-beta path already worked this way; the open-signup path did not.
- **Minting an agent token from the settings form requires a browser session.**
  `POST /settings/agents` and `POST /settings/agents/:id/delete` loaded the user
  but never checked *how* they authenticated, so a scoped `read_write` API token
  could post to the form and receive a fresh agent token — a credential that
  outlives the token that minted it, which is exactly the circularity #254 closed
  for `/settings/tokens`. Both are now behind the same session-only guard.
  This closes the browser form only: `POST /api/agents` and
  `DELETE /api/agents/:id` still accept any authenticated caller, so the
  capability is not gone. Closing that too is a breaking change for automation
  that provisions agents with an API token, and is left as a deliberate decision
  rather than folded into this change.

### Added
- **Signing up with GitHub or Google now asks you to choose a username.** The
  callbacks used to mint the account on the spot, naming it after the GitHub
  handle or the email's local part — and a username is the namespace every
  project URL, clone URL, and backing repository is keyed on, so it cannot be
  changed afterwards. A first-time identity is now parked (verified email and,
  for GitHub, the account to link; fifteen minutes, in KV, bound to an httpOnly
  cookie) and lands on `/auth/signup/complete` to pick a name, with the handle
  prefilled as a suggestion and live availability feedback. Nothing is written
  until the form comes back; signing in to an existing account is unchanged.
  The same page collects an invite code while the closed beta is on, so OAuth
  signup is no longer refused under the gate — it presents a code like the
  magic-link form does, and is admitted (codes minted, emailed) the same way.
- **A profile page, and invite codes you can actually find.** `/profile` (linked
  from the header, next to settings) shows your account identity — username,
  email, member since, and any linked GitHub account — plus the invite codes
  issued to your account, each with a share link and whether it has been
  redeemed. Codes previously existed only in the one email sent at signup, which
  is best-effort and skipped entirely when the instance has no email binding
  configured, so a lost or never-sent email meant unreachable codes; they can now
  be read back from the referral service on demand. The listing keys off
  `REFERRAL_SERVICE_URL` alone rather than `BETA_GATE`, so codes minted while the
  gate was on stay visible to their owners after signups reopen, and an
  unreachable service reports itself as such instead of rendering as "you have no
  codes". Requires the referral service to serve
  `GET /api/referral/codes?userId=…` (contract in `wrangler.toml`). On an
  instance with no referral service — every ungated self-hosted deployment — the
  page still renders its account details, just without the invite section. Like
  `/settings`, it is session-only: an API token cannot enumerate your codes.
- **The MCP server is now remote, served by the Worker at `/mcp`.** Streamable
  HTTP, stateless — no session id, no Durable Object, so any isolate answers any
  request. Connecting a client is a URL (`claude mcp add --transport http
  stratum https://…/mcp`) instead of a clone, a build, and a hand-copied token.
  All eighteen tools are unchanged in name and behaviour; they now run against
  the real API route handlers in-process (`src/mcp/dispatch.ts`) rather than
  over the network, so every authorization check, evaluation gate and refusal is
  the REST API's own rather than a reimplementation of it. Accepts the two
  older protocol revisions alongside `2025-06-18`, and handles JSON-RPC batches
  for the revisions that allow them.
- **Stratum is now an OAuth 2.1 authorization server**, for `/mcp`. Dynamic
  client registration (RFC 7591) at `/oauth/register`, mandatory PKCE with
  `S256` only, 60-second single-use authorization codes, one-hour access tokens,
  rotating 30-day refresh tokens capped at an absolute 180-day grant lifetime,
  RFC 7009 revocation, and RFC 8414/9728 discovery documents built from the
  request origin so a self-hosted instance advertises itself with nothing to
  configure. An editor is connected with a browser consent screen; no Stratum
  credential is ever pasted into a client config.

  Reuse of a spent credential is treated as a compromise signal on both halves
  of the flow, per OAuth 2.1 §4.3.1 and RFC 9700 §4.14: a replayed
  authorization code and a replayed (already-rotated) refresh token each revoke
  every token the grant produced. A redemption that merely *fails validation* —
  wrong client, wrong verifier, wrong redirect URI — leaves the code untouched,
  so observing one is not enough to disrupt the rightful client.
- **Connected applications in settings.** Every authorized MCP client is listed
  with its self-declared name, client id, granted access and last use, and can
  be disconnected in one click — which revokes the access token and the ability
  to refresh at once.
- **`stratum_mcp_` access tokens are a first-class credential kind** in
  `authMiddleware`, resolved on every request like user and agent tokens, with
  `mcp:write` mapping to `read_write` and anything else to `read`. Two refusals
  are specific to a delegated credential and enforced before routing: an OAuth
  grant cannot reach `/api/admin/*` (even for the instance administrator, whom
  `resolveAdminAuth` would otherwise authorize on an `ADMIN_EMAIL` match), and
  cannot rotate the never-expiring legacy API key.
- **CLI and MCP server guides.** Dedicated documentation for `@stratum/cli`
  (`docs/user-guide/cli.md`) and the MCP server (`docs/user-guide/mcp.md`),
  published at `/guides/cli/` and `/guides/mcp/` — configuration, the full
  command/tool surface (including `project delete` and `account delete`, which
  the package README omitted), the commit path's 2,000-file/25 MB caps and its
  inability to express deletions, and exactly which MCP tools an agent token
  can use. Also corrects the `stratum_review_change` tool description, which
  claimed agents can submit `request_changes` verdicts: the server refuses
  every review verdict from an agent token (`src/routes/reviews.ts` requires a
  user), so an agent's feedback channel is change comments.

### Changed
- **The MCP request body is capped at 8 MB**, below the REST API's 25 MB commit
  limit. A tool call is buffered, parsed, re-serialized into an internal request
  and parsed again, so a body near the REST limit would cost more than a Workers
  isolate's entire 128 MB budget — which is shared with every concurrent request
  that isolate serves. A commit that does not fit belongs on the git remote.
- **All three sign-in paths now honour one post-login destination.** The
  magic-link flow read a `redirect_after_login` cookie nothing set, GitHub
  threaded a `next` parameter, and Google always went to `/`. A flow that sends
  an unauthenticated user to sign in — the MCP consent screen, for one — has to
  get them back to the request they interrupted whichever button they used, so
  the cookie is now written and consumed by a shared helper with one
  open-redirect check (`src/utils/post-login-redirect.ts`). GitHub's `next`
  still wins when present.
- `isScopedTokenCaller` is now `cannotMintLegacyCredential`, and covers OAuth
  grants as well as scoped tokens.

### Removed
- **The standalone `mcp/` package (`@stratum/mcp`).** It was a stdio process
  that wrapped the REST API over the network — 609 lines holding no state,
  touching no local git, and offering nothing the Worker could not do itself,
  in exchange for a clone-and-build install. The remote endpoint replaces it
  outright; the CI job that built and smoke-tested it is gone with it.
- **Agent discovery metadata on the docs site.** `docs.usestratum.dev` now publishes an ARD
  capability manifest (`/.well-known/ai-catalog.json`), an Agent Skills Discovery v0.2.0 index
  with three `SKILL.md` artifacts and `sha256` digests, `/auth.md` describing the agent
  registration contract, and WebMCP tools registered on page load. DNS-AID SVCB records live
  in `website/dns/agents.zone` for the operator to publish.
  The docs site itself publishes no OAuth authorization-server, OIDC, or RFC 9728
  protected-resource document: RFC 9728 metadata is resolved from the API origin, which these
  docs do not serve, so advertising it here would send agents to a URL that cannot answer
  them. The app origin does now serve both discovery documents — see the MCP entry above.
- **Multi-branch support (#181).** Create, list and delete branches on a project
  (`GET/POST/DELETE /api/projects/:ns/:slug/branches`), browse any of them with
  `?ref=` on the files, content and log endpoints and in the web UI, and switch
  between them from a no-JavaScript branch switcher. Branch creation is the
  enabling piece: no path previously put a second `refs/heads/*` on a project
  repo, so there was nothing to list. A new branch can only start from a commit
  the repository already holds, so creating one can never introduce content.
  Backups now record branch refs and restore rebuilds them.
- **The diff's base commit reaches CI (#274).** Evaluation webhooks now carry
  `baseSha`, the commit the diff was actually taken against, so a receiver can
  apply the hunks to the right revision instead of guessing at whatever the
  default branch happened to be when the request landed.
- **Delete import.** A failed or cancelled import can be dismissed from the project page, clearing
  its import chrome. Only that job is removed, so the project's import history — and the clone
  depth the next sync reads from it — is preserved.
- Finished import jobs are now pruned after 30 days by the daily housekeeping cron. Nothing had
  been pruning them. The most recent job per project is always kept, because that is the row the
  next sync reads its clone depth from.
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
- **A total time budget for sandbox evaluation** (`totalBudgetMs`, default 150s). The per-phase
  timeouts were independent, so nothing bounded their sum and an evaluation could hold a
  synchronous request open past any client or proxy deadline. Each phase is now granted
  `min(configured, budget remaining)`, and exhausting the budget returns a failing verdict whose
  reason names the phase (`sandbox budget exceeded (install)`) instead of hanging. See
  [ADR 007](docs/adr/007-sandbox-evaluator-threat-model.md), which also documents what the
  Cloudflare Sandbox binding is and is not relied upon to isolate.
- `allowInstallScripts` on the `sandbox` evaluator config.
- **Docs for the last few weeks of shipping.** New guides for
  [code review](docs/user-guide/code-review.md) (line-anchored threads, replies,
  resolve/unresolve, and the three review verdicts) and
  [issues](docs/user-guide/issues.md) (triage, labels, assignee, search, and
  auto-close on merge), neither of which was documented anywhere; API references
  for both; a rewritten troubleshooting guide covering the failure modes that
  actually ship today (scoped-token refusals, wedged imports, sandbox budget
  exhaustion, `--ignore-scripts`, dismissed approvals); and the token, branch,
  and sync error codes added to the error reference.
- **The contributor rule from #344 now names the generated-docs workflow.** That PR
  required user-facing changes to update the public docs in the same PR, pointing
  contributors at `website/src/content/docs/`. Those pages are now generated, so
  AGENTS.md and the PR template say to edit the canonical page under `docs/user-guide/`
  or `docs/api/` and run `sync:guides` instead. Its "goes stale silently since nothing
  fails a build over it" caveat no longer applies — `check:guides` fails CI on drift.
- **The docs site now publishes the CI integration guide, and the guide and
  reference pages are generated from `docs/` rather than hand-mirrored.**
  `website/scripts/mirror-docs.mjs` renders them; the mirrors are committed, and
  CI runs `npm run check:guides` before the site build so drift fails rather
  than deploying a stale page. The two copies had drifted in
  both directions: the published authentication page still described the
  pre-scoped-token model, and the published FAQ and import guide were each
  missing whole sections.

### Breaking
- **The sandbox evaluator no longer runs npm lifecycle scripts.** Dependency installs now pass
  `--ignore-scripts`, because the evaluated tree is untrusted and a `preinstall`/`postinstall`
  would otherwise execute before any human review. Projects whose build genuinely needs them
  (native modules, a `prepare` step) opt back in with `allowInstallScripts: true` on the
  `sandbox` evaluator in `.stratum/policy.yaml`. Note the usual symptom is *not* a failing
  install: a native module installs unbuilt and then fails when the test command loads it.
- **The default sandbox install timeout drops from 120s to 90s**, so the per-phase defaults sum
  to exactly the new total budget and an unconfigured project is never truncated.
- Re-evaluating an existing change (`POST /changes/:id/evaluate`) runs under the new default, so
  a change that passed before this release may fail on re-evaluation.

### Fixed
- Approvals are dismissed when the evaluated **base** moves, not only when the
  tip does. A change re-evaluated against a newer base kept approvals that were
  granted against different code.
- **Import jobs can no longer wedge forever.** A scheduled sweep now moves stalled imports to a
  terminal state on its own — previously recovery only ran if somebody happened to open the
  project's progress page, so an abandoned job could show "Import in Progress" with a `CANCELLING`
  badge indefinitely. A cancel that never finished lands in `cancelled`; anything else that stopped
  progressing becomes `failed` with an explanatory error. Jobs that were never picked up off the
  queue are reaped too, under a longer grace period.
- **Stall detection never actually fired.** Both the sweep and the existing on-demand recovery
  compared `updated_at` against SQLite's `datetime('now', …)`, which formats timestamps with a
  space, while every job row stores an ISO-8601 string. Compared as text, `'T'` sorts after `' '`,
  so no row matched until the UTC date itself rolled over — silently delaying recovery by up to a
  day. Both now compare ISO instants, and migration 043 normalises any legacy timestamps.
- **The import status `syncing` was never actually saved.** It was missing from the `import_jobs`
  status constraint, so the write the queue consumer makes when a sync begins failed silently on
  every run and the job kept reading as `queued` long after it had started. The constraint now
  admits every status the code can produce (migration 043), and the write reports failures instead
  of discarding them.
- A cancellation that the sweep finished is now recognised as cancelled by the queue consumer, which
  previously treated it as a failure — emailing the user about a failure they never had and, on the
  sync path, restarting the work they had cancelled.
- An import in its sync phase now shows as in progress, with a spinner, a Cancel button and live
  updates. Because `syncing` could never previously be stored, the progress card had no case for it
  and would have rendered a running import as though nothing were happening.
- On-demand stall recovery now updates the job it actually selected. It picked the stalest row but
  wrote back by project, which resolves to the newest row — so on a project with more than one
  import it could fail a healthy running job and leave the wedged one in place.
- **"Sync Now" no longer appears on an empty repository**, where it sat next to "Not synced" and an
  in-progress import badge — three claims that could not all be true at once. It still appears when
  the file listing merely failed, which is when it is most needed.
- `STRATUM_TELEMETRY_DISABLED` had no effect on `deploy:production` or `deploy:staging`. It was
  declared only under top-level `[vars]`, which named wrangler environments replace rather than
  inherit, so self-hosters who set it were still sending telemetry. It is now declared per
  environment.
- The active-token cap counted expired tokens, so a user whose tokens had all
  lapsed could not create a replacement without first revoking each dead row by
  hand. Expired and revoked tokens now both free their slot.

### Changed
- **The docs site and the app share one header.** `docs.usestratum.dev` was rendering
  Starlight's default header — a different wordmark, typeface, height and link treatment from
  the one at `app.usestratum.dev`, so the two halves of the product did not look related.
  The docs site now renders the app's header: the same `stratum` wordmark, chrome and accent
  links, with search, theme and GitHub controls sized to sit on it, plus a `sign in` link back
  to the app. It is shared rather than copied — `src/ui/nav-css.ts` owns the rules and
  `website/scripts/mirror-header.mjs` generates the site's `header.css` from them, with the
  docs build and the test suite failing on a stale copy.
- **The docs home is a documentation page, not a second landing page.** It dropped the
  six marketing feature cards, then the splash hero itself: `docs.usestratum.dev/` now
  renders with the sidebar like every other page, opens with what the site is, and points
  at the three guides and three reference pages a reader starts from — the pitch lives at
  `usestratum.dev`, which the page links to. The header wordmark goes there too, the way
  the app's wordmark goes to the app, and a new "Overview" sidebar entry keeps the docs
  home reachable. `public/index.md`, the hand-maintained Markdown twin agents read, matches.
- Repository-activity analytics events no longer carry `project`, the concrete project name; they
  carry the opaque `projectId` instead. Dashboards grouping on `project` must switch to
  `projectId` — old `project` references receive no new data. Events for projects created before
  `projectId` dual-write carry no project property at all, so they group under nothing rather
  than under a name.

### Security
- **Webhooks are scoped on project id alone (#235).** `webhookBelongsToProject`
  and `listWebhooks` still matched `project_id = ? OR (project_id IS NULL AND
  project = ?)`, so a pre-migration-025 row could be read, modified and
  delivered to by a same-named project in another namespace. `listWebhooks` now
  takes the project id rather than its name, so a name-scoped lookup is not
  expressible at the call site, and `createWebhook` requires `projectId` so no
  new unstamped row can undo the backfill.
- Policy files are now validated per evaluator, not just spread onto the defaults. `sandbox` and
  `webhook` timeouts are clamped into range, `sandbox.command` is rejected if it is blank,
  over-length, or contains a newline (which a shell would read as a second command), a `webhook`
  entry without a `url` is dropped, and malformed `evaluators` entries are dropped instead of
  crashing evaluator construction. An out-of-range value is clamped with a warning; it does not
  block merges.
- **`minScore` is clamped to `[0, 1]` and replaced when rejected.** Previously the raw value from
  the policy file survived validation, so `minScore: -.inf` (or the string `"-5"`) made
  `score >= minScore` true for every score — accepting changes whose evaluators had all scored 0.
- A policy containing an unusable evaluator entry now fails the merge gate closed with a
  `configError` rather than dropping that entry and proceeding on the survivors. Silently removing
  one gate while its siblings remain would let a change through on the rest — a `webhook` whose
  `url` was typo'd previously reached the evaluator and blocked. An unrecognised evaluator *type*
  is unaffected; it is still passed through and rejected downstream.
- A YAML alias cycle in a policy file no longer causes the whole file to be treated as absent.
  Serializing a rejected entry for a log line could throw, and the fallback silently discarded the
  file's `merge` protection — dropping `requiredApprovals` and re-enabling force-merge.
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
- **Docs said agent tokens were "short-lived".** They are not: the `agents` table
  has no expiry column and `getAgentByToken` performs no expiry check, so an
  agent token is valid until the agent is deleted. The claim appeared in the
  README, the getting-started guide, the FAQ, `CURRENT_CAPABILITIES.md`, and the
  published authentication reference, and would have led an operator to assume a
  leaked agent token lapsed on its own.

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
