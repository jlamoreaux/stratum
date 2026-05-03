import { beforeEach, describe, expect, it, vi } from "vitest";
import { MergeQueue } from "../src/queue/merge-queue";
import { getChange, updateChangeStatus } from "../src/storage/changes";
import { mergeWorkspaceIntoProject } from "../src/storage/git-ops";
import { recordProvenance } from "../src/storage/provenance";
import { getProject, getWorkspace } from "../src/storage/state";
import type { Env } from "../src/types";

vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(),
}));

vi.mock("../src/storage/git-ops", () => ({
  mergeWorkspaceIntoProject: vi.fn(),
}));

vi.mock("../src/storage/provenance", () => ({
  recordProvenance: vi.fn(),
}));

vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

describe("MergeQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProject).mockResolvedValue({
      name: "my-project",
      remote: "https://artifacts.example.com/repos/my-project",
      token: "tok_project",
      createdAt: "2026-01-01T00:00:00.000Z",
      ownerId: "user_test",
    });
    vi.mocked(getWorkspace).mockResolvedValue({
      name: "fix-bug",
      remote: "https://artifacts.example.com/repos/fix-bug",
      token: "tok_workspace",
      parent: "my-project",
      createdAt: "2026-01-01T01:00:00.000Z",
    });
    vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue("sha_merged");
    vi.mocked(updateChangeStatus).mockResolvedValue(undefined);
    vi.mocked(recordProvenance).mockResolvedValue({
      id: "prv_123",
      commitSha: "sha_merged",
      project: "my-project",
      workspace: "fix-bug",
      changeId: "chg_abc123",
      mergedAt: "2026-01-01T02:00:00.000Z",
    });
  });

  it("merges accepted changes", async () => {
    vi.mocked(getChange).mockResolvedValue({
      id: "chg_abc123",
      project: "my-project",
      workspace: "fix-bug",
      status: "accepted",
      createdAt: "2026-01-01T02:00:00.000Z",
    });

    const queue = new MergeQueue({} as DurableObjectState, makeEnv());
    const result = await queue.merge("chg_abc123");

    expect(result).toEqual({ success: true, commit: "sha_merged" });
    expect(updateChangeStatus).toHaveBeenCalledWith(
      expect.anything(),
      "chg_abc123",
      "merged",
      expect.objectContaining({ mergedAt: expect.any(String) }),
    );
  });

  it("rejects non-mergeable changes before mutating state", async () => {
    vi.mocked(getChange).mockResolvedValue({
      id: "chg_abc123",
      project: "my-project",
      workspace: "fix-bug",
      status: "open",
      createdAt: "2026-01-01T02:00:00.000Z",
    });

    const queue = new MergeQueue({} as DurableObjectState, makeEnv());
    const result = await queue.merge("chg_abc123");

    expect(result).toEqual({ success: false, error: "Change not found or not ready to merge" });
    expect(updateChangeStatus).not.toHaveBeenCalled();
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });
});
