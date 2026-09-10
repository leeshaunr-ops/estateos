CREATE TABLE scheduled_work_types (
 work_id TEXT PRIMARY KEY REFERENCES work_orders(id),
 kind TEXT NOT NULL,
 reference_id TEXT
);
