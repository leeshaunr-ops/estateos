-- Hurricane and storm workflow: storm events, the residences each storm affects, and links from storm visits and
-- repair work orders back to the event. Forward-only and additive; valid in both SQLite (local) and Postgres (Render).
-- Existing inspections and work orders keep storm_event_id NULL, so nothing changes until a storm event is created.
CREATE TABLE IF NOT EXISTS storm_events(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 name TEXT NOT NULL,
 type TEXT NOT NULL DEFAULT 'hurricane',
 status TEXT NOT NULL DEFAULT 'preparing',
 expected_impact_at TEXT,
 prep_deadline_at TEXT,
 post_check_target_at TEXT,
 notes TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL,
 closed_at TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storm_events_org ON storm_events(organization_id,status);
CREATE TABLE IF NOT EXISTS storm_event_residences(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 storm_event_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 prep_status TEXT NOT NULL DEFAULT 'not_started',
 prep_issues INTEGER NOT NULL DEFAULT 0,
 post_status TEXT NOT NULL DEFAULT 'not_started',
 damage_severity TEXT,
 assigned_user_id TEXT,
 pre_inspection_id TEXT,
 post_inspection_id TEXT,
 client_prep_notified_at TEXT,
 client_post_notified_at TEXT,
 internal_notes TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(storm_event_id,property_id)
);
CREATE INDEX IF NOT EXISTS idx_storm_residences_org ON storm_event_residences(organization_id,storm_event_id);
CREATE INDEX IF NOT EXISTS idx_storm_residences_assignee ON storm_event_residences(assigned_user_id,property_id);
ALTER TABLE inspections ADD COLUMN storm_event_id TEXT;
ALTER TABLE work_orders ADD COLUMN storm_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_inspections_storm ON inspections(storm_event_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_storm ON work_orders(storm_event_id);
