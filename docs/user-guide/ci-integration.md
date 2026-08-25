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

The `sandbox` evaluator (`src/evaluation/sandbox-evaluator.ts`) writes the
added lines of the change's diff into a fresh Cloudflare Sandbox and runs a
command there (default `npm test`, default timeout 60s, configurable via
`command` and `timeoutMs`). Exit code 0 scores 1.0; otherwise the test
output is parsed for `N passed / M failed` counts to derive a partial score.

It **requires the optional `SANDBOX` binding**. If a policy names a `sandbox`
evaluator and the binding is absent, the evaluator does not silently
disappear — it is replaced with an "unavailable" evaluator that returns
score 0 / failed (see `buildEvaluators` in `src/services/change-flow.ts`).
In other words, it **fails closed**.

Note the sandbox sees only the diff's added lines reconstructed as files, not
a full checkout — it is a smoke-check, not a full CI environment.

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
    secret: <shared-secret>   # optional; enables HMAC signing
    timeoutMs: 10000          # optional; default 10000 (10s)

merge:
  requiredEvaluators: ["secret_scan", "webhook"]
```

### Request (Stratum → your endpoint)

- `POST` with `Content-Type: application/json`.
- Body: `{"diff": "<unified diff of the change>", "policy": {...}}` — the
  policy object is the parsed evaluation policy, so your endpoint can read
  its own config from `policy.evaluators`.
- If `secret` is set, the header `X-Stratum-Signature: sha256=<hex>` carries
  an HMAC-SHA256 of the exact request body, keyed with the secret. Verify it
  before trusting the payload.
- The URL must target a **public host over http/https** — localhost, private
  IP ranges, `.internal`/`.local` names, and bare single-label hostnames are
  rejected and the evaluation fails closed (score 0). Redirects are **not
  followed**; a 3xx counts as failure.

Three properties of the current contract are worth knowing before you point a
receiver at it. All three are tracked; this section describes what ships today.

- **The policy is sent verbatim, `secret` values included.** Every webhook
  receiver therefore sees the secrets of *every* webhook evaluator in the
  policy, not just its own — and a receiver configured without a secret still
  receives the others'. Until that is fixed ([#273](https://github.com/stratum-eng/stratum/issues/273)), do not configure two
  webhook evaluators with different trust levels against one policy, and treat
  a policy secret as shared with every endpoint it names.
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

## Worked example: a generic webhook CI receiver

Any HTTPS service works. A minimal Node receiver that applies the diff to a
checkout, runs tests, and answers the verdict:

```js
// stratum-ci-receiver.mjs — run on your own infrastructure, behind TLS
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = process.env.STRATUM_WEBHOOK_SECRET;
if (!SECRET) throw new Error("STRATUM_WEBHOOK_SECRET is required");
const REPO_DIR = process.env.REPO_DIR; // a clone kept in sync with the project

// Stay under Stratum's timeoutMs (default 10000) with room to send the reply.
// The budget covers the WHOLE request — checkout, patch, tests — not just the
// test run, or Stratum aborts before the verdict is written.
const DEADLINE_MS = 9000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// An explicit allowlist, never this process's env. A diff can rewrite
// package.json or a test file, and anything inherited here is handed to that
// code — including STRATUM_WEBHOOK_SECRET, which would let it forge verdicts.
const CHILD_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

function evaluate(diff, budgetMs) {
  // A throwaway worktree per request. `git checkout -f .` restores tracked
  // paths but leaves whatever `git apply` created, so a shared checkout leaks
  // untracked files from one evaluation into the next.
  const dir = mkdtempSync(join(tmpdir(), "stratum-eval-"));
  const started = Date.now();
  const left = () => Math.max(1, budgetMs - (Date.now() - started));
  try {
    execFileSync("git", ["-C", REPO_DIR, "worktree", "add", "--detach", dir, "HEAD"],
      { env: CHILD_ENV, timeout: left() });
    writeFileSync(join(dir, "change.diff"), diff);
    execFileSync("git", ["-C", dir, "apply", "change.diff"],
      { env: CHILD_ENV, timeout: left() });
    execFileSync("npm", ["test", "--prefix", dir], { env: CHILD_ENV, timeout: left() });
    return { score: 1, passed: true, reason: "tests passed" };
  } catch (e) {
    return { score: 0, passed: false,
             reason: String(e.stdout || e.message).slice(0, 500) };
  } finally {
    try {
      execFileSync("git", ["-C", REPO_DIR, "worktree", "remove", "--force", dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

createServer((req, res) => {
  const started = Date.now();
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    // Bound the body BEFORE the signature check: this endpoint is public, and
    // an unbounded `body += c` lets an unauthenticated sender exhaust memory.
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);

    // 1. Verify the HMAC over the EXACT bytes received, before parsing them.
    const expected = "sha256=" +
      createHmac("sha256", SECRET).update(body).digest("hex");
    const got = Buffer.from(req.headers["x-stratum-signature"] ?? "");
    if (got.length !== expected.length ||
        !timingSafeEqual(got, Buffer.from(expected))) {
      res.writeHead(401).end();
      return;
    }

    // 2. Parse and validate inside error handling. Malformed JSON must be a
    //    400, not an uncaught throw in an event handler that kills the process.
    let diff;
    try {
      const payload = JSON.parse(body.toString("utf8"));
      if (typeof payload?.diff !== "string") throw new Error("missing diff");
      diff = payload.diff;
    } catch {
      res.writeHead(400).end();
      return;
    }

    // 3. Evaluate inside what is left of the request budget.
    const result = evaluate(diff, DEADLINE_MS - (Date.now() - started));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
}).listen(8080);
```

The worktree starts without `node_modules`, so give it the dependencies your
suite needs — share a cache directory, symlink from the primary clone, or bake
them into the image. `createServer` here is plain HTTP on purpose: terminate
TLS in front of it (a reverse proxy or load balancer) rather than exposing this
port directly, since the body carries the change diff.

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

If you need those, run a real CI system and connect it via the webhook
evaluator (for gating) or via GitHub sync in layer mode (for everything else).

## See also

- [FAQ: Does Stratum replace GitHub Actions?](faq.md#does-stratum-replace-github-actions)
- `docs/CURRENT_CAPABILITIES.md` — the authoritative current state
