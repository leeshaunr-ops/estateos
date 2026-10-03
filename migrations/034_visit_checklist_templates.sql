-- Field visits use published checklist templates: each new visit records the exact published template version it
-- started from and a snapshot of that version's items. Recurring inspection schedules can name a checklist.
-- Forward-only and additive; valid in both SQLite (local) and Postgres (Render). Existing visits keep NULL here and
-- render exactly as before on the built-in checklist.
ALTER TABLE inspections ADD COLUMN template_version_id TEXT;
ALTER TABLE inspections ADD COLUMN checklist_snapshot TEXT;
ALTER TABLE inspection_plans ADD COLUMN template_id TEXT;
CREATE INDEX IF NOT EXISTS idx_inspections_template ON inspections(template_id,template_version);
