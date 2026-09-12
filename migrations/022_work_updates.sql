CREATE TABLE work_updates(id TEXT PRIMARY KEY,work_order_id TEXT NOT NULL REFERENCES work_orders(id),author_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX work_updates_work ON work_updates(work_order_id,created_at);
