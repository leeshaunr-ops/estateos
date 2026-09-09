CREATE TABLE IF NOT EXISTS user_profiles (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 phone TEXT NOT NULL DEFAULT '',
 preferred_contact TEXT NOT NULL DEFAULT 'Email'
);
