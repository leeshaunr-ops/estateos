CREATE TABLE staff_profiles (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 details TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE staff_schedules (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 property_id TEXT REFERENCES properties(id),
 title TEXT NOT NULL,
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE work_staff (
 work_id TEXT PRIMARY KEY REFERENCES work_orders(id),
 user_id TEXT REFERENCES users(id),
 schedule_id TEXT REFERENCES staff_schedules(id)
);
CREATE INDEX staff_schedules_user ON staff_schedules(user_id,starts_at);
