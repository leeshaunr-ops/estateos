-- Prospects (Oct 2026): each company's own sales leads, from first contact to a signed quote and a new client family.
-- Portable TEXT/INTEGER columns only, so the same file runs on SQLite and Postgres. Every row carries organization_id
-- and every query filters by it (tenant isolation). Money is stored in minor units (cents).
CREATE TABLE IF NOT EXISTS prospects(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 name TEXT NOT NULL,
 email TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '',
 street_address TEXT NOT NULL DEFAULT '',
 address_line2 TEXT NOT NULL DEFAULT '',
 city TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT '',
 postal_code TEXT NOT NULL DEFAULT '',
 country TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT 'other',
 stage TEXT NOT NULL DEFAULT 'new',
 monthly_value_minor INTEGER,
 next_follow_up TEXT,
 assigned_to TEXT,
 lost_reason TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL DEFAULT '',
 client_id TEXT,
 property_id TEXT,
 won_at TEXT,
 converted_at TEXT,
 converted_by TEXT,
 created_by TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS prospects_org_stage ON prospects(organization_id, stage);
CREATE INDEX IF NOT EXISTS prospects_org_follow_up ON prospects(organization_id, next_follow_up);
CREATE TABLE IF NOT EXISTS prospect_notes(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 prospect_id TEXT NOT NULL REFERENCES prospects(id),
 kind TEXT NOT NULL DEFAULT 'note',
 body TEXT NOT NULL,
 author_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prospect_notes_prospect ON prospect_notes(organization_id, prospect_id, created_at);
CREATE TABLE IF NOT EXISTS prospect_quotes(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 prospect_id TEXT NOT NULL REFERENCES prospects(id),
 plan_name TEXT NOT NULL DEFAULT '',
 frequency TEXT NOT NULL DEFAULT '',
 items TEXT NOT NULL DEFAULT '[]',
 monthly_minor INTEGER NOT NULL DEFAULT 0,
 notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft',
 token_hash TEXT UNIQUE,
 valid_until TEXT,
 sent_at TEXT,
 sent_to TEXT NOT NULL DEFAULT '',
 view_count INTEGER NOT NULL DEFAULT 0,
 viewed_at TEXT,
 accepted_at TEXT,
 accepted_name TEXT NOT NULL DEFAULT '',
 accepted_ip TEXT NOT NULL DEFAULT '',
 accepted_user_agent TEXT NOT NULL DEFAULT '',
 created_by TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS prospect_quotes_prospect ON prospect_quotes(organization_id, prospect_id, created_at);
CREATE TABLE IF NOT EXISTS prospect_settings(
 organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
 form_enabled INTEGER NOT NULL DEFAULT 1,
 form_intro TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prospect_staff(
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 granted_by TEXT,
 granted_at TEXT NOT NULL,
 PRIMARY KEY(organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS prospect_followup_alerts(
 prospect_id TEXT NOT NULL,
 follow_up TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(prospect_id, follow_up)
);
