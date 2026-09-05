/// <reference types="vite/client" />
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import {
  SOURCE_FOOTER_HTML,
  SOURCE_FOOTER_HTML_INLINE,
  SourceFooter,
} from "../src/ui/components/source-footer";
import { Layout } from "../src/ui/layout";
import { CSS } from "../src/ui/styles";
import { STRATUM_SOURCE_URL, STRATUM_VERSION } from "../src/version";

/**
 * AGPL-3.0 §13 asks an operator running a modified Stratum to prominently
 * offer that version's source to everyone who reaches the instance over the
 * network. The offer lives in the shared page chrome, which means it is one
 * component away from being deleted by a layout refactor and nobody noticing
 * until it matters. This suite is the thing that notices.
 */
const render = (): string =>
  renderToString(
    <Layout title="Test" user={{ id: "u1", email: "a@b.test", username: "someone" }}>
      <p>body</p>
    </Layout>,
  );

describe("AGPL §13 source offer", () => {
  it("offers the source on a signed-in page", () => {
    const html = render();
    expect(html).toContain(`href="${STRATUM_SOURCE_URL}"`);
    expect(html).toContain(">source<");
  });

  it("offers it to anonymous visitors too — §13 is not scoped to accounts", () => {
    const html = renderToString(
      <Layout title="Test">
        <p>body</p>
      </Layout>,
    );
    expect(html).toContain(`href="${STRATUM_SOURCE_URL}"`);
  });

  it("names the license and links its text", () => {
    const html = render();
    expect(html).toContain("AGPL-3.0");
    expect(html).toContain("https://www.gnu.org/licenses/agpl-3.0.html");
  });

  it("states which version the offer is for", () => {
    expect(render()).toContain(`stratum v${STRATUM_VERSION}`);
  });

  it("keeps the offer readable: muted text, not the decorative token", () => {
    // --text-faint is documented in styles.ts as decorative-only (it does not
    // meet the contrast floor). A legal notice rendered in it would be
    // "prominent" in markup and invisible in practice.
    const footer = CSS.slice(CSS.indexOf(".site-footer {"));
    const rule = footer.slice(0, footer.indexOf("}"));
    expect(rule).toContain("var(--text-muted)");
    expect(rule).not.toContain("var(--text-faint)");
  });

  it("points somewhere a visitor can actually fetch the source", () => {
    expect(STRATUM_SOURCE_URL).toMatch(/^https:\/\//);
    // A tag-pinned URL would 404 until the tag exists; the repository root is
    // always resolvable, and the version renders beside it.
    expect(STRATUM_SOURCE_URL).not.toContain("/tree/v");
  });

  /**
   * Every document Stratum serves has to carry the offer, so this sweeps all of
   * `src/` rather than a list of files someone has to remember to extend. The
   * first version of this test did hardcode five paths, and PR-Agent was right
   * that it could not catch what it existed to catch: two template-string
   * documents (the magic-link verify page and the webhook-created page) were
   * already missing the offer and the suite stayed green.
   *
   * A "document" is a file emitting `</body>` — JSX or template string alike.
   * The two exemptions are not pages Stratum serves: `src/email/templates.ts`
   * is email bodies, and `src/templates/index.ts` is scaffolding written into
   * projects *users* create. Both are listed explicitly so adding a third is a
   * decision someone makes on purpose.
   */
  const NOT_SERVED_PAGES = [
    "../src/email/templates.ts", // emails, not pages served over the network
    "../src/templates/index.ts", // scaffolding for user-created projects
    "../src/ui/components/source-footer.tsx", // defines the offer; its `</body>` is prose
  ];

  it("appears on every document Stratum serves", () => {
    const sources = import.meta.glob(["../src/**/*.ts", "../src/**/*.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const documents = Object.entries(sources).filter(
      ([path, contents]) => contents.includes("</body>") && !NOT_SERVED_PAGES.includes(path),
    );

    // If this drops to zero the sweep has stopped sweeping, not passed.
    expect(documents.length).toBeGreaterThanOrEqual(6);

    for (const [path, contents] of documents) {
      const bodies = contents.split("</body>").length - 1;
      const offers =
        contents.split("<SourceFooter />").length -
        1 +
        (contents.split("${SOURCE_FOOTER_HTML}").length - 1) +
        (contents.split("${SOURCE_FOOTER_HTML_INLINE}").length - 1);
      expect(offers, `${path} renders ${bodies} document(s) but ${offers} source offer(s)`).toBe(
        bodies,
      );
    }
  });

  it("carries the same four facts in every rendering", () => {
    const renderings = [
      renderToString(<SourceFooter />),
      SOURCE_FOOTER_HTML,
      SOURCE_FOOTER_HTML_INLINE,
    ];
    for (const html of renderings) {
      expect(html).toContain(`stratum v${STRATUM_VERSION}`);
      expect(html).toContain("AGPL-3.0");
      expect(html).toContain("https://www.gnu.org/licenses/agpl-3.0.html");
      expect(html).toContain(STRATUM_SOURCE_URL);
    }
  });

  it("keeps the raw-HTML rendering identical to the JSX one", () => {
    // Same markup, not merely the same facts: the two class-based renderings
    // sit next to each other in the same chrome, so a divergence would show.
    expect(renderToString(<SourceFooter />)).toBe(SOURCE_FOOTER_HTML);
  });
});
