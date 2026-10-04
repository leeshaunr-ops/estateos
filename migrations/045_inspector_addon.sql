-- Extra field inspector add-on ($5/month each beyond the plan's free allowance): quantities from the Stripe subscription.
ALTER TABLE stripe_billing ADD COLUMN extra_inspectors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stripe_subscription_sync ADD COLUMN extra_inspectors INTEGER NOT NULL DEFAULT 0;
