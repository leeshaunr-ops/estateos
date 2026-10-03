# Plan: GPS and timestamp proof of visit

Roadmap #3. Families pay for someone to physically check their home. This adds evidence to every report: when the
inspector arrived and left, and whether they were at the residence. Report times are also fixed so they always show
in the residence's time zone (until now the PDF always used Eastern).

## Scope

- **Check in / Check out** on the inspection screen. Each one records the device position (one reading), the device
  time and the server time.
- **Photo location**: photos taken in the app keep the capture position when it is fresh (within 10 minutes).
  Location is captured **only** at check-in, check-out and photo events. Nothing is tracked continuously.
- **Verification**: distance from the residence's coordinates. The server computes it with haversine:
  - `verified` when `distance <= radius + min(accuracy, 100)`;
  - `outside_geofence` otherwise (the inspector must give a reason);
  - `location_unavailable` when there is no position (permission denied, timeout, or a desktop with no GPS);
  - `no_residence_location` when the residence has no coordinates yet (an admin must set them);
  - `clock_skew` is a separate flag: the device clock differs from the server clock by more than 10 minutes when
    the change is sent.
- **Admin override**: admins can mark a visit verified with a reason of at least 10 characters. It is written to the
  audit log and shown as "Verified by …".
- **Offline**: check-in and check-out are queued in the existing offline outbox (`visit_check_in` / `visit_check_out`).
  The device time is the arrival time. The server time at sync is stored too, and the report says
  "Recorded offline; synced …".
- **Never blocking**: a visit can always be completed. When there is no position it is clearly marked
  "Location unavailable". If the inspector checked in but never checked out, submit or publish checks them out
  automatically and flags it as automatic.
- **Report output**: a "Visit verification" box in the PDF (under the header facts) and on the client portal (no
  coordinates). Photo captions add "at the residence" when the photo position is inside the residence area. Each
  report gets a human report number (`OH-20261002-1`); the UUID stays as a small footer line.
- **Time zones**: the residence time zone is used, falling back to the company time zone, then America/New_York. Times
  are shown with the zone abbreviation (EDT, CDT, MST, HST). Admins can set the residence time zone and company time
  zone.

## Feature flag

`workspace_settings.visit_verification_enabled`, per company, **default off**. With it off nothing changes: no card,
no prompts, no PDF box, no report number. The only change that always applies is the report time zone fix. Published
reports render unchanged. The PDF box appears only for reports whose snapshot carries a `visitVerification` marker,
which is set at publish while the feature is on.

Company settings (Visit verification dialog):

| Setting | Default |
|---|---|
| `visit_verification_enabled` | 0 |
| `require_check_in_to_start` | 0 |
| `geofence_radius_m` | 150 |
| `show_verification_on_pdf` | 1 |
| `capture_photo_location` | 1 |
| `timezone` (company) | NULL, meaning America/New_York |

## Data (migration 035, additive only, SQLite and Postgres)

- **`workspace_settings`**: the columns above.
- **`properties`**:
  - new: `latitude`, `longitude` (DOUBLE PRECISION), `geocoded_at`, `geocode_source` (`geoapify` | `manual` |
    `device`), `geofence_radius_m` (NULL = company default), `timezone_source`;
  - `timezone_source` is needed because `timezone` is NOT NULL with default America/New_York. When it is NULL, the
    company time zone is used.
- **`inspection_visits`** (one row per inspection, unique `inspection_id`, `organization_id`-scoped):
  - `check_in_*` and `check_out_*`: server_at, device_at, lat, lon, accuracy_m, distance_m, source, offline, note,
    user_id;
  - `check_out_auto`, `duration_seconds`, `verification_status`, `clock_skew`;
  - `override_by`, `override_at`, `override_reason`, plus timestamps.
- **`files`**: `capture_lat`, `capture_lon`, `capture_accuracy_m`, `capture_source` (`device` | `exif`).
  `captured_at` and `received_at` already exist.
- **`inspections`**: `report_number`, with a unique index on (property_id, report_number). The number is generated
  inside the publish transaction.

## API

All endpoints are company-scoped and idempotent.

- **`POST /api/inspections/:id/check-in`** and **`/check-out`** (admin/employee who can operate the residence):
  - body `{deviceAt, latitude?, longitude?, accuracy?, source, offline, note?, auto?}`;
  - query `?sentAt=` gives the device clock at send time (kept out of the idempotency hash);
  - a repeated call returns the existing record (first check-in wins; a later call can only add the reason note).
- **`POST /api/inspections/:id/visit/override`**: admin only, reason of at least 10 characters, audited.
- **`POST /api/visit-verification/settings`**: admin only, company settings.
- **`POST /api/properties/location`**: admin only. Sets coordinates, radius and time zone, or `geocode: true` to
  look them up from the address with Geoapify.
- **`inspections/save`**: returns 422 when `require_check_in_to_start` is on, the visit is not checked in, and
  something is recorded.
- **`submit` / `publish`**: automatic check-out when the visit is checked in but not checked out.
- **`/api/data`**: per-inspection `visit`, sanitized by role:
  - admins see everything;
  - employees see device/server times and coordinates for their own visits;
  - clients see status, times and distance only, never coordinates;
  - vendors see nothing.
- **`/api/offline/visits`**: adds residence coordinates, radius, effective time zone, settings and visit rows, so the
  card works with no signal.

## Server-side photo EXIF

Uploaded JPEGs are always stripped of the EXIF GPS IFD and XMP before storage (privacy). When the feature is on,
`DateTimeOriginal` and the GPS position are extracted into the capture columns first. In-app photos are re-encoded
through a canvas and carry no EXIF, so they use the device position captured at the photo event.

## Geocoding

A background job (about 1 request per second) runs only for companies with the feature on and only when
`GEOAPIFY_API_KEY` is set. It geocodes residences with no coordinates, or whose address changed since geocoding,
unless the coordinates were set manually or by device. The Geoapify result also sets the time zone when none was set
explicitly. Address autocomplete in the residence form already returns lat/lon and time zone, and those are now saved
too. With no API key, admins set the location by typing coordinates or by tapping "Use my current location" while
standing at the residence.

## UI

- **Inspection screen**: Visit verification card with Check in / Check out, plain status text, a one-time privacy
  notice before the browser prompt, a permission-denied explanation, and an outside-area reason dialog.
- **Residence**: "Location & time zone" dialog with the geocoded address, lat/lon, Look up from address, Use my
  current location, radius override and time zone select.
- **Company settings**: "Visit verification" dialog with the toggles, radius and company time zone.
- **Reports list**: verification badge column plus a filter.
- **Admin details panel**: device vs server times, coordinates, accuracy and an "Open in Google Maps" plain link.
- **Client portal**: the same box without coordinates.
- Styling uses the existing wine accent and status pill colours. There are no new third-party origins and the CSP is
  unchanged.

## Tests (`tests/visit-verification.test.mjs`, SQLite + PGlite)

- **Unit**: haversine, geofence with accuracy allowance, clock skew, time zone formatting for NY, Chicago, Phoenix and
  Honolulu, report number uniqueness under concurrent publishes.
- **API**: check-in/out idempotency, employee cannot override, client/vendor 403, cross-company 404,
  require-check-in, EXIF stripped and extracted, automatic check-out.
- **Offline**: queued check-in and check-out through EAOfflineCore show "recorded offline" with the device time.
- **PDF text**: box present with the zone abbreviation; absent for old reports, when the feature is off, and when
  "show on PDF" is off; photo captions; completed time in the residence time zone with company fallback.
- **Portal**: no coordinates for clients.
- **E2E screenshots** (Playwright with `setGeolocation`): phone check-in, PDF box, portal.

## Follow-ups (out of scope)

- Vendor work-order check-ins.
- A /privacy page paragraph (draft wording in the PR).
- Bulk geocode reporting for admins.
