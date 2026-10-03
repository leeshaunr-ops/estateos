-- GPS and timestamp proof of visit (per-company feature flag, default off) and residence/company time zones.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render). Existing rows keep NULL / default
-- values, so with the flag off every screen and report behaves exactly as before.
ALTER TABLE workspace_settings ADD COLUMN visit_verification_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_settings ADD COLUMN require_check_in_to_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_settings ADD COLUMN geofence_radius_m INTEGER NOT NULL DEFAULT 150;
ALTER TABLE workspace_settings ADD COLUMN show_verification_on_pdf INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspace_settings ADD COLUMN capture_photo_location INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspace_settings ADD COLUMN timezone TEXT;
-- properties.timezone is NOT NULL DEFAULT 'America/New_York'; timezone_source marks a zone an admin (or geocoding)
-- actually chose. NULL means "use the company time zone".
ALTER TABLE properties ADD COLUMN latitude DOUBLE PRECISION;
ALTER TABLE properties ADD COLUMN longitude DOUBLE PRECISION;
ALTER TABLE properties ADD COLUMN geocoded_at TEXT;
ALTER TABLE properties ADD COLUMN geocode_source TEXT;
ALTER TABLE properties ADD COLUMN geocoded_address TEXT;
ALTER TABLE properties ADD COLUMN geofence_radius_m INTEGER;
ALTER TABLE properties ADD COLUMN timezone_source TEXT;
CREATE TABLE IF NOT EXISTS inspection_visits(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 inspection_id TEXT NOT NULL UNIQUE,
 property_id TEXT NOT NULL,
 check_in_user_id TEXT,
 check_in_server_at TEXT,
 check_in_device_at TEXT,
 check_in_lat DOUBLE PRECISION,
 check_in_lon DOUBLE PRECISION,
 check_in_accuracy_m DOUBLE PRECISION,
 check_in_distance_m DOUBLE PRECISION,
 check_in_source TEXT,
 check_in_offline INTEGER NOT NULL DEFAULT 0,
 check_in_note TEXT,
 check_out_user_id TEXT,
 check_out_server_at TEXT,
 check_out_device_at TEXT,
 check_out_lat DOUBLE PRECISION,
 check_out_lon DOUBLE PRECISION,
 check_out_accuracy_m DOUBLE PRECISION,
 check_out_distance_m DOUBLE PRECISION,
 check_out_source TEXT,
 check_out_offline INTEGER NOT NULL DEFAULT 0,
 check_out_note TEXT,
 check_out_auto INTEGER NOT NULL DEFAULT 0,
 duration_seconds INTEGER,
 radius_m INTEGER,
 verification_status TEXT NOT NULL DEFAULT 'pending',
 clock_skew INTEGER NOT NULL DEFAULT 0,
 override_by TEXT,
 override_at TEXT,
 override_reason TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inspection_visits_org ON inspection_visits(organization_id,verification_status);
ALTER TABLE files ADD COLUMN capture_lat DOUBLE PRECISION;
ALTER TABLE files ADD COLUMN capture_lon DOUBLE PRECISION;
ALTER TABLE files ADD COLUMN capture_accuracy_m DOUBLE PRECISION;
ALTER TABLE files ADD COLUMN capture_source TEXT;
ALTER TABLE inspections ADD COLUMN report_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inspections_report_number ON inspections(property_id,report_number);
