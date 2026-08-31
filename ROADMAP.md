# Roadmap

This file tracks what is **not yet shipped**. Everything that *is* shipped is described in
[`README.md`](README.md) and, in full detail with its caveats, in
[`docs/CURRENT_CAPABILITIES.md`](docs/CURRENT_CAPABILITIES.md). Keeping the two apart is
deliberate: the README carries no status markers, so it can't drift out of sync with them.

[`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md) holds the rationale for each item below —
why it's open, and what it unblocks. Dates and per-change detail live in
[`CHANGELOG.md`](CHANGELOG.md).

Want to pick something up? See [CONTRIBUTING.md](CONTRIBUTING.md). Items here are
deliberately coarse; open an issue to discuss an approach before starting a large one.

## Where things stand

The master-plan feature roadmap — Phases 0–3, plus the code-level Phase 4 hardening — has
been complete since 2026-06-11.

| Phase | Delivered |
|---|---|
| 0 | Fork/commit/merge loop on Artifacts, GitHub import |
| 1 | D1 persistence, authentication, evaluation engine, web UI |
| 2 | LLM evaluator, sandbox execution, event-driven pipeline, Durable Object merge queue, provenance |
| 3 | Organizations and teams, CLI, reference agent, bidirectional GitHub sync, issue tracker |
| 4 (code) | Audit trail, backup/restore, deletion jobs, gated `git push` (ADR 005), security hardening |

What remains is Phase 4's **operational** half — the work required to run Stratum as a
hosted, multi-tenant service — plus engineering debt and one feature gap. None of it blocks
single-tenant self-hosted usage.

## Operational / scale (Stratum Cloud)

- [ ] **Load testing** — validate 1000+ concurrent workspaces per repo; establish latency
      and error budgets before any public hosting.
- [ ] **D1 hot/cold rotation** — move events, audit entries, and evaluation evidence older
      than 30 days to R2 to keep the hot database small.
- [ ] **Batch merging in the merge queue** — the merge queue Durable Object merges one
      change at a time. Test N queued changes together and bisect on failure. (The
      server-side `changes/merge-batch` endpoint already does this for an explicit batch;
      this item is the queue doing it automatically.)
- [ ] **SSO remainders** — per-org OIDC sign-in and SCIM 2.0 Users provisioning shipped
      (#253; config via `/api/orgs/:slug/sso`, sign-in at `/auth/sso`). Still open: an SSO
      enforcement toggle (magic-link still works for corporate emails), SAML (if a customer
      requires it), SCIM Groups, and a management UI.
- [ ] **Multi-tenancy and billing** — tenant isolation, usage metering, billing. Per-change
      cost tracking already exists and provides the metering foundation.
- [ ] **Monitoring dashboard UI** — a UI over the existing `/api/admin/metrics` (queue
      depth, evaluation latency, error rates, event outbox lag).
- [x] **Backup strategy for D1 and Artifacts** — daily and on-demand backups to R2 with a
      tested restore path ([runbook](docs/runbooks/backup-restore.md)).

## Engineering debt

- [ ] **Migrate project/workspace identity from KV to D1** — KV has no listing or
      transactional guarantees. Unblocks `workspace.deleted` events and removes the scan
      fallback in `getProject`.
- [ ] **Async evaluation worker** — evaluation runs synchronously at change creation, so
      change-creation latency includes the full evaluator suite. A queue-backed worker keeps
      creation fast and allows retries. Fine at current scale.
- [ ] **Per-project team permission grants** — team write/admin grants are org-wide today.

### Publish the client packages to npm

- [ ] `@stratum/cli`, `@stratum/mcp`, and `@stratum/agent` all live in this repo at full API
      parity, but none are published, so consumers must build from source. Publishing needs a
      release workflow, provenance attestation, and a version policy across the three.

## Feature gaps

### Git LFS support

- [ ] Stratum has no LFS support at all: no `/info/lfs` route, no `objects/batch` endpoint,
      and a 50 MB git push body cap, so large-binary workflows are blocked entirely. An
      implementation needs the LFS batch API plus transfer endpoints, an R2 object store
      addressed by OID, and pointer awareness in the browse and diff surfaces. Until then,
      keep LFS repos on GitHub and use layer mode. Details in
      [`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md#git-lfs-support).

### Diff depth

- [ ] Per-line intra-hunk highlighting and binary-file diffs. Hunk-level unified and split
      views already ship.

### Merge conflict resolution for changes

- [ ] A conflicting three-way merge falls back to a squash merge; there is no interactive
      conflict resolution for changes. (GitHub *sync* conflicts do have a resolution UI.)

## Explicitly not planned

- **SSH transport for git.** Workers have no raw TCP listener. Smart HTTP is the supported
  transport; [ADR 006](docs/adr/006-ssh-transport.md) records what SSH would take, should
  the decision be revisited.
- **Moving git operations off the Worker.** Git runs in-memory via isomorphic-git, which
  caps usable repository size. Containers or a backend service would lift that ceiling; it
  is a plausible future direction rather than committed work.
