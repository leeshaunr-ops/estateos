CREATE TABLE stripe_subscription_sync (
 subscription_id TEXT PRIMARY KEY,
 organization_id TEXT,
 customer_id TEXT,
 status TEXT NOT NULL,
 plan TEXT,
 extra_seats INTEGER NOT NULL DEFAULT 0,
 storage_packs INTEGER NOT NULL DEFAULT 0,
 amount_minor INTEGER,
 currency TEXT NOT NULL DEFAULT 'usd',
 current_period_start TEXT,
 current_period_end TEXT,
 trial_start TEXT,
 trial_end TEXT,
 cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
 canceled_at TEXT,
 ended_at TEXT,
 last_invoice_status TEXT,
 last_payment_failed_at TEXT,
 last_payment_failed_minor INTEGER,
 livemode INTEGER NOT NULL DEFAULT 0,
 source TEXT NOT NULL,
 event_created BIGINT NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE INDEX stripe_subscription_sync_org ON stripe_subscription_sync(organization_id);
CREATE TABLE stripe_webhook_events (
 id TEXT PRIMARY KEY,
 type TEXT NOT NULL,
 subscription_id TEXT,
 organization_id TEXT,
 amount_minor INTEGER,
 event_created BIGINT NOT NULL,
 received_at TEXT NOT NULL
);
CREATE INDEX stripe_webhook_events_type ON stripe_webhook_events(type,event_created);
