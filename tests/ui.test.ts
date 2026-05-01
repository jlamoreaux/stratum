import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { uiRouter } from "../src/routes/ui";
import type { Env } from "../src/types";

vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn().mockResolvedValue({
    id: "chg_abc123",
    project: "my-project",
    workspace: "fix-bug",
    status: "merged",
    evalScore: 0.5,
    evalPassed: false,
    evalReason: "Secret detected",
    createdAt: "2026-01-01T00:00:00.000Z",
    mergedAt: "2026-01-01T01:00:00.000Z",
  }),
  listChanges: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/storage/eval-runs", () => ({
  listEvalRuns: vi.fn().mockResolvedValue([
    {
      id: "evl_abc123",
      changeId: "chg_abc123",
      evaluatorType: "secret_scan",
      score: 0,
      passed: false,
      reason: "Secret detected",
      issues: ["AWS Access Key: line 4"],
      ranAt: "2026-01-01T00:01:00.000Z",
    },
  ]),
}));

vi.mock("../src/storage/provenance", () => ({
  getProvenance: vi.fn().mockResolvedValue({
    id: "prv_abc123",
    commitSha: "abc123def456",
    project: "my-project",
    workspace: "fix-bug",
    changeId: "chg_abc123",
    mergedAt: "2026-01-01T01:00:00.000Z",
  }),
}));

vi.mock("../src/storage/state", () => ({
  getProject: vi.fn().mockResolvedValue(null),
  listProjects: vi.fn().mockResolvedValue([]),
  listWorkspaces: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/storage/git-ops", () => ({
  getCommitLog: vi.fn().mockResolvedValue([]),
  listFilesInRepo: vi.fn().mockResolvedValue([]),
}));

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/ui", uiRouter);
  return app;
}

describe("UI routes", () => {
  it("renders evaluator evidence and provenance on change detail", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/ui/changes/chg_abc123"),
      {} as Env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Evaluator evidence");
    expect(html).toContain("secret_scan");
    expect(html).toContain("AWS Access Key: line 4");
    expect(html).toContain("Provenance");
    expect(html).toContain("abc123def456");
  });
});
