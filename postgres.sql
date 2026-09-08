CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','employee','client','vendor')),client_id TEXT,vendor_id TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS invitations(token_hash TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),email TEXT NOT NULL,role TEXT NOT NULL,client_id TEXT,vendor_id TEXT,expires_at BIGINT NOT NULL,used_at TEXT);
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS properties(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),client_id TEXT NOT NULL REFERENCES clients(id),name TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',timezone TEXT NOT NULL DEFAULT 'America/New_York',manual TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS property_access(user_id TEXT NOT NULL REFERENCES users(id),property_id TEXT NOT NULL REFERENCES properties(id),PRIMARY KEY(user_id,property_id));
CREATE TABLE IF NOT EXISTS vendors(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,trade TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),name TEXT NOT NULL,category TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',serial TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',warranty TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_orders(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),asset_id TEXT REFERENCES assets(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL DEFAULT 'Normal',due_date TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',vendor_id TEXT REFERENCES vendors(id),created_by TEXT NOT NULL REFERENCES users(id),service_notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,completed_at TEXT,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),created_by TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'new',work_order_id TEXT REFERENCES work_orders(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inspections(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),inspector_id TEXT NOT NULL REFERENCES users(id),inspection_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',answers TEXT NOT NULL DEFAULT '[]',summary TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',internal_notes TEXT NOT NULL DEFAULT '',published_at TEXT,report_snapshot TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),inspection_id TEXT REFERENCES inspections(id),work_order_id TEXT REFERENCES work_orders(id),name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,storage_key TEXT NOT NULL UNIQUE,visibility TEXT NOT NULL DEFAULT 'internal',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shopping_items(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),name TEXT NOT NULL,quantity TEXT NOT NULL DEFAULT '1',category TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS arrivals(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),created_by TEXT NOT NULL REFERENCES users(id),arrival_at TEXT NOT NULL,needs TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'submitted',items TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS maintenance_plans(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),title TEXT NOT NULL,frequency TEXT NOT NULL,next_due TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance_occurrences(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES maintenance_plans(id),due_date TEXT NOT NULL,work_order_id TEXT NOT NULL REFERENCES work_orders(id),UNIQUE(plan_id,due_date));
CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),client_id TEXT NOT NULL REFERENCES clients(id),number TEXT NOT NULL,description TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),due_date TEXT NOT NULL,currency TEXT NOT NULL DEFAULT 'USD',created_at TEXT NOT NULL,UNIQUE(organization_id,number));
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),reference TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES properties(id),body TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,entity_id TEXT,read_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,entity_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL,key TEXT NOT NULL,route TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,key,route));
CREATE INDEX IF NOT EXISTS idx_properties_client ON properties(client_id);
CREATE INDEX IF NOT EXISTS idx_work_property_status ON work_orders(property_id,status);
CREATE INDEX IF NOT EXISTS idx_inspections_property ON inspections(property_id,published_at);
CREATE INDEX IF NOT EXISTS idx_files_property ON files(property_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at);

CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
CREATE OR REPLACE FUNCTION estateos.protect_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='published' AND
    (to_jsonb(NEW) - 'frequency' - 'next_due') IS DISTINCT FROM
    (to_jsonb(OLD) - 'frequency' - 'next_due') THEN
  RAISE EXCEPTION 'Published inspections are immutable';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS protect_published_inspection ON inspections;
CREATE TRIGGER protect_published_inspection BEFORE UPDATE ON inspections FOR EACH ROW EXECUTE FUNCTION estateos.protect_published();
CREATE OR REPLACE FUNCTION estateos.protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit is append only'; END; $$;
DROP TRIGGER IF EXISTS protect_audit_update ON audit;
CREATE TRIGGER protect_audit_update BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION estateos.protect_audit();
