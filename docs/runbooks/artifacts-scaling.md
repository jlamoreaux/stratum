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
