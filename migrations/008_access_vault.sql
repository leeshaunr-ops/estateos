CREATE TABLE IF NOT EXISTS property_vault (
 property_id TEXT PRIMARY KEY REFERENCES properties(id),
 encrypted_details TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
