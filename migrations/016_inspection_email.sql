ALTER TABLE inspections ADD COLUMN report_email TEXT NOT NULL DEFAULT '';
CREATE TABLE inspection_email_delivery(inspection_id TEXT PRIMARY KEY REFERENCES inspections(id),email_status TEXT NOT NULL DEFAULT 'not_requested',email_attempted_at TEXT);
