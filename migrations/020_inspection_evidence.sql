CREATE TABLE IF NOT EXISTS work_evidence_sources(file_id TEXT PRIMARY KEY REFERENCES files(id),inspection_id TEXT NOT NULL REFERENCES inspections(id));
