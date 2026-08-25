# Spike Plan: Option B — Warm RepoDO Cache

**Goal:** Kill clone-per-operation on the commit/merge hot path and produce a
**measured** single-repo throughput number (commits/sec, p50/p95 latency, and a
per-phase breakdown). This is the evidence-gathering stage from
[ADR 004](../adr/004-high-frequency-agent-commits.md) — it does **not** build the
owned object store (Option A). We instrument first, warm the cache second, then
decide whether the remaining gap justifies Option A.

**Target effort:** ~1–2 weeks. **Exit criterion:** a before/after number we
trust, plus a go/no-go recommendation on Option A.

---

## Phase 0 — Instrument the current path (get the "before" number)

We cannot improve what we have not measured. Before touching architecture,
capture where the seconds go today.

- [ ] Add phase timings around each step in the merge path: token mint, clone,
      fetch, merge, push, D1 update. Wrap the calls in
      `src/storage/git-ops.ts` (`mergeWorkspaceIntoProject`, `cloneRepo`,
      `commitAndPush`) and `src/queue/merge-queue.ts` (`MergeQueue.merge`).
- [ ] Emit timings through the existing metrics path
      (`src/storage/metrics.ts`, surfaced at `/api/admin/metrics`) rather than
      inventing a new sink. Add a `commit_phase_timings` table/rollup or reuse
      the import-metrics shape.
- [ ] Write a load harness under `scripts/` (e.g. `bench-commit-throughput.ts`,
      alongside the existing `scripts/*.ts`) that fires N concurrent commits at
      **one** repo and reports: commits/sec, p50/p95/p99 end-to-end latency, and
      the per-phase breakdown. Parameterize N (1, 5, 25, 100) and commit size.
- [ ] Run it against staging. Record the baseline in this doc's Results table.

**Deliverable:** the honest current number, replacing "I think ~1–2/sec," and a
breakdown proving clone+push dominate (the ADR's hypothesis).

## Phase 1 — Warm RepoDO cache (remove clone-per-op)

- [ ] Introduce a per-repo Durable Object (extend `MergeQueue` into `RepoDO`, or
      add `RepoDO` and have `MergeQueue` delegate). One instance per project
      repo, keyed by project id.
- [ ] Cache warm state in DO storage between operations: packed refs + a hot
      object index, so a commit no longer triggers a cold `git.clone`
      (`depth: 50`) every time. Large blobs stay in Artifacts; the DO holds
      refs + index, not the whole working tree.
- [ ] Route commits through the DO: write objects, then ask the DO to apply the
      change against its warm state and push to Artifacts. Keep the existing
      cold path as a fallback when the cache is empty or stale.
- [ ] Keep the persisted commit/merge semantics identical — this phase is a
      latency change, not a behavior change. Existing tests
      (`tests/git-ops.test.ts`, `tests/changes.test.ts`,
      `tests/merge-protection.test.ts`) must stay green.

**Deliverable:** commits that reuse warm state instead of re-cloning; the
clone phase drops out of the Phase 0 breakdown.

## Phase 2 — Fast-forward CAS + optimistic concurrency

- [ ] Commit carries `expectedParent`. The DO does an in-memory compare-and-swap
      on `refs/heads/main`: if `head == expectedParent`, fast-forward and return;
      this is the common case at high frequency (concurrent agents mostly touch
      different files). Mirrors the optimistic-locking `version` CAS already used
      for import state in [ADR 003](../adr/003-d1-for-import-state.md).
- [ ] On CAS miss (raced), **do not reject** — enqueue to a resolve step that
      rebases the incoming tree onto the new head and re-attempts the CAS. For
      this spike the resolver can be the mechanical three-way tree merge only;
      LLM auto-resolution of true same-hunk overlaps is explicitly out of scope
      (it lives in the resolve plane and reuses the existing evaluator later).
- [ ] (Stretch) Batch: drain N queued advances, one combined tree, one CAS, one
      push — the load-bearing version of the `TODO.md` "batch merging" item.

**Deliverable:** the serialization window shrinks from a full merge to a ref
CAS; throughput should jump on the concurrent-N runs.

## Phase 3 — Re-measure and decide

- [ ] Re-run the Phase 0 harness unchanged. Fill in the "after" column.
- [ ] Compare against the ~20+ commits/sec single-repo target and write a
      go/no-go recommendation on Option A: if Option B (bounded by Artifacts'
      ref-update latency) lands close enough, Option A may be unnecessary; if a
      real gap remains, the measured number justifies the quarter-scale build.
- [ ] Update ADR 004 status (Proposed → Accepted/Superseded) based on findings.

---

## Out of scope for this spike

- Owning the object store / R2-direct plumbing (Option A).
- LLM-assisted conflict resolution (resolve plane intelligence).
- Containerized native-git backend for gc/repack/large packs.
- Changing the fork-per-workspace model; this runs alongside it.

## Results

**Status: pending staging benchmark.** The harness
(`scripts/bench-commit-throughput.ts`) is implemented, but the runs against a
real staging deployment (real Artifacts, real D1) have not been recorded here
yet, so every "pending" cell below awaits that run. This table must not be
filled from local-dev numbers — `wrangler dev` latencies are not
representative of Artifacts round-trips.

| Metric (single repo)        | Before (Phase 0)             | After (Phase 2)              | Target |
|-----------------------------|------------------------------|------------------------------|--------|
| Commits/sec (N=25)          | pending staging benchmark    | pending staging benchmark    | ~20+   |
| p50 end-to-end latency      | pending staging benchmark    | pending staging benchmark    | —      |
| p95 end-to-end latency      | pending staging benchmark    | pending staging benchmark    | —      |
| Clone phase share of total  | pending staging benchmark    | pending staging benchmark    | —      |

Phase 2 is *designed* to remove the per-request clone by keeping the repo
resident in the DO, so the expected warm figure is ~0. That is a prediction,
not a result: the benchmark still has to show that the warmup batch primes the
DO and that no re-clone happens inside the measured interval. A cold start
clones once regardless, so if the warm and cold shares turn out to differ,
report them separately rather than collapsing them into one number.

### How to produce the numbers

The harness fires N concurrent commit → merge cycles at one project repo and
reports commits/sec plus a per-phase breakdown, in both conflict modes. Run it
against **staging** (it refuses known production hosts unless
`--i-understand-this-writes-real-commits` is passed, because every merge
pushes a real commit):

```bash
# Export the credentials first, and keep the quotes. An unquoted <...> is a
# shell redirection, not a placeholder: pasting these as one backslash-
# continued VAR=value block is a syntax error, not a silent no-op.
export STRATUM_URL="https://staging-host.example"
export STRATUM_SESSION="<stratum_session cookie value>"  # or: export STRATUM_TOKEN="<bearer token>"

npx tsx scripts/bench-commit-throughput.ts --n=1,5,25,100 --conflict=none --repeat=3
```

Credentials differ by what you are running:

| Run | Needs | How it is sent |
|-----|-------|----------------|
| Ordinary benchmark | `STRATUM_SESSION` **or** `STRATUM_TOKEN` | session cookie / bearer token |
| `--r2-bench` | `STRATUM_ADMIN_KEY` | `X-Admin-API-Key`, compared against the server's `ADMIN_API_KEY` |
| `GET /api/admin/metrics` | admin rights | the same `X-Admin-API-Key`, **or** a signed-in user whose email equals the server's `ADMIN_EMAIL` |

`--r2-bench` fails fast without `STRATUM_ADMIN_KEY`, and the metrics read
returns 401 for a non-admin session — so a run can produce throughput numbers
and still have no per-phase breakdown to go with them.

Flags (defaults in parentheses): `--url` (or `STRATUM_URL`,
`http://localhost:8787`), `--n` — comma-separated concurrency levels
(`1,5,25,100`; `1,5,25,50,64` in batch mode, whose server cap is 80),
`--conflict` `none|same` (`none`), `--repeat` (1), `--warmup` (1),
`--project` name prefix (`bench-throughput`; each run creates a disposable
uniquely-suffixed project), `--bytes` commit payload size (256),
`--duration` ms for the R2 probe (3000), `--r2-bench` — drive the Phase 2
R2 object-plane + group-commit endpoint (authenticates with an admin key)
instead of full merges, `--batch` — drive the server-side batch-merge
endpoint.

Output is a plain-text table:
`N | mode | landed | failed | wall(ms) | commits/sec | p50/p95/p99(ms)` —
per-op latency percentiles are reported only at N ≤ 5 (at N ≥ 25 the single
DO serializes advances, so latency is queue wait, not work). The server-side
per-phase breakdown is read separately from `GET /api/admin/metrics` (commits
block), which reports all eight spans of `CommitPhaseSpans` — token mint,
project clone, workspace fetch, merge, push, ref advance, D1 update, and
provenance. Reading only the clone/merge/push subset hides where the rest of
the wall-clock went; workspace fetch and D1 update in particular are the two
that move once the repo is warm. Note the timing caveat printed by the
harness: Workers freeze the clock between I/O, so CPU spans are lower bounds.

Run each mode twice: once "before" and once "after", per the harness header
comment. `REPO_DO_ENABLED` is a **server-side** Worker var set per environment
in `wrangler.toml` — not one of the client `STRATUM_*` variables above — so the
two runs need two staging configurations (or two deployments), with the flag
`"false"` for "before" and `"true"` for "after". Record the effective
`REPO_DO_ENABLED` value next to each result: without it the two columns cannot
be told apart after the fact.

### Acceptance thresholds

- ADR 004's target is **~20+ commits/sec** sustained into a single repo
  (versus its estimated **~1–2 merges/sec** cap on the current serialized
  path).
- Issue #124 records the thresholds used for the R2/group-commit fast path:
  the group-commit benchmark **must stay ≥ 22.6 c/s**, with **431 c/s** as
  the then-current group-commit figure. The 22.6 floor is also enforced in
  the repo — `TARGET_CPS` in `tests/group-commit.test.ts` (added by #109) —
  but that test measures a **local model** of the ref plane (a
  `GroupCommitCoordinator` over a 50 ms simulated `durableWrite`), not a
  deployment, so it bounds the batching design, not Stratum's real
  throughput. The 431 c/s figure appears only in the issue text. Treat the
  staging run — not either citation — as the source of truth when filling
  the table.

## References

- [ADR 004](../adr/004-high-frequency-agent-commits.md) — the architecture this
  spike de-risks
- Hot path: `src/storage/git-ops.ts`, `src/queue/merge-queue.ts`
- Metrics: `src/storage/metrics.ts`, `src/routes/metrics.ts`
  (`/api/admin/metrics`)
- Related tests: `tests/git-ops.test.ts`, `tests/merge-protection.test.ts`,
  `tests/conflict-resolution.test.ts`
