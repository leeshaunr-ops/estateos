CREATE TABLE IF NOT EXISTS checklist_templates (
 id TEXT PRIMARY KEY,
 organization_id TEXT REFERENCES organizations(id),
 name TEXT NOT NULL,
 visit_type TEXT NOT NULL DEFAULT 'routine',
 description TEXT NOT NULL DEFAULT '',
 is_system INTEGER NOT NULL DEFAULT 0,
 is_default INTEGER NOT NULL DEFAULT 0,
 archived_at TEXT,
 created_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_template_versions (
 id TEXT PRIMARY KEY,
 template_id TEXT NOT NULL REFERENCES checklist_templates(id),
 version INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft',
 published_at TEXT,
 published_by TEXT REFERENCES users(id),
 changelog TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 UNIQUE(template_id,version)
);
CREATE TABLE IF NOT EXISTS checklist_template_items (
 id TEXT PRIMARY KEY,
 template_version_id TEXT NOT NULL REFERENCES checklist_template_versions(id),
 section TEXT NOT NULL,
 label TEXT NOT NULL,
 help_text TEXT NOT NULL DEFAULT '',
 response_type TEXT NOT NULL DEFAULT 'pass_fail_na',
 options TEXT NOT NULL DEFAULT '[]',
 required INTEGER NOT NULL DEFAULT 0,
 photo_rule TEXT NOT NULL DEFAULT 'optional',
 scope TEXT NOT NULL DEFAULT 'property',
 room_types TEXT NOT NULL DEFAULT '[]',
 sort_order INTEGER NOT NULL DEFAULT 0,
 stable_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS property_checklist_settings (
 property_id TEXT NOT NULL REFERENCES properties(id),
 visit_type TEXT NOT NULL,
 template_id TEXT REFERENCES checklist_templates(id),
 added_items TEXT NOT NULL DEFAULT '[]',
 hidden_item_keys TEXT NOT NULL DEFAULT '[]',
 updated_by TEXT REFERENCES users(id),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(property_id,visit_type)
);
ALTER TABLE inspections ADD COLUMN template_id TEXT;
ALTER TABLE inspections ADD COLUMN template_version INTEGER;
ALTER TABLE inspections ADD COLUMN visit_type TEXT NOT NULL DEFAULT 'routine';
ALTER TABLE files ADD COLUMN answer_key TEXT;
CREATE INDEX IF NOT EXISTS idx_checklist_templates_org ON checklist_templates(organization_id,visit_type,archived_at);
CREATE INDEX IF NOT EXISTS idx_checklist_items_version ON checklist_template_items(template_version_id,sort_order);
CREATE INDEX IF NOT EXISTS idx_property_checklist_settings ON property_checklist_settings(property_id,visit_type);
