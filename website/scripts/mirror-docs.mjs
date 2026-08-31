// Mirrors the canonical Markdown in ../docs into this site's content
// collection, the same way sync:openapi copies the OpenAPI spec.
//
// The user guide and API reference live twice: under `docs/` in the repo, and
// as Starlight pages here. `docs/` is canonical. The two copies differ only in
// frontmatter and link style, so keeping them in sync by hand is busywork that
// silently fails — and it has: the published site has carried a token model,
// an import options table, and FAQ entries that no longer matched the code.
//
//   node scripts/mirror-docs.mjs           # write the mirrors
//   node scripts/mirror-docs.mjs --check   # exit 1 if any mirror is stale
import { readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const REPO = "https://github.com/stratum-eng/stratum";
const DOCS = "../docs";
const OUT = "src/content/docs";

/** Pages published as /guides/<slug>/, keyed by their file in docs/user-guide. */
const GUIDES = [
  ["getting-started", "From sign-up to a merged, evaluation-gated change — policy, agent identity, and the change flow."],
  ["importing", "Import a repository from GitHub, GitLab, or Bitbucket, track progress, and keep the project in sync with its source."],
  ["code-review", "Line-anchored comment threads, replies, resolve/unresolve, and the three review verdicts."],
  ["issues", "Open, triage, search, and link issues — and how a merged change closes them."],
  ["ci-integration", "Bring your own CI: run evaluations on your existing infrastructure and report verdicts back."],
  ["troubleshooting", "Symptoms and fixes for auth, imports, evaluation, merges, and access."],
  ["faq", "Common questions about Stratum's merge gate, provenance, CI, limitations, and telemetry."],
];

/** Pages published as /reference/<slug>/, keyed by their file in docs/api. */
const REFERENCE = [
  ["errors", "HTTP status codes and the machine-readable error codes Stratum returns."],
  ["authentication", "Named scoped API tokens, agent tokens, session cookies, anonymous access, and the admin API key."],
];

const GUIDE_SLUGS = new Set(GUIDES.map(([slug]) => slug));
const REF_SLUGS = new Set([...REFERENCE.map(([slug]) => slug), "endpoints", "openapi", "agent-discovery"]);

/**
 * Map a repo-relative path to its published URL, or null if the site does not
 * publish it. Resolving the link target first (rather than pattern-matching the
 * raw href) is what makes `openapi.yml` from docs/api and `../api/openapi.yml`
 * from docs/user-guide reach the same answer.
 */
function siteUrl(resolved) {
  let m = resolved.match(/^docs\/user-guide\/([a-z0-9-]+)\.md$/);
  if (m && GUIDE_SLUGS.has(m[1])) return `/guides/${m[1]}/`;
  if (resolved === "docs/api/openapi.yml") return "/reference/openapi/";
  m = resolved.match(/^docs\/api\/([a-z0-9-]+)\.md$/);
  if (m && REF_SLUGS.has(m[1])) return `/reference/${m[1]}/`;
  // Endpoint pages are not published individually; the site has one overview.
  if (/^docs\/api\/endpoints\/[a-z0-9-]+\.md$/.test(resolved)) return "/reference/endpoints/";
  return null;
}

// The repo's copies are written for a self-hosted reader; the published site
// documents the hosted instance and uses it consistently in examples. Each page
// still tells the reader to substitute their own host.
const HOSTED_ORIGIN = "https://app.usestratum.dev";
const SELF_HOST_PLACEHOLDER = /https:\/\/your-instance\.workers\.dev/g;

function rewriteLinks(text, srcDir) {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    if (/^(https?:|mailto:|\/|#)/.test(href)) return whole;
    const [path, hash] = href.split("#");
    const anchor = hash ? `#${hash}` : "";
    if (!path || !/\.(md|yml)$/.test(path)) return whole;
    const resolved = normalize(join(srcDir, path)).split("\\").join("/");
    const url = siteUrl(resolved);
    return url ? `[${label}](${url}${anchor})` : `[${label}](${REPO}/blob/main/${resolved}${anchor})`;
  });
}

/** Quote the scalar: a colon in a title or description otherwise parses as a
 *  YAML mapping and fails the Astro build. */
const yamlString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function render(srcPath, srcDir, description, canonicalPath) {
  const raw = await readFile(srcPath, "utf8");
  const lines = raw.split("\n");
  if (!lines[0].startsWith("# ")) throw new Error(`${srcPath}: expected a level-1 heading`);
  const title = lines[0].slice(2).trim();
  let body = rewriteLinks(lines.slice(1).join("\n").replace(/^\n+/, ""), srcDir);
  body = body.replace(SELF_HOST_PLACEHOLDER, HOSTED_ORIGIN);
  // Starlight's default edit link is `editLink.baseUrl + entry.filePath`, which
  // for these pages resolves to the generated copy under src/content/docs — so
  // "Edit this page" would send a contributor to a file the next sync
  // overwrites. A per-page editUrl overrides that and points at the canonical
  // source. Pages actually authored in website/ keep the default.
  const editUrl = `${REPO}/edit/main/${canonicalPath}`;
  return (
    `---\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\n` +
    `editUrl: ${yamlString(editUrl)}\n---\n\n${body}`
  );
}

const check = process.argv.includes("--check");
const targets = [
  ...GUIDES.map(([slug, d]) => [join(DOCS, "user-guide", `${slug}.md`), "docs/user-guide", join(OUT, "guides", `${slug}.md`), d]),
  ...REFERENCE.map(([slug, d]) => [join(DOCS, "api", `${slug}.md`), "docs/api", join(OUT, "reference", `${slug}.md`), d]),
];

const stale = [];
for (const [srcPath, srcDir, destPath, description] of targets) {
  // srcPath is website-relative ("../docs/..."); the edit link needs it
  // relative to the repository root.
  const canonicalPath = srcPath.replace(/^\.\.\//, "");
  const rendered = await render(srcPath, srcDir, description, canonicalPath);
  if (check) {
    const current = await readFile(destPath, "utf8").catch(() => null);
    if (current !== rendered) stale.push(`${destPath} is out of sync with ${srcPath}`);
  } else {
    await writeFile(destPath, rendered);
  }
}

if (check) {
  if (stale.length) {
    console.error("mirror-docs: the published mirrors are stale:\n");
    for (const s of stale) console.error(`  ${s}`);
    console.error("\nRun `npm run sync:guides` in website/ and commit the result.");
    process.exit(1);
  }
  console.log(`mirror-docs: all ${targets.length} mirrors are in sync`);
} else {
  console.log(`mirror-docs: wrote ${targets.length} mirrors into ${OUT}/`);
}
