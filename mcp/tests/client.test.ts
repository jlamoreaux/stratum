import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StratumClient, parseProjectRef } from "../src/client.js";

const fetchMock = vi.fn();

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

describe("parseProjectRef", () => {
  it("parses namespace/slug with and without @", () => {
    expect(parseProjectRef("@user/repo")).toEqual({ namespace: "@user", slug: "repo" });
    expect(parseProjectRef("user/repo")).toEqual({ namespace: "@user", slug: "repo" });
  });

  it("rejects malformed references", () => {
    expect(() => parseProjectRef("just-a-name")).toThrow(/namespace\/slug/);
  });
});

describe("StratumClient", () => {
  let client: StratumClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    client = new StratumClient("https://stratum.example.com/", "stratum_user_key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and strips trailing slash from host", async () => {
    await client.listProjects();
    const { url, init } = lastCall();
    expect(url).toBe("https://stratum.example.com/api/projects");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer stratum_user_key");
  });

  it("sets Content-Type only when a body is sent", async () => {
    await client.listProjects();
    expect((lastCall().init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();

    await client.createWorkspace(parseProjectRef("@user/repo"));
    expect((lastCall().init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("surfaces API error bodies including merge-blocking reasons", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: "Merge blocked",
            reasons: ["secret_scan failed", "1 approval required"],
          }),
          { status: 409 },
        ),
    );
    await expect(client.mergeChange("chg_1")).rejects.toThrow(
      /Merge blocked[\s\S]*secret_scan failed[\s\S]*1 approval required/,
    );
  });

  it("falls back to HTTP status when the error body is not JSON", async () => {
    fetchMock.mockImplementation(
      async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(client.listProjects()).rejects.toThrow("Bad Gateway");
  });
});
