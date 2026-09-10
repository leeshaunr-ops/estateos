ALTER TABLE requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN ('Low','Normal','High','Urgent'));
