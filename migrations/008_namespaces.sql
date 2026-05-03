-- Migration 008: Add namespace support for projects
-- NOTE: Projects are stored in KV, not D1. This migration is kept for tracking
-- but the actual schema changes are handled in the application code.
-- 
-- The namespace support is implemented via the storage/state.ts functions:
-- - Project keys are now: project:{namespace}:{slug}
-- - ProjectEntry type includes: namespace, slug, ownerType
-- - Artifacts repos are named: {namespace}-{slug}

-- This file intentionally left blank as projects use KV storage
