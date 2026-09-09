CREATE TABLE IF NOT EXISTS workspace_settings (
 organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 support_email TEXT NOT NULL DEFAULT ''
);
INSERT INTO workspace_settings(organization_id) SELECT id FROM organizations WHERE id NOT IN (SELECT organization_id FROM workspace_settings);
CREATE TABLE IF NOT EXISTS workspace_invites (
 token_hash TEXT PRIMARY KEY,
 company TEXT NOT NULL,
 email TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 expires_at BIGINT NOT NULL,
 used_at TEXT
);
