# AI code review (PR-Agent via Cloudflare AI Gateway)

`.github/workflows/pr-agent.yml` runs [PR-Agent](https://github.com/qodo-ai/pr-agent) on every
non-draft, non-fork PR (opened / reopened / ready_for_review / synchronize). It posts a review
comment with findings; it never blocks a merge.

All LLM traffic goes through **Cloudflare AI Gateway's OpenAI-compatible `/compat` endpoint**
with unified billing: one Cloudflare API token, one Cloudflare bill, no third-party model
accounts. Every request (tokens, cost, latency, errors) is visible in the gateway's analytics,
and gateway-level caching/rate limits/spend caps apply.

## Model chain

Configured in the workflow env (`config.model` / `config.fallback_models`). Fallbacks trigger on
API errors or context overflow — not on review quality:

| Order | Model | Where it runs | Pricing (in/out per MTok, 2026-08) |
|---|---|---|---|
| 1 | `workers-ai/@cf/zai-org/glm-5.3` | Cloudflare Workers AI | $1.40 / $4.40 ($0.26 cached input) |
| 2 | `workers-ai/@cf/zai-org/glm-5.3-flash` | Cloudflare Workers AI | flash tier (~20× cheaper) |
| 3 | `openai/gpt-5.6-terra` | OpenAI via unified billing | $2.00 / $12.00 |

Kimi K3 was considered and dropped: Moonshot is not a Cloudflare-billable provider, so keeping
it would have required a third-party account — the thing this setup exists to avoid.

Typical PR review ≈ 15–40K input + a few K output tokens → **roughly $0.03–0.08 per review** on
GLM-5.3. Unified billing adds a 5% fee on credit *purchases*; per-token rates are provider
pass-through. Verify actuals in AI Gateway analytics after the first week.

## One-time setup

1. **AI Gateway**: Cloudflare dashboard → AI → AI Gateway → create gateway (e.g.
   `stratum-reviews`). Buy unified-billing credits (needed for the GPT-5.6 Terra fallback;
   Workers AI models bill to the account directly).
2. **API token**: create a Cloudflare API token with **AI Gateway: Run** (and Workers AI)
   permission.
3. **Repo secrets**:

   ```sh
   gh secret set CLOUDFLARE_AI_TOKEN --body '<cloudflare api token>'
   gh secret set AI_GATEWAY_COMPAT_BASE \
     --body 'https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat'
   ```

## Usage

- Auto-review posts on PR open and on new commits.
- Comment commands — restricted to owner/member/collaborator in the workflow gate: `/review`,
  `/describe`, `/improve`, `/ask <question>`. `/review` also works on fork PRs (comment events
  run with base-repo secrets).
- To change models, edit the workflow env — one line per model; no code involved.

## Security posture & abuse bounds

Who can spend money, from broadest to narrowest:

- **Strangers: nobody.** Fork PRs and non-collaborator comments skip the job before a runner
  starts — a flood of drive-by PRs produces skipped jobs, not LLM calls.
- **Collaborators: bounded.** Per-PR concurrency cancels the in-flight review when a new push
  supersedes it, and a daily cap (50 successful runs, checked against the Actions API before
  the review step) bounds total spend even for a compromised collaborator account.
- **Backstop:** gateway-level rate limits / spend caps on the Cloudflare side, plus billing
  notifications on the account. These should never be the first line of defense.

Other hardening:

- The action image is pinned by immutable sha256 digest, not by tag.
- The job has `contents: read` — the bot can comment but never push.
- Comment triggers are gated by `author_association`, so drive-by accounts on the public repo
  cannot spend LLM credits.
- **Prompt injection is an accepted residual risk**: PR diffs and descriptions are
  attacker-influenced input to the model, so a crafted PR could steer the review's wording.
  Blast radius is a misleading comment — treat bot reviews as advisory, never as a merge
  gate or a substitute for human review of untrusted contributions.

## Turning it off

Disable the workflow in the Actions tab (or delete `.github/workflows/pr-agent.yml`). Gateway
rate limits / spend caps on the Cloudflare gateway are the backstop.

## Known limitations

- Fallback chain is availability-based, not quality-based; if GLM-5.3 errors persistently you
  are silently reviewed by flash-tier — check gateway logs when reviews look shallow.
- Draft PRs are skipped until marked ready for review.
- The full build-your-own alternative (Cloudflare Worker reviewer) was specced and shelved; see
  `~/projects/indy/.claude/ship/PRD.md` for the requirements analysis behind choosing PR-Agent.
