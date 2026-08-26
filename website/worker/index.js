/**
 * Docs site Worker.
 *
 * The site is still a static build; this Worker only adds the two things static
 * assets cannot do on their own:
 *
 *   1. RFC 8288 `Link` headers pointing agents at the machine-readable entry
 *      points (llms.txt, the OpenAPI spec, the API catalogue, the sitemap).
 *   2. Markdown content negotiation — a request for a page with
 *      `Accept: text/markdown` gets the Markdown source instead of HTML.
 *
 * Everything else falls straight through to the assets binding.
 */

const LINK_HEADER = [
  '</llms.txt>; rel="alternate"; type="text/plain"; title="Documentation index for language models"',
  '</llms-full.txt>; rel="alternate"; type="text/plain"; title="Complete documentation for language models"',
  '</openapi.yml>; rel="service-desc"; type="application/yaml"; title="Stratum REST API"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</sitemap-index.xml>; rel="sitemap"; type="application/xml"',
].join(", ");

/** Paths whose content type the assets binding cannot infer from the extension. */
const CONTENT_TYPES = {
  "/.well-known/api-catalog": "application/linkset+json",
};

/**
 * True when the client actually accepts Markdown.
 *
 * Parses each Accept entry rather than prefix-matching it: `startsWith` would
 * also match an unrelated `text/markdownish`, and — more importantly — would
 * treat `text/markdown;q=0` as acceptance when q=0 is how a client says it does
 * NOT want that representation.
 */
const wantsMarkdown = (accept) =>
  accept.split(",").some((part) => {
    const [mediaType, ...params] = part.split(";");
    if (mediaType.trim().toLowerCase() !== "text/markdown") return false;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    if (q === undefined) return true;
    // Validate the whole token before converting. `Number.parseFloat` stops at
    // the first non-numeric character, so it reads `q=0bogus` as 0 — refusing a
    // malformed value that the policy below accepts, purely because the garbage
    // happened to start with a digit. The pattern is RFC 9110's qvalue grammar.
    if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)) return true;
    // A malformed q is not a refusal, so only a well-formed zero excludes.
    return Number(q) > 0;
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && wantsMarkdown(request.headers.get("accept") ?? "")) {
      const path = url.pathname.replace(/\/+$/, "");
      // Set `pathname` on a copy rather than resolving a relative URL against
      // `url`: a request path can begin with `//` (e.g. `//example.com/x`), and
      // `new URL("//example.com/x.md", url)` is protocol-relative, so it would
      // resolve to a different origin entirely. Assigning `pathname` cannot
      // change the origin, so the lookup always stays on this site.
      const markdownUrl = new URL(url);
      markdownUrl.pathname = `${path === "" ? "/index" : path}.md`;
      markdownUrl.search = "";
      markdownUrl.hash = "";
      const markdown = await env.ASSETS.fetch(new Request(markdownUrl, { method: "GET" }));
      if (markdown.ok) {
        const headers = new Headers(markdown.headers);
        headers.set("content-type", "text/markdown; charset=utf-8");
        headers.set("link", LINK_HEADER);
        headers.set("vary", "Accept");
        return new Response(markdown.body, { status: 200, headers });
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    const contentType = headers.get("content-type") ?? "";

    if (contentType.includes("text/html")) {
      headers.set("link", LINK_HEADER);
      headers.set("vary", "Accept");
    }
    const override = CONTENT_TYPES[url.pathname];
    if (override) headers.set("content-type", override);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
