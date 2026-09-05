# Policy reference

Everything `.stratum/policy.yaml` accepts: every field, its type, its default,
the bounds Stratum clamps it into, and what happens when it is wrong.

This is the reference. [Getting started](../user-guide/getting-started.md#3-write-your-evaluation-policy)
is the tutorial that walks you into it, and
[CI integration](../user-guide/ci-integration.md) covers the `webhook` evaluator
in depth. Stratum's own policy —
[`.stratum/policy.yaml`](../../.stratum/policy.yaml) — is a live example the
project runs under.

## Contents

- [Where the policy lives](#where-the-policy-lives)
- [What happens when the file is missing or broken](#what-happens-when-the-file-is-missing-or-broken)
- [The whole file at a glance](#the-whole-file-at-a-glance)
- [`evaluators:`](#evaluators)
  - [Secret scan (always on)](#secret-scan-always-on)
  - [`diff`](#diff)
  - [`llm`](#llm)
  - [`sandbox`](#sandbox)
  - [`webhook`](#webhook)
- [Scoring and aggregation](#scoring-and-aggregation)
- [`merge:`](#merge)
- [Editing the policy is itself gated](#editing-the-policy-is-itself-gated)
- [`deploys:`](#deploys)
- [Defaults and limits](#defaults-and-limits)
- [What a policy cannot enforce](#what-a-policy-cannot-enforce)

## Where the policy lives

The policy is a file in the repository, read from the **project's default
branch** at the revision being evaluated. Commit it like any other file; there
is no separate policy UI or API to keep in sync.

Two filenames are read, in order:

1. `.stratum/policy.yaml` — YAML. Preferred.
2. `stratum.config.json` — JSON, same shape. Read only when the YAML file is
   absent.

`evaluators` is **top level**. Nesting it under another key is the most common
mistake in a first policy, and it produces a file that parses cleanly and gates
nothing.

## What happens when the file is missing or broken

| State | Evaluation | Merge |
|-------|-----------|-------|
| No policy file | Default policy: secret scan plus a `diff` evaluator on its defaults | No branch protection — no required approvals, no required evaluators |
| Valid policy file | As configured, plus the always-on secret scan | As configured under `merge:` |
| Present but unparseable | Runs on the default evaluators, so the change flow still works | **Blocked** on every change until the file is fixed |

A malformed policy **fails closed**. Stratum does not fall back to the
permissive default, because a typo in a stricter policy would otherwise quietly
downgrade the project's governance and nothing on the change would say so. The
block carries the parse error, naming the file.

An individual *field* is treated more gently than a broken file. An
out-of-range timeout is clamped and logged; an unrecognised field on a `sandbox`
entry is dropped and logged; an evaluator entry with no `type` is dropped. None
of these sets the error that blocks merges: they are bounded mistakes that are
safe to correct, and blocking on them would be hostile to a project that already
has a working policy. Only a file that cannot be parsed at all blocks.

## The whole file at a glance

```yaml
# Every key is optional. This shows all of them at once; a real policy is
# usually a third of this.
evaluators:
  - type: diff
    maxFiles: 30
    maxLines: 5000
    forbiddenPatterns: ["*.lock", "node_modules/", ".env"]
    requiredPatterns: ["tests/"]

  - type: llm
    model: "@cf/meta/llama-3.1-8b-instruct"
    threshold: 0.6
    maxDiffChars: 48000

  - type: sandbox
    command: "npm test"
    timeoutMs: 60000
    installTimeoutMs: 90000
    totalBudgetMs: 150000
    allowInstallScripts: false

  - type: webhook
    url: "https://ci.example.com/evaluate"
    secret: "a-long-random-string-you-generated"
    timeoutMs: 120000

requireAll: true
minScore: 0.7

merge:
  requiredApprovals: 1
  requiredEvaluators: ["secret_scan", "sandbox"]
  allowForce: false
  requireFreshBase: true
  postMergeCommand: "npm test"
  postMergeTimeoutMs: 60000
  autoRevert: true

deploys:
  - name: site
    target: cloudflare-pages
    dir: dist
    secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]
    requiresApproval: false
```

## `evaluators:`

A list of the checks that score a change. Each entry needs a `type`; an unknown
type is logged and skipped rather than blocking.

An evaluator whose prerequisites are missing does **not** vanish from the run.
It scores 0 and fails, with a reason naming the missing prerequisite — a policy
listing `sandbox` on an instance with no Sandboxes binding blocks merges until
the binding is enabled or the evaluator is removed. Dropping it instead would
let a change be scored, and merged, by whichever evaluators happened to be
wired up, with nothing in the result showing that one never ran.

### Secret scan (always on)

There is no `secret_scan` entry to write and no way to switch it off. Every
change is scanned before any configured evaluator has a say.

It matches roughly thirty credential shapes — AWS, GitHub, GitLab, Slack,
Stripe, OpenAI, Anthropic, Google, npm, PyPI, Hugging Face, SendGrid, Twilio,
private key blocks, JWTs, database connection strings with inline credentials,
Azure storage keys, and Stratum's own token formats — plus a high-entropy
heuristic for assignments whose *name* looks like a credential (`apiKey`,
`secret`, `token`, `password`): Shannon entropy at or above 4.0 for mixed
alphabets, 3.5 for hex.

It reads added lines only, and it recognises file headers by their position in
the diff rather than by prefix, so a line of file content that looks like a
`+++` header cannot walk a credential past it.

A hit scores 0 and **fails the whole aggregate regardless of `requireAll` or
`minScore`** — the one evaluator whose failure cannot be outvoted. Name it in
`merge.requiredEvaluators` as well if you want the merge step to re-check it
against the latest run.

### `diff`

Pure analysis of the change. No code execution, no network, cheap enough to run
on everything.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `maxLines` | integer | `500` | Added plus removed content lines, across the whole change |
| `maxFiles` | integer | `20` | Files in the change |
| `forbiddenPatterns` | string[] | `["*.lock", "node_modules/", ".env"]` | A violation per pattern that matches any changed path |
| `requiredPatterns` | string[] | `[]` | A violation per pattern that matches no changed path |

**Patterns match file paths, not file contents.** A pattern containing `*` is a
glob (`*` matches any run of characters, and the pattern may match anywhere in
the path); a pattern with no `*` is a plain substring test. So `node_modules/`
works, `*.lock` works, and `console.log(` matches nothing at all.

**Which paths a pattern sees:** every path the change touches. The post-image of
an added or modified file, the pre-image of a deleted one, *both* sides of a
rename, and the path of a mode-only change. A file leaving a protected
directory trips a `forbiddenPatterns` rule the same way one entering it does.

**The verdict is scored, not binary.** Each violation costs 0.25 off a starting
1.0, and the evaluator passes when the result is at or above the policy's
`minScore`. Under the default `minScore` of 0.7 a *single* violation scores 0.75
and still passes — it takes two to fail. If any one violation should block, set
`minScore` above 0.75, or name `diff` in `merge.requiredEvaluators` and give it
a `minScore` it cannot clear.

### `llm`

Sends the diff to a model on the Workers AI binding, with the sanitized policy
as context, and asks for a JSON verdict.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `model` | string | `@cf/meta/llama-3.1-8b-instruct` | Must be a model the **Workers AI binding** serves |
| `threshold` | number | `0.7` | Minimum score to pass. Clamped into `[0, 1]` |
| `maxDiffChars` | integer | `24000` | Diff characters sent. Clamped into `[1000, 100000]` |

The prompt is fixed and not configurable: the model is told to review for
correctness bugs, security vulnerabilities, leaked credentials, and violations
of the policy context, and to answer with a single JSON object.

Three behaviours are worth knowing before you rely on it:

- **An unreadable verdict fails closed.** Output that is not valid JSON, or that
  is missing `score`/`passed`/`reason`, scores 0 and blocks. Stratum never infers
  a verdict from prose — reading approval out of an "LGTM" once let unparseable
  output half-approve a merge.
- **Model output is never echoed into the result.** A model can quote the diff
  back, and the diff can contain exactly the credentials the secret scan exists
  to catch. Failures report the response's length, not its text.
- **A diff longer than `maxDiffChars` is truncated, not rejected.** The verdict
  then covers only the first slice, and the result carries an issue saying so.
  A policy whose serialized form exceeds 8,000 characters fails closed before
  any model call, since the policy context shares the model's input budget with
  the diff.

Token usage is estimated (Workers AI does not report it) and recorded as a cost
on the change.

### `sandbox`

Clones the workspace into a Cloudflare Sandbox, installs dependencies, and runs
a command. Passes on exit code 0.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `command` | string | `npm test` | Max 500 characters. Newlines are rejected |
| `timeoutMs` | integer | `60000` | Scored command. Clamped into `[1000, 120000]` |
| `installTimeoutMs` | integer | `90000` | Dependency install and in-sandbox decode. Same clamp |
| `totalBudgetMs` | integer | `150000` | Whole evaluation. Clamped into `[5000, 150000]` |
| `allowInstallScripts` | boolean | `false` | Run npm `preinstall`/`install`/`postinstall` |

`totalBudgetMs` bounds the **sum** of the phases, which the per-phase timeouts
do not: each phase gets `min(configured, budget remaining)`, and exhausting the
budget fails the evaluation rather than hanging. The two per-phase defaults add
up to exactly the default budget, so an unconfigured project never has its test
command truncated by a budget it did not choose.

A newline in `command` is rejected rather than escaped, because
`npm test\ncurl x | sh` is one string to a naive check and two commands to a
shell. A field name that is not one of the five above is dropped with a warning
— `timeout` for `timeoutMs` is the typo most likely to be made and least likely
to be noticed.

Dependency installs pass `--ignore-scripts` unless `allowInstallScripts` is
true, because the tree being evaluated is untrusted code an agent wrote and a
`postinstall` would otherwise run before any human sees it. The usual symptom of
needing it and not setting it is *not* a failing install: it is a native module
that installs unbuilt and then fails when the test command loads it.

This evaluator needs the Sandboxes binding. Without it — or without workspace
repository access — it fails closed with a reason naming which prerequisite is
missing.

### `webhook`

POSTs the change to a URL you control and waits for a verdict, so an existing CI
system can be the gate. See [CI integration](../user-guide/ci-integration.md)
for the request and response shapes.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `url` | string | — | **Required.** An entry without one is dropped. SSRF-guarded |
| `secret` | string | none | Signs the delivery (HMAC-SHA256) so your CI can verify the sender |
| `timeoutMs` | integer | `10000` | Clamped into `[1000, 120000]` |

`secret` is used **exactly as written**. There is no `${ENV_VAR}` interpolation
anywhere in this file, so a placeholder is transmitted as a literal placeholder.
Generate a real secret and commit it, or leave the field out.

An unparseable response fails closed, on the same reasoning as the `llm`
evaluator.

## Scoring and aggregation

Every evaluator returns a score in `[0, 1]` and a pass/fail. Two top-level keys
turn those into one verdict:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `requireAll` | boolean | `true` | `true`: every evaluator must pass, and the aggregate score is their mean. `false`: any one passing is enough, and the score is the highest |
| `minScore` | number | `0.7` | The pass threshold the `diff` and `sandbox` evaluators score against. Clamped into `[0, 1]` |

`minScore` is easy to misread. It is **not** a floor applied to the aggregate
score at the merge step — the merge gate reads pass/fail per evaluator, not the
aggregate number. It is the threshold that scoring evaluators compare their own
result against. Raising it makes `diff` and `sandbox` stricter; it does not add
a check of its own.

A failed secret scan overrides all of this: the aggregate fails and its score is
capped at the scan's, whatever `requireAll` and `minScore` say.

## `merge:`

Branch protection, enforced at the merge step against the change's recorded
evaluation history — a separate pass from scoring, so a change can be fully
evaluated and still be unmergeable.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `requiredApprovals` | integer | `0` | **Human** approvals. Agents can never approve, and the change's own author does not count toward the total |
| `requiredEvaluators` | string[] | `[]` | Evaluator types whose **latest** run must have passed, e.g. `["secret_scan", "sandbox"]` |
| `allowForce` | boolean | `false` | `?force=true` is rejected unless this is explicitly `true` |
| `requireFreshBase` | boolean | `false` | Reject a change whose base moved, with `409 STALE_BASE` |
| `postMergeCommand` | string | none | Smoke command run in a sandbox against the merged HEAD |
| `postMergeTimeoutMs` | integer | `60000` | Timeout for that command |
| `autoRevert` | boolean | `true` | Land a forward revert when the smoke command fails |

Details that decide real merges:

- **`requiredEvaluators` checks the latest run per type.** An earlier failure
  that a later passing re-run superseded does not block. Where a policy lists
  the same type twice, every run of that type must have passed, so a passing
  duplicate cannot mask a failure.
- **Approvals exclude the author.** A lone writer cannot open a change, approve
  it, and merge it. An agent's approval never counts at all, and an agent's
  owning user is recorded as the change's human author, so the owner cannot
  approve their own agent's work either.
- **Staleness has two independent gates.** `requireFreshBase` is opt-in and
  rejects a change whose *base* moved (`409 STALE_BASE`). Regardless of it, a
  merge is always rejected when the *workspace* advanced after evaluation
  (`409 STALE_WORKSPACE`): you can never merge commits the evaluators did not
  see.
- **`autoRevert` defaults on** when a `postMergeCommand` is set. A failing smoke
  command lands a forward revert commit, marks the change `reverted`, and emits
  `change.reverted`.

## Editing the policy is itself gated

A change whose diff touches `.stratum/policy.yaml` or `stratum.config.json`
always requires **at least one human approval**, even when the policy in effect
sets `requiredApprovals: 0` and even when it has no `merge:` block at all.

Without that rule, a writer could relax protection — flip `allowForce`, drop
required evaluators, zero the approvals — in a change that merges with nobody
looking, and every later change would land under the weaker gate. Deleting the
policy file counts as touching it.

## `deploys:`

Post-merge deployments to Cloudflare Pages, Cloudflare Workers, or Vercel. The
[deployments guide](../user-guide/deployments.md) is the full account, including
what v1 deliberately does not do (no build step, no preview deploy, no
rollback). The fields:

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | **Required.** `^[a-z][a-z0-9-]{0,31}$`, unique in the list. Identifies the target across merges |
| `target` | string | **Required.** `cloudflare-pages`, `cloudflare-workers`, or `vercel` |
| `dir` | string | Output directory to publish, relative to the repo root. Used by `cloudflare-pages` |
| `secrets` | string[] | Names of project secrets the target needs. **Values live in Stratum, never in this file** |
| `requiresApproval` | boolean | Gate the deploy on a human approval |

An entry that fails validation is not silently skipped: it is recorded as a
*failed deployment* naming the reason, so a deploy that was written and never
ran is visible rather than absent.

## Defaults and limits

Every value Stratum supplies when your policy does not. This table is checked
against the code by `tests/policy-reference-docs.test.ts` — if a default changes
and this table does not, the build fails.

<!-- BEGIN:policy-defaults -->

| Setting | Default | Bounds |
|---------|---------|--------|
| `requireAll` | `true` | — |
| `minScore` | `0.7` | `[0, 1]` |
| `diff.maxLines` | `500` | — |
| `diff.maxFiles` | `20` | — |
| `diff.forbiddenPatterns` | `["*.lock", "node_modules/", ".env"]` | — |
| `diff` score cost per violation | `0.25` | — |
| `llm.model` | `@cf/meta/llama-3.1-8b-instruct` | — |
| `llm.threshold` | `0.7` | `[0, 1]` |
| `llm.maxDiffChars` | `24000` | `[1000, 100000]` |
| `llm` policy context ceiling | `8000` | — |
| `sandbox.command` | `npm test` | max 500 chars |
| `sandbox.timeoutMs` | `60000` | `[1000, 120000]` |
| `sandbox.installTimeoutMs` | `90000` | `[1000, 120000]` |
| `sandbox.totalBudgetMs` | `150000` | `[5000, 150000]` |
| `webhook.timeoutMs` | `10000` | `[1000, 120000]` |
| `merge.requiredApprovals` | `0` | — |
| `merge.postMergeTimeoutMs` | `60000` | — |

<!-- END:policy-defaults -->

## What a policy cannot enforce

A policy gates *diffs*. It has no view of anything that is not in the change, so
some rules a project cares about cannot be written here:

- **Prose conventions.** A house style, an architectural rule, "no client-side
  frameworks" — these live in a `CLAUDE.md` or `AGENTS.md` and are read by
  agents and reviewers as guidance. Nothing at the merge step checks them. To
  make one binding, express it as a `diff` pattern or as a command the `sandbox`
  evaluator runs (a lint rule, a custom script), which is the difference between
  a convention and a gate.
- **Anything requiring repository history or state outside the diff.** Commit
  message format, branch naming, an issue link — the evaluators receive the
  diff, its base commit, and the policy, and nothing else.
- **Per-path rules.** `forbiddenPatterns` is repository-wide; there is no
  CODEOWNERS-style "these paths need this reviewer" gate. `requiredApprovals` is
  one number for the whole project.
- **Per-branch policy.** One policy governs the project, read from the default
  branch. There is no per-branch or per-directory override.

If a rule matters enough to block a merge, it has to be a check that runs. The
`sandbox` and `webhook` evaluators exist so that check can be your own code.
