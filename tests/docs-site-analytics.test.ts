/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// Raw imports rather than node:fs, matching tests/wrangler-telemetry-config.test.ts.
// The docs site has no test runner of its own, so its two analytics-bearing
// files are asserted from here — otherwise they would ship with no coverage at
// all on a site that has no CSP.
import astroConfig from "../website/astro.config.mjs?raw";
import docsWorker from "../website/worker/index.js?raw";

describe("docs site analytics gating", () => {
  it("ships nothing unless a PostHog project key is supplied at build time", () => {
    // A fork, a PR preview, or anyone running `npm run build` must produce a
    // site that sends nothing. The build must never depend on the variable.
    expect(astroConfig).toContain("process.env.PUBLIC_POSTHOG_KEY");
    expect(astroConfig).toContain('POSTHOG_KEY.startsWith("phc_")');
  });

  it("refuses a personal API key, which would be a credential in public HTML", () => {
    // PostHog's two key types differ by one letter and the value is embedded in
    // every page, so the prefix check is the only thing standing between a
    // paste error and a disclosure.
    const gate = /POSTHOG_KEY\.startsWith\("phc_"\)\s*\?/.test(astroConfig);
    expect(gate).toBe(true);
  });

  it("pins the SDK version rather than tracking a floating bundle", () => {
    expect(astroConfig).toMatch(/SDK_VERSION = "\d+\.\d+\.\d+"/);
    expect(astroConfig).toContain("/_ph/static/${SDK_VERSION}/array.js");
  });

  it("does not load session replay", () => {
    expect(astroConfig).toContain("disable_session_recording: true");
    expect(astroConfig).toContain("disable_external_dependency_loading: true");
  });

  it("respects Do Not Track, the only control an anonymous docs visitor has", () => {
    expect(astroConfig).toContain("respect_dnt: true");
  });
});

describe("docs site proxy", () => {
  it("handles the analytics prefix before Markdown negotiation and the assets binding", () => {
    // The Markdown branch would rewrite `/_ph/e` to `/_ph/e.md`, and the assets
    // binding would 404 it, so ordering here is load-bearing rather than
    // stylistic.
    const proxyAt = docsWorker.indexOf("handleAnalyticsProxy(request, url)");
    const markdownAt = docsWorker.indexOf("wantsMarkdown(request.headers.get");
    const assetsAt = docsWorker.indexOf("env.ASSETS.fetch(request)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeLessThan(markdownAt);
    expect(proxyAt).toBeLessThan(assetsAt);
  });

  it("forwards only PostHog ingestion paths", () => {
    expect(docsWorker).toContain(
      'INGEST_PREFIXES = ["/e", "/i/v0/e", "/decide", "/flags", "/batch"]',
    );
  });

  it("strips credentials before forwarding and refuses to loop", () => {
    expect(docsWorker).toContain('headers.delete("cookie")');
    expect(docsWorker).toContain('headers.delete("authorization")');
    expect(docsWorker).toContain('request.headers.get("X-Stratum-Proxy")');
  });

  it("never lets the upstream set cookies on this origin", () => {
    expect(docsWorker).toContain('responseHeaders.delete("set-cookie")');
  });

  it("accepts only a plain semver in the SDK path", () => {
    // The version is interpolated into a CDN URL.
    expect(docsWorker).toContain("/^\\/static\\/(\\d+\\.\\d+\\.\\d+)\\/array\\.js$/");
  });
});
