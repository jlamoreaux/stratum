/// <reference types="vite/client" />
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { SourceFooter } from "../src/ui/components/source-footer";
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
   * The auth and OAuth-consent pages are their own HTML documents rather than
   * `Layout` children, and they are the only Stratum an anonymous visitor may
   * ever see. An offer that appears once you sign in is not the offer §13 asks
   * for, so every standalone document has to carry it too.
   */
  it("appears on every standalone document, not just the shared layout", () => {
    const standalone = import.meta.glob(
      [
        "../src/routes/login.tsx",
        "../src/routes/signup.tsx",
        "../src/routes/oauth-signup.tsx",
        "../src/routes/mcp-oauth.tsx",
        "../src/ui/layout.tsx",
      ],
      { query: "?raw", import: "default", eager: true },
    ) as Record<string, string>;

    for (const [path, contents] of Object.entries(standalone)) {
      const documents = contents.split("</body>").length - 1;
      const offers = contents.split("<SourceFooter />").length - 1;
      expect(documents, `${path} should render at least one document`).toBeGreaterThan(0);
      expect(offers, `${path} renders ${documents} document(s) but ${offers} offer(s)`).toBe(
        documents,
      );
    }
  });

  it("renders the same offer wherever it is used", () => {
    const html = renderToString(<SourceFooter />);
    expect(html).toContain(`href="${STRATUM_SOURCE_URL}"`);
    expect(html).toContain("AGPL-3.0");
    expect(html).toContain(`stratum v${STRATUM_VERSION}`);
  });
});
