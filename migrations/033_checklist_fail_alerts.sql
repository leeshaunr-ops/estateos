-- Checklist "Alert the office on fail": one alert per completed inspection with failed alert items.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render). Existing rows keep their defaults.
ALTER TABLE notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE notifications ADD COLUMN body TEXT NOT NULL DEFAULT '';
ALTER TABLE email_outbox ADD COLUMN html TEXT;
CREATE TABLE IF NOT EXISTS inspection_fail_alerts(inspection_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,property_id TEXT NOT NULL,source TEXT NOT NULL,items TEXT NOT NULL DEFAULT '[]',details TEXT NOT NULL DEFAULT '{}',recipient_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inspection_fail_alerts_org ON inspection_fail_alerts(organization_id,created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id,read_at);
