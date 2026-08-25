// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.usestratum.dev",
  integrations: [
    starlight({
      title: "Stratum",
      description:
        "The governance layer for AI-written code — evaluation-gated merges, provenance, and agent identities, built on Cloudflare Workers.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/stratum-eng/stratum",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/stratum-eng/stratum/edit/main/website/",
      },
      sidebar: [
        {
          label: "Guides",
          items: [
            { label: "Getting started", slug: "guides/getting-started" },
            { label: "Importing from GitHub", slug: "guides/importing" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
            { label: "FAQ", slug: "guides/faq" },
          ],
        },
        {
          label: "API reference",
          items: [
            { label: "Authentication", slug: "reference/authentication" },
            { label: "Endpoints", slug: "reference/endpoints" },
            { label: "Error codes", slug: "reference/errors" },
            { label: "OpenAPI specification", slug: "reference/openapi" },
          ],
        },
      ],
    }),
  ],
});
