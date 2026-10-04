-- Repeat-angle photo baselines: named photo spots per residence, each with a baseline photo, and every photo taken
-- for a spot (on a visit, or a new baseline) with the baseline that was in effect when it was taken, so
-- before/after comparisons stay the same after the baseline changes.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render).
CREATE TABLE IF NOT EXISTS photo_spots(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 name TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '',
 checklist_key TEXT,
 checklist_label TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '',
 baseline_file_id TEXT,
 baseline_set_at TEXT,
 baseline_set_by TEXT,
 archived_at TEXT,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_photo_spots_property ON photo_spots(property_id);
CREATE INDEX IF NOT EXISTS idx_photo_spots_org ON photo_spots(organization_id);
CREATE TABLE IF NOT EXISTS photo_spot_shots(
 file_id TEXT PRIMARY KEY,
 spot_id TEXT NOT NULL,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 inspection_id TEXT,
 baseline_file_id TEXT,
 kind TEXT NOT NULL DEFAULT 'visit',
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photo_spot_shots_spot ON photo_spot_shots(spot_id);
CREATE INDEX IF NOT EXISTS idx_photo_spot_shots_inspection ON photo_spot_shots(inspection_id);
