// GPS and timestamp proof of visit (per-company feature flag `visit_verification_enabled`, default off).
// Check-in / check-out record one device position each, with device time and server time. Location is captured only at
// check-in, check-out and photo events; nothing is tracked continuously. Distances are computed here (haversine).
// Everything is scoped to the caller's company; employees operate only residences they can operate; clients see a
// sanitized summary with no coordinates; vendors see nothing.
import './public/visit-verification.js';
import {readExif, exifTime, stripLocation} from './exif.mjs';
export const EAVisit = globalThis.EAVisit;
const V = EAVisit;
const ROUTE = /^\/api\/inspections\/([^/]+)\/(check-in|check-out|visit\/override)$/;
export const VISIT_IDEMPOTENT_ROUTE = ROUTE;
const SOURCES = new Set(['gps', 'denied', 'unavailable', 'timeout', 'unsupported', 'auto']);
const bool = v => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clampRadius = v => { const n = num(v); if (n === null) return null; if (n < 25 || n > 2000) return NaN; return Math.round(n); };

export function reportInitials(name) {
 const words = String(name || '').normalize('NFKD').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
 const letters = words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
 return letters || 'RES';
}

export function createVisitVerification({get, all, run, transaction, id, now, fail, json, body, roles, property, entity, audit, captureTime, env = process.env}) {
 async function settings(orgId) {
  const s = await get('SELECT visit_verification_enabled,require_check_in_to_start,geofence_radius_m,show_verification_on_pdf,capture_photo_location,timezone FROM workspace_settings WHERE organization_id=?', orgId) || {};
  return {
   enabled: Number(s.visit_verification_enabled || 0) === 1,
   requireCheckIn: Number(s.require_check_in_to_start || 0) === 1,
   radius: num(s.geofence_radius_m) ?? V.DEFAULT_RADIUS,
   showOnPdf: s.show_verification_on_pdf === undefined || s.show_verification_on_pdf === null ? true : Number(s.show_verification_on_pdf) === 1,
   capturePhotoLocation: s.capture_photo_location === undefined || s.capture_photo_location === null ? true : Number(s.capture_photo_location) === 1,
   timezone: V.validTimezone(s.timezone) ? s.timezone : null
  };
 }
 const geo = (p, s) => ({lat: num(p?.latitude), lon: num(p?.longitude), radius: num(p?.geofence_radius_m) ?? s.radius});
 const timezoneFor = (p, s) => V.effectiveTimezone(p, s.timezone);
 const visitRow = inspectionId => get('SELECT * FROM inspection_visits WHERE inspection_id=?', inspectionId);
 const userName = async userId => (userId ? (await get('SELECT name FROM users WHERE id=?', userId))?.name || '' : '');
 const fullFor = (user, row, inspection) => user.role === 'admin' || (['employee', 'inspector'].includes(user.role) && (row?.check_in_user_id === user.id || inspection?.inspector_id === user.id));
 async function shape(user, row, inspection) {
  if (!row) return null;
  const full = fullFor(user, row, inspection);
  return V.publicVisit(row, {full, overrideByName: await userName(row.override_by), checkInName: full ? await userName(row.check_in_user_id) : ''});
 }

 function readEvent(b, which) {
  const lat = num(b.latitude), lon = num(b.longitude), hasPosition = V.validCoord(lat, lon);
  const accuracy = hasPosition ? Math.min(Math.max(num(b.accuracy) ?? 0, 0), 100000) : null;
  let source = String(b.source || (hasPosition ? 'gps' : 'unavailable'));
  if (!SOURCES.has(source)) source = hasPosition ? 'gps' : 'unavailable';
  if (hasPosition) source = 'gps';
  const noteText = b.note == null ? '' : String(b.note).trim().slice(0, 500);
  return {lat: hasPosition ? lat : null, lon: hasPosition ? lon : null, accuracy, source, offline: bool(b.offline), deviceAt: captureTime(b.deviceAt), note: noteText, auto: which === 'check_out' && bool(b.auto)};
 }

 /** Record a check-in or check-out. The first one wins; a repeat can only add the reason note (after "outside"). */
 async function record(user, inspectionId, which, b, sentAt) {
  roles(user, 'admin', 'employee', 'inspector');
  const inspection = await entity(user, 'inspections', inspectionId, 'operate');
  const s = await settings(user.organization_id);
  const existing = await visitRow(inspection.id);
  if (!s.enabled && !existing) return {visit: null, disabled: true};
  const e = readEvent(b, which), serverAt = now();
  if (existing?.[which + '_server_at']) {
   if (e.note && !existing[which + '_note']) { await run(`UPDATE inspection_visits SET ${which}_note=?,updated_at=? WHERE id=?`, e.note, serverAt, existing.id); await audit(user, `inspection.${which === 'check_in' ? 'check_in' : 'check_out'}_reason`, inspection.id); }
   const fresh = await visitRow(inspection.id);
   return {visit: await shape(user, fresh, inspection), status: fresh.verification_status, repeated: true};
  }
  if (inspection.status === 'published' || (which === 'check_out' && !existing?.check_in_server_at)) {
   // A late check-out (or one with no check-in) changes nothing; the report already stands.
   return {visit: await shape(user, existing, inspection), status: existing?.verification_status || 'pending', ignored: true};
  }
  if (which === 'check_in' && inspection.status !== 'draft') return {visit: await shape(user, existing, inspection), status: existing?.verification_status || 'pending', ignored: true};
  const pRow = await get('SELECT * FROM properties WHERE id=?', inspection.property_id);
  const residence = geo(pRow, s), radius = existing?.radius_m ?? residence.radius;
  const evaluation = V.evaluate({lat: e.lat, lon: e.lon, accuracy: e.accuracy}, {...residence, radius});
  const skew = V.clockSkew({deviceAt: e.deviceAt, serverAt, sentAt: captureTime(sentAt), offline: e.offline});
  await transaction(async () => {
   if (!existing) await run('INSERT INTO inspection_visits(id,organization_id,inspection_id,property_id,radius_m,verification_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(inspection_id) DO NOTHING', id(), user.organization_id, inspection.id, inspection.property_id, radius, 'pending', serverAt, serverAt);
   const changed = await run(`UPDATE inspection_visits SET ${which}_user_id=?,${which}_server_at=?,${which}_device_at=?,${which}_lat=?,${which}_lon=?,${which}_accuracy_m=?,${which}_distance_m=?,${which}_source=?,${which}_offline=?,${which}_note=?,${which === 'check_out' ? 'check_out_auto=?,' : ''}clock_skew=CASE WHEN clock_skew=1 OR ?=1 THEN 1 ELSE 0 END,updated_at=? WHERE inspection_id=? AND ${which}_server_at IS NULL`,
    user.id, serverAt, e.deviceAt, e.lat, e.lon, e.accuracy, evaluation.distance, e.source, e.offline ? 1 : 0, e.note || null, ...(which === 'check_out' ? [e.auto ? 1 : 0] : []), skew ? 1 : 0, serverAt, inspection.id);
   if (changed.changes === 1) await finish(inspection.id);
  });
  await audit(user, which === 'check_in' ? 'inspection.checked_in' : 'inspection.checked_out', inspection.id);
  const fresh = await visitRow(inspection.id);
  return {visit: await shape(user, fresh, inspection), status: fresh.verification_status};
 }
 /** Recompute the stored status and time on site after any change. */
 async function finish(inspectionId) {
  const row = await visitRow(inspectionId); if (!row) return;
  const start = Date.parse(V.publicVisit(row).check_in?.at || ''), end = Date.parse(V.publicVisit(row).check_out?.at || '');
  const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : null;
  await run('UPDATE inspection_visits SET verification_status=?,duration_seconds=? WHERE id=?', V.overallStatus(row), duration, row.id);
 }
 /** Submit/publish of a visit that is checked in but not out: check out automatically (flagged as automatic). */
 async function autoCheckOut(user, inspection) {
  const row = await visitRow(inspection.id);
  if (!row || !row.check_in_server_at || row.check_out_server_at) return false;
  const at = now();
  const changed = await run("UPDATE inspection_visits SET check_out_user_id=?,check_out_server_at=?,check_out_source='auto',check_out_auto=1,updated_at=? WHERE id=? AND check_out_server_at IS NULL", user.id, at, at, row.id);
  if (changed.changes === 1) { await finish(inspection.id); await audit(user, 'inspection.auto_checked_out', inspection.id); }
  return changed.changes === 1;
 }
 async function override(user, inspectionId, b) {
  roles(user, 'admin');
  const inspection = await entity(user, 'inspections', inspectionId, 'operate');
  const reason = String(b.reason ?? '').trim();
  if (reason.length < 10 || reason.length > 500) fail(422, 'Give a reason of at least 10 characters.');
  const at = now();
  await transaction(async () => {
   const pRow = await get('SELECT * FROM properties WHERE id=?', inspection.property_id);
   await run('INSERT INTO inspection_visits(id,organization_id,inspection_id,property_id,radius_m,verification_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(inspection_id) DO NOTHING', id(), user.organization_id, inspection.id, inspection.property_id, geo(pRow, await settings(user.organization_id)).radius, 'pending', at, at);
   await run('UPDATE inspection_visits SET override_by=?,override_at=?,override_reason=?,updated_at=? WHERE inspection_id=?', user.id, at, reason, at, inspection.id);
   await finish(inspection.id);
   await audit(user, 'inspection.visit_override', inspection.id);
  });
  const fresh = await visitRow(inspection.id);
  return {visit: await shape(user, fresh, inspection), status: fresh.verification_status};
 }
 /** require_check_in_to_start: nothing may be recorded on a visit that has not been checked in. */
 async function assertCheckedIn(user, inspection, answers) {
  const s = await settings(user.organization_id);
  if (!s.enabled || !s.requireCheckIn) return;
  const recorded = (answers || []).some(a => (a.status && !['unchecked', ''].includes(a.status)) || (a.value != null && a.value !== '' && a.value !== '[]'));
  if (!recorded) return;
  if (!(await visitRow(inspection.id))?.check_in_server_at) fail(422, 'Check in at the residence before recording the inspection.');
 }
 /** Report number {INITIALS}-{YYYYMMDD}-{n}, unique per residence. Call inside the publish transaction. */
 async function reportNumber(inspection, pRow) {
  // Row lock on the residence (Postgres) so concurrent publishes at one residence number in turn; harmless in SQLite.
  await run('UPDATE properties SET name=name WHERE id=?', pRow.id);
  const prefix = `${reportInitials(pRow.name)}-${String(inspection.inspection_date || now().slice(0, 10)).replace(/-/g, '').slice(0, 8)}-`;
  const used = (await all('SELECT report_number FROM inspections WHERE property_id=? AND report_number LIKE ?', pRow.id, prefix + '%')).map(r => Number(String(r.report_number).slice(prefix.length)) || 0);
  return prefix + (Math.max(0, ...used) + 1);
 }
 /** Fields added to a report snapshot at publish. */
 async function publishFields(user, inspection, pRow) {
  const s = await settings(user.organization_id);
  const fields = {timezone: timezoneFor(pRow, s)};
  if (!s.enabled) return {fields, number: null};
  return {fields: {...fields, visitVerification: true}, number: await reportNumber(inspection, pRow)};
 }
 /**
  * Report → PDF input. Times always show in the residence's current zone (residence → company → Eastern), including
  * reports published before the time zone fix (they stored the residence default, which was always Eastern). The
  * verification box appears only for reports published with the feature on, and reads the live visit row so a later
  * admin override shows.
  */
 async function reportForPdf(user, inspection, report) {
  const s = await settings(user.organization_id);
  const pRow = await get('SELECT * FROM properties WHERE id=?', inspection.property_id);
  const out = {...report};
  if (pRow) out.timezone = timezoneFor(pRow, s);
  if (report.visitVerification && s.showOnPdf) {
   const row = await visitRow(inspection.id);
   out.visit = V.describe(V.publicVisit(row, {overrideByName: await userName(row?.override_by)}) || {status: 'pending'}, out.timezone);
   if (out.visit.status === 'pending') out.visit = {...out.visit, label: 'Not checked in', rows: [['Arrived', 'The inspector did not check in on this visit']]};
   Object.defineProperty(out, 'residenceGeo', {value: geo(pRow, s), enumerable: false});
  }
  return out;
 }
 /** Photo caption flag: the photo's own position is inside the residence area. */
 const photoAtResidence = (file, report) => (report.residenceGeo ? V.photoAtResidence(file, report.residenceGeo) : false);

 /** Uploaded JPEG bytes: always strip GPS/XMP; with the feature on, keep EXIF time/position (or the device position) as columns. */
 async function uploadMeta(user, pRow, b, bytes, isJpeg) {
  const s = await settings(user.organization_id);
  const meta = {bytes, capturedAt: captureTime(b.capturedAt), lat: null, lon: null, accuracy: null, source: null};
  if (!isJpeg) return meta;
  const exif = readExif(bytes);
  if (exif) meta.bytes = stripLocation(bytes);
  if (!s.enabled || !s.capturePhotoLocation) return meta;
  const lat = num(b.captureLatitude), lon = num(b.captureLongitude);
  if (V.validCoord(lat, lon)) Object.assign(meta, {lat, lon, accuracy: num(b.captureAccuracy), source: 'device'});
  else if (exif && V.validCoord(exif.lat, exif.lon)) Object.assign(meta, {lat: exif.lat, lon: exif.lon, accuracy: exif.accuracy, source: 'exif'});
  if (!meta.capturedAt && exif?.dateTimeOriginal) meta.capturedAt = captureTime(exifTime(exif, timezoneFor(pRow, s)));
  return meta;
 }

 /** /api/data additions: settings, effective time zones, per-visit summaries sanitized by role. */
 async function decorate(user, data) {
  const s = await settings(user.organization_id);
  const staff = ['admin', 'employee', 'inspector'].includes(user.role); // field inspectors check in like staff
  data.companyTimezone = s.timezone || '';
  data.visitVerification = staff ? {...s, notice: V.NOTICE, geocoding: !!env.GEOAPIFY_API_KEY} : {enabled: s.enabled, showOnPdf: s.showOnPdf};
  if (!staff) for (const f of data.files || []) for (const k of ['capture_lat', 'capture_lon', 'capture_accuracy_m', 'capture_source']) delete f[k];
  const homes = new Map();
  for (const p of data.properties || []) {
   homes.set(p.id, p);
   if (user.role === 'vendor') continue;
   p.effective_timezone = timezoneFor(p, s);
   if (!staff) for (const k of ['latitude', 'longitude', 'geocoded_at', 'geocode_source', 'geocoded_address', 'geofence_radius_m', 'timezone_source']) delete p[k];
   else p.effective_radius_m = geo(p, s).radius;
  }
  if (user.role === 'vendor' || !(data.inspections || []).length) return data;
  const rows = new Map((await all('SELECT * FROM inspection_visits WHERE organization_id=?', user.organization_id)).map(r => [r.inspection_id, r]));
  const marked = user.role === 'client' ? new Set((await all(`SELECT i.id FROM inspections i JOIN properties p ON p.id=i.property_id WHERE p.organization_id=? AND i.status='published' AND i.report_snapshot LIKE '%"visitVerification":true%'`, user.organization_id)).map(r => r.id)) : null;
  const names = new Map((await all('SELECT id,name FROM users WHERE organization_id=?', user.organization_id)).map(u => [u.id, u.name]));
  for (const i of data.inspections) {
   const row = rows.get(i.id);
   if (user.role === 'client') {
    if (!marked.has(i.id) || !s.showOnPdf) continue;
    i.visit = row ? V.publicVisit(row, {overrideByName: names.get(row.override_by) || ''}) : {status: 'pending', check_in: null, check_out: null, duration_seconds: null, override: null, clock_skew: false};
    continue;
   }
   if (!row && !s.enabled) continue;
   i.visit = row ? V.publicVisit(row, {full: fullFor(user, row, i), overrideByName: names.get(row.override_by) || '', checkInName: names.get(row.check_in_user_id) || ''}) : null;
  }
  return data;
 }
 /** /api/offline/visits additions, so check-in works with no signal. */
 async function decorateOffline(user, payload) {
  const s = await settings(user.organization_id);
  payload.visitVerification = {...s, notice: V.NOTICE};
  const ids = payload.properties.map(p => p.id);
  const full = ids.length ? await all(`SELECT id,latitude,longitude,geofence_radius_m,timezone,timezone_source FROM properties WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const byId = new Map(full.map(r => [r.id, r]));
  for (const p of payload.properties) { const r = byId.get(p.id) || {}; Object.assign(p, {latitude: num(r.latitude), longitude: num(r.longitude), geofence_radius_m: num(r.geofence_radius_m), timezone_source: r.timezone_source || null, effective_radius_m: geo(r, s).radius, effective_timezone: timezoneFor(r, s)}); }
  const visitIds = payload.inspections.map(i => i.id);
  if (visitIds.length) {
   const rows = new Map((await all(`SELECT * FROM inspection_visits WHERE inspection_id IN (${visitIds.map(() => '?').join(',')})`, ...visitIds)).map(r => [r.inspection_id, r]));
   for (const i of payload.inspections) { const row = rows.get(i.id); if (row) i.visit = V.publicVisit(row, {full: fullFor(user, row, i)}); }
  }
  return payload;
 }

 // ---- residence location (admin) and geocoding ----
 const geoapifyBase = () => (env.GEOAPIFY_BASE_URL || 'https://api.geoapify.com').replace(/\/$/, '');
 async function geocodeAddress(address) {
  if (!env.GEOAPIFY_API_KEY) fail(503, 'Address lookup is not configured. Enter the coordinates, or use your current location while at the residence.');
  let remote;
  try { remote = await fetch(geoapifyBase() + '/v1/geocode/search?text=' + encodeURIComponent(address) + '&limit=1&format=json&apiKey=' + encodeURIComponent(env.GEOAPIFY_API_KEY), {signal: AbortSignal.timeout(10000)}); } catch { return null; }
  if (!remote.ok) return null;
  const r = (await remote.json())?.results?.[0];
  if (!r || !V.validCoord(r.lat, r.lon)) return null;
  return {lat: Number(r.lat), lon: Number(r.lon), timezone: V.validTimezone(r.timezone?.name) ? r.timezone.name : null, formatted: r.formatted || address};
 }
 async function applyGeocode(pRow, result) {
  const at = now();
  if (!result) { await run("UPDATE properties SET geocode_source='geoapify_failed',geocoded_address=?,geocoded_at=? WHERE id=? AND (geocode_source IS NULL OR geocode_source LIKE 'geoapify%')", pRow.address, at, pRow.id); return false; }
  await run("UPDATE properties SET latitude=?,longitude=?,geocode_source='geoapify',geocoded_address=?,geocoded_at=? WHERE id=?", result.lat, result.lon, pRow.address, at, pRow.id);
  if (result.timezone && !pRow.timezone_source) await run("UPDATE properties SET timezone=?,timezone_source='geocode' WHERE id=? AND timezone_source IS NULL", result.timezone, pRow.id);
  return true;
 }
 async function setLocation(user, b) {
  roles(user, 'admin');
  const pRow = await property(user, b.id, 'operate');
  const at = now();
  if (b.geocode === true) {
   const result = await geocodeAddress(pRow.address || '');
   if (!result) fail(422, 'That address could not be found. Enter the coordinates, or use your current location while at the residence.');
   await applyGeocode({...pRow, timezone_source: b.timezone !== undefined ? 'keep' : pRow.timezone_source}, result);
  } else if (b.latitude !== undefined || b.longitude !== undefined) {
   const lat = num(b.latitude), lon = num(b.longitude);
   if (lat === null && lon === null) await run('UPDATE properties SET latitude=NULL,longitude=NULL,geocode_source=NULL,geocoded_address=NULL,geocoded_at=NULL WHERE id=?', pRow.id);
   else {
    if (!V.validCoord(lat, lon)) fail(422, 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.');
    const source = b.source === 'device' ? 'device' : 'manual';
    await run('UPDATE properties SET latitude=?,longitude=?,geocode_source=?,geocoded_address=?,geocoded_at=? WHERE id=?', lat, lon, source, pRow.address, at, pRow.id);
   }
  }
  if (b.radius !== undefined) { const r = clampRadius(b.radius); if (Number.isNaN(r)) fail(422, 'The residence area must be between 25 and 2000 metres.'); await run('UPDATE properties SET geofence_radius_m=? WHERE id=?', r, pRow.id); }
  if (b.timezone !== undefined) {
   if (b.timezone === '' || b.timezone === null) await run('UPDATE properties SET timezone_source=NULL WHERE id=?', pRow.id);
   else { if (!V.validTimezone(b.timezone)) fail(422, 'Choose a valid time zone.'); await run("UPDATE properties SET timezone=?,timezone_source='manual' WHERE id=?", b.timezone, pRow.id); }
  }
  await audit(user, 'property.location_updated', pRow.id);
  const fresh = await get('SELECT id,latitude,longitude,geocode_source,geocoded_address,geocoded_at,geofence_radius_m,timezone,timezone_source FROM properties WHERE id=?', pRow.id);
  return {...fresh, effective_timezone: timezoneFor(fresh, await settings(user.organization_id))};
 }
 /** Residence create/update: keep coordinates picked from address autocomplete; clear stale geocodes when the address changes. */
 async function afterAddressSave(propertyId, b, previous) {
  const lat = num(b.geoLatitude), lon = num(b.geoLongitude), at = now();
  const row = await get('SELECT * FROM properties WHERE id=?', propertyId); if (!row) return;
  if (V.validCoord(lat, lon)) {
   await run("UPDATE properties SET latitude=?,longitude=?,geocode_source='geoapify',geocoded_address=?,geocoded_at=? WHERE id=? AND (geocode_source IS NULL OR geocode_source LIKE 'geoapify%')", lat, lon, row.address, at, propertyId);
   if (V.validTimezone(b.geoTimezone) && !row.timezone_source) await run("UPDATE properties SET timezone=?,timezone_source='geocode' WHERE id=? AND timezone_source IS NULL", b.geoTimezone, propertyId);
  } else if (previous && previous.address !== row.address && (!row.geocode_source || row.geocode_source.startsWith('geoapify'))) {
   await run('UPDATE properties SET latitude=NULL,longitude=NULL,geocode_source=NULL,geocoded_address=NULL,geocoded_at=NULL WHERE id=?', propertyId);
  }
 }
 /** Background geocoding: only companies with the feature on, only with GEOAPIFY_API_KEY, about one request a second. */
 async function geocodePending(limit = 25) {
  if (!env.GEOAPIFY_API_KEY) return 0;
  const rows = await all(`SELECT p.* FROM properties p JOIN workspace_settings w ON w.organization_id=p.organization_id WHERE w.visit_verification_enabled=1 AND p.archived_at IS NULL AND p.address<>'' AND ((p.latitude IS NULL AND (p.geocode_source IS NULL OR (p.geocode_source='geoapify_failed' AND p.geocoded_address<>p.address))) OR (p.geocode_source='geoapify' AND p.geocoded_address<>p.address)) LIMIT ${Math.max(1, Math.min(100, limit))}`);
  let done = 0;
  for (const pRow of rows) {
   if (done) await new Promise(r => setTimeout(r, Number(env.ESTATEOS_GEOCODE_DELAY_MS ?? 1100)));
   try { await applyGeocode(pRow, await geocodeAddress(pRow.address)); done++; } catch (error) { console.error('Geocode:', error.message); break; }
  }
  return done;
 }
 function startGeocoder() {
  if (!env.GEOAPIFY_API_KEY) return null;
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await geocodePending(); } catch (error) { console.error('Geocode job:', error.message); } finally { busy = false; } };
  const timer = setInterval(tick, Number(env.ESTATEOS_GEOCODE_INTERVAL_MS || 60000)); timer.unref?.();
  setTimeout(tick, 2000).unref?.();
  return timer;
 }

 async function saveSettings(user, b) {
  roles(user, 'admin');
  const radius = clampRadius(b.radius);
  if (Number.isNaN(radius)) fail(422, 'The residence area must be between 25 and 2000 metres.');
  if (b.timezone && !V.validTimezone(b.timezone)) fail(422, 'Choose a valid time zone.');
  const values = [bool(b.enabled) ? 1 : 0, bool(b.requireCheckIn) ? 1 : 0, radius ?? V.DEFAULT_RADIUS, bool(b.showOnPdf) ? 1 : 0, bool(b.capturePhotoLocation) ? 1 : 0, b.timezone || null];
  await run('INSERT INTO workspace_settings(organization_id,visit_verification_enabled,require_check_in_to_start,geofence_radius_m,show_verification_on_pdf,capture_photo_location,timezone) VALUES(?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET visit_verification_enabled=excluded.visit_verification_enabled,require_check_in_to_start=excluded.require_check_in_to_start,geofence_radius_m=excluded.geofence_radius_m,show_verification_on_pdf=excluded.show_verification_on_pdf,capture_photo_location=excluded.capture_photo_location,timezone=excluded.timezone', user.organization_id, ...values);
  await audit(user, 'workspace.visit_verification_updated', user.organization_id);
  return settings(user.organization_id);
 }

 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (req.method !== 'POST') return false;
  const m = ROUTE.exec(p);
  if (m) {
   if (!user) fail(401, 'Please sign in.');
   const b = await body(req), inspectionId = decodeURIComponent(m[1]);
   const result = m[2] === 'visit/override' ? await override(user, inspectionId, b) : await record(user, inspectionId, m[2] === 'check-in' ? 'check_in' : 'check_out', b, url.searchParams.get('sentAt'));
   json(res, 200, result); return true;
  }
  if (p === '/api/visit-verification/settings') { if (!user) fail(401, 'Please sign in.'); json(res, 200, await saveSettings(user, await body(req))); return true; }
  if (p === '/api/properties/location') { if (!user) fail(401, 'Please sign in.'); json(res, 200, await setLocation(user, await body(req))); return true; }
  return false;
 }
 return {settings, timezoneFor, handle, record, autoCheckOut, assertCheckedIn, publishFields, reportForPdf, photoAtResidence, uploadMeta, decorate, decorateOffline, afterAddressSave, geocodePending, startGeocoder, visitRow};
}
