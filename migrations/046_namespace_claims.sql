-- Migration 046: Namespace claims.
--
-- One row per project ever created under a personal namespace, written to D1
-- before the project's KV entry. Project records live in KV, whose listings
-- are only eventually consistent, so a username change cannot learn from KV
-- alone whether a project exists yet. D1 is strongly consistent: the rename
-- refuses inside its own UPDATE when a claim exists, and creation writes its
-- claim before the KV entry, so neither operation can miss the other.
--
-- Rows outlive their projects. A username is fixed once its first project
-- exists, deleted or not, so an old namespace's URLs never resolve to someone
-- else; only a project withdrawn during creation releases its claim.
--
-- Timestamps are ISO 8601 strings written by the application, as in 042/044.
CREATE TABLE IF NOT EXISTS namespace_claims (
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, slug)
);

CREATE INDEX IF NOT EXISTS idx_namespace_claims_owner ON namespace_claims(owner_id);
