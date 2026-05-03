-- Import jobs table for strong consistency (moved from KV)
-- Provides real-time status tracking and reliable cancellation

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'cloning', 'processing', 'completed', 'failed', 'cancelled', 'cancelling')),
  source_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  progress_processed_files INTEGER DEFAULT 0,
  progress_total_files INTEGER,
  progress_current_file TEXT,
  progress_bytes_transferred INTEGER,
  progress_total_bytes INTEGER,
  logs TEXT NOT NULL DEFAULT '[]', -- JSON array of log entries
  errors TEXT NOT NULL DEFAULT '[]', -- JSON array of error entries
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER DEFAULT 1 -- Optimistic locking version
);

-- Index for fast lookup by namespace/slug (primary access pattern)
CREATE INDEX IF NOT EXISTS idx_import_jobs_ns_slug ON import_jobs(namespace, slug);

-- Index for listing active imports (queued, cloning, processing, cancelling)
-- Partial index for better performance
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status) 
  WHERE status IN ('queued', 'cloning', 'processing', 'cancelling');

-- Index for cleanup of old completed imports
CREATE INDEX IF NOT EXISTS idx_import_jobs_completed_at ON import_jobs(completed_at) 
  WHERE completed_at IS NOT NULL;

-- Index for project lookups
CREATE INDEX IF NOT EXISTS idx_import_jobs_project_id ON import_jobs(project_id);
