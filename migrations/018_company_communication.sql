ALTER TABLE workspace_settings ADD COLUMN logo_data TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN primary_admin_id TEXT REFERENCES users(id);
CREATE TABLE message_threads(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),subject TEXT NOT NULL,kind TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TABLE message_members(thread_id TEXT NOT NULL REFERENCES message_threads(id),user_id TEXT NOT NULL REFERENCES users(id),read_at TEXT,PRIMARY KEY(thread_id,user_id));
CREATE INDEX message_members_user ON message_members(user_id,thread_id);
CREATE TABLE messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES message_threads(id),sender_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX messages_thread_time ON messages(thread_id,created_at);
CREATE TABLE email_outbox(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT REFERENCES users(id),email TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX email_outbox_pending ON email_outbox(status,next_attempt_at);
