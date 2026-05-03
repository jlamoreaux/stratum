-- Add version column for optimistic locking
-- Prevents race conditions during concurrent import progress updates

ALTER TABLE import_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Create index for efficient version-based lookups during updates
CREATE INDEX IF NOT EXISTS idx_import_jobs_version ON import_jobs(id, version);
