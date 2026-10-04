-- Flight-aware arrival preparation: flights on an arrival (arrival and departure), timed preparation tasks anchored to
-- landing or departure, and the company's flight settings. Forward-only and additive; valid in SQLite and Postgres.
CREATE TABLE IF NOT EXISTS arrival_flights(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 arrival_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 direction TEXT NOT NULL DEFAULT 'arrival',
 airline TEXT NOT NULL,
 flight_number TEXT NOT NULL,
 ident TEXT NOT NULL,
 flight_date TEXT NOT NULL,
 origin TEXT,
 origin_name TEXT,
 destination TEXT,
 destination_name TEXT,
 diverted_to TEXT,
 scheduled_out TEXT,
 estimated_out TEXT,
 actual_out TEXT,
 scheduled_in TEXT,
 estimated_in TEXT,
 actual_in TEXT,
 status TEXT NOT NULL DEFAULT 'scheduled',
 status_text TEXT,
 source TEXT NOT NULL DEFAULT 'manual',
 fa_flight_id TEXT,
 alert_id TEXT,
 provider_error TEXT,
 last_checked_at TEXT,
 notified_eta TEXT,
 notified_status TEXT,
 closedown INTEGER NOT NULL DEFAULT 0,
 closedown_inspection_id TEXT,
 closedown_at TEXT,
 updated_by TEXT,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_arrival_flights_arrival ON arrival_flights(arrival_id);
CREATE INDEX IF NOT EXISTS idx_arrival_flights_org ON arrival_flights(organization_id,status);
CREATE TABLE IF NOT EXISTS arrival_tasks(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 arrival_id TEXT NOT NULL,
 title TEXT NOT NULL,
 anchor TEXT NOT NULL DEFAULT 'landing',
 offset_minutes INTEGER NOT NULL DEFAULT 0,
 due_at TEXT,
 planned_due_at TEXT,
 assignee_user_id TEXT,
 done_at TEXT,
 done_by TEXT,
 sort INTEGER NOT NULL DEFAULT 0,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arrival_tasks_arrival ON arrival_tasks(arrival_id);
CREATE TABLE IF NOT EXISTS flight_settings(
 organization_id TEXT PRIMARY KEY,
 alert_minutes INTEGER NOT NULL DEFAULT 20,
 closedown_delay_minutes INTEGER NOT NULL DEFAULT 60,
 updated_at TEXT NOT NULL
);
