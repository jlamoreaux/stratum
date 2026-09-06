-- Migration 048: name who pays for each cost sample.
--
-- `cost_records` (021, given `project_id` by 025) has recorded what a change
-- consumed since it existed, but never who owes for it. A project name is not a
-- billing subject: names are unique only per-namespace, projects are transferred
-- and deleted, and an aggregate keyed on one cannot be reconciled against an
-- account. These three columns make every new row attributable at the moment
-- the spend is incurred, which is the only moment the payer is known for
-- certain.
--
-- `owner_id`/`owner_type` are NULLABLE, deliberately. Every historical row
-- predates attribution and the mapping needed to backfill it lives in KV (the
-- ProjectEntry's owner), not in D1 — the same reason 025 backfilled no
-- `project_id`. SQL cannot resolve it here, and discarding rows that cannot be
-- attributed would delete the only record of spend that actually happened. So
-- unattributed rows stay, visibly unattributed: a NULL owner is a row nobody
-- can be billed for, which is honest, where an owner guessed from a project
-- name would be a row billed to possibly the wrong account. Live code can also
-- write NULL — `resolveBillingSubject` (src/storage/costs.ts) returns null
-- rather than throwing when a project's owner cannot be named — so this is not
-- a transitional state that later becomes NOT NULL.
--
-- `source` is NOT NULL DEFAULT 'platform' because the backfill is correct by
-- construction, not merely convenient: BYOK does not exist yet, so every row
-- already in this table was spend on the operator's own provider account. The
-- default backfills them in place with the truth. Precedent for both shapes of
-- ALTER: a CHECK on an added column in 037, NOT NULL DEFAULT in 032/034/041.
-- No table rebuild — unlike `kind`, whose closed CHECK would need one to widen.
--
-- The new index sorts by `created_at`, which is safe HERE specifically.
-- `cost_records.created_at` is written exclusively by `recordCosts`
-- (src/storage/costs.ts) as `new Date().toISOString()` — that function holds the
-- only INSERT into this table anywhere in the tree — so every value is ISO 8601
-- with a 'T' separator. The hazard 042/044/047 warn about is a column mixing
-- that format with `datetime('now')`'s space separator, which sorts differently
-- as TEXT (' ' 0x20 < 'T' 0x54) and silently breaks range and ORDER BY
-- comparisons. A single-format column has no such problem, so an owner's usage
-- history can be paged newest-first in SQL rather than in JavaScript.
--
-- ROLLBACK: drop `idx_costs_owner`; leave the three columns in place. SQLite's
-- DROP COLUMN would rewrite the table for no gain, and the columns are inert
-- when unwritten — reads name them explicitly, an absent owner is already the
-- normal historical case, and `source` defaults itself. Code must therefore
-- tolerate the columns being present but never populated. No migration in this
-- repo has been reverted; this records the intent rather than building
-- machinery for it.

-- CHECK'd rather than free text: an owner_type outside this set is unreachable
-- from `resolveBillingSubject`, which maps ProjectEntry's third kind ('agent')
-- onto the user that owns the agent instead of passing it through. A row
-- claiming a type no billing subject can have would aggregate under an account
-- that will never be invoiced.
ALTER TABLE cost_records ADD COLUMN owner_id TEXT;
ALTER TABLE cost_records ADD COLUMN owner_type TEXT CHECK(owner_type IN ('user','org'));
ALTER TABLE cost_records ADD COLUMN source TEXT NOT NULL DEFAULT 'platform'
  CHECK(source IN ('platform','byok'));

-- Covers the owner-scoped read this exists for: `WHERE owner_id = ? ORDER BY
-- created_at DESC`. Rows with a NULL owner are still indexed (SQLite indexes
-- NULLs) but are never selected by that predicate, which is the intent.
CREATE INDEX IF NOT EXISTS idx_costs_owner ON cost_records(owner_id, created_at DESC);
