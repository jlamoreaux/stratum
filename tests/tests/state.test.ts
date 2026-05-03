import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteProject,
  deleteWorkspace,
  getProject,
  getWorkspace,
  listProjects,
  listWorkspaces,
  setProject,
  setWorkspace,
} from "../src/storage/state";
import type { ProjectEntry, WorkspaceEntry } from "../src/types";
import { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => mockLogger,
};

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

const project: ProjectEntry = {
  name: "my-project",
  remote: "https://artifacts.example.com/repos/my-project",
  token: "tok_abc123",
  createdAt: "2026-04-29T00:00:00.000Z",
};

const workspace: WorkspaceEntry = {
  name: "fix-bug",
  remote: "https://artifacts.example.com/repos/fix-bug",
  token: "tok_def456",
  parent: "my-project",
  createdAt: "2026-04-29T01:00:00.000Z",
};

describe("project state", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeKV();
  });

  it("returns error for missing project", async () => {
    const result = await getProject(kv, "nope", mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("stores and retrieves a project", async () => {
    await setProject(kv, project, mockLogger);
    const result = await getProject(kv, project.name, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(project);
    }
  });

  it("overwrites existing project", async () => {
    await setProject(kv, project, mockLogger);
    const updated = { ...project, token: "tok_new" };
    await setProject(kv, updated, mockLogger);
    const result = await getProject(kv, project.name, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe("tok_new");
    }
  });

  it("deletes a project", async () => {
    await setProject(kv, project, mockLogger);
    await deleteProject(kv, project.name, mockLogger);
    const result = await getProject(kv, project.name, mockLogger);
    expect(result.success).toBe(false);
  });

  it("lists all projects", async () => {
    const p2 = { ...project, name: "other-project" };
    await setProject(kv, project, mockLogger);
    await setProject(kv, p2, mockLogger);
    const result = await listProjects(kv, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data.map((p) => p.name)).toContain("my-project");
      expect(result.data.map((p) => p.name)).toContain("other-project");
    }
  });

  it("lists empty when no projects", async () => {
    const result = await listProjects(kv, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });
});

describe("workspace state", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeKV();
  });

  it("returns error for missing workspace", async () => {
    const result = await getWorkspace(kv, "nope", mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("stores and retrieves a workspace", async () => {
    await setWorkspace(kv, workspace, mockLogger);
    const result = await getWorkspace(kv, workspace.name, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(workspace);
    }
  });

  it("deletes a workspace", async () => {
    await setWorkspace(kv, workspace, mockLogger);
    await deleteWorkspace(kv, workspace.name, mockLogger);
    const result = await getWorkspace(kv, workspace.name, mockLogger);
    expect(result.success).toBe(false);
  });

  it("lists all workspaces", async () => {
    const w2 = { ...workspace, name: "add-feature", parent: "other-project" };
    await setWorkspace(kv, workspace, mockLogger);
    await setWorkspace(kv, w2, mockLogger);
    const result = await listWorkspaces(kv, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
  });

  it("filters workspaces by parent project", async () => {
    const w2 = { ...workspace, name: "add-feature", parent: "other-project" };
    await setWorkspace(kv, workspace, mockLogger);
    await setWorkspace(kv, w2, mockLogger);
    const result = await listWorkspaces(kv, mockLogger, "my-project");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe("fix-bug");
    }
  });

  it("does not mix project and workspace keys", async () => {
    await setProject(kv, project, mockLogger);
    await setWorkspace(kv, workspace, mockLogger);
    const projectsResult = await listProjects(kv, mockLogger);
    const workspacesResult = await listWorkspaces(kv, mockLogger);
    expect(projectsResult.success).toBe(true);
    expect(workspacesResult.success).toBe(true);
    if (projectsResult.success && workspacesResult.success) {
      expect(projectsResult.data).toHaveLength(1);
      expect(workspacesResult.data).toHaveLength(1);
    }
  });
});
