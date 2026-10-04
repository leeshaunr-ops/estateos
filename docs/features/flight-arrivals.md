# Flight-aware arrival preparation

The family (or the team) adds the flights for an arrival. The arrival plan is a list of timed steps such as "Turn on air conditioning or heat, 4 h before landing", and those due times follow the landing time. When a flight is delayed, early, diverted or cancelled, staff are told in the bell and by email. The family sees the flight status and **Residence ready** once the readiness checklist is done. A departure flight can start the close-down visit automatically.

## What it does
- **Flights on an arrival** (Arrival preparation › open an arrival › Flights): airline code + flight number + date, as an arrival or a departure. Up to 8 per arrival. Staff and the family can add flights. The team is alerted when the family adds one, and the family can remove the flights they added.
- **Arrival plan**: timed tasks with an offset from landing or from departure ("2 h before landing", "At landing", "1 h after departure"), an optional staff assignee, and done / undo. *Add suggested steps* adds three: AC or heat 4 h before landing, flowers and groceries 2 h before, and the driver at landing. Staff manage the plan. The family sees it read-only.
- **Landing time used for the plan**: the earliest gate-arrival time (ETA) among the arrival flights that are not cancelled. With no live flight, the arrival time typed on the arrival is used, read on the residence's clock. Offsets are real elapsed time, so "4 h before" is still 4 hours across a daylight-saving change. When the ETA changes, every due time moves and the task shows "moved 1 h 15 min later with the flight".
- **Alerts**: a delay or early arrival of at least the company's threshold (20 minutes by default, 5–240), a diversion, or a cancellation (sent once). Each is compared with the last time staff were told, so small drifts don't send repeated alerts. Alerts go to the primary administrator, the residence manager and anyone with a timed task, in the bell and as an email through the outbox. The email lists the new due times. Families are not sent flight alerts. If every flight is cancelled, the plan goes back to the typed arrival time.
- **Residence ready**: tasks due before landing (and the existing shopping, rooms and needs checks) must be done before staff can mark the arrival ready. The "at landing" and departure steps don't block it. The family portal then shows **Residence ready ✓**. Until then it shows how many checklist items are done.
- **Close-down after departure**: on a departure flight, choose *Start the close-down visit after this flight departs*. Once the flight has taken off, plus the company's delay (60 minutes by default, 0–720), a draft **Departure** visit is created for the residence manager (or the primary administrator) for that day. That person is notified and the creation is audited. This happens once per flight.
- **Company settings › Flight tracking** shows the connection status, the alert threshold and the close-down delay, and explains how to connect.

## Modes
- **Manual** (works today, nothing to sign up for): staff or the family type the ETA and status (scheduled, in the air, landed, diverted, cancelled; for departures: scheduled, departed, cancelled). Alerts, plan shifts and the close-down visit all work the same way.
- **FlightAware AeroAPI** (`FLIGHTAWARE_API_KEY`): flights are matched with `GET /flights/{ident}?ident_type=designator&start&end` inside AeroAPI's live window (up to 2 days ahead). Further out, the airline schedule (`GET /schedules/{start}/{end}`) fills in the times, and the flight becomes tracked once it enters the window. After a match, status is read by `fa_flight_id`, and staff can't overwrite a tracked flight's ETA.
  - **Alerts** (Standard tier and above, `FLIGHTAWARE_WEBHOOK_SECRET`): each flight gets `POST /alerts` with `target_url = https://<domain>/api/webhooks/flightaware/<flight id>/<HMAC token>` and the events out, off, on, in, departure, arrival, diverted and cancelled. Alerts are removed with `DELETE /alerts/{id}` when the flight is removed. AeroAPI doesn't sign its callbacks, so the server checks the per-flight HMAC token in the URL (constant-time) and that the alert id matches. It then re-fetches the flight from AeroAPI instead of trusting the callback body.
  - **Polling safety net**: flights within 48 hours are checked every 60 minutes, and every 10 minutes within 4 hours of the ETA or while in the air. This is the only way updates arrive when alerts are off.
- **Test service** (`ESTATEOS_FAKE_FLIGHTS=1`, optional `ESTATEOS_FAKE_FLIGHTS_FILE` overrides): used by the tests and local demos. It is ignored on Render.

## Turning on the live connection (FlightAware AeroAPI)
1. Sign up at https://www.flightaware.com/commercial/aeroapi/ and create an API key in the AeroAPI portal. Pricing at the time of writing:
   - *Personal*: no minimum, up to $5/month of free queries, personal or academic use only, **no alerts**.
   - *Standard*: $100/month minimum, business and business-to-consumer use, includes alerts.
   - *Premium*: $1,000/month minimum.
   - Per query: `GET /flights/{ident}` costs $0.005 per result set, schedules $0.02, and each delivered alert callback $0.02. Creating alerts is free.
   
   A home-watch business offering this to clients needs **Standard**.
2. Set `FLIGHTAWARE_API_KEY` on the service. That alone turns on tracking with polling.
3. For push alerts, also set `FLIGHTAWARE_WEBHOOK_SECRET` (any long random string; it signs the per-flight callback URLs). The public https address comes from `FLIGHTAWARE_CALLBACK_BASE`, else `APP_URL`, else Render's `RENDER_EXTERNAL_URL`.

Rough cost: polling one flight over its last 48 hours is about 10–30 lookups ≈ $0.05–$0.15. Alerts add about $0.02 per event (typically 4–6 per flight).

## Code
`flights.mjs` (rules, API, alerts, close-down, webhook), `flight-providers.mjs` (AeroAPI client, manual, test service), `integration-core.mjs` (time zones, HMAC tokens; shared with smart locks), `migrations/040_flight_arrivals.sql`, `public/flights.js` / `.css`, tests in `tests/flights.test.mjs` plus the signed-in smoke test.
