-- Severe-weather alerts (per-company feature flag weather_settings.enabled, default off): NWS alert cache, grouped
-- company alert records, affected residences, staff notifications, forecast cache, job runs and a portable job lock.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render). Lists are JSON text. With the flag off
-- nothing reads these tables, so every screen and report behaves exactly as before.
ALTER TABLE properties ADD COLUMN nws_supported INTEGER;
ALTER TABLE properties ADD COLUMN nws_state TEXT;
ALTER TABLE properties ADD COLUMN nws_forecast_zone TEXT;
ALTER TABLE properties ADD COLUMN nws_county_zone TEXT;
ALTER TABLE properties ADD COLUMN nws_fire_zone TEXT;
ALTER TABLE properties ADD COLUMN nws_grid_id TEXT;
ALTER TABLE properties ADD COLUMN nws_grid_x INTEGER;
ALTER TABLE properties ADD COLUMN nws_grid_y INTEGER;
ALTER TABLE properties ADD COLUMN nws_station_id TEXT;
ALTER TABLE properties ADD COLUMN nws_points_checked_at TEXT;
ALTER TABLE properties ADD COLUMN nws_points_lat DOUBLE PRECISION;
ALTER TABLE properties ADD COLUMN nws_points_lon DOUBLE PRECISION;
ALTER TABLE properties ADD COLUMN weather_monitoring_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE properties ADD COLUMN weather_threshold_overrides TEXT;
ALTER TABLE inspections ADD COLUMN weather_snapshot TEXT;
ALTER TABLE inspections ADD COLUMN weather_snapshot_overridden INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS weather_settings(
 organization_id TEXT PRIMARY KEY,
 enabled INTEGER NOT NULL DEFAULT 0,
 categories TEXT,
 levels TEXT NOT NULL DEFAULT '["warning","watch"]',
 freeze_threshold_f INTEGER NOT NULL DEFAULT 28,
 freeze_notice_f INTEGER,
 heat_threshold_f INTEGER NOT NULL DEFAULT 105,
 heavy_rain_in DOUBLE PRECISION NOT NULL DEFAULT 2.0,
 high_wind_gust_mph INTEGER NOT NULL DEFAULT 50,
 forecast_lookahead_days INTEGER NOT NULL DEFAULT 3,
 notify_admins INTEGER NOT NULL DEFAULT 1,
 notify_residence_managers INTEGER NOT NULL DEFAULT 1,
 notify_user_ids TEXT NOT NULL DEFAULT '[]',
 digest_time TEXT NOT NULL DEFAULT '06:30',
 watch_immediate INTEGER NOT NULL DEFAULT 0,
 client_notice TEXT NOT NULL DEFAULT 'off',
 on_reports INTEGER NOT NULL DEFAULT 0,
 storm_prep_lead_hours INTEGER NOT NULL DEFAULT 24,
 last_digest_day TEXT,
 updated_by TEXT,
 updated_at TEXT
);
CREATE TABLE IF NOT EXISTS weather_user_prefs(user_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,email_pref TEXT NOT NULL DEFAULT 'all',updated_at TEXT);
CREATE TABLE IF NOT EXISTS nws_alerts(
 id TEXT PRIMARY KEY,
 event TEXT NOT NULL,
 category TEXT,
 level TEXT,
 status TEXT,
 severity TEXT,
 urgency TEXT,
 certainty TEXT,
 headline TEXT,
 description TEXT,
 instruction TEXT,
 sender_name TEXT,
 area_desc TEXT,
 sent_at TEXT,
 effective_at TEXT,
 onset_at TEXT,
 expires_at TEXT,
 ends_at TEXT,
 message_type TEXT,
 refs TEXT NOT NULL DEFAULT '[]',
 vtec TEXT NOT NULL DEFAULT '[]',
 ugc TEXT NOT NULL DEFAULT '[]',
 geometry TEXT,
 fetched_at TEXT NOT NULL,
 last_active_at TEXT,
 superseded_by TEXT,
 cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nws_alerts_active ON nws_alerts(last_active_at);
CREATE TABLE IF NOT EXISTS weather_alerts(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 source TEXT NOT NULL,
 category TEXT NOT NULL,
 level TEXT NOT NULL,
 event_name TEXT NOT NULL,
 group_key TEXT NOT NULL,
 severity_rank INTEGER NOT NULL DEFAULT 0,
 headline TEXT NOT NULL DEFAULT '',
 onset_at TEXT,
 ends_at TEXT,
 forecast_summary TEXT,
 status TEXT NOT NULL DEFAULT 'active',
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 ended_at TEXT,
 acknowledged_by TEXT,
 acknowledged_at TEXT,
 dismissed_by TEXT,
 dismissed_at TEXT,
 dismiss_reason TEXT,
 storm_event_id TEXT,
 supersedes_alert_id TEXT,
 nws_alert_ids TEXT NOT NULL DEFAULT '[]',
 cancelled_ids TEXT NOT NULL DEFAULT '[]',
 notified_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_org ON weather_alerts(organization_id,status);
CREATE TABLE IF NOT EXISTS weather_alert_residences(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 weather_alert_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 matched_by TEXT NOT NULL,
 forecast_value DOUBLE PRECISION,
 forecast_unit TEXT,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 UNIQUE(weather_alert_id,property_id)
);
CREATE INDEX IF NOT EXISTS idx_weather_alert_residences_org ON weather_alert_residences(organization_id,property_id);
CREATE TABLE IF NOT EXISTS weather_alert_notifications(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 weather_alert_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 channel TEXT NOT NULL DEFAULT 'email',
 kind TEXT NOT NULL,
 sent_at TEXT NOT NULL,
 email_log_id TEXT,
 UNIQUE(weather_alert_id,user_id,channel,kind)
);
CREATE TABLE IF NOT EXISTS forecast_cache(cache_key TEXT PRIMARY KEY,lat_r DOUBLE PRECISION,lon_r DOUBLE PRECISION,provider TEXT NOT NULL,fetched_at TEXT NOT NULL,daily TEXT NOT NULL,hourly TEXT);
CREATE TABLE IF NOT EXISTS weather_job_runs(id TEXT PRIMARY KEY,job TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL DEFAULT 'running',requests INTEGER NOT NULL DEFAULT 0,alerts_seen INTEGER NOT NULL DEFAULT 0,errors TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS idx_weather_job_runs_job ON weather_job_runs(job,started_at);
CREATE TABLE IF NOT EXISTS job_locks(job TEXT PRIMARY KEY,owner TEXT,locked_until TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS feature_pilots(organization_id TEXT NOT NULL,feature TEXT NOT NULL,applied_at TEXT NOT NULL,PRIMARY KEY(organization_id,feature));
