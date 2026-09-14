CREATE TABLE paid_signups (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 company TEXT NOT NULL,
 organization_id TEXT NOT NULL UNIQUE,
 selection TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 session_id TEXT UNIQUE,
 checkout_url TEXT,
 access_hash TEXT NOT NULL UNIQUE,
 secrets TEXT NOT NULL,
 invite_hash TEXT UNIQUE,
 email_status TEXT NOT NULL DEFAULT 'pending',
 next_email_at BIGINT NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 accepted_at TEXT
);
