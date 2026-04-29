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

  it("returns null for missing project", async () => {
    expect(await getProject(kv, "nope")).toBeNull();
  });

  it("stores and retrieves a project", async () => {
    await setProject(kv, project);
    expect(await getProject(kv, project.name)).toEqual(project);
  });

  it("overwrites existing project", async () => {
    await setProject(kv, project);
    const updated = { ...project, token: "tok_new" };
    await setProject(kv, updated);
    expect((await getProject(kv, project.name))?.token).toBe("tok_new");
  });

  it("deletes a project", async () => {
    await setProject(kv, project);
    await deleteProject(kv, project.name);
    expect(await getProject(kv, project.name)).toBeNull();
  });

  it("lists all projects", async () => {
    const p2 = { ...project, name: "other-project" };
    await setProject(kv, project);
    await setProject(kv, p2);
    const list = await listProjects(kv);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name)).toContain("my-project");
    expect(list.map((p) => p.name)).toContain("other-project");
  });

  it("lists empty when no projects", async () => {
    expect(await listProjects(kv)).toEqual([]);
  });
});

describe("workspace state", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeKV();
  });

  it("returns null for missing workspace", async () => {
    expect(await getWorkspace(kv, "nope")).toBeNull();
  });

  it("stores and retrieves a workspace", async () => {
    await setWorkspace(kv, workspace);
    expect(await getWorkspace(kv, workspace.name)).toEqual(workspace);
  });

  it("deletes a workspace", async () => {
    await setWorkspace(kv, workspace);
    await deleteWorkspace(kv, workspace.name);
    expect(await getWorkspace(kv, workspace.name)).toBeNull();
  });

  it("lists all workspaces", async () => {
    const w2 = { ...workspace, name: "add-feature", parent: "other-project" };
    await setWorkspace(kv, workspace);
    await setWorkspace(kv, w2);
    const all = await listWorkspaces(kv);
    expect(all).toHaveLength(2);
  });

  it("filters workspaces by parent project", async () => {
    const w2 = { ...workspace, name: "add-feature", parent: "other-project" };
    await setWorkspace(kv, workspace);
    await setWorkspace(kv, w2);
    const filtered = await listWorkspaces(kv, "my-project");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("fix-bug");
  });

  it("does not mix project and workspace keys", async () => {
    await setProject(kv, project);
    await setWorkspace(kv, workspace);
    const projects = await listProjects(kv);
    const workspaces = await listWorkspaces(kv);
    expect(projects).toHaveLength(1);
    expect(workspaces).toHaveLength(1);
  });
});
