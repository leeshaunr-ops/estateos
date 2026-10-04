# Field inspector logins

A cheaper login for the people who walk the homes. A field inspector runs the visits the office assigns them and
sees nothing else.

## Pricing

- Every plan includes **2 free field inspector logins per included admin/staff user**: 8 on Essentials, 20 on
  Growth, 40 on Professional (`FREE_INSPECTORS_PER_SEAT` and `freeInspectors(plan)` in `stripe-plans.mjs`).
- Beyond that, **$5 per inspector per month** (`ADDONS.inspectors`, 500 cents).
- Inspectors **never** count toward admin/staff seats (`SEAT_ROLE_SQL` only counts `admin` and `employee`).
- Manual (non-Stripe) invoices: `planPrice()` in `subscriptions.mjs` adds $5 per inspector beyond the Essentials
  allowance of 8.

### Stripe add-on (needs a product before extra inspectors can be sold)

Like the other add-ons, the price is found on Stripe **by product + amount** (`stripe-client.mjs`). The product
doesn't exist yet. Until `STRIPE_INSPECTOR_PRODUCT_ID` is set:

- Inviting, accepting, or reactivating an inspector beyond the free allowance is refused with a clear message
  ("Extra field inspector logins ($5 each per month) can't be added yet…").
- Checkout with `extraInspectors > 0` is refused (422).
- `billing/status` reports `inspectorAddon.available = false`.

To turn it on:

1. In Stripe, create the product **"EstateAegis extra field inspector"** with one active recurring price:
   **USD 5.00, monthly (interval 1 month), per unit (licensed, quantity-based)**. No metadata needed.
2. Set `STRIPE_INSPECTOR_PRODUCT_ID=prod_…` on the Render service (live product on production; a test-mode
   product on staging if you want to test it there). Nothing else changes.

Once set, a Stripe subscription item with that product is read as `extraInspectors` (`parseSubscription`), stored in
`stripe_billing.extra_inspectors` and `stripe_subscription_sync.extra_inspectors`, and raises the allowance by that
quantity.

## What an inspector can do

Server side, `inspector.mjs` runs before every other API handler. An inspector request must match
`INSPECTOR_ROUTES`, an explicit allow-list; anything else returns 403
("Field inspector logins can only open their assigned visits…"). A new endpoint is closed to inspectors until it is
added to the list.

| Allowed | Extra rule |
| --- | --- |
| Sign in/out, invitation, password reset, profile, two-step sign-in, notifications | none (own account only) |
| `GET /api/data` | Inspector-only payload: own open visits, those residences' address and room list, own photos |
| Save / mark complete / GPS check-in and check-out | Visit must be assigned to them (404 otherwise) |
| Add photos | Only to their own draft visit at that residence; stored staff-only |
| Read a photo | Only photos on their own open visits |
| Door, gate and alarm codes (read only) | Only on the day of an assigned visit, in the residence's time zone; every view is audited |
| Offline copies of visits | Own open visits only; no earlier reports, family names or report recipients |

Inspectors can't see clients, family members, other residences, work orders, invoices, messages, notes, published
reports or the team list, and other people can't message them. Another company's records always return 404.

A residence becomes visible to an inspector only through a visit (draft or waiting for review) or an active
recurring schedule assigned to them. Once the office publishes the report it drops off their list.

## Office side

- **Team & access → Invite someone → Field inspector (free, no seat).** The allowance is checked when the
  invitation is created, when it's accepted and when a suspended inspector is reactivated.
- The **Field inspectors** panel on Team & access shows the allowance ("3 of 8 field inspector logins in use") and
  each inspector's open visits, with **Assign a visit** (residence, date, checklist).
- An open visit can be moved to an inspector with **Assign to a field inspector** on the visit.
- Recurring inspection schedules can be assigned to an inspector; each generated visit is theirs.
- The inspector gets an in-app notification and an email when a visit is assigned
  (`POST /api/inspectors/assign`, `POST /api/inspectors/reassign`, admin only).
- Completed visits arrive as "Submitted for review" for an admin to publish, as for staff.

## Inspector screens

- **Today**: today's route with "Open today's route in Maps", overdue visits, the next 14 days, and visits waiting
  for office review. Each visit has Open visit, Door & alarm codes (today only) and Directions.
- The visit screen is the normal checklist (rooms, photos, GPS check-in, notes, Mark complete) without
  Delete draft, report recipients or publish.
- Menu: Today, Notifications, My profile.

## Plan panel and Platform owner view

- Billing → Your EstateAegis plan shows "Field inspectors x of y" (free plus extra) and never as seats.
- Platform → each company shows "Field inspectors x of y" and any extra-inspector add-on.

## Database

- `043_field_inspector_role.sqlite.sql` / `.postgres.sql`: `users.role` accepts `inspector`. The migration runner
  now supports engine-specific files (`NNN.sqlite.sql`, `NNN.postgres.sql`); the SQLite file rebuilds `users` with
  foreign keys off and checks `PRAGMA foreign_key_check` before committing.
- `044_inspector_addon.sql`: `extra_inspectors` on `stripe_billing` and `stripe_subscription_sync`.

## Tests

`tests/field-inspector.test.mjs` (SQLite and PGlite): every non-allow-listed route is refused, company isolation,
another inspector's visit, codes outside the visit day, the trimmed data payload, seats unaffected, allowance and
add-on, Stripe parsing. `tests/signed-in-smoke.test.mjs` signs in as an inspector in a real browser.
