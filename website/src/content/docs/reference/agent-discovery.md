---
title: Agent discovery
description: Every machine-readable entry point Stratum publishes, what each one contains, and how an agent should walk them.
---

Stratum treats agents as first-class users, so everything a human can find in
these docs an agent can find in a machine-readable form. This page is the map.

## Start here

An agent that knows nothing but the domain should walk this order:

1. **DNS** — `_index._agents.usestratum.dev` (SVCB) points at the origin that
   serves the discovery documents.
2. **`/.well-known/ai-catalog.json`** — the ARD manifest. One document listing
   every capability, each with a media type and a URL.
3. Follow the entry that matches the task.

An agent that already has an HTML page can skip step 1: every page carries the
catalogue in an RFC 8288 `Link` header and an in-page `<link rel="ai-catalog">`.

## The entry points

| Path | Format | What it is |
|---|---|---|
| [`/.well-known/ai-catalog.json`](/.well-known/ai-catalog.json) | ARD manifest | Every capability Stratum publishes, with representative queries for semantic indexing |
| [`/.well-known/api-catalog`](/.well-known/api-catalog) | RFC 9727 linkset | Service description and documentation links for the REST API |
| [`/.well-known/mcp/server-card.json`](/.well-known/mcp/server-card.json) | MCP server card | How to launch and authenticate the Stratum MCP server, and its tool list |
| [`/.well-known/agent-skills/index.json`](/.well-known/agent-skills/index.json) | Agent Skills Discovery v0.2.0 | SKILL.md artifacts with `sha256` digests |
| [`/auth.md`](/auth.md) | Markdown | The agent registration contract, in prose |
| [`/openapi.yml`](/openapi.yml) | OpenAPI 3.1 | The complete REST API contract |
| [`/llms.txt`](/llms.txt), [`/llms-full.txt`](/llms-full.txt) | Plain text | Documentation index and complete corpus |
| [`/sitemap-index.xml`](/sitemap-index.xml) | XML | Every page |

All of them are served with `Access-Control-Allow-Origin: *`, so an agent running
in a browser on another origin can read them directly.

## Markdown instead of HTML

Any documentation page returns its Markdown source when you ask for it:

```bash
curl -H "Accept: text/markdown" https://docs.usestratum.dev/guides/getting-started/
```

Appending `.md` to the path works too, and survives intermediary caches that
ignore `Vary: Accept`.

## Skills

Three SKILL.md artifacts cover the things agents actually need to do. Verify the
`sha256` digest from the index against what you download.

- [`stratum-merge-gate`](/.well-known/agent-skills/stratum-merge-gate/SKILL.md) —
  get a change through the evaluation gates, and read the verdict when one blocks
- [`stratum-mcp`](/.well-known/agent-skills/stratum-mcp/SKILL.md) — connect an
  MCP client and use the tool set
- [`stratum-agent-identity`](/.well-known/agent-skills/stratum-agent-identity/SKILL.md) —
  obtain a credential and understand its limits

## WebMCP

Documentation pages register [WebMCP][webmcp] tools on load, so a browser agent
can call the site instead of scraping it: `search_stratum_docs`,
`read_stratum_doc`, `list_stratum_docs`, `get_stratum_api_spec`, and
`get_stratum_agent_auth`. The registration is a no-op in browsers without
`navigator.modelContext`.

## DNS-AID

[DNS-AID][dnsaid] records under the `_agents` namespace let an agent find the
discovery origin without a prior HTTP request:

```text
_index._agents.usestratum.dev.  3600 IN SVCB 1 docs.usestratum.dev. (
                                     alpn="h2,http/1.1" port=443
                                     mandatory=alpn,port
                                     key65280="/.well-known/ai-catalog.json" )
```

`key65280` carries the draft's `well-known` parameter, which has no IANA
allocation yet and so travels in RFC 9460's private-use range. The zone must be
signed with DNSSEC before these records are relied on — discovery records tell an
agent where to send credentials, and unsigned they are trivially spoofable.

The records are kept in
[`website/dns/agents.zone`](https://github.com/stratum-eng/stratum/blob/main/website/dns/agents.zone),
with apply and verification steps in the README beside it.

## What Stratum does not publish

There is **no `/.well-known/openid-configuration` and no
`/.well-known/oauth-authorization-server`**, because Stratum is not an OAuth
authorization server. It issues opaque bearer tokens minted by a human account
holder; there is no `authorization_endpoint`, `token_endpoint`, or `jwks_uri` to
name. [`/auth.md`](/auth.md) carries the registration flow instead.

There is also **no `/.well-known/oauth-protected-resource`**. RFC 9728 has a
client derive that URL from the protected resource's own origin, and the
protected resource is `https://app.usestratum.dev` — an origin these docs do not
serve. A copy published here would be found only by agents that already knew
where to look, while every spec-compliant client kept getting a 404 from the
origin that matters. It belongs on the API origin or nowhere, so for now:
nowhere.

Publishing endpoints that do not exist would send agents into a failing OAuth
handshake, which is worse than the metadata being absent — and it is precisely
the class of confidently-wrong machine output Stratum exists to gate.

[webmcp]: https://webmachinelearning.github.io/webmcp/
[dnsaid]: https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/
