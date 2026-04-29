import type { ProjectEntry, WorkspaceEntry } from "../types";

const PROJECT_PREFIX = "project:";
const WORKSPACE_PREFIX = "workspace:";

function parseEntry<T>(raw: string, key: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`[state] Failed to parse KV entry for key "${key}" — skipping`);
    return null;
  }
}

function projectKey(name: string): string {
  return `${PROJECT_PREFIX}${name}`;
}

function workspaceKey(name: string): string {
  return `${WORKSPACE_PREFIX}${name}`;
}

export async function getProject(kv: KVNamespace, name: string): Promise<ProjectEntry | null> {
  const raw = await kv.get(projectKey(name));
  return raw ? parseEntry<ProjectEntry>(raw, projectKey(name)) : null;
}

export async function setProject(kv: KVNamespace, entry: ProjectEntry): Promise<void> {
  await kv.put(projectKey(entry.name), JSON.stringify(entry));
}

export async function deleteProject(kv: KVNamespace, name: string): Promise<void> {
  await kv.delete(projectKey(name));
}

export async function listProjects(kv: KVNamespace): Promise<ProjectEntry[]> {
  const result = await kv.list({ prefix: PROJECT_PREFIX });
  const entries = await Promise.all(
    result.keys.map(async ({ name }) => {
      const raw = await kv.get(name);
      return raw ? parseEntry<ProjectEntry>(raw, name) : null;
    }),
  );
  return entries.filter((e): e is ProjectEntry => e !== null);
}

export async function getWorkspace(kv: KVNamespace, name: string): Promise<WorkspaceEntry | null> {
  const raw = await kv.get(workspaceKey(name));
  return raw ? parseEntry<WorkspaceEntry>(raw, workspaceKey(name)) : null;
}

export async function setWorkspace(kv: KVNamespace, entry: WorkspaceEntry): Promise<void> {
  await kv.put(workspaceKey(entry.name), JSON.stringify(entry));
}

export async function deleteWorkspace(kv: KVNamespace, name: string): Promise<void> {
  await kv.delete(workspaceKey(name));
}

export async function listWorkspaces(
  kv: KVNamespace,
  repoName?: string,
): Promise<WorkspaceEntry[]> {
  const result = await kv.list({ prefix: WORKSPACE_PREFIX });
  const entries = await Promise.all(
    result.keys.map(async ({ name }) => {
      const raw = await kv.get(name);
      return raw ? parseEntry<WorkspaceEntry>(raw, name) : null;
    }),
  );
  const all = entries.filter((e): e is WorkspaceEntry => e !== null);
  return repoName ? all.filter((e) => e.parent === repoName) : all;
}
