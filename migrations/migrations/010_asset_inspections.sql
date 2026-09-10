CREATE TABLE IF NOT EXISTS asset_inspections (
 id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL REFERENCES assets(id),
 inspector_id TEXT NOT NULL REFERENCES users(id),
 inspection_date TEXT NOT NULL,
 answers TEXT NOT NULL DEFAULT '[]',
 notes TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_inspections_asset ON asset_inspections(asset_id, inspection_date DESC);
