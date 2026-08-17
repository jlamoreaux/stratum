import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StratumClient } from "../src/client.js";
import { buildTools, type ToolDef } from "../src/tools.js";

const fetchMock = vi.fn();

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

function getTool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

let tools: ToolDef[];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
  tools = buildTools(new StratumClient("https://stratum.example.com", "stratum_agent_key"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool registry", () => {
  it("exposes the full change-flow surface with unique, prefixed names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("stratum_"))).toBe(true);
    for (const required of [
      "stratum_whoami",
      "stratum_list_projects",
      "stratum_get_project",
      "stratum_list_files",
      "stratum_get_file",
      "stratum_get_activity",
      "stratum_create_workspace",
      "stratum_list_workspaces",
      "stratum_commit",
      "stratum_create_change",
      "stratum_list_changes",
      "stratum_get_change",
      "stratum_merge_change",
      "stratum_reject_change",
      "stratum_review_change",
      "stratum_create_issue",
      "stratum_list_issues",
      "stratum_update_issue",
    ]) {
      expect(names).toContain(required);
    }
    expect(names).toHaveLength(18);
  });

  it("gives every tool a non-empty description", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("documents the human-approval invariant on the review tool", () => {
    const review = getTool(tools, "stratum_review_change");
    expect(review.description).toMatch(/human gate|never approve/i);
  });
});

describe("read tools", () => {
  it("stratum_whoami calls /api/users/me and returns formatted JSON", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ id: "user_1", email: "a@b.c" }), { status: 200 }),
    );
    const result = await getTool(tools, "stratum_whoami").handler({});
    expect(lastCall().url).toBe("https://stratum.example.com/api/users/me");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ id: "user_1", email: "a@b.c" });
  });

  it("stratum_get_project normalizes the namespace", async () => {
    await getTool(tools, "stratum_get_project").handler({ project: "acme/api" });
    expect(lastCall().url).toBe("https://stratum.example.com/api/projects/%40acme/api");
  });

  it("stratum_get_file encodes the path query", async () => {
    await getTool(tools, "stratum_get_file").handler({
      project: "@acme/api",
      path: "src/a b.ts",
    });
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/projects/%40acme/api/content?path=src%2Fa%20b.ts",
    );
  });

  it("stratum_list_issues passes the status filter", async () => {
    await getTool(tools, "stratum_list_issues").handler({ project: "@acme/api", status: "open" });
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/projects/%40acme/api/issues?status=open",
    );
  });
});

describe("write tools", () => {
  it("stratum_commit posts files, message, and projectId", async () => {
    await getTool(tools, "stratum_commit").handler({
      workspace: "ws-1",
      project_id: "proj_123",
      message: "add feature",
      files: { "src/a.ts": "export const a = 1;" },
    });
    const { url, init } = lastCall();
    expect(url).toBe("https://stratum.example.com/api/workspaces/ws-1/commit");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      files: { "src/a.ts": "export const a = 1;" },
      message: "add feature",
      projectId: "proj_123",
    });
  });

  it("stratum_create_change normalizes a bare namespace before hitting the API", async () => {
    await getTool(tools, "stratum_create_change").handler({
      project: "acme/api",
      workspace: "ws-1",
    });
    expect(lastCall().url).toBe("https://stratum.example.com/api/projects/%40acme%2Fapi/changes");
  });

  it("stratum_create_change posts the workspace and echoes eval verdicts", async () => {
    const evalPayload = {
      change: { id: "chg_1", status: "open" },
      eval: { score: 0.4, passed: false, reason: "secret detected" },
      evalRuns: [{ evaluatorType: "secret_scan", score: 0, passed: false }],
    };
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(evalPayload), { status: 200 }),
    );
    const result = await getTool(tools, "stratum_create_change").handler({
      project: "@acme/api",
      workspace: "ws-1",
    });
    expect(lastCall().url).toBe("https://stratum.example.com/api/projects/%40acme%2Fapi/changes");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ workspace: "ws-1" });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(evalPayload);
  });

  it("stratum_merge_change forwards force and strategy as query params", async () => {
    await getTool(tools, "stratum_merge_change").handler({
      change_id: "chg_1",
      force: true,
      strategy: "squash",
    });
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/changes/chg_1/merge?force=true&strategy=squash",
    );
  });

  it("stratum_update_issue patches by number", async () => {
    await getTool(tools, "stratum_update_issue").handler({
      project: "@acme/api",
      number: 7,
      status: "closed",
    });
    const { url, init } = lastCall();
    expect(url).toBe("https://stratum.example.com/api/projects/%40acme/api/issues/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({ status: "closed" });
  });
});

describe("error handling", () => {
  it("maps API rejections to isError results instead of throwing", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "agent tokens cannot approve work" }), {
          status: 403,
        }),
    );
    const result = await getTool(tools, "stratum_review_change").handler({
      change_id: "chg_1",
      verdict: "approve",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("agent tokens cannot approve work");
  });

  it("rejects invalid arguments before any network call", async () => {
    const result = await getTool(tools, "stratum_commit").handler({
      workspace: "ws-1",
      // project_id, message, files missing
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown review verdict before any network call", async () => {
    const result = await getTool(tools, "stratum_review_change").handler({
      change_id: "chg_1",
      verdict: "rubber_stamp",
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed project reference without a network call", async () => {
    const result = await getTool(tools, "stratum_get_project").handler({ project: "no-slash" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("namespace/slug");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
