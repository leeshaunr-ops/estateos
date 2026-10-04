# Plan user limits (Oct 4 2026)

| Plan | Price (launch / regular) | Active residences | Admin/staff users | Storage |
|---|---|---|---|---|
| Essentials | $59 / $79 | 50 | 4 (was 2) | 10 GB |
| Growth | $109 / $129 | 150 | 10 (was 5) | 30 GB |
| Professional | $179 / $199 | 300 | 20 (was 10) | 50 GB |

Extra admin/staff users: $15 each per month. Extra storage: $5 per 20 GB per month.
Client and vendor logins are unlimited on every plan and never use a seat.

## How limits are applied
- `stripe-plans.mjs` is the only catalog. `stripe_billing` stores the plan key and add-on quantities, never limits,
  so every existing subscriber gets the new allowances on the next request. No data migration is needed.
- Seats = active users with role `admin` or `employee` (`SEAT_ROLES`). Checked when an admin/staff invitation is
  accepted, when staff are created from the Staff screen, and (new) when a suspended admin/staff account is reactivated.
  Client and vendor invitations, acceptance and reactivation never check seats.
- Stored checkout selections (`paid_signups.selection`, `stripe_checkout_attempts.selection`) are compared on plan,
  add-on quantities and price only (`sameSelection`), so checkouts started before a limit change still verify.
- Stripe: products and prices are unchanged (same product IDs, same amounts). Limits are not read from Stripe metadata.

## Where limits appear
Pricing page (`public/signup.html`, served at `/pricing` and `/signup`), homepage pricing cards and FAQ
(`public/marketing.html`), FAQ page (`public/faq.html`), signup calculator (`public/signup.js`), paid-signup invitation
email (`paid-signup.mjs`), capacity error messages (`stripe-billing.mjs`), manual invoice pricing (`subscriptions.mjs`),
and the in-app Billing page plan panel (`public/plan-panel.js`). The overview PDF, tutorial captions and JSON-LD
do not state user limits.
