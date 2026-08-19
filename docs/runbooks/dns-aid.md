# DNS-AID: agent discovery records

How Stratum instances advertise themselves to AI agents via
[DNS for AI Discovery (DNS-AID)](https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/):
ServiceMode SVCB/HTTPS records ([RFC 9460](https://www.rfc-editor.org/rfc/rfc9460))
under the domain's `_agents` namespace, served from a DNSSEC-signed zone.

DNS-AID answers "does this domain host agent-facing services, and where?"
before any HTTP request is made. The records point at the Stratum instance,
whose own discovery surface then takes over: `/auth.md` and
`/.well-known/oauth-protected-resource` /
`/.well-known/oauth-authorization-server` (served by `src/routes/discovery.ts`)
describe how agents register and authenticate.

## The records (hosted instance)

The `usestratum.dev` zone publishes the well-known organizational entrypoint
from the draft, pointing at the production instance:

```dns
_index._agents.usestratum.dev. 3600 IN HTTPS 1 app.usestratum.dev. alpn="h2"
```

- **`_index._agents`** — the DNS-AID well-known entrypoint label for a
  domain's agent registry/index.
- **ServiceMode** (priority `1`, explicit TargetName) — carries endpoint +
  parameters in one answer; `alpn="h2"` says the endpoint speaks HTTP/2 over
  TLS. Stratum's agent surface is plain HTTPS (REST API, git smart-HTTP), so
  an HTTPS record is the right shape; per the draft, protocol-specific labels
  (`_a2a._agents`, `_mcp._agents`) should only be added if such endpoints are
  actually hosted — `@stratum/mcp` runs locally against the REST API, so no
  `_mcp` record is published.
- **TTL 3600** — matches the draft's examples; discovery data changes rarely.

## Publishing / updating

The records are managed by an idempotent script against the Cloudflare API:

```bash
export CLOUDFLARE_API_TOKEN=...   # Zone:Read + DNS:Edit on the zone
npx tsx scripts/publish-dns-aid.ts --dry-run   # show what would change
npx tsx scripts/publish-dns-aid.ts             # create/update the record set
```

Zone and target default to `usestratum.dev` / `app.usestratum.dev`; override
with `DNS_AID_ZONE` and `DNS_AID_TARGET` (see below for self-hosting).

## DNSSEC

The draft calls for discovery zones to be signed so validating resolvers
return authenticated data. On Cloudflare:

1. `npx tsx scripts/publish-dns-aid.ts --enable-dnssec` (or dashboard →
   zone → **DNS → Settings → Enable DNSSEC**).
2. Publish the DS record at the registrar. On Cloudflare Registrar this is
   automatic; elsewhere, copy the DS the script prints (also shown in the
   dashboard) into the registrar's DNSSEC settings. Note `.dev` requires a
   DNSSEC-capable registrar, and the whole chain (`.dev` → zone) must be
   intact.
3. Status flips from `pending` to `active` once the DS is seen at the parent.

## Validation

Query through a validating DNS-over-HTTPS resolver (this is how scanners such
as isitagentready.com check):

```bash
# Answer + AD (authenticated data) flag via Cloudflare's resolver
dig @1.1.1.1 _index._agents.usestratum.dev HTTPS +dnssec

# Same over DoH JSON (Google fallback: dns.google/resolve)
curl -s -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=_index._agents.usestratum.dev&type=HTTPS' | jq
```

Expect a ServiceMode HTTPS answer targeting `app.usestratum.dev` with
`alpn="h2"`, and `"AD": true` once DNSSEC is active. A full external check:
`POST https://isitagentready.com/api/scan` with `{"url": "https://usestratum.dev"}`
should report `checks.discoverability.dnsAid.status: "pass"`.

## Self-hosting

Publish the equivalent record for your own domain, targeting wherever your
Worker runs:

```dns
_index._agents.example.com. 3600 IN HTTPS 1 your-instance.example.com. alpn="h2"
```

On Cloudflare, reuse the script
(`DNS_AID_ZONE=example.com DNS_AID_TARGET=your-instance.example.com npx tsx scripts/publish-dns-aid.ts`);
on any other DNS provider, add the record above (as type `HTTPS`, or `SVCB`
where `HTTPS` is unavailable) and sign the zone with your provider's DNSSEC
tooling. The `/auth.md` + well-known endpoints need no configuration — they
derive all URLs from the request origin.
