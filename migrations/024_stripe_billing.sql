CREATE TABLE stripe_billing (
 organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
 customer_id TEXT UNIQUE,
 subscription_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending',
 plan TEXT,
 extra_seats INTEGER NOT NULL DEFAULT 0,
 storage_packs INTEGER NOT NULL DEFAULT 0,
 verified_at TEXT,
 last_error TEXT
);
CREATE TABLE stripe_checkout_attempts (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 selection TEXT NOT NULL,
 session_id TEXT UNIQUE,
 checkout_url TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'creating'
);
