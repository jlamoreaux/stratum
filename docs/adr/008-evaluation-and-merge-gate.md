# ADR 008: The evaluation and merge gate architecture

**Status:** Accepted (documenting a design already shipped)
**Date:** 2026-09-05
**Supersedes:** nothing. **Related:** [ADR 007](007-sandbox-evaluator-threat-model.md)

## Context

Stratum's entire product claim is that it decides what agent output is allowed
to merge. How that decision is made is therefore the most load-bearing design in
the repository — and until now it was recorded only as code comments. A reader
asking "why is it built this way, and what am I not allowed to break?" had no
entry point, which made the invariants easy to erode by accident: each one
looks like an over-cautious branch until you know what it is defending against.

Two framings were live when this was built, and the difference still shapes
what people expect on arrival:

1. **The gate is a prompt.** A model reviews the diff and says yes or no; the
   policy file is context for that prompt.
2. **The gate is a program.** Declarative config drives deterministic checks;
   a model is one check among several, with no special authority.

## Decision

The gate is a program. Specifically:

### 1. Policy is declarative config, sanitized into a typed value

`.stratum/policy.yaml` is parsed and then **rebuilt** field by field
(`parsePolicyContent` → `sanitizeEvaluator` / `sanitizeSandboxConfig` /
`sanitizeMergePolicy`). A returned `EvalPolicy` shares no object identity with
the parsed input: every value is copied, type-checked, and clamped, and
unrecognised fields are dropped with a warning rather than passed through.

Nothing downstream can reach back into user-supplied input, and no evaluator
has to defend itself against a hostile policy file — a timeout it reads is
already in range.

### 2. Evaluation and merge protection are two passes, not one

Scoring (`CompositeEvaluator` over the configured evaluators) answers "how good
is this change?" and persists one `eval_runs` row per evaluator. Merge
protection (`checkMergeProtection`) answers "may this change land?" by reading
that persisted history plus the approval record.

They are separate because they answer to different clocks. A change is
evaluated once, at creation; it may be re-evaluated later; it merges at a third
moment, by which time the base may have moved, an approval may have arrived, or
a failing evaluator may have been re-run and passed. Folding the two together
would force the merge step to trust a verdict computed against a tree that no
longer exists.

This is why `requiredEvaluators` reads the **latest** run per type, and why an
in-memory variant (`requiredEvaluatorReasons`) exists for manual conflict
resolution, whose content has no `Change` row of its own to look up.

### 3. Every failure mode fails closed

The rule is uniform, and each instance had to be argued for individually:

- A **malformed policy file** blocks merges instead of falling back to the
  permissive default, so a typo in a stricter policy cannot quietly downgrade
  governance.
- An **evaluator with a missing prerequisite** becomes an `UnavailableEvaluator`
  scoring 0, rather than being dropped from the list. Dropping it would let a
  change be scored and merged by whichever evaluators happened to be wired up,
  with nothing in the result showing that one never ran.
- An **unreadable verdict** from the `llm` or `webhook` evaluator scores 0. A
  verdict is never inferred from prose: reading approval out of an "LGTM" once
  let unparseable output half-approve a merge.
- **Force-merge is deny-by-default.** `?force=true` is rejected unless the
  policy explicitly enables it.

The deliberate exception is a **single out-of-range field**, which is clamped
and logged rather than escalated to a merge block. `configError` means "this
file could not be understood at all"; an out-of-range timeout is a bounded
mistake that is safe to correct, and blocking on it would be hostile to a
project that already has a working policy.

### 4. The LLM is one evaluator, with no special authority

It scores into the same aggregate as `diff`, `sandbox`, and `webhook`. Its
prompt is fixed rather than policy-supplied, its verdict must be a JSON object
with a numeric score, its `threshold` and diff window are clamped, and its raw
output is never echoed into a result — a model can quote the diff back, and the
diff can contain exactly the credentials the secret scan exists to catch.

### 5. The secret scan is unconfigurable and outranks the aggregate

It is wired in by `buildEvaluators` regardless of policy, and a failure fails
the aggregate and caps its score whatever `requireAll` and `minScore` say. It is
the one verdict a policy cannot outvote, because a leaked credential is not a
quality trade-off.

It also parses the diff **structurally**, recognising file headers by position
rather than prefix. A diff marks added lines with `+`, so a source line
beginning `++` arrives as `+++…` — indistinguishable by prefix from a file
header, and therefore a way to walk a credential past an always-on gate. The
`diff` evaluator now shares that discipline (`parseDiff`), for the same reason:
read by prefix, a change could write `++ b/tests/covered.ts` into any file and
have it counted among the change's paths, satisfying a `requiredPatterns` gate
without adding the file.

### 6. Approvals are a human gate, and the gate's own config is protected

Agents authenticate as themselves and can never approve. The change author's
own approval does not count toward `requiredApprovals`, and an agent's owning
user is recorded as the change's human author, so an owner cannot approve their
agent's work either.

A change whose diff touches `.stratum/policy.yaml` or `stratum.config.json`
requires at least one human approval **even when the policy sets
`requiredApprovals: 0` and even when it has no `merge:` block at all**. Without
this, a writer could relax protection in a change that merges with nobody
looking, and every later change would land under the weaker gate.

## Consequences

**What this buys.** The merge decision is reproducible and auditable: given a
policy and a diff, the verdict is a function, and the evidence for it is a row
per evaluator rather than a chat transcript. A project can adopt Stratum without
trusting a model at all — omit the `llm` entry and the gate is entirely
deterministic.

**What it costs.** Expressiveness. A policy gates diffs and nothing else, so
rules needing repository history, per-path ownership, or per-branch variation
cannot be written (see [What a policy cannot enforce](../api/policy.md#what-a-policy-cannot-enforce)).
Prose conventions in a `CLAUDE.md` or `AGENTS.md` are guidance that nothing at
the merge step checks; making one binding means expressing it as a `diff`
pattern or a command the `sandbox` evaluator runs.

**What must not be broken.** Every "fails closed" branch above is load-bearing
and none is defensive coding to be tidied away. The protected-config approval
escalation, the author-exclusion in `countApprovals`, the structural diff
parsing, and the secret scan's override of the aggregate are each the fix for a
specific way the gate was bypassable. Changing one is a change to the security
model, not a refactor.

**Where the contract is written down.** [`docs/api/policy.md`](../api/policy.md)
is the user-facing reference, and its defaults table is checked against
`src/evaluation/defaults.ts` by `tests/policy-reference-docs.test.ts` — so the
numbers in the docs cannot drift from the numbers in the gate.
