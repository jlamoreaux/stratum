# Stratum docs site

The public documentation site for [Stratum](https://github.com/stratum-eng/stratum),
built with [Astro Starlight](https://starlight.astro.build/).

## Development

```bash
cd website
npm install
npm run dev      # http://localhost:4321
```

## Build

```bash
npm run build    # static output in dist/
npm run preview  # serve the built site locally
```

Both `dev` and `build` first copy `docs/api/openapi.yml` into `public/openapi.yml`
(via the `sync:openapi` script) so the published spec always matches the
repository's source of truth. The copy is gitignored — edit the spec only at
`docs/api/openapi.yml`.

## Content

Pages live in `src/content/docs/` as Markdown/MDX with Starlight frontmatter
(`title`, `description`). The sidebar is configured in `astro.config.mjs`.

- `guides/` — user-facing guides (getting started, importing, troubleshooting, FAQ)
- `reference/` — API reference (authentication, endpoints, errors, OpenAPI)

Internal repo documentation (ADRs, runbooks, developer docs) intentionally stays
in `docs/` as plain Markdown and is not published here.

## Deployment

The site is a fully static build (`dist/`) and deploys to Cloudflare Pages via
the `Deploy Docs` GitHub Actions workflow (`.github/workflows/deploy-docs.yml`,
manual dispatch), or by hand:

```bash
npm run build
npx wrangler pages deploy dist --project-name=stratum-docs
```
