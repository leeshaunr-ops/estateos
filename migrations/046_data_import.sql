-- Data import (Oct 2026): one row per import a company admin runs, the records it created or updated (so Undo can
-- remove exactly what it created for 7 days), and read-only visit history brought over from a previous system.
CREATE TABLE IF NOT EXISTS import_batches(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 data_type TEXT NOT NULL,
 file_name TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'completed',
 created_count INTEGER NOT NULL DEFAULT 0,
 updated_count INTEGER NOT NULL DEFAULT 0,
 skipped_count INTEGER NOT NULL DEFAULT 0,
 summary TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL,
 undo_until TEXT NOT NULL,
 undone_at TEXT,
 undone_by TEXT
);
CREATE INDEX IF NOT EXISTS import_batches_org ON import_batches(organization_id, created_at);
CREATE TABLE IF NOT EXISTS import_records(
 batch_id TEXT NOT NULL REFERENCES import_batches(id),
 organization_id TEXT NOT NULL,
 entity_type TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 action TEXT NOT NULL,
 parent_id TEXT,
 PRIMARY KEY(batch_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS import_records_entity ON import_records(organization_id, entity_type, entity_id);
CREATE TABLE IF NOT EXISTS imported_visits(
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 property_id TEXT NOT NULL REFERENCES properties(id),
 batch_id TEXT NOT NULL REFERENCES import_batches(id),
 visit_date TEXT NOT NULL,
 inspector_name TEXT NOT NULL DEFAULT '',
 visit_type TEXT NOT NULL DEFAULT '',
 outcome TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imported_visits_property ON imported_visits(organization_id, property_id, visit_date);
