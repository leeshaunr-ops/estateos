// Shared helpers for outside-service integrations (smart locks, flight tracking): time-zone math that is safe across
// daylight-saving changes, webhook signature checks, signed callback tokens and a size-limited raw body reader.
// Pure functions only (no database), so they are unit-tested directly.
import {createHmac, timingSafeEqual} from 'node:crypto';

export function validTimezone(tz) { if (!tz || typeof tz !== 'string') return false; try { new Intl.DateTimeFormat('en-US', {timeZone: tz}); return true; } catch { return false; } }

/** Offset (minutes east of UTC) of a time zone at an instant. */
export function zoneOffsetMinutes(instantMs, tz) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}).formatToParts(new Date(instantMs)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
 const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
 return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

/**
 * A wall-clock date and time in a time zone → UTC ISO string. Times that do not exist (the hour skipped when clocks
 * spring forward) move forward to the first valid minute; ambiguous times (the repeated hour in the fall) use the
 * earlier, daylight-saving occurrence.
 */
export function zonedToUtc(day, time, tz) {
 const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '')), t = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
 if (!d || !t || !validTimezone(tz)) throw Error('A valid date, time and time zone are required.');
 const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
 const candidates = [...new Set([zoneOffsetMinutes(wall - 864e5 / 2, tz), zoneOffsetMinutes(wall, tz), zoneOffsetMinutes(wall + 864e5 / 2, tz)])].sort((a, b) => b - a);
 for (const offset of candidates) { const instant = wall - offset * 60000; if (zoneOffsetMinutes(instant, tz) === offset) return new Date(instant).toISOString(); }
 // Skipped hour: use the offset in force just before the gap, which lands after the gap in local time.
 const before = zoneOffsetMinutes(wall - 864e5 / 2, tz);
 return new Date(wall - before * 60000).toISOString();
}

/** UTC instant → {day:'YYYY-MM-DD', time:'HH:MM'} on the wall clock of a time zone. */
export function wallClock(iso, tz) {
 const at = new Date(iso); if (Number.isNaN(at.getTime())) return null;
 const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).formatToParts(at).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
 return {day: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`};
}

/** Add whole minutes to an ISO instant (elapsed time, so DST never shifts it). */
export const addMinutes = (iso, minutes) => new Date(Date.parse(iso) + Math.round(Number(minutes) || 0) * 60000).toISOString();

/** Calendar day arithmetic on 'YYYY-MM-DD'. */
export function addDays(day, n) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** Readable time in a zone, e.g. "Oct 5, 2026, 9:02 AM EDT". */
export function formatIn(iso, tz, {date = true} = {}) {
 const at = new Date(iso); if (!iso || Number.isNaN(at.getTime())) return 'Not recorded';
 return at.toLocaleString('en-US', {timeZone: validTimezone(tz) ? tz : 'America/New_York', ...(date ? {year: 'numeric', month: 'short', day: 'numeric'} : {}), hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).replace(/[\u202f\u00a0]/g, ' ');
}

/* ---------- Svix-style webhook signatures (used by Seam) ---------- */
function svixKey(secret) { const s = String(secret || ''); if (!s) throw Error('Webhook secret is not configured.'); return Buffer.from(s.startsWith('whsec_') ? s.slice(6) : s, 'base64'); }
export function svixSign({id, timestamp, body, secret}) { return 'v1,' + createHmac('sha256', svixKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64'); }
/**
 * Verify Svix headers (svix-id, svix-timestamp, svix-signature) over the exact raw body. Rejects missing headers, a
 * timestamp more than `toleranceSeconds` from now (replay protection) and any signature that does not match.
 */
export function verifySvix({headers, body, secret, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)}) {
 const h = k => headers[k] ?? headers[k.replace('svix', 'webhook')];
 const msgId = String(h('svix-id') || ''), ts = String(h('svix-timestamp') || ''), sig = String(h('svix-signature') || '');
 if (!msgId || !/^\d+$/.test(ts) || !sig) throw Object.assign(Error('Missing webhook signature.'), {status: 401});
 if (Math.abs(nowSeconds - Number(ts)) > toleranceSeconds) throw Object.assign(Error('Webhook timestamp is too old.'), {status: 401});
 const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
 const expected = Buffer.from(svixSign({id: msgId, timestamp: ts, body: raw, secret}).slice(3), 'base64');
 const ok = sig.split(' ').some(part => { const [version, value] = part.split(','); if (version !== 'v1' || !value) return false; const given = Buffer.from(value, 'base64'); return given.length === expected.length && timingSafeEqual(given, expected); });
 if (!ok) throw Object.assign(Error('Invalid webhook signature.'), {status: 401});
 return {id: msgId, timestamp: Number(ts)};
}

/* ---------- Signed callback URLs (for services that cannot sign their requests) ---------- */
export function signToken(secret, value) { if (!secret) throw Error('Callback secret is not configured.'); return createHmac('sha256', String(secret)).update(String(value)).digest('base64url'); }
export function verifyToken(secret, value, token) {
 if (!secret || typeof token !== 'string' || !token) return false;
 const expected = Buffer.from(signToken(secret, value)), given = Buffer.from(token);
 return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Read a request body as raw bytes with a size limit (webhooks must verify the exact bytes that were signed). */
export async function readRaw(req, limit = 1024 * 1024) {
 const chunks = []; let length = 0;
 for await (const chunk of req) { length += chunk.length; if (length > limit) throw Object.assign(Error('Payload too large.'), {status: 413}); chunks.push(chunk); }
 return Buffer.concat(chunks);
}
