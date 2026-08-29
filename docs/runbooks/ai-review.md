# AI code review (PR-Agent via Cloudflare AI Gateway)

`.github/workflows/pr-agent.yml` runs [PR-Agent](https://github.com/qodo-ai/pr-agent) on every
non-draft, non-fork PR (opened / reopened / ready_for_review / synchronize). It posts a review
comment with findings; it never blocks a merge.

All LLM traffic goes through **Cloudflare AI Gateway → OpenRouter**, so every request (tokens,
cost, latency, errors) is visible in the Cloudflare dashboard under the gateway's analytics,
and gateway-level caching/rate limits apply.

## Model chain

Configured in the workflow env (`config.model` / `config.fallback_models`). Fallbacks trigger on
API errors or context overflow — not on review quality:

| Order | Model | OpenRouter pricing (in/out per MTok, 2026-08) |
|---|---|---|
| 1 | `z-ai/glm-5.3` | ~$1.40 / $4.40 (official z-ai endpoint) |
| 2 | `z-ai/glm-5.3-flash` | $0.075 / $0.25 |
| 3 | `moonshotai/kimi-k3` | $2.55 / $12.75 |
| 4 | `openai/gpt-5.6-terra` | $2.00 / $12.00 |

Typical PR review ≈ 15–40K input + a few K output tokens → **roughly $0.02–0.08 per review** on
GLM-5.3. Verify actuals in AI Gateway analytics after the first week.

## One-time setup

1. **OpenRouter**: create an API key at openrouter.ai and add credits. In OpenRouter's provider
   settings, prefer the official `z-ai` provider for GLM models (third-party hosts may serve
   quantized weights).
2. **Cloudflare AI Gateway**: dashboard → AI → AI Gateway → create gateway (e.g. `stratum-reviews`).
   The OpenRouter base URL is
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openrouter/v1`.
3. **Repo secrets**:

   ```sh
   gh secret set OPENROUTER_KEY --body '<openrouter api key>'
   gh secret set AI_GATEWAY_OPENROUTER_BASE \
     --body 'https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/openrouter/v1'
   ```

## Usage

- Auto-review posts on PR open and on new commits.
- Comment commands (collaborators): `/review`, `/describe`, `/improve`, `/ask <question>`.
  `/review` also works on fork PRs (comment events run with base-repo secrets).
- To change models, edit the workflow env — it is one line per model; no code involved.

## Turning it off

Disable the workflow in the Actions tab (or delete `.github/workflows/pr-agent.yml`). Gateway
rate limits / spend caps can be set on the Cloudflare gateway itself as a backstop.

## Known limitations

- Fallback chain is availability-based, not quality-based; if GLM-5.3 errors persistently you
  are silently reviewed by flash-tier — check `config.output_run_details` / gateway logs when
  reviews look shallow.
- Draft PRs are skipped until marked ready for review.
- The full build-your-own alternative (Cloudflare Worker reviewer) was specced and shelved; see
  `~/projects/indy/.claude/ship/PRD.md` for the requirements analysis behind choosing PR-Agent.
