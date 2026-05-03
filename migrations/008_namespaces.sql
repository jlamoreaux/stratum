-- Migration 008: Add namespace support for projects
-- This enables multiple users/orgs to have projects with the same name

-- Add namespace fields to track ownership
ALTER TABLE projects ADD COLUMN namespace TEXT;
ALTER TABLE projects ADD COLUMN slug TEXT;
ALTER TABLE projects ADD COLUMN owner_type TEXT DEFAULT 'user';

-- Create unique index on namespace + slug combination
-- This allows projects with same name in different namespaces
CREATE UNIQUE INDEX idx_projects_namespace_slug ON projects(namespace, slug);

-- Create index for looking up projects by namespace
CREATE INDEX idx_projects_namespace ON projects(namespace);

-- Migration notes:
-- 1. Existing projects will need namespace populated (default to owner username)
-- 2. Slug will be derived from name (URL-safe version)
-- 3. owner_type distinguishes between user/org/agent ownership
