# Platform owner monitoring (read-only)

**Who sees it:** only the platform owner, meaning the admin whose user id matches `ESTATEOS_PLATFORM_OWNER_ID`. Everyone else gets a 404 (a 401 when signed out). That includes admins of other companies, other admins in the owner's own company, staff, clients and vendors. The menu item "Platform" (page `#/platform-owner`) only appears for the owner.

**What it shows:**
- Every signed-up company with its plan, signup date, trial status and trial end date (in ET), Stripe subscription status, usage against limits (residences, admin/staff users, storage) and add-ons.
- MRR (active subscriptions only), the value of trials if they convert, and counts of trials, paid, past due and canceled subscriptions.
- Lists of recent signups, trials ending within 7 days, failed payments, cancellations and `/demo` workspace requests (7-day demo, no card).

**Data sources:**
- `organizations`, `stripe_billing`, usage tables and `demo_requests`/`demo_workspaces`.
- `stripe_subscription_sync`, which is filled by the Stripe webhook and by the backfill.

## Stripe webhook
- Endpoint: `POST /api/stripe/webhook`. The signature is verified with `STRIPE_WEBHOOK_SECRET`. If that variable is unset the endpoint returns 503 and no events are stored.
- Events handled:
  - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`
  - `invoice.payment_failed`, `invoice.paid`, `invoice.payment_succeeded`
- Duplicate events are ignored by event id. Older events never overwrite newer data.
- Live keys accept live events only. Test keys accept test-mode events only.
- The webhook only records data. Access changes still go through the existing billing reconcile, which runs only when live billing is enabled.

**Setup:** in Stripe, go to Developers → Webhooks → Add endpoint `https://<host>/api/stripe/webhook` with the events above. Then set the signing secret as `STRIPE_WEBHOOK_SECRET` on the Render service.

## Backfill
- The backfill runs 25 s after startup. You can also run it from the "Sync from Stripe" button (`POST /api/owner/backfill`).
- It copies existing `stripe_billing` rows. When live billing is configured, it also refreshes each subscription from the Stripe API.
- Rows written by the webhook are never overwritten by older data.

## Trial fix (same PR)
- Checkout uses a 30-day trial. A trialing subscription has `payment_status: no_payment_required` and `status: trialing`.
- Before this PR, verification required `paid` + `active`.
- Now both `paid`/`no_payment_required` and `active`/`trialing` count as good standing. This is defined in `GOOD_STANDING` and `CHECKOUT_SETTLED` in `stripe-plans.mjs`.
