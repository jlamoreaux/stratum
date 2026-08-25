# ADR 006: SSH Transport for Git

## Status

Proposed — **exploration only, not pursued now**. HTTPS smart-HTTP (ADR 005)
is the supported transport; this ADR records what an SSH transport would take
so the decision can be revisited on demand. ADR 005 already called this out:
"Smart-HTTP only at first; SSH transport is explicitly out of scope (Workers
have no raw TCP listener)."

## Context

`git clone git@host:owner/repo.git` is the default muscle memory for many
developers, and some environments (locked-down HTTPS proxies, existing SSH
key infrastructure, tooling that assumes SSH remotes) prefer or require it.
Stratum currently serves git exclusively over smart HTTP
(`src/routes/git-http.ts`): `info/refs`, `git-upload-pack`, and
`git-receive-pack` on the Worker, authenticated with API keys over HTTP
Basic. The user-guide FAQ states plainly: "SSH transport is not supported
(Workers have no raw TCP listener)."

### Why SSH cannot live in the Worker

- **No inbound raw TCP.** Cloudflare Workers accept HTTP(S) requests; there
  is no way for a Worker to listen on port 22 (or any raw TCP port) for
  inbound connections. The SSH protocol cannot be terminated in the Worker
  at all.
- **The storage backend speaks smart-HTTP only.** Repositories live on
  Cloudflare Artifacts, addressed as
  `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`
  and accessed with short-lived tokens minted via the `ARTIFACTS` binding
  (`freshRepoToken` in `src/storage/git-ops.ts`). There is no SSH endpoint
  anywhere in the storage plane, so any SSH front end must translate to
  smart-HTTP anyway.

So SSH support necessarily means a **separate always-on service** in front
of the existing HTTP plane — exactly the "large operational departure from
the Workers-only architecture" that ADR 005's alternatives section rejected.

## Decision

**Do not build SSH transport now.** Smart HTTP covers clone, fetch, and push
(workspace push and the gated default-branch push), works with stock git and
credential helpers, and has produced no demand signal strong enough to
justify running a stateful, always-on SSH service. Revisit when concrete
demand appears (users blocked by HTTPS-hostile environments, enterprise SSH
key policies). The exploration below is the record of what "yes" would look
like.

## Exploration: what an implementation would require

### Hosting the SSH endpoint

The SSH daemon must run somewhere that accepts raw TCP:

| Option | Pros | Cons |
| --- | --- | --- |
| **Cloudflare Containers** | Stays in the Cloudflare account/tooling; scales to zero; close to the Worker for the bridge hop | Newer platform; per-instance pricing; still an always-on-ish footprint for interactive SSH latency; **does not answer public port 22 on its own** — a Container is reached through a Worker binding, so raw SSH needs a separate TCP ingress path in front of it (Spectrum, or another TCP proxy). That is a second product in the dependency chain, not a detail to settle later |
| **Small VM (e.g. one $5-tier instance)** | Boring, well-understood sshd/ops story; trivial to run a custom SSH server binary | A second deployment target outside `wrangler deploy`; patching, monitoring, host-key custody, HA are all manual; single region unless multiplied |

Either way the cost is dominated by operations, not compute: a git-SSH
bridge is tiny, but it is a new stateful service with its own uptime, host
keys, and security patching — for a transport the HTTP proxy already covers
functionally.

### Auth design sketch

- **SSH public keys mapped to Stratum users.** A new table (D1) of
  `(user_id, key_fingerprint, public_key, name, created_at)`.
- **Key-management API**: `POST /api/users/me/keys` to add a key (plus list
  and delete), sitting alongside the existing API-key management in
  settings. (This endpoint does not exist today; it would be new surface.)
- **Fingerprint → user resolution.** At SSH auth time the bridge computes
  the offered key's fingerprint and resolves it to a Stratum user.
- **Delegating that identity is the hard part, and it is a confused-deputy
  problem.** The Worker authorizes with `canReadProject` /
  `canWriteProject` / `canWriteWorkspace` (`src/utils/authz.ts`), each keyed
  on a `userId`/`agentOwnerId` the HTTP router derives from the caller's own
  credential. A bridge calling in with a *service* credential presents its
  own identity, so the user it claims to be acting for arrives as data. If
  the Worker simply believes that claim, any compromise of the bridge — or
  any bug in its fingerprint lookup — reads and writes every repository.
  This repository has already paid for trusting caller-supplied
  authorization input once (SA-6, #233).

  So the contract has to be explicit, and it is a prerequisite rather than
  an implementation detail. Either:
  - the bridge sends a **short-lived assertion binding the resolved
    `userId`, the repository, the requested scope and an expiry, signed with
    a key the Worker verifies** before it calls the `authz` helpers — the
    Worker still makes every authorization decision, the assertion only
    carries *who is asking*; or
  - the bridge performs the authorization itself against the same helpers,
    accepting that the policy now lives in two places (see the scope-parity
    note below for why that is the worse option).

  Whichever is chosen, the acceptance test is the same and must exist before
  the path is enabled: **user A's key must not reach user B's private
  repository**, asserted end to end rather than at the fingerprint lookup.

### Backend bridge

After SSH auth succeeds, the bridge executes the requested git service by
proxying to Artifacts, exactly as the HTTP proxy does today in
`src/routes/git-http.ts`:

- Mint a short-lived, scope-appropriate Artifacts token per operation with
  `freshRepoToken` (read for `git-upload-pack`, write for
  `git-receive-pack`); tokens carry an embedded `?expires=` and are never
  persisted or exposed to the client.
- Authenticate upstream with HTTP Basic as `x:<secret>`, where the secret
  is `extractTokenSecret(token)` (the portion before `?expires=`) — the
  same header construction the HTTP proxy's `basicAuthHeader` uses.
- Drive the same two-step exchange the HTTP routes drive, rather than
  relaying stdin/stdout at one endpoint. Git-over-SSH runs one command
  (`git-upload-pack <repo>` / `git-receive-pack <repo>`) over a single
  duplex channel; smart HTTP splits that into ref discovery and an RPC, so
  the bridge has to bridge the shape as well as the framing:
  1. `GET /info/refs?service=git-upload-pack|git-receive-pack` for the
     advertisement, forwarding the client's `Git-Protocol` header so
     protocol-v2 negotiation is preserved (`proxyUpstream` forwards exactly
     `Git-Protocol`, `Content-Type` and `Content-Encoding`, and never the
     inbound `Authorization`). Note the advertisement differs between the
     two transports — SSH has no `# service=` pkt-line banner or flush that
     smart HTTP prepends — so the bridge strips or synthesizes it.
  2. `POST` the client's pack negotiation to the matching RPC endpoint.
     Workers cannot half-duplex stream an outbound `fetch` body, so the
     request body is buffered whole before it is sent — the same constraint
     the HTTP path already lives with, and the reason the 50 MB
     `MAX_GIT_BODY_BYTES` cap exists.
- Map failures back into the SSH channel deliberately. `proxyUpstream`
  fails closed on any non-2xx and on redirects (`redirect: "manual"`, so an
  Artifacts token is never followed to another host); a `receive-pack`
  refusal instead arrives as an in-protocol `report-status` with per-ref
  `ng` lines. The bridge must preserve that distinction — a policy refusal
  has to reach the user as a failed ref update with its reason, not as a
  dropped connection.

The bridge would either call the Worker's existing `/@ns/slug.git/*` routes
with a service credential, or (preferably) reuse the Worker as the single
authorization point so the SSH path cannot drift from the HTTP path's
policy decisions — in particular the push gate.

### Scope parity

- **Read-only first**: `git-upload-pack` (clone/fetch) for projects and
  workspaces is the low-risk slice.
- **Push carries the HTTP path's policy, not just its plumbing.** Neither
  push route is a straight relay any more:
  - A **workspace** push has its ref-update commands parsed and checked
    against `checkWorkspacePushPolicy` before anything reaches upstream
    (`src/utils/git-protocol.ts`, wired in at the workspace
    `git-receive-pack` route). The proxy did relay that body verbatim until
    #130/#216, which is precisely the hole that closed: a fork owner could
    otherwise delete refs or push arbitrary `refs/*` through their
    workspace remote. An SSH bridge that "just proxies" reintroduces it.
  - A **default-branch** push on the project remote must route through the
    same gated-push flow as ADR 005 slice 2b (`GIT_PUSH_GATED_ENABLED`),
    never around it.

  This is the strongest argument for the bridge delegating to the Worker
  rather than reimplementing the proxy: every future ref-policy change lands
  in one place instead of two, and the SSH path cannot silently fall behind
  the HTTP path's guarantees.

## Consequences

### Positive (if built)

- `git@` remotes work; SSH-key-only environments can use Stratum natively.

### Negative

- A second, stateful, always-on service outside the Workers deployment
  model: host-key custody, patching, monitoring, and scaling all become
  ongoing obligations.
- A second auth surface (SSH keys) beside API keys, with its own lifecycle
  UI and revocation story.
- A second transport that must track every future change to the push gate.

## Open questions

- **Host key rotation**: how to rotate the server host key without
  triggering `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` for every
  user; publish fingerprints where?
- **Rate limiting / abuse**: the HTTP path inherits the Worker's rate
  limiting; the SSH bridge would need its own connection and auth-attempt
  limits.
- **Demand**: no quantified demand yet. What signal (support requests,
  adoption blockers) justifies the standing cost?

## Alternatives Considered

- **Do nothing (chosen)**: HTTPS smart-HTTP suffices for clone, fetch, and
  push today.
- **Vend Artifacts tokens for direct SSH-ish access**: not possible —
  Artifacts itself is smart-HTTP only, and vending tokens was already
  rejected in ADR 005.

## Related Decisions

- [ADR 005: Native `git push` via a Smart-HTTP Proxy](005-git-smart-http-proxy.md)
  — establishes the HTTP transport, the token-minting bridge pattern this
  ADR would reuse, and the original SSH out-of-scope note.

## References

- `src/routes/git-http.ts` — smart-HTTP proxy (auth, `proxyUpstream`,
  `basicAuthHeader`)
- `src/utils/git-protocol.ts` — `parseReceivePackRequest`,
  `checkWorkspacePushPolicy` (the ref policy an SSH bridge must also honour)
- `src/storage/git-ops.ts` — `freshRepoToken`, `extractTokenSecret`
- `docs/user-guide/faq.md` — "SSH transport is not supported"
