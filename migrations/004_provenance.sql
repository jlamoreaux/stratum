CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  project TEXT NOT NULL,
  workspace TEXT NOT NULL,
  change_id TEXT NOT NULL REFERENCES changes(id),
  agent_id TEXT REFERENCES agents(id),
  eval_score REAL,
  merged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_provenance_project ON provenance(project);
CREATE INDEX IF NOT EXISTS idx_provenance_change ON provenance(change_id);
