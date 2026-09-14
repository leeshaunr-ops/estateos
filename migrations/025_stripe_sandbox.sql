CREATE TABLE stripe_sandbox_attempts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 session_id TEXT UNIQUE,
 checkout_url TEXT,
 status TEXT NOT NULL DEFAULT 'creating',
 created_at TEXT NOT NULL,
 verified_at TEXT
);
