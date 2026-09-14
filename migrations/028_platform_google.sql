CREATE TABLE platform_oauth_states(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at BIGINT NOT NULL);
CREATE TABLE platform_connections(provider TEXT PRIMARY KEY,secrets TEXT NOT NULL,updated_at TEXT NOT NULL);
