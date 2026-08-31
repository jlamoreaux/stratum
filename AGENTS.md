# AGENTS.md

Guidance for AI coding agents (and the humans reviewing them) working in this repository.
Stratum treats agents as first-class contributors — this file is the contract.

## What this project is

Stratum is a code-collaboration platform for the AI engineering era, built on Cloudflare
Workers (Hono), Durable Objects (SQLite), D1, KV, R2, Queues, and Cloudflare Artifacts for
serverless Git. The web UI is **server-rendered JSX**: every page must work with JavaScript
disabled. A few inline scripts exist purely as progressive enhancement — never add a
client-side framework or a build step.

## Repository layout

| Path | What it is |
|------|------------|
| `src/` | The Worker: routes, middleware, storage, queue consumers, evaluation engine, UI |
| `cli/` | `@stratum/cli` — standalone publishable package |
| `agent/` | `@stratum/agent` — reference agent, standalone publishable package |
| `mcp/` | `@stratum/mcp` — MCP server for any MCP-capable agent/editor, standalone publishable package |
| `tests/` | Vitest suites: unit (`tests/*.test.ts`), `tests/integration/`, `tests/smoke/` |
| `migrations/` | D1 SQL migrations |
| `docs/` | User, API, developer docs, ADRs (`docs/adr/`), and runbooks (`docs/runbooks/`) |
| `scripts/` | Benchmark and operational scripts |
| `website/` | Docs site (own build; deployed by `deploy-docs.yml`). Its guide and reference pages are **generated** from `docs/` by `scripts/mirror-docs.mjs` — edit `docs/`, not `website/src/content/docs/` |

## Commands

Run from the repo root unless noted. `cli/`, `agent/`, and `mcp/` have their own `package.json`.

```bash
npm install          # install deps
npm run dev          # local dev server at http://localhost:8787
npm test             # full unit suite (vitest run)
npm run test:coverage  # with coverage; thresholds enforced in vitest.config.ts
npm run test:integration  # tests/integration/
npm run typecheck    # tsc --noEmit
npm run lint         # biome check src tests
npm run lint:fix     # biome check --write src tests
npm run release:check   # validate CHANGELOG.md against package.json
npm run release:prepare # cut a release from the Unreleased section (maintainers)
```

`npm run test:smoke` hits a **live deployed instance** (set `STAGING_URL` + `TEST_AUTH_TOKEN`);
it is network-dependent and not part of the offline gate.

## Quality gates (must pass before a PR is mergeable)

CI (`pr-checks.yml`) runs **lint, typecheck, unit tests, and the `cli/`/`agent/`/`mcp/`
package suites in parallel**, then integration tests, then a staging deploy + smoke test.
Mirror lint → typecheck → test locally before pushing.

1. **Typecheck and tests must pass.** Never comment out, skip, or `.skip` a test to get green.
2. **Run lint last.** Biome autofixes formatting — running it before you finish editing just
   creates churn. Fix all lint errors; zero warnings tolerated in CI.
3. **No `any`.** `noExplicitAny` is an error. Use `Result`/typed unions (`src/utils/result.ts`).
4. **Coverage is a ratchet.** Thresholds in `vitest.config.ts` are a floor — raise them as
   coverage improves, never lower them to make a build pass.

## Conventions

- **TypeScript strict**, double quotes, 2-space indent, trailing commas, semicolons (Biome enforces).
- **Errors are values.** Prefer the `Result` type over throwing across module boundaries; never
  silently swallow an error — log it (see `src/utils/logger.ts`).
- **Comments explain *why*, not *what*.** Add one only for a non-obvious constraint, invariant, or
  workaround. JSDoc on public APIs is welcome.
- **Server-rendered only.** Do not introduce client-side JS into the UI.
- **Every user-visible change gets a `CHANGELOG.md` entry** under `## [Unreleased]`, in the same
  PR, under a Keep a Changelog group. That text ships verbatim as the release notes; the release
  tooling infers the version bump from which groups are present (`docs/developer/releasing.md`).
- **A change to user-facing config, API shape, or evaluator/policy behavior also updates the public
  docs** (`website/src/content/docs/`, `docs.usestratum.dev`) in the same PR — not just
  `CHANGELOG.md`. `docs/` is internal (developer, API reference, ADRs, runbooks); `website/` is what
  a self-hoster or agent operator actually reads to configure `.stratum/policy.yaml` or use the API,
  and it goes stale silently since nothing fails a build over it.
- Highlight.js / type gotchas and the full ship flow live in `docs/developer/`.

## Operational rules (do not violate)

- **Benchmarks and write-heavy load tests run against STAGING only.** A production token must
  never be used for throughput/load testing.
- **`REPO_DO_ENABLED` is a kill switch** — `true` on staging, `false` in production. Respect it
  when touching the Durable-Object hot-index / merge paths.
- Secrets live in `.dev.vars` (gitignored) and Wrangler secrets — never commit credentials.

## Commit & PR conventions

- End every commit message with a `Co-Authored-By` trailer naming the model that actually
  wrote the change, e.g.:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
- Commit or push only when asked; if on `main`, branch first.
- Keep PRs focused; describe what changed and how it was verified (which gates ran).
- Every PR receives an automated AI review (PR-Agent via Cloudflare AI Gateway — see
  `docs/runbooks/ai-review.md`). Its findings are advisory, never a merge gate; collaborators
  can run `/review`, `/improve`, or `/ask <question>` in PR comments.

See `CONTRIBUTING.md` for the human-facing version of all of this.
