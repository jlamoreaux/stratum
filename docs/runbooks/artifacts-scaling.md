# Artifacts Namespace Scaling Runbook

## Purpose
Provide a repeatable process when a single Artifacts namespace becomes a bottleneck.

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
- Human interactive traffic -> `stratum-prod-realtime`
- Bulk agent/evaluation traffic -> `stratum-prod-batch`

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
3. Update project-creation/provisioning handlers to select binding by workload profile (human-interactive vs batch agent) instead of the single `ARTIFACTS` binding.
4. Add tests for routing decisions in project/workspace creation paths.

Tracking: create a dedicated follow-up issue for binding-based routing implementation before enabling shard routing in production.

## Namespace migration requirement
If namespace identifiers in `wrangler.toml` are changed, first run a pre-deploy inventory and migrate existing repos via the Artifacts REST API. Do not deploy namespace changes until migration mapping (project -> old namespace -> new namespace) is validated.
