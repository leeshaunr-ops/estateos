# Plan: severe-weather alerts for every residence (`weather-alerts`)

Status: committed as the first commit of `feat-weather-alerts` (non-interactive run; implementation follows in the same PR).
Target: `stability-baseline` → staging (`estateos-staging`). Production (`main`, `estateos-1`) is untouched.

## What I found in the repo (checked against the spec's assumptions)

| Topic | Reality in `stability-baseline` (79ef3d3) |
|---|---|
| Server | Plain `node:http` in `server.mjs`. Feature modules export `createX({deps})` with `handle(req,res,url,user)` that returns `true` when it answered (storm, visit verification, offline). New code goes in new modules wired with a few lines. |
| Database | **Not Supabase client.** `database.mjs` opens Postgres through `pg` (`DATABASE_URL`, which on Render is the Supabase pooler, private schema `estateos`), SQLite (`node:sqlite`) locally, PGlite in tests. Migrations: every `migrations/*.sql` runs once by file name on both engines, so SQL must be valid in SQLite **and** Postgres (TEXT ids/timestamps, INTEGER booleans, JSON stored as TEXT, no arrays). Every business transaction takes `pg_advisory_xact_lock(174902381)` on Postgres. |
| Company settings | `workspace_settings` (one row per `organization_id`). `users` and `organizations` are inserted positionally (`INSERT INTO users VALUES(...)`), so **no columns may be added to them** (SQLite would break). New per-company and per-user settings go in new tables. |
| Roles / access | `roles(user,...)`, `property(user,id,op)` (admin: all; employee: Residence Manager, `property_access`, or open storm assignment; client: own family). Cross-company → 404. |
| `data` | `snapshot(user)` then `visitVerification.decorate(...)`. I add `weather.decorate(...)` the same way. |
| Email | `email_outbox` rows (id = idempotency key, optional `html`) drained by `communications.drain()` through Resend every 15 s; **Email activity** lists `email_outbox`. Demo workspaces are cancelled at send time. |
| Scheduled work | **In-process timers** in `server.mjs` (`operations.tick` every 60 s for maintenance/run-due automation, backup worker, billing sync, geocoder). There is no Render Cron Job service and no `pg_cron`. |
| PDF | Hand-written PDF in `pdf.mjs` (`inspectionPdf(report)`), report data frozen in `inspections.report_snapshot` at publish; `visitVerification.publishFields/reportForPdf` are the extension points (smart-locks uses the same wrap pattern). Storm report in `storm-pdf.mjs`. |
| Front end | `public/live.js` + feature scripts that wrap globals (`view`, `action`, `residenceView`, `inspectionView`, `routeView`, `ovStormStrip`), `public/*-core.js` UMD rule files shared with Node tests, hash routes in `view-route.js`, menu in `sidebar-core.js`. Strict CSP, no inline script/style. |
| Already merged | Checklist templates ✅, offline inspections + `Idempotency-Key` ✅, GPS proof of visit (`properties.latitude/longitude`, Geoapify backfill for companies with visit verification on) ✅, storm workflow (`storm_events`, wizard, board, storm report) ✅. AI summaries ✗ (Task A comes next; it will read the snapshot). |
| Tests | `node --test tests/*.test.mjs`; server scenarios spawn `server.mjs` on SQLite and PGlite; browser smoke with playwright-core when present. |

## Decisions (owner decisions already made, plus my judgement calls)

- **Forecast provider in production: NWS gridpoint** (`WEATHER_FORECAST_PROVIDER=nws_grid`, the default). The Open-Meteo **customer** endpoint is implemented behind `OPEN_METEO_API_KEY`. The free Open-Meteo endpoint is only used when `WEATHER_FORECAST_PROVIDER=open_meteo`, no key, **and** the server is not on Render (local dev / tests); on Render without a key it falls back to NWS grid and logs a warning once.
- **NWS `User-Agent`**: env `NWS_USER_AGENT`, default `(estateaegis.com, help@estateaegis.com)` pending Shaun's confirmation.
- **Scheduler**: follow today's pattern, an **in-process scheduler** (60 s tick) guarded by a **database lease lock** (`job_locks` row claimed with a conditional UPDATE, valid on both engines), so two instances or overlapping ticks never run the same job. Plus `POST /api/internal/cron/weather` (`X-Cron-Secret`, constant-time compare, bypasses the browser Origin check like webhooks) so a Render Cron Job can drive it later **without code changes**. No new paid Render service is created; the option is noted in the PR.
- **Settings tables**: `weather_settings` (per company) and `weather_user_prefs` (per user) instead of columns on `companies`/`users` (positional inserts, see above). Lists (`categories`, `levels`, `notify_user_ids`) are JSON text.
- **Storm types**: add `winter_storm`, `severe_storm`, `extreme_heat` to `EAStorm.TYPES` (storm `type` is free TEXT validated against that map, so no migration).
- **Staging pilot**: flags default off. `FEATURE_PILOT_COMPANIES` (staging env only; tokens `platform_owner`, `demo_company` = "EstateOS Demo Company", or organization ids) turns `weather_alerts_enabled` on **once** for those companies at start-up (recorded in `feature_pilots`, so an admin can switch it off afterwards and it stays off).
- **Levels**: NWS `warning|watch|advisory|statement` (statements ignored); forecast threshold groups use level `forecast`.

## Schema migration `migrations/040_weather_alerts.sql` (forward-only, additive, both engines)

- `properties`: `nws_supported INTEGER`, `nws_state`, `nws_forecast_zone`, `nws_county_zone`, `nws_fire_zone`, `nws_grid_id`, `nws_grid_x INTEGER`, `nws_grid_y INTEGER`, `nws_station_id`, `nws_points_checked_at`, `nws_points_lat`, `nws_points_lon` (to detect moved coordinates), `weather_monitoring_enabled INTEGER NOT NULL DEFAULT 1`, `weather_threshold_overrides TEXT`.
- `inspections`: `weather_snapshot TEXT`, `weather_snapshot_overridden INTEGER NOT NULL DEFAULT 0`.
- `weather_settings(organization_id PK, enabled 0, categories TEXT json, levels TEXT '["warning","watch"]', freeze_threshold_f 28, freeze_notice_f NULL, heat_threshold_f 105, heavy_rain_in REAL 2.0, high_wind_gust_mph 50, forecast_lookahead_days 3, notify_admins 1, notify_residence_managers 1, notify_user_ids TEXT '[]', digest_time '06:30', watch_immediate 0, client_notice 'off', on_reports 0, storm_prep_lead_hours 24, last_digest_day, updated_by, updated_at)`.
- `weather_user_prefs(user_id PK, organization_id, email_pref 'all'|'warnings_only'|'none')`.
- `nws_alerts` (platform cache of public data, not company-scoped): spec columns, arrays as JSON text, plus `status`, `cancelled`.
- `weather_alerts`, `weather_alert_residences` (unique `weather_alert_id,property_id`), `weather_alert_notifications` (unique `weather_alert_id,user_id,channel,kind`), `forecast_cache` (`cache_key` PK + `lat_r,lon_r,provider`), `weather_job_runs`, `job_locks(job PK, owner, locked_until)`, `feature_pilots(organization_id, feature, applied_at)`, `weather_client_notice_dismissals` not needed (client dismissal is per device).
- Rollback: drop the new tables; the added columns are nullable/defaulted and unused when the flag is off.

## Files

New: `weather-core.mjs` → `public/weather-core.js` (UMD, shared rules: category map, levels, point-in-polygon, UGC match, grouping, thresholds, conversions, WMO codes, text lines, time labels, email rendering), `weather-providers.mjs` (NWS client with headers/backoff/Cache-Control, NWS grid + Open-Meteo forecast providers, current conditions), `weather.mjs` (API, jobs, scheduler, notifications, decorate, report hooks, storm hand-off), `feature-pilot.mjs`, `public/weather.js`, `public/weather.css`, `migrations/040_weather_alerts.sql`, `tests/weather.test.mjs`, `tests/fixtures/weather/*.json`, `docs/features/weather-alerts.md`.
Changed (small): `server.mjs` (wire module, `data` decorate, timer, cron route, static routes, shell files, start-of-visit hook), `storm.mjs` (expose `createEvent`/`addResidences`, optional report extras), `storm-pdf.mjs` (timeline entry + visit weather line), `public/storm-core.js` (3 types), `pdf.mjs` (weather line + footnote, only when the frozen report has it), `visit-verification.mjs` (geocode backfill also for weather-enabled companies), `public/sidebar-core.js` + `public/view-route.js` (Weather page), `public/live.html`, `public/sw.js`, `package.json` (check entries), `.env.example`, `tests/signed-in-smoke.test.mjs`.

## API contracts (all company-scoped; employees see only residences `property()` allows; other company → 404)

- `GET /api/weather/alerts?status=active|recent` → `{alerts:[{id,source,category,category_label,level,event_name,headline,onset_at,ends_at,status,residence_count,property_ids,acknowledged_by_name,acknowledged_at,storm_event_id,storm_event_name}]}` sorted by severity.
- `GET /api/weather/alerts/:id` → alert + `description`, `instruction` (NWS text), `residences:[{property_id,name,city,manager,next_visit,storm_status,matched_by,forecast}]`, `attribution`, `disclaimer`.
- `POST /api/weather/alerts/:id/acknowledge` (staff) · `POST /api/weather/alerts/:id/dismiss {reason}` (admin).
- `POST /api/weather/alerts/:id/start-storm-event` (admin). Body `{}` → pre-fill `{name,type,expected_impact_at,prep_deadline_at,residenceIds}` (or `{linked:true,event}` if already linked). Body `{create:true,name,type,expectedImpactAt,prepDeadlineAt,residenceIds}` → creates the event through the storm module's own create/add-residence code inside one transaction, links it, returns `{event}`; repeat calls return the same event.
- `POST /api/weather/alerts/:id/add-to-storm {stormEventId,residenceIds?}` (admin).
- `GET /api/weather/residences/:id` → active alerts + next 3 days of threshold checks.
- `GET|POST(PUT) /api/settings/weather` (admin; validation freeze −20..40 °F, heat 80..130 °F, rain 0.5..10 in, wind 20..120 mph, lookahead 1..7, digest HH:MM).
- `GET /api/weather/coverage` (admin), `POST /api/weather/coverage/geocode-missing` (admin; runs the existing Geoapify backfill).
- `GET /api/weather/health` (admin: own counts; platform owner: job runs).
- `POST|PUT /api/inspections/:id/weather` (staff, drafts only): `{snapshot}` override, `{clear:true}`, `{refresh:true}`.
- `POST /api/weather/residences/:id/monitoring {enabled,overrides}` (admin) · `POST /api/weather/preferences {emailPref}` (staff).
- `POST /api/internal/cron/weather {job}` with `X-Cron-Secret` (no session).
- `/api/data`: staff get `weather:{enabled,alerts:[{id,event_name,level,category,count,onset_at,ends_at,property_ids,storm_event_id,acknowledged}],emailPref,canManage}`; clients get `weatherNotices` only when `client_notice` allows (`automatic`, or `after_staff_review` once acknowledged), own residences only, fields `{event_name,onset_at,ends_at,company_message}`.

## Grouping (pure functions in `weather-core`, unit-tested)

NWS group key `nws:{event}:{onset date in company tz}`; an alert joins an active group of the same event whose window overlaps, or the group holding an alert it `references` (Update replaces the referenced member; Cancel removes it). A group with no active members ends (`cancelled` if every member was cancelled). A Warning arriving while a Watch group of the same hazard (same event stem, else same category with shared residences) is active creates a new Warning group with `supersedes_alert_id`, ends the Watch and sends `upgraded`. Updates email only when residences grow by ≥ max(3, 25 %) (`expanded`). Forecast groups `forecast:{category}:{first date}`; consecutive qualifying days merge; a residence already covered by an NWS group of the same category with overlapping dates is not added. Runs are idempotent (unique notification rows, deterministic outbox ids, lease lock). Dismissed groups stay dismissed while active.

## Jobs

`alerts` every 10 min (one `/alerts/active?area=ST&status=actual` per state with monitored residences; `?point=` fallback for residences without zones), `forecast` every 3 h, `points` daily (missing zones or older than 30 days or moved), `digest` every 15 min (companies whose digest time just passed in their time zone). Only companies with the flag on and residences with coordinates and monitoring on. 4-minute budget; `weather_job_runs` row per run; prune `nws_alerts` > 30 days. `WEATHER_JOBS_ENABLED=true` required.

## UI

- Overview + Daily route: banner (icon + text), collapses to "N weather alerts affecting M residences — View"; hidden when the alert's storm event is open (storm strip shows instead). Acknowledge (staff), dismiss (admin).
- Badges: residence cards and residence header ("⚠ Hard freeze Tue (low 24 °F)"), inspection header and daily-route stops ("⚠ Winter Storm Warning during this visit"); tap opens the alert.
- Weather page (Daily work → Weather): Active / Recent tabs, cards, detail with affected-residence list (filters: manager, city; select rows), collapsed NWS text, actions Start/Open/Add to storm event (admin), Plan route, Acknowledge, Dismiss. Admin "Settings" tab: enable, categories, levels, thresholds, lookahead, recipients, digest time, client notice (with preview), weather on reports, storm prep lead time, coverage panel, disclaimer, attribution. Company settings gets a "Weather alerts" summary panel.
- Residence (admin): monitoring toggle and threshold overrides. My profile: "Weather alert emails: All / Warnings only / None".
- Inspection screen: "Weather at visit" line with Edit / Remove (drafts).
- Client portal: gentle notice card (own residences only, dismissible per device).
- Times: residence items in the residence time zone, grouped banners in the company time zone, always with the zone abbreviation. Georgia page header, white cards, 44 px targets, no scrolling boxes.

## PDF

With `on_reports` on and a snapshot, publish freezes `report.weather = {line, sources}`; the PDF prints "Weather at visit: …" after Visit verification and a small footnote naming only the sources used. Reports without it render byte-for-byte as before. Storm report: alert timeline entry and each visit's weather line when present.

## Permission matrix

As in the spec: banner/badges/page staff only (employees: accessible residences); acknowledge staff; dismiss, storm hand-off, settings, residence monitoring/overrides admin; snapshot edit staff on editable drafts; own email preference staff; client notice clients (own residences, when enabled); vendors nothing; job health across companies platform owner only.

## Environment variables

| Name | Staging | Production |
|---|---|---|
| `NWS_USER_AGENT` | `(estateaegis.com, help@estateaegis.com)` | same, once Shaun confirms the email |
| `WEATHER_JOBS_ENABLED` | `true` | `false` until sign-off |
| `CRON_SECRET` | random (only needed if a Render Cron Job is added) | random |
| `WEATHER_FORECAST_PROVIDER` | unset (= `nws_grid`) | unset |
| `OPEN_METEO_API_KEY` | unset | only if Shaun buys a plan |
| `FEATURE_PILOT_COMPANIES` | `platform_owner,demo_company` | unset |

## Test plan

Fixtures in `tests/fixtures/weather/` served by a local mock HTTP server (`NWS_BASE_URL`, `OPEN_METEO_BASE_URL`): hurricane, multi-office winter storm with Update and Cancel, polygon Tornado Warning, zone Hard Freeze Warning, Red Flag Warning, Test-status alert, 429/503. Unit (mapping incl. renamed events, polygon incl. MultiPolygon/edge, UGC, grouping rules, thresholds/overrides/conversions/day boundaries/merging/suppression, rounding, headers, customer endpoint, throttle/prefs), job integration on SQLite and PGlite (2 companies, one request per state, separate groups, one email per recipient, second run silent, failing state isolated, missing coordinates counted), API permissions and cross-company 404s, client notice, storm hand-off idempotency, cron secret, PDF on/off/old reports, storm report timeline, signed-in browser smoke + axe on the Weather page.

## Rollout

1. Merge to `stability-baseline` → staging auto-deploys. Set staging env (above). Pilot turns the flag on for the owner/demo company only.
2. Shaun checks on staging: Settings → Weather alerts coverage; a live NWS alert (or a freeze forecast) appears within one interval; Start storm event; Email activity; PDF weather line with "Show weather on inspection reports" on.
3. Production stays off (`WEATHER_JOBS_ENABLED` unset, no pilot) until Shaun signs off and confirms the NWS contact email and privacy wording.
