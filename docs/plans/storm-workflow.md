# Plan: Hurricane and storm workflow

Roadmap #4. One place to run a storm: create a **storm event**, pick the affected residences, bulk-create
pre-storm and post-storm visits from the storm checklists, assign staff, track every home on a live **status board**,
notify client families in bulk, and download an **insurance-ready storm report** per residence.

## What exists (verified in the repo)

- **Server:** one Node `http` server (`server.mjs`) with feature modules (`createX({get,all,run,...})` returning
  `handle(req,res,url,user)`), dispatched in `api()`. JSON only; non-GET requires same Origin + JSON.
- **Database:** `database.mjs` runs `schema.sql`/`postgres.sql` then every `migrations/*.sql` in order. Each migration is
  one file valid in **both** SQLite and Postgres (PGlite in tests). Company scope column is `organization_id`.
- **Roles / access:** `roles(user,...)`, `property(user,id,op)` (admin all; employee = Residence Manager
  (`account_manager_id`); client = own family, read only; vendor = assigned jobs), `entity()` for rows with
  `property_id`.
- **Inspections:** `draft → submitted (field tech) → published (admin)`, optimistic `version`, `visit_type`
  (`pre_storm` = "Hurricane prep", `post_storm` = "Post-storm" already exist), checklist snapshot from published
  templates (`visit-checklists.mjs`), answers Pass/Monitor/Fail/N-A (`public/inspection-checklist.js`).
- **Storm checklists:** "Hurricane prep" and "Post-storm" starter items exist (`checklist-templates.mjs`
  `PRESET_ITEMS.pre_storm/post_storm`).
- **Offline:** PWA + IndexedDB outbox replays `inspections`, `inspections/save`, `inspections/submit`, `files` with
  `Idempotency-Key` (`offline-inspections.mjs`). `/api/offline/visits` scopes with `property()`.
- **Visit verification (GPS):** `visit-verification.mjs` (`reportForPdf` gives the verification box), residence time
  zone helpers (`EAVisit.effectiveTimezone/formatTime`), photo `captured_at`/`received_at`, EXIF GPS stripped on upload.
- **PDF:** hand-written PDF writer in `pdf.mjs` (Helvetica, WinAnsi, JPEG photos). Legacy PDF has a sha256 golden test.
- **Email:** `email_outbox` (+ optional `html`) drained to Resend by `communications.drain()`; the admin
  **Email activity** page lists `email_outbox`. In-app notifications: `notifications` table.
- **Front end:** vanilla JS `public/live.js` (template strings, `btn/input/select/dialog/esc`), extra classic-script
  modules (`proactive.js`, `visit-card.js`) hook in through global functions and `typeof fn==='function'` checks.

## Files

- `migrations/036_storm_workflow.sql` (new)
- `storm-core.mjs` (new, pure rules shared by server + tests), `storm.mjs` (new, API), `storm-pdf.mjs` (new, PDFs)
- `server.mjs`: wire module, storm-assignee access in `property()`, status hooks on save/submit/publish, static files
- `operations.mjs`: work order from a storm finding carries `storm_event_id`
- `offline-inspections.mjs`: `storm_event_id` in offline visit rows
- `public/storm.js`, `public/storm.css` (new), `public/live.js` (nav, view, action, load, banners, route preset),
  `public/proactive.js` (client home card), `public/live.html`, `public/sw.js`, `package.json` (check)
- `tests/storm.test.mjs` (new), `docs/features/storm-workflow.md` (new)

## Schema (036, additive only)

- `storm_events`: `id, organization_id, name, type (hurricane|tropical_storm|freeze|flood|wildfire|other),
  status (preparing|active|recovery|closed), expected_impact_at, prep_deadline_at, post_check_target_at, notes,
  created_by, closed_at, created_at, updated_at, version`.
- `storm_event_residences`: `id, organization_id, storm_event_id, property_id (UNIQUE per event), prep_status,
  prep_issues, post_status, damage_severity, assigned_user_id, pre_inspection_id, post_inspection_id,
  client_prep_notified_at, client_post_notified_at, internal_notes, created_at, updated_at`.
- `inspections.storm_event_id`, `work_orders.storm_event_id` (NULL for everything that exists today).

## API (company-scoped)

| Endpoint | Who |
|---|---|
| `GET /api/storm` (events + board rows shaped by role; client: plain-language status cards) | admin, employee (accessible residences), client (own residences) |
| `GET /api/storm-events/:id` | admin, employee |
| `POST /api/storm-events` / `POST /api/storm-events/:id` (create / edit, status changes, close) | admin |
| `POST /api/storm-events/:id/residences` (`propertyIds` or `filter`: all, city, zip, manager, search) | admin |
| `POST /api/storm-events/:id/residences/remove` | admin |
| `POST /api/storm-events/:id/residences/update` (status, severity, notes; admin also assignee) | admin, employee (accessible) |
| `POST /api/storm-events/:id/visits` (`phase`, `date`, `assignment` residence_manager/round_robin/user, `residenceIds?`, `templateId?`) idempotent | admin |
| `POST /api/storm-events/:id/recovery` (event → recovery) | admin |
| `POST /api/storm-events/:id/notify` (`template` prep_planned/secured/post_check_complete, `residenceIds`, `preview`) | admin |
| `GET /api/storm-events/:id/export.csv` | admin, employee |
| `GET /api/storm-events/:id/residences/:rid/report.pdf` | admin, employee, client (own) |
| `GET /api/storm-events/:id/summary.pdf` | admin |

Automatic status changes (hooks in `inspections/save`, `submit`, `publish`, also reached by offline replays):
first recorded answer → `in_progress`; pre-storm submit/publish → `secured` (`prep_issues` when any Fail/Attention);
post-storm publish → `no_damage` (no Monitor/Fail) or `damage_found` with a suggested severity
(Monitor only → minor, 1–2 Fail → moderate, 3+ → major; editable).

If the company has no published Hurricane prep / Post-storm checklist, bulk scheduling publishes one from the existing
starter items (named "Hurricane prep" / "Post-storm", reported in the result) so every storm visit is a normal
template visit.

## UI

Sidebar **Storm events** (Daily Operations, admin + staff); red Overview banner while an event is preparing/active;
3-step full-page wizard (details → residences with filters, select-all and count → optional pre-storm visits);
status board (counters, progress bar, table + column view, filters, search, bulk assign / create visits / notify /
status / add to Daily route, 30 s refresh, phone card list with large status buttons); recovery switch; linked work
orders; storm banner on storm visits; client home + residence card with plain-language status and report link.

## PDF

`storm-pdf.mjs`: branded header like the inspection PDF, "Storm Report — {event}", timeline (pre visit, expected
impact, post visit, visit verification when the visit was published with it), pre-storm checklist + timestamped
photos, post-storm damage list with severity, before/after pairs, work orders, client notes and summaries, disclaimer
footer and page numbers, times in the residence zone with abbreviation. Only published storm visits are used. Never
internal notes, help text or access codes. Internal summary PDF: one table row per residence.

## Permissions

| Action | admin | employee | client | vendor |
|---|---|---|---|---|
| Create/edit/close event, select residences | ✓ | ✗ | ✗ | ✗ |
| Bulk-create visits, bulk notify | ✓ | ✗ | ✗ | ✗ |
| View status board / CSV | ✓ | ✓ (accessible residences) | ✗ | ✗ |
| Update status / notes | ✓ | ✓ (accessible) | ✗ | ✗ |
| Do storm visits | ✓ | ✓ | ✗ | ✗ |
| Publish storm visits | ✓ | ✗ (submit) | ✗ | ✗ |
| Own residence storm status + report | ✓ | ✓ | ✓ | ✗ |

Employees assigned to a residence for an open (not closed) storm event can operate that residence like its
Residence Manager until the event is closed, so round-robin assignment works.

## Tests (`tests/storm.test.mjs`, SQLite + PGlite)

Unit: status rules, severity, before/after matching, filter selection, CSV escaping, client wording.
API: idempotent bulk create, residence-manager and round-robin assignment, notify preview/skip/Email activity/notified
at, role matrix (employee/client/vendor), cross-company 404s, CSV columns, offline (Idempotency-Key) completion.
PDF text: sections, no internal notes, zone abbreviation, disclaimer; summary PDF.
E2E: Playwright screenshots (desktop + phone) of bulk scheduling, board, storm visit, report PDF.

## Rollout

No flag needed: with no storm event nothing changes (existing tests prove routes, inspections, PDFs unchanged).
Phase 2 (NWS alerts), residence tags/county filters and per-photo item tagging are follow-ups.
