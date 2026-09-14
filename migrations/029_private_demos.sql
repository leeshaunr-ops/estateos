CREATE TABLE demo_invites(token_hash TEXT PRIMARY KEY REFERENCES workspace_invites(token_hash));
CREATE TABLE demo_workspaces(organization_id TEXT PRIMARY KEY REFERENCES organizations(id),admin_id TEXT NOT NULL REFERENCES users(id),expires_at BIGINT NOT NULL,reset_at TEXT NOT NULL);
CREATE TABLE demo_file_cleanup(storage_key TEXT PRIMARY KEY,created_at TEXT NOT NULL);
