# Cloudflare Artifacts Best Practices Audit

Date: 2026-05-02

Reference:
- https://developers.cloudflare.com/artifacts/concepts/best-practices/

## Summary

Current status: **Partially aligned**.

Stratum follows key guidance by using a dedicated Artifacts binding and by separating production and staging Worker environments. However, it currently keeps both environments in the same Artifacts namespace (`default`), and there is no visible policy/documentation for metadata via Git notes, lifecycle cleanup, or namespace sharding.

## What aligns today

1. **Artifacts is a first-class storage backend**
   - The worker is explicitly configured with an Artifacts binding in both default and staging environments.

2. **Environment separation exists at the Worker layer**
   - Production and staging are separated as Wrangler environments.

## Gaps against Cloudflare guidance

1. **Namespace partitioning is not implemented**
   - Both prod and staging use `namespace = "default"`.
   - Cloudflare recommends namespace boundaries for environments/ownership/traffic isolation.

2. **Isolation unit policy is not explicit**
   - Cloudflare recommends one repo per autonomous work unit (agent/session/application).
   - The codebase docs mention projects/workspaces, but there is no explicit policy/checklist tying provisioning to the one-unit-per-repo model.

3. **Metadata handling guidance is missing**
   - Cloudflare recommends Git notes for out-of-band metadata to avoid mutating tree contents.
   - No repository standard is documented for where evaluation/provenance metadata should be stored relative to Git objects.

4. **Namespace growth/sharding playbook is missing**
   - No runbook for when request rates or repo count make `default` a hot namespace.

## Recommended changes

1. **Split namespaces by environment immediately**
   - Example: `stratum-prod` and `stratum-staging`.

2. **Document isolation policy**
   - Add a short architecture rule: one Artifacts repo per project/session (choose one and enforce consistently).

3. **Define metadata strategy**
   - Decide and document what belongs in Git notes vs. in-app DB tables.

4. **Add namespace scaling runbook**
   - Define thresholds and a sharding strategy for high-volume workloads (e.g., batch agents vs realtime agents).

## Minimal config change example

```toml
[[artifacts]]
binding = "ARTIFACTS"
namespace = "stratum-prod"

[[env.staging.artifacts]]
binding = "ARTIFACTS"
namespace = "stratum-staging"
```

## Validation checklist

- [ ] Prod and staging no longer share a namespace.
- [ ] Repo provisioning enforces the chosen isolation unit.
- [ ] Metadata policy (Git notes vs DB) is documented.
- [ ] Hot namespace detection + sharding process is documented.
