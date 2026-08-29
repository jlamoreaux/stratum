# Artifacts Namespace Scaling Runbook

## Purpose
Provide a repeatable process when a single Artifacts namespace becomes a bottleneck.

## Standing operating policy
These rules hold at all times, not only during a sharding exercise. They align Stratum with
Cloudflare Artifacts best practices.

- **Environment namespace separation.** Production and staging must use distinct Artifacts
  namespaces. Never share a namespace between environments.
  - Production namespace (`[env.production]`): `stratum-prod`
  - Staging namespace (`[env.staging]`): `stratum-staging`
  - Top-level default, used by `wrangler dev` and an unqualified `wrangler deploy`:
    `stratum`
- **Isolation unit.** Each Stratum project maps to a dedicated Git repository in Artifacts.
- **Metadata strategy.** Relational and queryable metadata lives in D1. Commit and
  evaluation provenance that should not alter tree contents is **planned to be stored** as
  Git notes (Phase 2 design decision); that is not yet implemented.
- **Scaling.** When namespace traffic grows, shard by workload class (for example
  `stratum-prod-realtime` and `stratum-prod-batch`) and route new projects to
  shard-specific namespaces — see the rest of this runbook.
- **Namespace change safety.** Before changing `[[artifacts]]` / `[[env.staging.artifacts]]`
  values in `wrangler.toml`, run a pre-deploy audit and migrate existing repos off the old
  namespace using the Artifacts REST API, or the data is orphaned. Track project-to-namespace
  migration here.

## Triggers
Start sharding when one or more of these persists for 24h+:
- Elevated Git operation latency for clone/fetch/push.
- Sustained high request volume from agent automation.
- Operational need to isolate noisy workloads (batch vs realtime).

## Sharding plan
1. Create additional namespaces by workload class:
   - `stratum-prod-realtime`
   - `stratum-prod-batch`
2. Route **new** projects to target namespace based on workload profile.
3. Keep existing projects in place initially to avoid disruptive migrations.
4. Migrate existing projects in maintenance windows if needed.

## Routing policy
- This is a **planning/pre-implementation runbook**. Do not run the routing, migration, or rollback steps until the "Before proceeding" checklist below is complete.
- Use a single explicit classification signal named `workloadProfile` for all implementations. The signal is supplied on project creation/import requests and persisted in project metadata so workspace provisioning and later maintenance jobs reuse the original classification.
- Accepted values:
  - `human_interactive`: route human-initiated, latency-sensitive project traffic to `stratum-prod-realtime`.
  - `bulk_agent`: route agent automation, evaluation, and other high-throughput batch traffic to `stratum-prod-batch`.
- Human interactive traffic -> `stratum-prod-realtime`.
- Bulk agent/evaluation traffic -> `stratum-prod-batch`.
- Example request body: `{ "name": "demo-project", "workloadProfile": "human_interactive" }`.
- Unknown values must be rejected with a 400 before provisioning. Missing values default to `human_interactive` so existing callers stay on realtime capacity during the transition.
- The binding-based routing implementation below must use this same `workloadProfile` signal, enum, and fallback policy.

## Before proceeding
- Define the migration mapping schema before moving repos. Add the DB or KV schema for `project -> old namespace -> new namespace -> migrated_at -> validated_at`; use a new file in `migrations/*.sql` for DB-backed state or update `src/storage/state.ts` for KV-backed project metadata.
- Implement binding-based routing and multi-namespace bindings in `wrangler.toml` before routing live traffic.
- Specify validation signals and thresholds, including clone/fetch/push success rate, p95 Git operation latency, project inventory completeness, and post-migration repository count/hash checks.
- Document Artifacts REST API prerequisites: credentials, required scopes, pagination handling, rate-limit behavior, retry policy, and completeness checks for inventory and migration verification.

## Safety checks
- Confirm prod/staging namespace separation remains intact.
- Confirm backup/restore and rollback process for migrated repos.
- Track migration map (project -> old namespace -> new namespace).

## Rollback
If elevated errors occur after migration:
1. Stop new migrations.
2. Route affected projects back to prior namespace.
3. Re-run validation and retry with smaller batches.

## Implementation approach (chosen)
Use **multiple Worker bindings** rather than direct REST namespace selection from request handlers.

Planned config and code changes (follow-up issue):
1. Add bindings in `wrangler.toml`:
   - `ARTIFACTS_REALTIME` -> `stratum-prod-realtime`
   - `ARTIFACTS_BATCH` -> `stratum-prod-batch`
2. Update env typing in `src/types.ts` to include both bindings.
3. Refactor existing single-binding references such as `c.env.ARTIFACTS.create(...)`, `c.env.ARTIFACTS.get(...)`, and `c.env.ARTIFACTS.delete(...)` in provisioning handlers to select `ARTIFACTS_REALTIME` or `ARTIFACTS_BATCH` by the persisted `workloadProfile`.
4. Update project-creation/import handlers to validate `workloadProfile`, persist it in project metadata, and call the selected binding.
5. Update workspace creation/deletion and maintenance paths to resolve the parent project's `workloadProfile` before selecting the binding.
6. Add tests for realtime, batch, missing-value default, and unknown-value rejection in project/workspace routing decisions.
7. Retain the legacy `ARTIFACTS` binding only as a backward-compatible alias to `ARTIFACTS_REALTIME` for one release after multi-binding routing ships; remove it after all provisioning and maintenance paths have switched to profile-based selection.

Tracking: create a dedicated follow-up issue for binding-based routing implementation before enabling shard routing in production.

## Namespace migration requirement
If namespace identifiers in `wrangler.toml` are changed, first run a pre-deploy inventory and migrate existing repos via the Artifacts REST API. Do not deploy namespace changes until migration mapping (project -> old namespace -> new namespace) is validated.
