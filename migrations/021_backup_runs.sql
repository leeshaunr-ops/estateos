CREATE TABLE IF NOT EXISTS backup_runs(day TEXT PRIMARY KEY,status TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,storage_key TEXT,error TEXT NOT NULL DEFAULT '');
