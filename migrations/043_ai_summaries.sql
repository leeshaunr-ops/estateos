-- AI inspection summaries (off unless AI_FEATURES_ENABLED=true on the server AND ai_settings.enabled for the company).
-- Drafts are suggestions only: the summary text on an inspection is still written by the device draft queue and the
-- normal save path. Forward-only and additive; valid in SQLite (local) and Postgres (Render).
CREATE TABLE IF NOT EXISTS ai_settings(
 organization_id TEXT PRIMARY KEY,
 enabled INTEGER NOT NULL DEFAULT 0,
 label_reports INTEGER NOT NULL DEFAULT 0,
 monthly_cap INTEGER,
 platform_cap_override INTEGER,
 updated_by TEXT,
 updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_summary_drafts(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 inspection_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 text TEXT,
 mentioned_items TEXT NOT NULL DEFAULT '[]',
 missing_items TEXT NOT NULL DEFAULT '[]',
 model TEXT,
 prompt_version TEXT,
 input_hash TEXT,
 tokens_in INTEGER NOT NULL DEFAULT 0,
 tokens_out INTEGER NOT NULL DEFAULT 0,
 latency_ms INTEGER,
 error TEXT,
 created_at TEXT NOT NULL,
 used_at TEXT,
 discarded_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_summary_drafts_idem ON ai_summary_drafts(user_id,idempotency_key);
CREATE INDEX IF NOT EXISTS ai_summary_drafts_inspection ON ai_summary_drafts(inspection_id,created_at);
CREATE TABLE IF NOT EXISTS ai_usage_events(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 user_id TEXT,
 inspection_id TEXT,
 draft_id TEXT,
 kind TEXT NOT NULL,
 status TEXT NOT NULL,
 model TEXT,
 tokens_in INTEGER NOT NULL DEFAULT 0,
 tokens_out INTEGER NOT NULL DEFAULT 0,
 latency_ms INTEGER,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_events_user ON ai_usage_events(user_id,kind,created_at);
CREATE INDEX IF NOT EXISTS ai_usage_events_inspection ON ai_usage_events(inspection_id,kind,created_at);
CREATE INDEX IF NOT EXISTS ai_usage_events_org ON ai_usage_events(organization_id,created_at);
CREATE TABLE IF NOT EXISTS ai_usage_monthly(
 organization_id TEXT NOT NULL,
 month TEXT NOT NULL,
 drafts INTEGER NOT NULL DEFAULT 0,
 tokens_in INTEGER NOT NULL DEFAULT 0,
 tokens_out INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,month)
);
ALTER TABLE inspections ADD COLUMN summary_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE inspections ADD COLUMN summary_ai_draft_id TEXT;
ALTER TABLE inspections ADD COLUMN summary_reviewed_by TEXT;
ALTER TABLE inspections ADD COLUMN summary_reviewed_at TEXT;
ALTER TABLE inspections ADD COLUMN summary_reviewed_hash TEXT;
