CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  github_id TEXT UNIQUE,
  github_username TEXT,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  model TEXT,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  agent_id TEXT REFERENCES agents(id),
  eval_score REAL,
  eval_passed INTEGER,
  eval_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  evaluator_type TEXT NOT NULL,
  score REAL,
  passed INTEGER,
  reason TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project);
CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);
CREATE INDEX IF NOT EXISTS idx_eval_runs_change ON eval_runs(change_id);
