ALTER TABLE properties ADD COLUMN account_manager_id TEXT REFERENCES users(id);
