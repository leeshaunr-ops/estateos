-- Offline mobile inspections: replay-safe writes, photo capture times and the `submitted` status.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render). Existing rows keep NULL / default values.
CREATE TABLE IF NOT EXISTS idempotency_keys(organization_id TEXT NOT NULL,key TEXT NOT NULL,endpoint TEXT NOT NULL,user_id TEXT NOT NULL,request_hash TEXT NOT NULL,status INTEGER NOT NULL DEFAULT 0,response TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,PRIMARY KEY(organization_id,key));
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);
ALTER TABLE files ADD COLUMN client_op_id TEXT;
ALTER TABLE files ADD COLUMN captured_at TEXT;
ALTER TABLE files ADD COLUMN received_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_client_op ON files(created_by,client_op_id);
ALTER TABLE inspections ADD COLUMN submitted_at TEXT;
ALTER TABLE inspections ADD COLUMN submitted_by TEXT;
