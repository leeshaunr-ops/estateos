// Flight-aware arrival preparation (Competitor opportunities #5). Staff or the family add flights to an arrival (and an
// optional departure flight). The arrival plan gets timed tasks anchored to landing ("turn on the air conditioning 4 h
// before landing", "driver at landing") whose due times move automatically when the ETA changes. Staff get bell and
// email alerts on delays, early arrivals, diversions and cancellations; the client portal shows the flight status and
// "Residence ready" once the readiness checklist is done; a departure flight can start the close-down visit after it
// departs.
//
// Manual mode (no flight service): staff or the family update the ETA and status by hand. FlightAware mode
// (FLIGHTAWARE_API_KEY): AeroAPI status, per-flight alerts to a signed callback URL (FLIGHTAWARE_WEBHOOK_SECRET), and
// a light polling safety net.
import {readFileSync} from 'node:fs';
import {flightProvider, normalizeFlight} from './flight-providers.mjs';
import {zonedToUtc, wallClock, addMinutes, formatIn, readRaw, validTimezone, signToken, verifyToken} from './integration-core.mjs';

export const SUGGESTED_TASKS = [
 {title: 'Turn on air conditioning or heat', anchor: 'landing', offset: -240},
 {title: 'Fresh flowers and groceries in place', anchor: 'landing', offset: -120},
 {title: 'Driver waiting at the airport', anchor: 'landing', offset: 0}
];
const ARRIVAL_STATUSES = ['scheduled', 'en_route', 'landed', 'diverted', 'cancelled'];
const DEPARTURE_STATUSES = ['scheduled', 'departed', 'cancelled'];
const DONE_ARRIVAL = ['landed', 'arrived'];
const DEPARTED = ['departed', 'en_route', 'landed', 'arrived'];

/* ---------- pure rules (unit-tested) ---------- */
/** Datetime-local 'YYYY-MM-DDTHH:MM' on the residence's clock → UTC ISO. */
export function localToUtc(value, tz) {
 const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(value || ''));
 if (!m) return null;
 return zonedToUtc(m[1], m[2], validTimezone(tz) ? tz : 'America/New_York');
}
/** The time that matters for a flight: landing (gate arrival) for arrivals, departure for departures. */
export function flightTimes(f) {
 if (f.direction === 'departure') return {scheduled: f.scheduled_out || null, eta: f.actual_out || f.estimated_out || f.scheduled_out || null, actual: f.actual_out || null};
 return {scheduled: f.scheduled_in || null, eta: f.actual_in || f.estimated_in || f.scheduled_in || null, actual: f.actual_in || null};
}
/** Plan anchors: landing = the first arrival flight's ETA (else the arrival time); departure = the last departure flight. */
export function anchors(arrival, flights, tz) {
 const live = flights.filter(f => f.status !== 'cancelled');
 const lands = live.filter(f => f.direction !== 'departure').map(f => flightTimes(f).eta).filter(Boolean).sort();
 const leaves = live.filter(f => f.direction === 'departure').map(f => flightTimes(f).eta).filter(Boolean).sort();
 let landing = lands[0] || null;
 if (!landing && arrival?.arrival_at) { const iso = /Z|[+-]\d\d:\d\d$/.test(arrival.arrival_at) ? new Date(arrival.arrival_at).toISOString() : localToUtc(arrival.arrival_at, tz); landing = iso; }
 return {landing, departure: leaves.length ? leaves[leaves.length - 1] : null};
}
/** Due time of a task: anchor + offset minutes (negative = before). */
export function taskDue(task, a) { const at = a[task.anchor === 'departure' ? 'departure' : 'landing']; return at ? addMinutes(at, task.offset_minutes) : null; }
/** Which tasks move and by how much when the anchors change. */
export function shiftPlan(tasks, a) {
 return tasks.map(t => ({task: t, from: t.due_at || null, to: taskDue(t, a)})).filter(x => x.from !== x.to);
}
/** Alerts for a change, compared with what staff were last told. */
export function changeEvents({notifiedEta, notifiedStatus, eta, status, alertMinutes = 20}) {
 const out = [];
 if (status === 'cancelled' && notifiedStatus !== 'cancelled') out.push({kind: 'cancelled'});
 if (status === 'diverted' && notifiedStatus !== 'diverted') out.push({kind: 'diverted'});
 if (!['cancelled', 'diverted'].includes(status) && eta && notifiedEta) {
  const moved = Math.round((Date.parse(eta) - Date.parse(notifiedEta)) / 60000);
  if (moved >= alertMinutes) out.push({kind: 'delay', minutes: moved});
  if (-moved >= alertMinutes) out.push({kind: 'early', minutes: -moved});
 }
 return out;
}
export function offsetLabel(minutes, anchor = 'landing') {
 const m = Math.abs(Math.round(Number(minutes) || 0)), h = Math.floor(m / 60), r = m % 60;
 const span = h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
 const what = anchor === 'departure' ? 'departure' : 'landing';
 return !m ? `At ${what}` : `${span} ${minutes < 0 ? 'before' : 'after'} ${what}`;
}
/** Tests (never on Render or in production) can move the clock with a file holding an ISO time. */
export function flightClock(env = process.env) {
 const file = env.ESTATEOS_FLIGHT_TEST_NOW_FILE;
 if (!file || env.RENDER || env.NODE_ENV === 'production') return () => Date.now();
 return () => { try { const t = Date.parse(readFileSync(file, 'utf8').trim()); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); } };
}

export function createFlights({get, all, run, transaction, id, now, fail, text, json, body, roles, property, audit, communications, timezoneFor, visitChecklists, EAChecklist, template, env = process.env, provider: injected, fetcher, clock = flightClock(env)}) {
 const provider = injected || flightProvider(env, {fetcher, clock});
 const callbackBase = () => { for (const v of [env.FLIGHTAWARE_CALLBACK_BASE, env.APP_URL, env.RENDER_EXTERNAL_URL]) { try { const u = new URL(v); if (u.protocol === 'https:' && !u.username) return u.origin; } catch {} } return provider.kind === 'fake' ? 'https://example.test' : null; };
 const residenceTz = async pRow => (timezoneFor ? await timezoneFor(pRow) : pRow.timezone) || 'America/New_York';
 const nowIso = () => new Date(clock()).toISOString();

 async function settings(org) {
  const s = await get('SELECT * FROM flight_settings WHERE organization_id=?', org) || {};
  return {alertMinutes: s.alert_minutes ?? 20, closedownDelayMinutes: s.closedown_delay_minutes ?? 60};
 }
 async function arrivalFor(user, arrivalId, {edit = false, staffOnly = false} = {}) {
  const arrival = await get('SELECT a.* FROM arrivals a JOIN properties p ON p.id=a.property_id WHERE a.id=? AND p.organization_id=?', String(arrivalId || ''), user.organization_id);
  if (!arrival) fail(404, 'Arrival not found.');
  if (user.role === 'vendor' || (staffOnly && user.role === 'client')) fail(403, 'Only your team can change the arrival plan.');
  const pRow = await property(user, arrival.property_id, user.role === 'client' ? 'read' : 'operate');
  if (edit && ['completed', 'cancelled'].includes(arrival.status)) fail(409, 'This arrival is closed.');
  return {arrival, pRow};
 }
 async function flightFor(user, flightId, opts) {
  const f = await get('SELECT * FROM arrival_flights WHERE id=? AND organization_id=?', String(flightId || ''), user.organization_id);
  if (!f) fail(404, 'Flight not found.');
  return {flight: f, ...(await arrivalFor(user, f.arrival_id, opts))};
 }

 /* ---------- plan times and alerts ---------- */
 async function recompute(arrivalId) {
  const arrival = await get('SELECT * FROM arrivals WHERE id=?', arrivalId); if (!arrival) return [];
  const pRow = await get('SELECT * FROM properties WHERE id=?', arrival.property_id), tz = await residenceTz(pRow);
  const flights = await all('SELECT * FROM arrival_flights WHERE arrival_id=?', arrivalId), tasks = await all('SELECT * FROM arrival_tasks WHERE arrival_id=? ORDER BY sort,created_at', arrivalId);
  const shifts = shiftPlan(tasks, anchors(arrival, flights, tz));
  for (const s of shifts) await run('UPDATE arrival_tasks SET due_at=?,planned_due_at=COALESCE(planned_due_at,?),updated_at=? WHERE id=?', s.to, s.to, now(), s.task.id);
  return shifts.filter(s => s.from && s.to && !s.task.done_at);
 }
 async function staffRecipients(pRow, arrivalId) {
  const primary = await communications.primary(pRow.organization_id);
  const manager = pRow.account_manager_id ? await get("SELECT id,email FROM users WHERE id=? AND organization_id=? AND active=1 AND role IN ('admin','employee')", pRow.account_manager_id, pRow.organization_id) : null;
  const assignees = await all("SELECT DISTINCT u.id,u.email FROM arrival_tasks t JOIN users u ON u.id=t.assignee_user_id WHERE t.arrival_id=? AND u.active=1 AND u.organization_id=?", arrivalId, pRow.organization_id);
  const seen = new Set(); return [primary, manager, ...assignees].filter(r => r && !seen.has(r.id) && seen.add(r.id));
 }
 async function alertStaff(flight, events, shifts) {
  if (!events.length) return;
  const pRow = await get('SELECT * FROM properties WHERE id=?', flight.property_id), tz = await residenceTz(pRow), t = flightTimes(flight);
  const verb = flight.direction === 'departure' ? 'departs' : 'lands', was = flight.notified_eta ? ` (was ${formatIn(flight.notified_eta, tz, {date: false})})` : '';
  const lines = events.map(e => e.kind === 'cancelled' ? `Flight ${flight.ident} was cancelled.` : e.kind === 'diverted' ? `Flight ${flight.ident} was diverted${flight.diverted_to ? ' to ' + flight.diverted_to : ''}.` : e.kind === 'delay' ? `Flight ${flight.ident} is delayed ${e.minutes} min: now ${verb} ${formatIn(t.eta, tz)}${was}.` : `Flight ${flight.ident} is early: now ${verb} ${formatIn(t.eta, tz)}${was}.`);
  const plan = shifts.length ? `\n\nThe arrival plan moved with it:\n${shifts.map(s => `• ${s.task.title}: now due ${formatIn(s.to, tz)}`).join('\n')}` : '';
  const dep = flight.direction === 'departure', kind = events.map(e => e.kind).join('+'), subject = {cancelled: dep ? 'Departure flight cancelled' : 'Flight cancelled', diverted: 'Flight diverted', delay: dep ? 'Departure flight delayed' : 'Flight delayed', early: dep ? 'Departure flight leaving early' : 'Flight arriving early'}[events[0].kind] + `: ${pRow.name}`;
  await communications.enqueue(pRow.organization_id, `flight:${flight.id}:${kind}:${t.eta || ''}:${flight.status}`, await staffRecipients(pRow, flight.arrival_id), subject, `${lines.join('\n')}${plan}\n\nSign in to EstateAegis to see the arrival.`, flight.arrival_id);
 }
 /** Apply new flight data (from the flight service or typed by a person), then move the plan and alert staff. */
 async function applyUpdate(flight, patch, user = null, {baseline = false} = {}) {
  const cols = Object.keys(patch); if (!cols.length) return flight;
  await run(`UPDATE arrival_flights SET ${cols.map(c => c + '=?').join(',')},updated_at=?,version=version+1${user ? ',updated_by=?' : ''} WHERE id=?`, ...cols.map(c => patch[c]), now(), ...(user ? [user.id] : []), flight.id);
  const fresh = await get('SELECT * FROM arrival_flights WHERE id=?', flight.id), st = await settings(fresh.organization_id), t = flightTimes(fresh);
  const shifts = await recompute(fresh.arrival_id);
  // The first match from the flight service sets the baseline: what was typed before is not a delay or an early arrival.
  const events = baseline ? changeEvents({notifiedStatus: fresh.notified_status, status: fresh.status}) : changeEvents({notifiedEta: fresh.notified_eta, notifiedStatus: fresh.notified_status, eta: t.eta, status: fresh.status, alertMinutes: st.alertMinutes});
  if (events.length) await alertStaff(fresh, events, shifts);
  if (baseline || events.length || !fresh.notified_eta || fresh.notified_status !== fresh.status) await run('UPDATE arrival_flights SET notified_eta=?,notified_status=? WHERE id=?', t.eta, fresh.status, fresh.id);
  await closedownCheck(await get('SELECT * FROM arrival_flights WHERE id=?', fresh.id));
  return get('SELECT * FROM arrival_flights WHERE id=?', fresh.id);
 }
 const providerPatch = (f, data) => ({
  fa_flight_id: data.faFlightId || f.fa_flight_id || null, origin: data.origin?.code || f.origin, origin_name: data.origin?.city || data.origin?.name || f.origin_name, destination: f.destination && data.diverted ? f.destination : (data.destination?.code || f.destination), destination_name: f.destination_name && data.diverted ? f.destination_name : (data.destination?.city || data.destination?.name || f.destination_name),
  diverted_to: data.diverted ? (data.destination?.code && data.destination.code !== f.destination ? data.destination.code : f.diverted_to) : null,
  scheduled_out: data.scheduledOut || f.scheduled_out, estimated_out: data.estimatedOut || data.scheduledOut || f.estimated_out, actual_out: data.actualOff || data.actualOut || null,
  scheduled_in: data.scheduledIn || f.scheduled_in, estimated_in: data.estimatedIn || data.scheduledIn || f.estimated_in, actual_in: data.actualIn || data.actualOn || null,
  status: f.direction === 'departure' ? (data.status === 'cancelled' ? 'cancelled' : DEPARTED.includes(data.status) ? 'departed' : 'scheduled') : (data.status === 'arrived' ? 'landed' : data.status), status_text: data.statusText || null,
  provider_error: null, last_checked_at: nowIso()
 });
 async function refresh(flight) {
  if (!provider.live) return flight;
  try {
   const data = flight.fa_flight_id ? await provider.status({faFlightId: flight.fa_flight_id}) : await provider.lookup({airline: flight.airline, number: flight.flight_number, day: flight.flight_date});
   if (!data) { await run('UPDATE arrival_flights SET last_checked_at=?,provider_error=? WHERE id=?', nowIso(), 'The flight service has no matching flight yet. Check the airline, number and date.', flight.id); return flight; }
   const updated = await applyUpdate(flight, {...providerPatch(flight, data), source: provider.kind}, null, {baseline: !flight.fa_flight_id && !!data.faFlightId});
   await ensureAlert(updated);
   return updated;
  } catch (error) { await run('UPDATE arrival_flights SET last_checked_at=?,provider_error=? WHERE id=?', nowIso(), String(error.message || 'Flight service error.').slice(0, 300), flight.id); return flight; }
 }
 async function ensureAlert(flight) {
  if (!provider.live || !provider.alerts || flight.alert_id || flight.status === 'cancelled') return;
  const base = callbackBase(); if (!base) return;
  const targetUrl = `${base}/api/webhooks/flightaware/${flight.id}/${signToken(provider.webhookSecret, 'flight:' + flight.id)}`;
  try { const {alertId} = await provider.createAlert({ident: flight.ident, origin: flight.origin, destination: flight.destination, day: flight.flight_date, targetUrl}); if (alertId) await run('UPDATE arrival_flights SET alert_id=? WHERE id=?', String(alertId), flight.id); }
  catch (error) { await run('UPDATE arrival_flights SET provider_error=? WHERE id=?', ('Flight alerts could not be set up yet: ' + error.message).slice(0, 300), flight.id); }
 }
 async function dropAlert(flight) { if (flight.alert_id && provider.live) { try { await provider.deleteAlert({alertId: flight.alert_id}); } catch {} } }

 /* ---------- close-down visit after the departure flight departs ---------- */
 async function closedownCheck(flight) {
  if (!flight || flight.direction !== 'departure' || !Number(flight.closedown) || flight.closedown_inspection_id || !DEPARTED.includes(flight.status)) return;
  const departedAt = flight.actual_out || flight.estimated_out || flight.scheduled_out; if (!departedAt) return;
  const st = await settings(flight.organization_id); if (clock() < Date.parse(departedAt) + st.closedownDelayMinutes * 60000) return;
  const pRow = await get('SELECT * FROM properties WHERE id=?', flight.property_id), tz = await residenceTz(pRow);
  const primary = await communications.primary(flight.organization_id); if (!primary) return;
  const manager = pRow.account_manager_id ? await get("SELECT id,email FROM users WHERE id=? AND organization_id=? AND active=1 AND role IN ('admin','employee')", pRow.account_manager_id, pRow.organization_id) : null;
  const inspector = manager || primary, key = id(), day = wallClock(nowIso(), tz).day;
  const claimed = await run('UPDATE arrival_flights SET closedown_inspection_id=?,closedown_at=? WHERE id=? AND closedown_inspection_id IS NULL', key, nowIso(), flight.id);
  if (!claimed.changes) return;
  const chosen = await visitChecklists.resolve(flight.organization_id, {visitType: 'departure'}), snap = chosen.snapshot;
  await transaction(async () => {
   await run('INSERT INTO inspections(id,property_id,inspector_id,inspection_date,answers,created_at,frequency,next_due,visit_type,template_id,template_version,template_version_id,checklist_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', key, pRow.id, inspector.id, day, JSON.stringify(snap ? EAChecklist.propertyAnswers(snap) : template), now(), 'One-time', '', chosen.visit_type || 'departure', snap?.template_id ?? null, snap?.template_version ?? null, snap?.template_version_id ?? null, snap ? JSON.stringify(snap) : null);
   await run('UPDATE inspections SET report_email=? WHERE id=?', pRow.inspection_report_email || '', key);
   await run('INSERT INTO audit VALUES(?,?,?,?,?,?)', id(), flight.organization_id, primary.id, 'flights.closedown_visit_created', key, now());
  });
  await communications.enqueue(flight.organization_id, `flight-closedown:${flight.id}`, [inspector, primary].filter((r, i, a) => r && a.findIndex(x => x.id === r.id) === i), `Close-down visit: ${pRow.name}`, `Flight ${flight.ident} departed ${formatIn(departedAt, tz)}. A close-down visit for ${pRow.name} is ready in EstateAegis for today.`, key);
 }

 /* ---------- what each role sees ---------- */
 function flightView(f, tz, user) {
  const t = flightTimes(f), staff = ['admin', 'employee'].includes(user.role), dep = f.direction === 'departure';
  const delay = t.scheduled && t.eta && !t.actual ? Math.round((Date.parse(t.eta) - Date.parse(t.scheduled)) / 60000) : (t.scheduled && t.actual ? Math.round((Date.parse(t.actual) - Date.parse(t.scheduled)) / 60000) : 0);
  const at = iso => iso ? formatIn(iso, tz, {date: false}) : '';
  let label, tone;
  if (f.status === 'cancelled') { label = 'Cancelled'; tone = 'fail'; }
  else if (f.status === 'diverted') { label = `Diverted${f.diverted_to ? ' to ' + f.diverted_to : ''}`; tone = 'fail'; }
  else if (dep) { if (DEPARTED.includes(f.status)) { label = `Departed${t.actual ? ' ' + at(t.actual) : ''}`; tone = 'pass'; } else if (delay >= 15) { label = `Delayed ${delay} min · departs ${at(t.eta)}`; tone = 'monitor'; } else { label = t.eta ? `On time · departs ${at(t.eta)}` : 'Scheduled'; tone = 'neutral'; } }
  else if (DONE_ARRIVAL.includes(f.status)) { label = `Landed${t.actual ? ' ' + at(t.actual) : ''}`; tone = 'pass'; }
  else if (f.status === 'en_route') { label = `In the air · lands ${at(t.eta)}${delay >= 15 ? ` · ${delay} min late` : delay <= -15 ? ` · ${-delay} min early` : ''}`; tone = delay >= 15 ? 'monitor' : 'pass'; }
  else if (delay >= 15) { label = `Delayed ${delay} min · lands ${at(t.eta)}`; tone = 'monitor'; }
  else if (delay <= -15) { label = `Early · lands ${at(t.eta)}`; tone = 'neutral'; }
  else { label = t.eta ? `On time · lands ${at(t.eta)}` : 'Scheduled'; tone = 'neutral'; }
  return {id: f.id, arrival_id: f.arrival_id, property_id: f.property_id, direction: f.direction, ident: f.ident, airline: f.airline, flight_number: f.flight_number, flight_date: f.flight_date, origin: f.origin || '', origin_name: f.origin_name || '', destination: f.destination || '', destination_name: f.destination_name || '', diverted_to: f.diverted_to || '', scheduled_at: t.scheduled, eta: t.eta, actual_at: t.actual, status: f.status, status_label: label, tone, delay_minutes: delay, source: f.source, tracked: !!f.fa_flight_id, mine: f.created_by === user.id, closedown: !!Number(f.closedown), closedown_inspection_id: staff ? f.closedown_inspection_id || '' : '', updated_at: f.updated_at, version: f.version, ...(staff ? {provider_error: f.provider_error || '', last_checked_at: f.last_checked_at || ''} : {})};
 }
 async function decorate(user, data) {
  if (!data || !Array.isArray(data.arrivals)) return data;
  const st = await settings(user.organization_id), admin = user.role === 'admin';
  const out = {mode: provider.kind, live: !!provider.live, providerLabel: provider.label, alerts: !!provider.alerts, settings: st, flights: [], tasks: []};
  if (admin) out.connection = {provider: provider.kind, configured: !!provider.live, alerts: !!provider.alerts && !!callbackBase(), callbackBase: callbackBase() || ''};
  const ids = data.arrivals.map(a => a.id);
  if (ids.length && user.role !== 'vendor') {
   const marks = ids.map(() => '?').join(',');
   const flights = await all(`SELECT * FROM arrival_flights WHERE organization_id=? AND arrival_id IN (${marks}) ORDER BY direction,created_at`, user.organization_id, ...ids);
   const tasks = await all(`SELECT t.*,u.name assignee_name,d.name done_by_name FROM arrival_tasks t LEFT JOIN users u ON u.id=t.assignee_user_id LEFT JOIN users d ON d.id=t.done_by WHERE t.organization_id=? AND t.arrival_id IN (${marks}) ORDER BY t.due_at,t.sort,t.created_at`, user.organization_id, ...ids);
   const tzByHome = new Map();
   for (const a of data.arrivals) if (!tzByHome.has(a.property_id)) { const p = await get('SELECT * FROM properties WHERE id=?', a.property_id); tzByHome.set(a.property_id, p ? await residenceTz(p) : 'America/New_York'); }
   const tzOfArrival = new Map(data.arrivals.map(a => [a.id, tzByHome.get(a.property_id)]));
   out.flights = flights.map(f => flightView(f, tzOfArrival.get(f.arrival_id), user));
   out.tasks = tasks.map(t => ({id: t.id, arrival_id: t.arrival_id, title: t.title, anchor: t.anchor, offset_minutes: t.offset_minutes, offset_label: offsetLabel(t.offset_minutes, t.anchor), due_at: t.due_at, planned_due_at: t.planned_due_at, moved_minutes: t.due_at && t.planned_due_at ? Math.round((Date.parse(t.due_at) - Date.parse(t.planned_due_at)) / 60000) : 0, required: t.anchor !== 'departure' && t.offset_minutes < 0, assignee_name: t.assignee_name || '', assignee_user_id: ['admin', 'employee'].includes(user.role) ? t.assignee_user_id || '' : undefined, done_at: t.done_at, done_by_name: t.done_by_name || ''}));
  }
  data.flights = out;
  return data;
 }
 /** Readiness: tasks due before landing must be done before the arrival is marked ready. */
 async function assertReady(arrivalId) {
  const open = await all("SELECT title FROM arrival_tasks WHERE arrival_id=? AND anchor<>'departure' AND offset_minutes<0 AND done_at IS NULL ORDER BY due_at", arrivalId);
  if (open.length) fail(422, `Finish the arrival plan first: ${open.map(t => t.title).slice(0, 3).join(', ')}${open.length > 3 ? '…' : ''}.`);
 }

 /* ---------- polling safety net and close-down timer ---------- */
 let ticking = false;
 async function tick() {
  if (ticking) return; ticking = true;
  try {
   const nowMs = clock();
   const since = new Date(nowMs - 3 * 864e5).toISOString().slice(0, 10);
   for (const f of await all("SELECT * FROM arrival_flights WHERE status NOT IN ('cancelled') AND flight_date>=? AND (closedown_inspection_id IS NULL OR direction='arrival')", since)) {
    const t = flightTimes(f), eta = t.eta ? Date.parse(t.eta) : Date.parse(f.flight_date + 'T12:00:00Z');
    if (provider.live && !(f.direction === 'departure' ? DEPARTED.includes(f.status) : DONE_ARRIVAL.includes(f.status))) {
     const soon = eta - nowMs < 4 * 3600e3 || f.status === 'en_route', interval = (soon ? 10 : 60) * 60000;
     const inWindow = eta - nowMs < 2 * 864e5 && nowMs - eta < 12 * 3600e3;
     if (inWindow && (!f.last_checked_at || nowMs - Date.parse(f.last_checked_at) >= interval)) await refresh(f);
    }
    if (f.direction === 'departure') await closedownCheck(await get('SELECT * FROM arrival_flights WHERE id=?', f.id));
   }
  } catch (error) { console.error('Flights:', error.message); } finally { ticking = false; }
 }

 /* ---------- webhooks (FlightAware alerts) ---------- */
 async function webhook(req, res, url) {
  const m = /^\/api\/webhooks\/flightaware\/([A-Za-z0-9-]{8,64})\/([A-Za-z0-9_-]{20,100})$/.exec(url.pathname);
  if (!url.pathname.startsWith('/api/webhooks/flightaware')) return false;
  if (req.method !== 'POST') fail(405, 'Use POST.');
  if (!provider.live || !provider.alerts) fail(404, 'Endpoint not found.');
  if (!m || !verifyToken(provider.webhookSecret, 'flight:' + m[1], m[2])) fail(401, 'Invalid callback.');
  const raw = await readRaw(req, 64 * 1024); let payload = {}; try { payload = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid callback.'); }
  const flight = await get('SELECT * FROM arrival_flights WHERE id=?', m[1]); if (!flight) fail(404, 'Flight not found.');
  if (flight.alert_id && payload.alert_id !== undefined && String(payload.alert_id) !== String(flight.alert_id)) fail(409, 'Alert does not match this flight.');
  // The callback is only a nudge: the authoritative status always comes from the flight service.
  const fresh = payload?.flight?.fa_flight_id && !flight.fa_flight_id ? {...flight, fa_flight_id: String(payload.flight.fa_flight_id)} : flight;
  await refresh(fresh);
  json(res, 200, {received: true});
  return true;
 }

 /* ---------- API ---------- */
 async function handle(req, res, url, user) {
  const p = url.pathname; if (!p.startsWith('/api/flights/')) return false;
  if (!user) fail(401, 'Please sign in.');
  if (req.method !== 'POST') fail(405, 'Use POST.');
  const b = await body(req), done = v => { json(res, 200, v); return true; };
  if (p === '/api/flights/add') {
   const {arrival, pRow} = await arrivalFor(user, b.arrivalId, {edit: true});
   const f = normalizeFlight(b.airline, b.flightNumber); if (!f) fail(422, 'Enter the airline code (for example DL or UA) and the flight number.');
   const direction = b.direction === 'departure' ? 'departure' : 'arrival';
   if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) fail(422, 'Choose the flight date.');
   if ((await all('SELECT id FROM arrival_flights WHERE arrival_id=?', arrival.id)).length >= 8) fail(422, 'An arrival can have up to 8 flights.');
   const tz = await residenceTz(pRow), scheduled = b.scheduledAt ? localToUtc(b.scheduledAt, tz) : null;
   if (b.scheduledAt && !scheduled) fail(422, 'Enter a valid time.');
   const key = id(), at = now();
   const fallback = direction === 'arrival' && !scheduled ? anchors(arrival, [], tz).landing : null;
   await run('INSERT INTO arrival_flights(id,organization_id,arrival_id,property_id,direction,airline,flight_number,ident,flight_date,scheduled_out,estimated_out,scheduled_in,estimated_in,status,source,closedown,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', key, user.organization_id, arrival.id, pRow.id, direction, f.airline, f.number, f.ident, b.date, direction === 'departure' ? scheduled : null, direction === 'departure' ? scheduled : null, direction === 'arrival' ? scheduled || fallback : null, direction === 'arrival' ? scheduled || fallback : null, 'scheduled', 'manual', direction === 'departure' && b.closedown ? 1 : 0, user.id, at, at);
   await audit(user, 'flight.added', key);
   let flight = await get('SELECT * FROM arrival_flights WHERE id=?', key);
   await run('UPDATE arrival_flights SET notified_eta=?,notified_status=? WHERE id=?', flightTimes(flight).eta, 'scheduled', key);
   flight = await refresh(await get('SELECT * FROM arrival_flights WHERE id=?', key));
   await recompute(arrival.id);
   if (user.role === 'client') await communications.enqueue(user.organization_id, `flight-added:${key}`, await staffRecipients(pRow, arrival.id), `Flight added: ${pRow.name}`, `The family added flight ${f.ident} (${direction}) on ${b.date} to their arrival at ${pRow.name}.`, arrival.id);
   return done({id: key, tracked: !!flight.fa_flight_id});
  }
  if (p === '/api/flights/eta') {
   const {flight, pRow} = await flightFor(user, b.id, {edit: true});
   if (Number.isInteger(b.version) && b.version !== flight.version) fail(409, 'This flight changed. Reload before saving.');
   if (flight.fa_flight_id && provider.live) fail(409, 'This flight updates automatically from the flight service.');
   const tz = await residenceTz(pRow), allowed = flight.direction === 'departure' ? DEPARTURE_STATUSES : ARRIVAL_STATUSES;
   const status = allowed.includes(b.status) ? b.status : flight.status === 'arrived' ? 'landed' : flight.status;
   const eta = b.eta ? localToUtc(b.eta, tz) : null; if (b.eta && !eta) fail(422, 'Enter a valid time.');
   const patch = {status, source: 'manual', status_text: null};
   if (flight.direction === 'departure') { if (eta) patch.estimated_out = eta; if (status === 'departed') patch.actual_out = eta || flight.actual_out || nowIso(); else patch.actual_out = null; if (!flight.scheduled_out && eta) patch.scheduled_out = eta; }
   else { if (eta) patch.estimated_in = eta; if (status === 'landed') patch.actual_in = eta || flight.actual_in || nowIso(); else patch.actual_in = null; if (!flight.scheduled_in && eta) patch.scheduled_in = eta; patch.diverted_to = status === 'diverted' ? text(b.divertedTo || 'another airport', 'Diverted to', 60) : null; }
   await applyUpdate(flight, patch, user);
   await audit(user, 'flight.updated', flight.id);
   return done({id: flight.id});
  }
  if (p === '/api/flights/remove') {
   const {flight} = await flightFor(user, b.id, {edit: true});
   if (user.role === 'client' && flight.created_by !== user.id) fail(403, 'Ask your team to remove this flight.');
   await dropAlert(flight);
   await run('DELETE FROM arrival_flights WHERE id=?', flight.id);
   await recompute(flight.arrival_id); await audit(user, 'flight.removed', flight.id);
   return done({removed: true});
  }
  if (p === '/api/flights/refresh') { const {flight} = await flightFor(user, b.id, {staffOnly: true}); if (!provider.live) fail(422, 'Flight tracking is not connected. Update the ETA by hand.'); const f = await refresh(flight); return done({id: f.id, error: (await get('SELECT provider_error FROM arrival_flights WHERE id=?', f.id))?.provider_error || ''}); }
  if (p === '/api/flights/tasks/add' || p === '/api/flights/tasks/suggested') {
   const {arrival, pRow} = await arrivalFor(user, b.arrivalId, {edit: true, staffOnly: true});
   const existing = await all('SELECT title FROM arrival_tasks WHERE arrival_id=?', arrival.id);
   let list;
   if (p.endsWith('/suggested')) list = SUGGESTED_TASKS.filter(s => !existing.some(e => e.title === s.title)).map(s => ({title: s.title, anchor: s.anchor, offset: s.offset, assignee: null}));
   else {
    const offset = Math.round(Number(b.offsetMinutes)); if (!Number.isFinite(offset) || Math.abs(offset) > 7 * 1440) fail(422, 'Choose when the task is due, up to 7 days from landing or departure.');
    let assignee = null; if (b.assigneeId) { const u = await get("SELECT id FROM users WHERE id=? AND organization_id=? AND active=1 AND role IN ('admin','employee')", b.assigneeId, user.organization_id); if (!u) fail(422, 'Choose an active staff member.'); assignee = u.id; }
    list = [{title: text(b.title, 'Task', 160), anchor: b.anchor === 'departure' ? 'departure' : 'landing', offset, assignee}];
   }
   if (existing.length + list.length > 30) fail(422, 'An arrival plan can have up to 30 timed tasks.');
   let sort = existing.length;
   for (const t of list) await run('INSERT INTO arrival_tasks(id,organization_id,arrival_id,title,anchor,offset_minutes,assignee_user_id,sort,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id(), user.organization_id, arrival.id, t.title, t.anchor, t.offset, t.assignee, sort++, user.id, now(), now());
   await recompute(arrival.id); await audit(user, 'arrival.plan_updated', arrival.id);
   if (arrival.status === 'ready') await run("UPDATE arrivals SET status='preparing',version=version+1 WHERE id=? AND status='ready'", arrival.id);
   void pRow; return done({added: list.length});
  }
  if (p === '/api/flights/tasks/done' || p === '/api/flights/tasks/remove') {
   const task = await get('SELECT * FROM arrival_tasks WHERE id=? AND organization_id=?', String(b.id || ''), user.organization_id); if (!task) fail(404, 'Task not found.');
   await arrivalFor(user, task.arrival_id, {staffOnly: true, edit: p.endsWith('/remove')});
   if (p.endsWith('/remove')) { await run('DELETE FROM arrival_tasks WHERE id=?', task.id); await audit(user, 'arrival.plan_updated', task.arrival_id); return done({removed: true}); }
   await run('UPDATE arrival_tasks SET done_at=?,done_by=?,updated_at=? WHERE id=?', b.done === false ? null : now(), b.done === false ? null : user.id, now(), task.id);
   await audit(user, b.done === false ? 'arrival.task_reopened' : 'arrival.task_done', task.id);
   return done({id: task.id});
  }
  if (p === '/api/flights/settings') {
   roles(user, 'admin');
   const alertMinutes = Math.round(Number(b.alertMinutes)), delay = Math.round(Number(b.closedownDelayMinutes));
   if (!Number.isFinite(alertMinutes) || alertMinutes < 5 || alertMinutes > 240) fail(422, 'Alert threshold must be between 5 and 240 minutes.');
   if (!Number.isFinite(delay) || delay < 0 || delay > 720) fail(422, 'Close-down delay must be between 0 and 720 minutes.');
   await run('INSERT INTO flight_settings(organization_id,alert_minutes,closedown_delay_minutes,updated_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET alert_minutes=excluded.alert_minutes,closedown_delay_minutes=excluded.closedown_delay_minutes,updated_at=excluded.updated_at', user.organization_id, alertMinutes, delay, now());
   await audit(user, 'flights.settings_updated', user.organization_id);
   return done({settings: await settings(user.organization_id)});
  }
  fail(404, 'Endpoint not found.');
 }
 return {handle, webhook, decorate, assertReady, recompute, tick, settings, provider, applyUpdate};
}
