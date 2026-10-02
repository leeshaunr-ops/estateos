# Offline mobile inspections — plan

Branch: `offline-mobile-inspections` (from `stability-baseline`). PR into `stability-baseline` only. Requirements: Shaun's brief plus the
"Task 1: Offline-capable mobile inspections (PWA)" spec (`/workspace/ea-audit/EstateAegis_Codex_Software_Tasks.md` lines 21–196).
The spec was written without repo access, so the real code wins where they differ (see "Spec vs code").

## 1. How things work today (verified in code)

**Server.** One plain `node:http` server, `server.mjs` (no framework). `api()` is a long `if/else` router on `url.pathname`. Feature modules
(`checklist-templates-api.mjs`, `operations.mjs`, `staff.mjs` …) get injected helpers (`get/all/run/transaction`, `fail`, `json`, `body`, `roles`,
`property`, `entity`, `audit`). Every non-GET request must have a same-origin `Origin` header and `Content-Type: application/json`, so uploads are
base64 JSON (15 MB body cap, 10 MB file cap).

**Database.** `database.mjs`: Render/remote Postgres when `DATABASE_URL` is set (schema `estateos`, `postgres.sql` + `migrations/*.sql`
applied in name order inside one transaction, recorded in `schema_migrations`). Local dev with no `DATABASE_URL` uses `node:sqlite`
(`schema.sql` + the same migrations); tests can use PGlite (`NODE_ENV=test ESTATEOS_TEST_POSTGRES_DIR=…`). So **every migration must be valid in
both SQLite and Postgres**. `DATABASE_URL` also forces Supabase file storage, so a "real local Postgres" can't be run without Supabase; I'll verify
the Postgres path with PGlite (real Postgres compiled to WASM: same migration runner, same SQL, same triggers) and SQLite.

**Inspections.** Table `inspections(id, property_id, inspector_id, inspection_date, status 'draft'|'published', answers JSON text, summary, notes,
internal_notes, published_at, report_snapshot, version, frequency, next_due, report_email, template_id, template_version, visit_type)`.
- `POST /api/inspections` (admin/employee) creates a draft with a server UUID and the built-in `inspection-template.json` answers (44 items).
- `POST /api/inspections/save` saves the **whole** draft (answers + summary + notes + internal notes) with optimistic `version` (409 on mismatch).
  `validateAnswers()` requires every template key, statuses `unchecked|pass|monitor|attention|na`, and the 3 room checks per room.
- `POST /api/inspections/publish` (admin only) needs every item answered + a summary, has its own body `idempotencyKey` table (`idempotency`),
  freezes `report_snapshot`, notifies the family and emails the PDF. A Postgres trigger makes published rows immutable.
- Rooms/spaces are not rows: they live in `properties.room_profile` JSON. The client adds `space-<roomKey>-{condition|readiness|fixtures}` answers
  for each room when the draft is opened; the server validates them.
- Notes are per answer (`note`) plus summary / client notes / internal notes on the inspection.
- Photos: `POST /api/files` `{propertyId, inspectionId, name, base64}` → `files` row (JPEG only for inspections, draft only) + storage (local disk
  or Supabase). Served by `GET /api/files/:id` (no-store). `files.answer_key` exists (migration 021) but is never set. No capture time today.
- **Checklist templates (PRs #23/#24) are not linked to visits yet**: `inspections.template_id/template_version/visit_type` columns exist but
  creation never sets them; every visit uses the built-in JSON. The offline snapshot will record `template_id/template_version` as-is (null
  today) and the built-in checklist it used. No template linking in this PR.

**Client / app shell.** A vanilla-JS SPA: `/login` (and `/` when signed in) serve `public/live.html`, which loads classic scripts `live.js`,
`inspection-drafts.js`, `proactive.js` (shared global scope; later scripts override earlier functions). `load()` fetches `/api/data` (+ several
other endpoints) into the global `data`, `render()` rebuilds the DOM from template strings, `data-action` buttons go through `action()`.
Resident (client), vendor, staff and admin all use the same shell; the role only changes the nav and views. `page`, `activeInspection` etc. are
globals; a 30-minute idle timer calls logout and redirects to `/login`.

**Drafts today.** `inspection-drafts.js` stores the draft in `sessionStorage` and autosaves 1.2 s after typing via `inspections/save`. Photos and
publishing need a connection. Closing the tab loses unsynced work.

**Service worker / manifest.** None. `live.html` only links `apple-touch-icon.png` (from estateaegis.com absolute URL).

**Auth offline.** `estateos_session` cookie: HttpOnly, SameSite=Strict, 8 h server session. Nothing works offline today: `boot()` calls
`/api/status` and shows "EstateAegis could not connect" on failure.

**CSP** (static responses): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' …`.
No inline script/style/`style=""` (note: the existing monitor/attention row tints use `style=""` and are silently blocked; I'll move them to
classes). `default-src 'self'` already covers `worker-src`/`manifest-src`, so **no CSP change is needed**. Blob thumbnails are allowed (`img-src blob:`).

## 2. Design

### Server (minimal)
- Migration `032_offline_inspections.sql` (SQLite + Postgres, auto-applied by the existing runner):
  - `idempotency_keys(organization_id, key, endpoint, user_id, request_hash, status, response, created_at, PRIMARY KEY(organization_id,key))`.
  - `files.client_op_id` + unique index `(created_by, client_op_id)`, `files.captured_at`, `files.received_at`.
  - `inspections.submitted_at`, `inspections.submitted_by`.
- Idempotency middleware for `POST /api/inspections`, `/inspections/save`, `/inspections/submit`, `/inspections/publish`, `/files` when an
  `Idempotency-Key` (UUID) header is present: claim the key per company, run the handler, store the 2xx response, replay it on repeats
  (`Idempotency-Replayed: true`), 425 while the first attempt is still running, 422 if the key is reused for a different request/user, and
  release the claim on errors so the client can retry. Keys older than 30 days are purged hourly.
- `POST /api/inspections` accepts an optional client UUID v4 `id` (offline-started visit). Same user + same residence → returns the existing row
  (idempotent); any other collision → 409.
- `POST /api/files` accepts `clientOpId` and `capturedAt`; stores `received_at`; a repeat `clientOpId` returns the existing file.
- New status **`submitted`**: `POST /api/inspections/submit {id, version, autoPublish}` (admin/employee). Validates every item answered, N/A has
  a note, summary present → `submitted` (+ notification to staff). `autoPublish` only for admins → publishes right after. Repeats are no-ops.
  `publish` accepts `draft` or `submitted`. `POST /api/inspections/reopen` (admin) sends a submitted visit back to draft.
- `GET /api/offline/visits?propertyIds=…` (admin/employee, only residences they can operate): the minimal offline snapshot (user, company, logo,
  residences with rooms/manager/timezone, draft+submitted inspections, the last published visit per residence for "last visit" hints, photo
  metadata, the built-in checklist with `template_id/template_version`). Excludes access codes, documents, billing, other residences.
  `GET /api/offline/inspections/:id` returns the current server copy for conflict resolution.
- `inspections/save` accepts optional `conflictResolution` and writes an `inspection.conflict_resolved` audit entry.
- PDF: photos with `captured_at` print "Taken <time> <tz>" in the residence's timezone; older photos render exactly as before.

### Client
- `public/manifest.webmanifest` + optimized icons (192, 512, maskable 512) from the shield; linked from `live.html`.
- `public/sw.js`: precaches the app shell (live.html via `/login`, JS, CSS, icons) in a cache named by a server-computed hash of those files
  (bumps automatically on deploy); navigation = network-first (4 s timeout) → cached shell; static = cache-first; **never touches `/api/*`**
  (no user data in the Cache API). Waits for the user: page shows "A new version is available — Reload" and only then `SKIP_WAITING`.
  `sync` event (Background Sync, Chrome/Android) replays the outbox with the same code as the page.
- `public/offline-core.js` (pure, unit-tested in Node): UUIDs, outbox ordering/coalescing, backoff (2 s × 2ⁿ, cap 5 min), error
  classification, three-way merge, the sync runner (per-inspection order, ≤3 inspections in parallel), photo resize maths.
- `public/offline-store.js`: IndexedDB wrapper, one DB per user (`estateaegis-offline-<userId>`) with stores `drafts`, `outbox`, `blobs`,
  `snapshots`, `meta`, and an in-memory mirror so `render()` stays synchronous.
- `public/inspection-drafts.js` rewritten as the offline integration: drafts in IndexedDB (migrates old sessionStorage drafts), outbox, photo
  capture (resize to 2048 px, JPEG 0.8, EXIF orientation via `createImageBitmap`), sync triggers (online, visibility, start, 20 s timer while
  pending, Background Sync), offline boot, sync indicator + panel, conflict resolver, install prompt, "Offline data" in My profile.
- `public/offline.css`: banner, badges, sticky mobile action bar, 44 px targets, matches the refresh palette.

### Sync semantics
- Ops: `start_inspection`, `save_draft`, `upload_photo`, `complete_inspection`; each has a client UUID `opId` sent as `Idempotency-Key`.
- Per inspection strictly in order; a failed/conflicted head op blocks later ops of that inspection only.
- `save_draft` sends the full draft (the server model). Unsent saves coalesce; once attempted, a save's body is frozen so retries are identical;
  later edits queue another save.
- 409 on save → fetch server copy → three-way merge against the last synced base: non-overlapping changes merge automatically; overlapping
  ones become a **conflict** (local copy kept, sync for that visit paused, "Your version / Server version" per item; keep mine / use server per
  item; resolution saved + audited). Never silently overwrites; never deletes local data.
- 401 → sync pauses with "Sign in to finish syncing"; local data is kept (see deviations).
- Network/5xx/425/429 → retry with backoff. Other 4xx → "Needs attention" with Retry / Discard (discard asks first).

### UI
- Top bar (staff): "Online · all saved" / "Offline · N changes waiting" / "Syncing 2 of 5…" / "Needs attention (1)"; text + icon; `aria-live`.
  Tap → Sync panel (each queued item, status, last error, Retry now, Resolve).
- Offline banner. "Available offline · updated 8:12 AM" badges. "Make available offline" on residence Inspections tab, Inspection reports and
  Upcoming inspections lists, Daily route. Opening a draft auto-downloads it; on each load staff auto-download drafts due today/tomorrow.
- Inspection screen: per-item "Not synced" badges, local photo thumbnails "Waiting to upload", sticky bottom bar (Add photos · Save · Mark
  complete), "Saved on this device. It will sync automatically when you're back online." Mark complete offline → "Will submit when back online".
  Admin: optional "Publish automatically when synced" (default off).
- `submitted` badge, read-only view for employees, Publish / Return to draft for admins, Overview tile "Submitted for review (n)".

## 3. Spec vs code (deviations)
- Spec's answer status `not_applicable` is really `na`; statuses also include `unchecked`.
- `/api/data` is **not** cached as-is (it holds invoices, audit, users…); instead a purpose-built `/api/offline/visits` snapshot is stored per
  user in IndexedDB. Same goal, smaller and safer.
- Spec says wipe local data on 401. A field tech whose 8 h session (or the 30-min idle timer) expires while offline would lose the visit, which
  breaks the "never lose local data" rule. So: explicit **Sign out** wipes the user's offline DB (warning first if anything is unsynced);
  401/idle only pause sync, and the data stays bound to that user ID until the same user signs in. The idle auto-logout is deferred while the
  device is offline or the outbox is non-empty (flagged as a security trade-off).
- Spec's idempotency table stores `response_hash`; we store the response body itself (needed to replay it) plus a request hash.
- Brief said "last-write-wins per answer with server timestamps"; the spec says never overwrite on 409. Followed the spec, plus automatic
  three-way merge for non-overlapping edits so most conflicts need no user action.
- Rate limiting (`rate()`) only applies to auth endpoints, so a backlog sync doesn't trip it; no batching needed.
- Not linking checklist templates to visits (out of scope; noted above). Supabase storage path is unchanged.

## 4. Tests
- Unit (`tests/offline-core.test.mjs`): ordering, coalescing, frozen bodies, backoff cap, error classes, three-way merge, runner with a fake
  transport (in-order replay, retry after network failure, conflict pause, 401 pause, exactly-once photo), resize maths, sessionStorage migration.
- API (`tests/offline-inspections-api.test.mjs`): same `Idempotency-Key` → one inspection / one save / one photo; cross-company key isolation;
  key reuse with different body rejected; UUID collision rejected; submit validation; employees can't publish; admin auto-publish; client and
  vendor blocked; offline snapshot scoping; `captured_at`/`received_at`; access-code responses `no-store`; PDF prints capture time.
- E2E (Playwright, 390 px): online load → offline → answer items, notes, 3 photos, reload while offline (still loads, data kept), start a
  visit offline, mark complete → online → DB has exactly one inspection/save state and exactly 3 files with `captured_at`, status `submitted`;
  admin publishes, PDF has the photos. Conflict check with two contexts. Logout wipes IndexedDB. Screenshots `offline-*.png`.

## 5. What the browser run found and fixed
The first real-browser run (Playwright + Chrome, 390 px, strict CSP left on) turned up these, all fixed in this PR:
- **Starting a visit online could open "Inspection unavailable".** `load()` skips the refetch if the last load was under 1.5 s ago
  (this was already on `stability-baseline`), so a quick start showed stale data. Start now resets that timer and sends a client UUID
  (`id`), so a retried start comes back as the same visit.
- **Publish could show stale data** for the same reason. It now refetches if the visit doesn't come back as published.
- **Offline: the screen jumped back to the last visit** after starting a new one. The dialog's follow-up `load()` re-ran the offline boot
  and restored the saved view. When the app is already offline it now keeps the current screen.
- **Auto pre-download skipped newly started visits** because of a blanket 2-minute throttle. The throttle now only applies when the set of
  residences hasn't changed.
- Sync panel showed "Waiting for a connection." in red while offline. Errors are now shown only when they need attention.
- Conflict dialog radios and footer overflowed at 390 px (CSS fix in `offline.css`).
- Line endings: `server.mjs`, `live.js`, `live.html`, `pdf.mjs` and `proactive.js` are CRLF in the repo, and their original endings were restored so the
  diff only shows real changes.

Console output with CSP on: no errors from the new code. The only errors were already there on `stability-baseline`: the inline
`<style id="client-portal-clean">` in `live.html`, the `https://estateaegis.com/apple-touch-icon.png` icon link blocked by `img-src`, and
`/resident.css` returning JSON. None are touched here.
