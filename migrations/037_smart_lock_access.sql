-- Smart-lock access windows: locks at each residence, temporary door codes tied to visits and work orders, lock events
-- (entries, battery, offline) and the company's lock settings. Forward-only and additive; valid in both SQLite (local)
-- and Postgres (Render). Nothing changes for a company until it adds a lock to a residence.
CREATE TABLE IF NOT EXISTS residence_locks(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 name TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT 'manual',
 device_id TEXT,
 battery_level DOUBLE PRECISION,
 online INTEGER NOT NULL DEFAULT 1,
 offline_since TEXT,
 last_event_at TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_residence_locks_property ON residence_locks(organization_id,property_id,active);
CREATE INDEX IF NOT EXISTS idx_residence_locks_device ON residence_locks(provider,device_id);
CREATE TABLE IF NOT EXISTS lock_access_codes(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 lock_id TEXT NOT NULL,
 source_type TEXT NOT NULL,
 source_id TEXT NOT NULL,
 assignee_user_id TEXT,
 assignee_vendor_id TEXT,
 window_start TEXT NOT NULL,
 window_end TEXT NOT NULL,
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'needs_code',
 code_sealed TEXT,
 code_hint TEXT,
 code_source TEXT,
 provider TEXT NOT NULL DEFAULT 'manual',
 provider_code_id TEXT,
 provider_status TEXT,
 provider_error TEXT,
 provider_deleted_at TEXT,
 revoked_at TEXT,
 revoked_reason TEXT,
 expired_at TEXT,
 removal_work_id TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lock_codes_live ON lock_access_codes(lock_id,source_type,source_id) WHERE status IN ('needs_code','scheduled');
CREATE INDEX IF NOT EXISTS idx_lock_codes_org ON lock_access_codes(organization_id,status,ends_at);
CREATE INDEX IF NOT EXISTS idx_lock_codes_source ON lock_access_codes(source_type,source_id);
CREATE INDEX IF NOT EXISTS idx_lock_codes_provider ON lock_access_codes(provider_code_id);
CREATE TABLE IF NOT EXISTS lock_events(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 lock_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 method TEXT,
 code_id TEXT,
 source_type TEXT,
 source_id TEXT,
 provider_event_id TEXT,
 occurred_at TEXT NOT NULL,
 details TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lock_events_provider ON lock_events(provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lock_events_source ON lock_events(source_type,source_id);
CREATE INDEX IF NOT EXISTS idx_lock_events_lock ON lock_events(organization_id,lock_id,occurred_at);
CREATE TABLE IF NOT EXISTS lock_tasks(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 lock_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 work_order_id TEXT NOT NULL,
 code_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lock_tasks_lock ON lock_tasks(lock_id,kind);
CREATE INDEX IF NOT EXISTS idx_lock_tasks_work ON lock_tasks(work_order_id);
CREATE TABLE IF NOT EXISTS lock_settings(
 organization_id TEXT PRIMARY KEY,
 buffer_minutes INTEGER NOT NULL DEFAULT 30,
 default_start TEXT NOT NULL DEFAULT '08:00',
 default_end TEXT NOT NULL DEFAULT '18:00',
 code_length INTEGER NOT NULL DEFAULT 6,
 auto_create INTEGER NOT NULL DEFAULT 1,
 seam_accounts TEXT NOT NULL DEFAULT '[]',
 seam_webview_id TEXT,
 updated_at TEXT NOT NULL
);
