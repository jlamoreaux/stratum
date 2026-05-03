/**
 * Import progress tracking storage
 * Stores import job status in KV for persistence across page refreshes
 */

import type { ImportProgress, ImportStatus } from "../types";
import type { Logger } from "../utils/logger";
import { Result, ok, err } from "../utils/result";
import { AppError } from "../utils/errors";

const IMPORT_PREFIX = "import:";
const IMPORT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function importKey(namespace: string, slug: string): string {
  return `${IMPORT_PREFIX}${namespace}:${slug}`;
}

export async function createImportJob(
  kv: KVNamespace,
  params: {
    id: string;
    projectId: string;
    namespace: string;
    slug: string;
    sourceUrl: string;
    branch: string;
  },
  logger: Logger
): Promise<Result<ImportProgress, AppError>> {
  logger.debug('Creating import job', { 
    importId: params.id, 
    namespace: params.namespace, 
    slug: params.slug 
  });

  const progress: ImportProgress = {
    id: params.id,
    projectId: params.projectId,
    namespace: params.namespace,
    slug: params.slug,
    status: "queued",
    sourceUrl: params.sourceUrl,
    branch: params.branch,
    startedAt: new Date().toISOString(),
    progress: {
      processedFiles: 0,
    },
    errors: [],
    logs: [{
      message: "Import queued",
      level: "info",
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    await kv.put(importKey(params.namespace, params.slug), JSON.stringify(progress), {
      expirationTtl: IMPORT_TTL_SECONDS,
    });
    logger.info('Import job created', { importId: params.id });
    return ok(progress);
  } catch (error) {
    logger.error('Failed to create import job', error instanceof Error ? error : undefined);
    return err(new AppError("Failed to create import job", "STORAGE_ERROR", 500));
  }
}

export async function getImportProgress(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger
): Promise<Result<ImportProgress | null, AppError>> {
  try {
    const raw = await kv.get(importKey(namespace, slug));
    if (!raw) {
      return ok(null);
    }
    return ok(JSON.parse(raw) as ImportProgress);
  } catch (error) {
    logger.error('Failed to get import progress', error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get import progress", "STORAGE_ERROR", 500));
  }
}

export async function updateImportProgress(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  updates: Partial<ImportProgress>,
  logger: Logger
): Promise<Result<ImportProgress, AppError>> {
  const existingResult = await getImportProgress(kv, namespace, slug, logger);
  if (!existingResult.success) {
    return existingResult;
  }
  
  const existing = existingResult.data;
  if (!existing) {
    return err(new AppError("Import job not found", "NOT_FOUND", 404));
  }

  const updated: ImportProgress = {
    ...existing,
    ...updates,
    // Merge progress objects deeply
    progress: {
      ...existing.progress,
      ...updates.progress,
    },
    // Append new logs
    logs: [...existing.logs, ...(updates.logs || [])],
    // Append new errors
    errors: [...existing.errors, ...(updates.errors || [])],
  };

  try {
    await kv.put(importKey(namespace, slug), JSON.stringify(updated), {
      expirationTtl: IMPORT_TTL_SECONDS,
    });
    return ok(updated);
  } catch (error) {
    logger.error('Failed to update import progress', error instanceof Error ? error : undefined);
    return err(new AppError("Failed to update import progress", "STORAGE_ERROR", 500));
  }
}

export async function updateImportStatus(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  status: ImportStatus,
  logger: Logger,
  message?: string
): Promise<Result<ImportProgress, AppError>> {
  const updates: Partial<ImportProgress> = { status };
  
  if (status === "completed" || status === "failed" || status === "cancelled") {
    updates.completedAt = new Date().toISOString();
  }
  
  if (message) {
    updates.logs = [{
      message,
      level: status === "failed" ? "error" : "info",
      timestamp: new Date().toISOString(),
    }];
  }

  return updateImportProgress(kv, namespace, slug, updates, logger);
}

export async function cancelImportJob(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger
): Promise<Result<ImportProgress, AppError>> {
  logger.info('Cancelling import job', { namespace, slug });
  
  const progressResult = await getImportProgress(kv, namespace, slug, logger);
  if (!progressResult.success) {
    return progressResult;
  }
  
  if (!progressResult.data) {
    return err(new AppError("Import job not found", "NOT_FOUND", 404));
  }
  
  const progress = progressResult.data;
  
  // Can only cancel if not already completed/failed/cancelled
  if (["completed", "failed", "cancelled"].includes(progress.status)) {
    return err(new AppError(`Cannot cancel import with status: ${progress.status}`, "INVALID_STATE", 400));
  }
  
  return updateImportStatus(
    kv, 
    namespace, 
    slug, 
    "cancelling", 
    logger,
    "Import cancellation requested"
  );
}

export async function isImportCancelled(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger
): Promise<boolean> {
  const progressResult = await getImportProgress(kv, namespace, slug, logger);
  if (!progressResult.success || !progressResult.data) {
    return false;
  }
  return progressResult.data.status === "cancelling";
}

export async function deleteImportJob(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger
): Promise<Result<void, AppError>> {
  try {
    await kv.delete(importKey(namespace, slug));
    logger.debug('Import job deleted', { namespace, slug });
    return ok(undefined);
  } catch (error) {
    logger.error('Failed to delete import job', error instanceof Error ? error : undefined);
    return err(new AppError("Failed to delete import job", "STORAGE_ERROR", 500));
  }
}

export async function listActiveImports(
  kv: KVNamespace,
  logger: Logger
): Promise<Result<ImportProgress[], AppError>> {
  try {
    const result = await kv.list({ prefix: IMPORT_PREFIX });
    const imports: ImportProgress[] = [];
    
    for (const key of result.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        const progress = JSON.parse(raw) as ImportProgress;
        if (["queued", "cloning", "processing"].includes(progress.status)) {
          imports.push(progress);
        }
      }
    }
    
    return ok(imports);
  } catch (error) {
    logger.error('Failed to list active imports', error instanceof Error ? error : undefined);
    return err(new AppError("Failed to list active imports", "STORAGE_ERROR", 500));
  }
}
