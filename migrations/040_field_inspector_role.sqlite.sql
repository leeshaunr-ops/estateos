-- sqlite: foreign-keys-off
-- Field inspector logins (Oct 2026): allow role 'inspector'. SQLite cannot alter a CHECK constraint, so the users table is
-- rebuilt with the same columns (the documented 12-step procedure; the runner turns foreign keys off for the copy and
-- verifies them before commit). Other tables keep referencing "users" by name.
CREATE TABLE users_new_040(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','employee','client','vendor','inspector')),client_id TEXT,vendor_id TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
INSERT INTO users_new_040(id,organization_id,name,email,password_hash,role,client_id,vendor_id,active,created_at) SELECT id,organization_id,name,email,password_hash,role,client_id,vendor_id,active,created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new_040 RENAME TO users;
