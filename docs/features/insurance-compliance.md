# Insurance and vacancy compliance

Most homeowner policies say that while a home is unoccupied, someone has to check on it every so many days, and some also limit how long it can stay vacant. EstateAegis now stores each residence's policy rule. It tracks visits and owner occupancy against that rule, warns the office before a deadline is missed, and produces a visit history certificate the family or company can send to a broker.

## What it does
- **Insurance profile** (Residence › Home records › Insurance & vacancy rules): carrier, policy number, renewal date, broker or agent (name, email, phone), the unoccupancy rule (*inspect at least every N days while unoccupied*, plus an optional *unoccupied for no more than M days*), a warning window (3 days by default), and a devices checklist: automatic water shut-off, monitored alarm, generator, and other. Each device can be marked required, discount or installed, and can have a photo or document attached. Office notes are never shown to families or on the certificate.
- **Occupancy**: a home counts as occupied from an owner arrival (Arrivals) until a departure visit is completed or the office chooses *Owners left*. *Owners arrived* and *Owners left* can also be marked by hand, back-dated but never in the future.
- **Status per residence**, using the residence's time zone. The clock starts at the latest of the last completed visit, the start of the vacancy, or the date the rule was added. The deadline is that date plus N days, and a visit on the deadline day counts as on time.
  - **OK**: owners are in residence, or a visit is scheduled on or before the deadline (drafts, the next due date of completed visits, and active inspection plans all count).
  - **Due soon**: the deadline, or the vacancy limit, is within the warning window.
  - **At risk**: nothing is scheduled before the deadline.
  - **Breached**: the deadline or the vacancy limit has passed.
  - **Not set up**: no profile has been added yet.
- **Where it shows**: Overview › Needs your attention (breached, at risk, due soon, plus renewals for admins), the residence facts strip (an *Insurance* cell), the residence's *Needs attention here* panel, and a new **Insurance compliance** page under Residences. That page can be sorted by any column and filtered by status. On phones each residence is a card with a coloured status badge, one plain-English line (for example *Visit due by Oct 20 — nothing scheduled*) and only the dates that exist (last visit, visit due by, next scheduled, renewal). Homes without insurance details show an *Add insurance details* button for admins. A short legend explains each status; with a single residence the filters and sort chips are hidden.
- **Alerts** (hourly): bell notifications to admins and the Residence Manager, and email through the normal outbox (demo companies get bell alerts only). A residence gets at most one alert of each kind per deadline window:
  - *pre-breach*: at risk and within the warning window;
  - *breached*;
  - *vacancy limit near*;
  - *vacancy limit passed*;
  - *renewal*: 30 days before the renewal date, with a renewal checklist.
- **Visit history certificate (PDF)**: company branding, the residence, the policyholder, the policy and its rule, and counts of visits and GPS-verified visits. It covers published visits from the last 12 months, with dates and on-site times in the residence's time zone, how each visit was verified, a findings summary and the report summary. It also lists the longest gap between visits, the current status, the devices, and a disclaimer on every page saying it is not an insurance adjuster's assessment.
- **Share links**: a random 256-bit token, stored only as a SHA-256 hash. A link lasts 14 days by default (1–90 allowed) and can be turned off at any time. Every view is counted and audited. `/certificate/<token>` shows only the certificate and a PDF download, without signing in. Revoked or expired links return 410 and an unknown link returns 404. The public endpoint is limited to 60 requests per minute per IP and sends `noindex` and `no-referrer`.

## Permissions
| | Admin | Staff (Residence Manager or assigned) | Family | Vendor |
|---|---|---|---|---|
| See status and profile | yes | yes, their residences | yes, without office notes or proof files | no |
| Edit profile, mark occupancy | yes | no | no | no |
| Download certificate | yes | yes | if the admin turns on *Let the family download the visit history certificate and create share links* | no |
| Create share links | yes | no | if allowed | no |
| Turn off links | any link | no | only links they created | no |

## Code
- `insurance-core.mjs`: the rules (pure functions, unit-tested).
- `insurance.mjs`: API, data decoration, alerts and certificate data.
- `insurance-pdf.mjs`: the certificate PDF.
- `migrations/038_insurance_compliance.sql`.
- `public/insurance.js` / `.css`: the app.
- `public/certificate.html` / `.js` / `.css`: the public share page.
- Tests: `tests/insurance.test.mjs`, plus the signed-in smoke test.
