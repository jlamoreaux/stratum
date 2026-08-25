# CI Integration (Bring Your Own CI)

Stratum has **no native CI runner** — there are no workflow files, no hosted
build agents, and no GitHub Actions replacement. What Stratum *does* run for
you is its evaluation and merge pipeline, and it gives you exactly three ways
to execute code as part of that pipeline. This page inventories them honestly
and shows how to wire an external CI system you host into the evaluation gate.

## The complete code-execution inventory

Stratum can execute code in exactly three places, all driven by
`.stratum/policy.yaml`:

### 1. The sandbox evaluator

The `sandbox` evaluator (`src/evaluation/sandbox-evaluator.ts`) materializes
the **full workspace tree at the evaluated commit** — the same tree the merge
would land — into a fresh Cloudflare Sandbox and runs a command there (default
`npm test`, default timeout 60s, configurable via `command` and `timeoutMs`).
If the tree carries a `package.json` it installs first, using `npm ci` when a
lockfile is present and `npm install` otherwise. Exit code 0 scores 1.0;
otherwise the test output is parsed for `N passed / M failed` counts to derive
a partial score.

It **requires the optional `SANDBOX` binding**. If a policy names a `sandbox`
evaluator and the binding is absent, the evaluator does not silently
disappear — it is replaced with an "unavailable" evaluator that returns
score 0 / failed (see `buildEvaluators` in `src/services/change-flow.ts`).
In other words, it **fails closed**.

The evaluator's `diff` argument is ignored on purpose: an earlier version
reconstructed a pseudo-tree from the diff's `+` lines, which could not run a
real suite — no base tree, no untouched sources, no `package.json` unless it
happened to change. The tree is read from the repo instead.

It is still not a general CI environment — one command, one timeout, no
matrix, no artifacts, no caching between runs — but it does run against real
sources rather than a reconstruction.

### 2. The `webhook` evaluator — your CI, called synchronously

The `webhook` evaluator (`src/evaluation/webhook-evaluator.ts`) is the
bring-your-own-CI hook: Stratum POSTs the change to an HTTPS endpoint you
host, and your endpoint returns the verdict. The full contract is documented
[below](#the-webhook-evaluator-contract).

### 3. `merge.postMergeCommand` — post-merge smoke in a sandbox

After a merge, the policy's `merge.postMergeCommand` (if set) runs in a
Cloudflare Sandbox against the **full merged tree** (`src/merge/post-merge.ts`),
with a default timeout of 60s (`postMergeTimeoutMs`). On failure the merge is
automatically reverted unless `merge.autoRevert: false`. Like the sandbox
evaluator, this requires the `SANDBOX` binding; without it the check is
skipped with a warning.

That's it. Everything else — building artifacts, deploying, scheduled jobs —
must live in a system you run outside Stratum.

## The webhook evaluator contract

Configure it in `.stratum/policy.yaml`:

```yaml
evaluators:
  - type: webhook
    url: https://ci.example.com/stratum-eval
    secret: <shared-secret>   # optional; enables HMAC signing — see the warning
    timeoutMs: 10000          # optional; default 10000 (10s)

merge:
  requiredEvaluators: ["secret_scan", "webhook"]
```

> **`secret` is a literal in a committed file.** `EvaluatorConfig` types it as
> `secret?: string` (`src/evaluation/types.ts`) and the policy loader performs
> no environment or secret-store lookup, so the only way to enable HMAC signing
> today is to write the value into `.stratum/policy.yaml` — where every reader
> of the repository can see it. There is no `.dev.vars` or Wrangler-secret
> indirection for this field; adding one is an implementation change, not
> configuration. Until then, treat a signed webhook as authenticating *the
> repository*, not a confidential channel, and rotate the value if the repo's
> readership changes.

### Request (Stratum → your endpoint)

- `POST` with `Content-Type: application/json`.
- Body: `{"diff": "<unified diff of the change>", "policy": {...}}` — the
  policy object is the parsed evaluation policy, so your endpoint can read
  its own config from `policy.evaluators`. It is passed through
  `sanitizePolicy` first (`src/evaluation/sanitize-policy.ts`), which strips
  `secret` from every webhook evaluator entry, so no receiver sees any
  evaluator's signing secret — including its own. Provision your receiver's
  copy of the secret out of band; do not expect to read it from the payload.
- If `secret` is set, the header `X-Stratum-Signature: sha256=<hex>` carries
  an HMAC-SHA256 of the exact request body, keyed with the secret. Verify it
  before trusting the payload.
- The URL must target a **public host over http/https** — localhost, private
  IP ranges, `.internal`/`.local` names, and bare single-label hostnames are
  rejected and the evaluation fails closed (score 0). Redirects are **not
  followed**; a 3xx counts as failure.

Two properties of the current contract are worth knowing before you point a
receiver at it. This section describes what ships today.

- **`http://` URLs are accepted**, and the HMAC authenticates the body without
  encrypting it. Over plain HTTP the diff and the policy travel in cleartext.
  Use an `https://` URL, and terminate TLS in front of your receiver.
- **The payload does not name the base commit** the diff was generated
  against. A receiver that checks out its own `main` may evaluate against a
  newer tree than Stratum diffed, and `git apply` may succeed against the wrong
  base. Keep the mirror pinned rather than tracking a moving branch ([#274](https://github.com/stratum-eng/stratum/issues/274)).

### Response (your endpoint → Stratum)

Reply `200 OK` with JSON:

```json
{ "score": 0.95, "passed": true, "reason": "142 tests passed" }
```

- `score`: number (aggregated with the other evaluators' scores — averaged
  when `requireAll` is on, the default; max otherwise).
- `passed`: boolean verdict.
- `reason`: human-readable explanation shown in the change's evidence.

Any non-2xx status is recorded as a failed evaluation
(`Webhook failed: HTTP <status>`).

### The timeout constraint (important)

The call is **synchronous**: evaluation runs at change-creation time, inside
the request, and the webhook is aborted after `timeoutMs` (default **10
seconds**). There is **no async callback API today** — your CI must produce
its verdict within the request window. Practical approaches:

- Keep the webhook check fast (lint, typecheck, focused smoke tests) and
  raise `timeoutMs` moderately for slower suites.
- Pre-warm workers/caches on your CI host so a run doesn't pay cold-start.
- Run the long suite out-of-band and have the webhook return the verdict for
  the most recent equivalent state — accepting the staleness tradeoff.

A timed-out or errored webhook surfaces as an external-service error for that
evaluator, and a `merge.requiredEvaluators` entry for `webhook` will keep the
change unmergeable until a re-evaluation passes.

## Wiring your CI to the contract

The endpoint's job is narrow: authenticate the request, decide, and answer in
the verdict shape. A sketch of just that part:

```js
// Sketch — the contract, not a deployable receiver. See the note below.
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.STRATUM_WEBHOOK_SECRET;

/** Constant-time check of the `sha256=<hex>` header against the raw body. */
function signatureValid(rawBody, header) {
  if (!SECRET) return true; // no secret configured: Stratum sends no signature
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", SECRET).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// rawBody is the exact bytes Stratum sent — verify before parsing, since
// re-serializing JSON would change what you are authenticating.
if (!signatureValid(rawBody, headers["x-stratum-signature"])) {
  respond(401, { error: "bad signature" });
} else {
  const { diff, policy } = JSON.parse(rawBody);
  const verdict = await yourCi(diff, policy); // whatever "run the checks" means for you
  respond(200, {
    score: verdict.score,     // 0..100
    passed: verdict.passed,   // boolean — this is what gates the merge
    reason: verdict.reason,   // shown in the change UI
  });
}
```

**What this deliberately leaves out.** `yourCi` is where the change under
evaluation actually gets built and tested, and that is the part this guide does
not attempt to specify. Applying a diff and running its test suite means
executing attacker-controlled code: `git apply` alone can introduce hooks and
`.gitattributes` filters, and a test suite can do anything. Doing that safely is
an infrastructure problem — separate user and PID namespaces so the workload
cannot read the receiver's environment, a fresh filesystem per evaluation so one
change cannot observe or poison another, resource and time bounds, no ambient
credentials, no reachable cloud metadata — and it is not something a copyable
snippet can be trusted to get right. Run it on disposable, least-privileged
infrastructure you already trust for untrusted builds. Issue #281 tracks writing
that guidance up properly.

Two constraints worth knowing before you build it: the response must arrive
inside the timeout window described above, and the receiver should sit behind
TLS you terminate yourself — the body carries the change diff.

### Using GitHub Actions as the executor

GitHub Actions cannot answer a synchronous webhook directly (a dispatched
workflow run is asynchronous), so the common pattern in **layer mode** is to
not use the webhook evaluator at all: keep the repo synced to GitHub, let
Actions run on the promoted PR as usual, and let humans review there. If you
want Actions *inside* the Stratum gate, you need a small always-on receiver
(like the sketch above) that runs the same checks the workflow does — or that
proxies to a pre-warmed self-hosted runner — within the timeout window.

## What's missing vs GitHub Actions

To set expectations, Stratum has none of the following today:

- Workflow definitions (`.github/workflows`-style pipelines, triggers, steps)
- Hosted or self-hosted runner management
- Matrix builds
- Build artifacts (upload/download/retention)
- Dependency/build caching
- Scheduled jobs (cron workflows)
- A secrets store for CI (the webhook `secret` lives in the policy file)
- Deployment environments, approvals-per-environment, or deploy gates
- Status-check aggregation — Stratum does not collect external CI check
  results the way a GitHub PR's checks tab does. An external system reports a
  verdict only by answering the webhook evaluator synchronously; a check that
  reports anywhere else is invisible to the gate.

If you need those, run a real CI system and connect it via the webhook
evaluator (for gating) or via GitHub sync in layer mode (for everything else).

## See also

- [FAQ: Does Stratum replace GitHub Actions?](faq.md#does-stratum-replace-github-actions)
- `docs/CURRENT_CAPABILITIES.md` — the authoritative current state
