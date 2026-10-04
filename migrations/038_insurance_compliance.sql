-- Insurance and vacancy compliance: one insurance profile per residence, manual owner arrived/left marks, expiring
-- certificate share links (stored hashed) with a view log, and a once-per-window alert ledger.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render). Nothing changes for a residence until
-- an admin adds its insurance profile.
CREATE TABLE IF NOT EXISTS insurance_policies(
 property_id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 carrier TEXT NOT NULL DEFAULT '',
 policy_number TEXT NOT NULL DEFAULT '',
 renewal_date TEXT,
 broker_name TEXT NOT NULL DEFAULT '',
 broker_email TEXT NOT NULL DEFAULT '',
 broker_phone TEXT NOT NULL DEFAULT '',
 inspect_every_days INTEGER,
 max_vacancy_days INTEGER,
 warn_days INTEGER NOT NULL DEFAULT 3,
 devices TEXT NOT NULL DEFAULT '[]',
 notes TEXT NOT NULL DEFAULT '',
 client_share INTEGER NOT NULL DEFAULT 0,
 rule_started_at TEXT,
 created_by TEXT,
 updated_by TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_org ON insurance_policies(organization_id);
CREATE TABLE IF NOT EXISTS occupancy_events(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 state TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 created_by TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occupancy_events_property ON occupancy_events(property_id,occurred_at);
CREATE TABLE IF NOT EXISTS insurance_share_links(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 label TEXT NOT NULL DEFAULT '',
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 revoked_by TEXT,
 view_count INTEGER NOT NULL DEFAULT 0,
 last_viewed_at TEXT,
 created_by TEXT NOT NULL,
 created_by_role TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insurance_share_links_property ON insurance_share_links(property_id,created_at);
CREATE TABLE IF NOT EXISTS insurance_share_views(
 id TEXT PRIMARY KEY,
 link_id TEXT NOT NULL,
 organization_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 viewed_at TEXT NOT NULL,
 ip_hash TEXT NOT NULL DEFAULT '',
 user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_insurance_share_views_link ON insurance_share_views(link_id,viewed_at);
CREATE TABLE IF NOT EXISTS insurance_alerts(
 organization_id TEXT NOT NULL,
 property_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 window_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(property_id,kind,window_key)
);
