// Flight status providers for flight-aware arrival preparation.
// - FlightAware AeroAPI v4 (FLIGHTAWARE_API_KEY): GET /flights/{ident} (designator or fa_flight_id) for live status,
//   GET /schedules/{start}/{end} for flights more than two days out, POST /alerts with a per-flight signed target_url
//   (FLIGHTAWARE_WEBHOOK_SECRET) and DELETE /alerts/{id}. AeroAPI does not sign its callbacks, so the callback URL
//   carries an HMAC token for that one flight and the server re-fetches the flight from AeroAPI instead of trusting
//   the callback body.
// - Manual: no outside service; staff or the family type the ETA.
// - Fake: a deterministic test service (tests and local demos only, never on Render). Flights can be overridden from
//   a JSON file (ESTATEOS_FAKE_FLIGHTS_FILE) so tests can change a flight's status between calls.
import {readFileSync} from 'node:fs';
import {addDays} from './integration-core.mjs';

export const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';
export const ALERT_EVENTS = {arrival: true, cancelled: true, departure: true, diverted: true, filed: false, out: true, off: true, on: true, in: true};

/** "dl", "1234" → {airline:'DL', number:'1234', ident:'DL1234'}; null when it does not look like a flight. */
export function normalizeFlight(airline, number) {
 const a = String(airline || '').trim().toUpperCase().replace(/\s+/g, ''), n = String(number || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
 if (!/^[A-Z0-9]{2,3}$/.test(a) || !/^\d{1,4}[A-Z]?$/.test(n)) return null;
 return {airline: a, number: n, ident: a + n};
}

const iso = v => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
/** AeroAPI flight object → the fields EstateAegis keeps (one shape for the real and the fake service). */
export function parseAeroFlight(f) {
 if (!f || typeof f !== 'object') return null;
 const place = p => (p && typeof p === 'object' ? {code: p.code_iata || p.code || p.code_icao || '', name: p.name || '', city: p.city || '', timezone: p.timezone || ''} : {code: typeof p === 'string' ? p : '', name: '', city: '', timezone: ''});
 const out = {
  faFlightId: f.fa_flight_id || null, ident: f.ident_iata || f.ident || '', origin: place(f.origin), destination: place(f.destination),
  scheduledOut: iso(f.scheduled_out || f.scheduled_off), estimatedOut: iso(f.estimated_out || f.estimated_off), actualOut: iso(f.actual_out), actualOff: iso(f.actual_off),
  scheduledIn: iso(f.scheduled_in || f.scheduled_on), estimatedIn: iso(f.estimated_in || f.estimated_on), actualOn: iso(f.actual_on), actualIn: iso(f.actual_in),
  cancelled: !!f.cancelled, diverted: !!f.diverted, statusText: String(f.status || '').slice(0, 120)
 };
 out.status = out.cancelled ? 'cancelled' : out.diverted ? 'diverted' : out.actualIn ? 'arrived' : out.actualOn ? 'landed' : out.actualOff ? 'en_route' : out.actualOut ? 'departed' : 'scheduled';
 return out;
}
/** Pick the flight that departs on `day` (local date at the origin); otherwise the one nearest to that day. */
export function pickFlight(flights, day) {
 const list = (flights || []).map(parseAeroFlight).filter(f => f && f.scheduledOut);
 const local = f => { try { return new Date(f.scheduledOut).toLocaleDateString('en-CA', {timeZone: f.origin.timezone || 'UTC'}); } catch { return f.scheduledOut.slice(0, 10); } };
 const exact = list.filter(f => local(f) === day);
 if (exact.length) return exact.sort((a, b) => (a.diverted ? 0 : 1) - (b.diverted ? 0 : 1) || a.scheduledOut.localeCompare(b.scheduledOut))[0];
 const target = Date.parse(day + 'T12:00:00Z');
 return list.sort((a, b) => Math.abs(Date.parse(a.scheduledOut) - target) - Math.abs(Date.parse(b.scheduledOut) - target))[0] || null;
}

export function createFlightAwareProvider({apiKey, webhookSecret, fetcher = fetch, base = AEROAPI_BASE, clock = () => Date.now()}) {
 async function call(method, path, payload) {
  const res = await fetcher(base + path, {method, headers: {'x-apikey': apiKey, Accept: 'application/json; charset=UTF-8', ...(payload ? {'Content-Type': 'application/json; charset=UTF-8'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
  let data = {}; if (res.status !== 204) { try { data = await res.json(); } catch {} }
  if (!res.ok) throw Object.assign(Error(data?.detail || data?.title || `Flight service error (${res.status}).`), {status: 502, providerStatus: res.status});
  return {data, headers: res.headers};
 }
 return {
  kind: 'flightaware', live: true, label: 'FlightAware', alerts: !!webhookSecret, webhookSecret,
  /** Find a flight by airline + number on a departure date. Within AeroAPI's live window (10 days back, 2 ahead) this
   *  is the live flight; further out it is the airline schedule (times only, tracked live once inside the window). */
  async lookup({airline, number, day}) {
   const ident = airline + number, now = clock(), dayMs = Date.parse(day + 'T12:00:00Z');
   if (dayMs - now <= 2 * 864e5 && now - dayMs <= 9 * 864e5) {
    const q = new URLSearchParams({ident_type: 'designator', start: addDays(day, -1), end: addDays(day, 2)});
    const {data} = await call('GET', `/flights/${encodeURIComponent(ident)}?${q}`);
    const f = pickFlight(data.flights, day); return f ? {...f, tracked: true} : null;
   }
   const q = new URLSearchParams({airline, flight_number: number.replace(/[A-Z]$/, ''), max_pages: '1'});
   const {data} = await call('GET', `/schedules/${addDays(day, -1)}/${addDays(day, 2)}?${q}`);
   const s = (data.scheduled || []).map(x => ({...x, origin: {code_iata: x.origin_iata || x.origin}, destination: {code_iata: x.destination_iata || x.destination}})).filter(x => String(x.scheduled_out || '').slice(0, 10) >= day).sort((a, b) => String(a.scheduled_out).localeCompare(String(b.scheduled_out)))[0];
   return s ? {...parseAeroFlight(s), faFlightId: null, tracked: false} : null;
  },
  async status({faFlightId}) {
   const {data} = await call('GET', `/flights/${encodeURIComponent(faFlightId)}?ident_type=fa_flight_id`);
   const list = (data.flights || []).map(parseAeroFlight).filter(Boolean);
   return list.find(f => f.diverted) || list[0] || null;
  },
  async createAlert({ident, origin, destination, day, targetUrl}) {
   const {headers} = await call('POST', '/alerts', {ident, ...(origin ? {origin} : {}), ...(destination ? {destination} : {}), start: day, end: addDays(day, 1), eta: 0, events: ALERT_EVENTS, target_url: targetUrl});
   const location = headers.get('location') || ''; return {alertId: location.split('/').filter(Boolean).pop() || null};
  },
  async deleteAlert({alertId}) { try { await call('DELETE', `/alerts/${encodeURIComponent(alertId)}`); } catch (error) { if (error.providerStatus !== 404) throw error; } return {ok: true}; }
 };
}

export function createManualFlightProvider() {
 return {kind: 'manual', live: false, label: 'Manual', alerts: false, async lookup() { return null; }, async status() { return null; }, async createAlert() { return {alertId: null}; }, async deleteAlert() { return {ok: true}; }};
}

/** Test service: every flight departs 10:00 and lands 14:00 at its origin/destination unless the overrides file says otherwise. */
export function createFakeFlightProvider({file = '', webhookSecret = 'estateaegis-fake-flight-secret', clock = () => Date.now()} = {}) {
 const calls = []; let n = 0;
 const overrides = () => { if (!file) return {}; try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
 const base = (ident, day) => ({fa_flight_id: `${ident}-${day.replace(/-/g, '')}-fake`, ident_iata: ident, origin: {code_iata: 'BOS', name: 'Logan Intl', city: 'Boston', timezone: 'America/New_York'}, destination: {code_iata: 'PBI', name: 'Palm Beach Intl', city: 'West Palm Beach', timezone: 'America/New_York'}, scheduled_out: `${day}T14:00:00Z`, scheduled_in: `${day}T18:00:00Z`, estimated_out: `${day}T14:00:00Z`, estimated_in: `${day}T18:00:00Z`, status: 'Scheduled'});
 const flight = (ident, day) => { const o = overrides(); return {...base(ident, day), ...(o[`${ident}@${day}`] || {})}; };
 return {
  kind: 'fake', live: true, label: 'Test flight service', alerts: true, webhookSecret, calls,
  async lookup({airline, number, day}) { calls.push(['lookup', airline + number, day]); if (number === '9999') return null; return {...parseAeroFlight(flight(airline + number, day)), tracked: true}; },
  async status({faFlightId}) { calls.push(['status', faFlightId]); const m = /^(.+)-(\d{4})(\d{2})(\d{2})-fake$/.exec(String(faFlightId)); return m ? parseAeroFlight(flight(m[1], `${m[2]}-${m[3]}-${m[4]}`)) : null; },
  async createAlert({ident, day, targetUrl}) { calls.push(['alert', ident, day, targetUrl]); return {alertId: 'fake-alert-' + (++n)}; },
  async deleteAlert({alertId}) { calls.push(['delete-alert', alertId]); return {ok: true}; }
 };
}

/** FlightAware when configured, the test service only off Render, otherwise manual. */
export function flightProvider(env = process.env, {fetcher, clock} = {}) {
 if (env.FLIGHTAWARE_API_KEY) return createFlightAwareProvider({apiKey: env.FLIGHTAWARE_API_KEY, webhookSecret: env.FLIGHTAWARE_WEBHOOK_SECRET || '', fetcher, clock});
 if (env.ESTATEOS_FAKE_FLIGHTS === '1' && !env.RENDER) return createFakeFlightProvider({file: env.ESTATEOS_FAKE_FLIGHTS_FILE || '', clock});
 return createManualFlightProvider();
}
