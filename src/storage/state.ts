import type { ProjectEntry, WorkspaceEntry } from "../types";
import type { Logger } from "../utils/logger";
import { Result, ok, err } from "../utils/result";
import { AppError } from "../utils/errors";

const PROJECT_PREFIX = "project:";
const WORKSPACE_PREFIX = "workspace:";

function parseEntry<T>(
  raw: string,
  key: string,
  logger: Logger
): Result<T, AppError> {
  try {
    return ok(JSON.parse(raw) as T);
  } catch (error) {
    logger.error(`Failed to parse KV entry for key "${key}" — skipping`, error instanceof Error ? error : undefined);
    return err(new AppError(
      `Failed to parse KV entry for key "${key}"`,
      "PARSE_ERROR",
      500,
      { key, raw }
    ));
  }
}

function projectKey(name: string): string {
  return `${PROJECT_PREFIX}${name}`;
}

function workspaceKey(name: string): string {
  return `${WORKSPACE_PREFIX}${name}`;
}

export async function getProject(
  kv: KVNamespace,
  name: string,
  logger: Logger
): Promise<Result<ProjectEntry, AppError>> {
  logger.debug('Fetching project', { name });
  const raw = await kv.get(projectKey(name));
  if (!raw) {
    return err(new AppError(
      `Project '${name}' not found`,
      "NOT_FOUND",
      404,
      { resource: 'project', name }
    ));
  }
  return parseEntry<ProjectEntry>(raw, projectKey(name), logger);
}

export async function setProject(
  kv: KVNamespace,
  entry: ProjectEntry,
  logger: Logger
): Promise<Result<void, AppError>> {
  logger.debug('Setting project', { name: entry.name });
  try {
    await kv.put(projectKey(entry.name), JSON.stringify(entry));
    return ok(undefined);
  } catch (error) {
    logger.error('Failed to set project', error instanceof Error ? error : undefined, { name: entry.name });
    return err(new AppError(
      `Failed to set project '${entry.name}'`,
      "STORAGE_ERROR",
      500,
      { name: entry.name }
    ));
  }
}

export async function deleteProject(
  kv: KVNamespace,
  name: string,
  logger: Logger
): Promise<Result<void, AppError>> {
  logger.debug('Deleting project', { name });
  try {
    await kv.delete(projectKey(name));
    return ok(undefined);
  } catch (error) {
    logger.error('Failed to delete project', error instanceof Error ? error : undefined, { name });
    return err(new AppError(
      `Failed to delete project '${name}'`,
      "STORAGE_ERROR",
      500,
      { name }
    ));
  }
}

export async function listProjects(
  kv: KVNamespace,
  logger: Logger
): Promise<Result<ProjectEntry[], AppError>> {
  logger.debug('Listing projects');
  try {
    const result = await kv.list({ prefix: PROJECT_PREFIX });
    const entries = await Promise.all(
      result.keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        if (!raw) return null;
        const parsed = parseEntry<ProjectEntry>(raw, name, logger);
        return parsed.success ? parsed.data : null;
      }),
    );
    return ok(entries.filter((e): e is ProjectEntry => e !== null));
  } catch (error) {
    logger.error('Failed to list projects', error instanceof Error ? error : undefined);
    return err(new AppError(
      'Failed to list projects',
      "STORAGE_ERROR",
      500
    ));
  }
}

export async function getWorkspace(
  kv: KVNamespace,
  name: string,
  logger: Logger
): Promise<Result<WorkspaceEntry, AppError>> {
  logger.debug('Fetching workspace', { name });
  const raw = await kv.get(workspaceKey(name));
  if (!raw) {
    return err(new AppError(
      `Workspace '${name}' not found`,
      "NOT_FOUND",
      404,
      { resource: 'workspace', name }
    ));
  }
  return parseEntry<WorkspaceEntry>(raw, workspaceKey(name), logger);
}

export async function setWorkspace(
  kv: KVNamespace,
  entry: WorkspaceEntry,
  logger: Logger
): Promise<Result<void, AppError>> {
  logger.debug('Setting workspace', { name: entry.name });
  try {
    await kv.put(workspaceKey(entry.name), JSON.stringify(entry));
    return ok(undefined);
  } catch (error) {
    logger.error('Failed to set workspace', error instanceof Error ? error : undefined, { name: entry.name });
    return err(new AppError(
      `Failed to set workspace '${entry.name}'`,
      "STORAGE_ERROR",
      500,
      { name: entry.name }
    ));
  }
}

export async function deleteWorkspace(
  kv: KVNamespace,
  name: string,
  logger: Logger
): Promise<Result<void, AppError>> {
  logger.debug('Deleting workspace', { name });
  try {
    await kv.delete(workspaceKey(name));
    return ok(undefined);
  } catch (error) {
    logger.error('Failed to delete workspace', error instanceof Error ? error : undefined, { name });
    return err(new AppError(
      `Failed to delete workspace '${name}'`,
      "STORAGE_ERROR",
      500,
      { name }
    ));
  }
}

export async function listWorkspaces(
  kv: KVNamespace,
  logger: Logger,
  repoName?: string,
): Promise<Result<WorkspaceEntry[], AppError>> {
  logger.debug('Listing workspaces', { repoName });
  try {
    const result = await kv.list({ prefix: WORKSPACE_PREFIX });
    const entries = await Promise.all(
      result.keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        if (!raw) return null;
        const parsed = parseEntry<WorkspaceEntry>(raw, name, logger);
        return parsed.success ? parsed.data : null;
      }),
    );
    const all = entries.filter((e): e is WorkspaceEntry => e !== null);
    return ok(repoName ? all.filter((e) => e.parent === repoName) : all);
  } catch (error) {
    logger.error('Failed to list workspaces', error instanceof Error ? error : undefined, { repoName });
    return err(new AppError(
      'Failed to list workspaces',
      "STORAGE_ERROR",
      500,
      { repoName }
    ));
  }
}
