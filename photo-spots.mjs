// Repeat-angle photo baselines. Each residence can have named photo spots (for example "Kitchen sink cabinet"),
// each with a baseline photo. On a visit the camera opens with the baseline as a see-through overlay so the new
// photo is taken from the same angle; the photo is tied to the spot (also when it was taken offline: the offline
// photo upload carries the spot ID). Every spot has a dated timeline, visit reports and the client portal show
// before/after side by side, the inspection PDF gets a "Photo comparisons" section and the storm report pairs
// pre-storm and post-storm photos of the same spot.
//
// Permissions: admins and staff who can work at the residence add and edit spots, take photos and set a new
// baseline; only admins archive a spot. Families see their residences' spots, baselines and the photos from
// published visits. Vendors see nothing.
const SPOT_LIMIT = 60;
const ROUTE = /^\/api\/photo-spots(?:\/([^/]+)(?:\/(baseline|archive))?)?$/;
const IMAGE = /^\/api\/photo-spots\/image\/([^/]+)$/;

/** YYYY-MM-DD and a readable date/time for an instant in a time zone. Pure. */
export function takenLabel(iso, timeZone = 'America/New_York') {
 const at = new Date(iso || '');
 if (Number.isNaN(at.getTime())) return {day: '', label: ''};
 const fmt = (o, tz) => new Intl.DateTimeFormat('en-US', {timeZone: tz, ...o}).format(at).replace(/[\u202f\u00a0]/g, ' ');
 let tz = timeZone; try { fmt({year: 'numeric'}, tz); } catch { tz = 'America/New_York'; }
 const day = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'}).format(at);
 return {day, label: fmt({month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}, tz)};
}

/** Pre-storm/post-storm pairs for the same spot: the last pre-storm photo of a spot with the first post-storm photo. Pure.
    shots: [{file_id, spot_id, spot_name, taken}] */
export function spotPairs(shots, preIds, postIds) {
 const pre = new Set(preIds), post = new Set(postIds), bySpot = new Map();
 for (const s of [...shots].sort((a, b) => String(a.taken).localeCompare(String(b.taken)))) {
  if (!pre.has(s.file_id) && !post.has(s.file_id)) continue;
  const e = bySpot.get(s.spot_id) || {name: s.spot_name, before: null, after: null};
  if (pre.has(s.file_id)) e.before = s.file_id; else if (post.has(s.file_id) && !e.after) e.after = s.file_id;
  bySpot.set(s.spot_id, e);
 }
 return [...bySpot.values()].filter(e => e.before && e.after).sort((a, b) => a.name.localeCompare(b.name)).map(e => ({beforeId: e.before, afterId: e.after, spot: e.name}));
}

export function createPhotoSpots({get, all, run, transaction, id, now, fail, json, body, roles, property, audit, visitVerification, readBytes}) {
 const str = (v, label, max, required = false) => {
  if (v == null || v === '') { if (required) fail(422, `Enter the ${label.toLowerCase()}.`); return ''; }
  if (typeof v !== 'string' || v.trim().length > max) fail(422, `${label} must be text of at most ${max} characters.`);
  const t = v.trim(); if (required && !t) fail(422, `Enter the ${label.toLowerCase()}.`); return t;
 };
 const tzOf = async p => { try { return visitVerification.timezoneFor(p, await visitVerification.settings(p.organization_id)) || p.timezone || 'America/New_York'; } catch { return p.timezone || 'America/New_York'; } };
 const staff = user => user.role === 'admin' || user.role === 'employee';
 const spotRow = async (user, spotId) => { const s = await get('SELECT * FROM photo_spots WHERE id=? AND organization_id=?', spotId, user.organization_id); if (!s) fail(404, 'Photo spot not found.'); return s; };
 const published = async inspectionId => (await get('SELECT status FROM inspections WHERE id=?', inspectionId))?.status === 'published';

 // ---------- /api/data ----------
 async function decorate(user, data) {
  if (!['admin', 'employee', 'client'].includes(user.role)) return data;
  const homes = (data.properties || []).filter(p => p && p.id), ids = homes.map(p => p.id);
  if (!ids.length) { data.photoSpots = {canEdit: staff(user), canArchive: user.role === 'admin', spots: [], shots: []}; return data; }
  const q = ids.map(() => '?').join(',');
  const full = await all(`SELECT * FROM properties WHERE organization_id=? AND id IN (${q})`, user.organization_id, ...ids);
  const tz = new Map(); for (const p of full) tz.set(p.id, await tzOf(p));
  const spots = await all(`SELECT * FROM photo_spots WHERE organization_id=? AND property_id IN (${q}) AND archived_at IS NULL ORDER BY created_at,id`, user.organization_id, ...ids);
  const rows = await all(`SELECT s.*,f.name,f.captured_at,f.created_at file_created_at,i.status inspection_status,i.inspection_date FROM photo_spot_shots s JOIN files f ON f.id=s.file_id LEFT JOIN inspections i ON i.id=s.inspection_id WHERE s.organization_id=? AND s.property_id IN (${q}) ORDER BY COALESCE(f.captured_at,f.created_at) DESC,s.file_id`, user.organization_id, ...ids);
  const visible = r => staff(user) || !r.inspection_id || r.inspection_status === 'published';
  const shots = rows.filter(visible), shotIds = new Set(shots.map(r => r.file_id));
  // Baseline photos uploaded on their own (not on a visit) belong to the spot, not to the residence's Documents.
  const spotOnly = new Set(rows.filter(r => !r.inspection_id).map(r => r.file_id));
  if (Array.isArray(data.files)) data.files = data.files.filter(f => !spotOnly.has(f.id));
  const perSpot = new Map();
  const outShots = [];
  for (const r of shots) {
   const n = perSpot.get(r.spot_id) || 0; perSpot.set(r.spot_id, n + 1); if (n >= 80) continue;
   const t = takenLabel(r.captured_at || r.file_created_at, tz.get(r.property_id));
   outShots.push({file_id: r.file_id, spot_id: r.spot_id, inspection_id: r.inspection_id || null, inspection_date: r.inspection_date || null, kind: r.kind, baseline_file_id: r.baseline_file_id && shotIds.has(r.baseline_file_id) ? r.baseline_file_id : null, taken_at: r.captured_at || r.file_created_at, taken_day: t.day, taken_label: t.label, name: r.name});
  }
  data.photoSpots = {canEdit: staff(user), canArchive: user.role === 'admin', limit: SPOT_LIMIT,
   spots: spots.map(s => ({id: s.id, property_id: s.property_id, name: s.name, location: s.location, checklist_key: s.checklist_key || null, checklist_label: s.checklist_label || '', notes: staff(user) ? s.notes : '', baseline_file_id: s.baseline_file_id && shotIds.has(s.baseline_file_id) ? s.baseline_file_id : null, baseline_set_at: s.baseline_set_at, version: s.version, photo_count: perSpot.get(s.id) || 0, timezone: tz.get(s.property_id)})),
   shots: outShots};
  return data;
 }

 // ---------- photo uploads (/api/files with spotId) ----------
 /** Before the upload is stored: the spot must be an active spot at this residence, the photo a JPEG. Null when the upload is not for a spot. */
 async function checkUpload(user, pRow, b, isJpeg) {
  if (b.spotId == null || b.spotId === '') return null;
  if (!staff(user)) fail(403, 'Only staff take photo spot photos.');
  if (typeof b.spotId !== 'string') fail(422, 'Choose a photo spot.');
  const spot = await get('SELECT * FROM photo_spots WHERE id=? AND organization_id=?', b.spotId, user.organization_id);
  if (!spot || spot.property_id !== pRow.id || spot.archived_at) fail(422, 'This photo spot is not at this residence.');
  if (!isJpeg) fail(422, 'Photo spots need a JPEG photo.');
  return spot;
 }
 /** Inside the upload transaction: tie the new file to the spot. A visit photo keeps the baseline in effect; a photo
     taken outside a visit becomes the new baseline, and so does the first photo of a spot without one. */
 async function linkUpload(user, pRow, fileId, b, spot) {
  if (!spot) return;
  const at = now();
  const current = spot.baseline_file_id && await get('SELECT id FROM files WHERE id=?', spot.baseline_file_id) ? spot.baseline_file_id : null;
  const kind = b.inspectionId ? 'visit' : 'baseline';
  await run('INSERT INTO photo_spot_shots(file_id,spot_id,organization_id,property_id,inspection_id,baseline_file_id,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', fileId, spot.id, user.organization_id, pRow.id, b.inspectionId || null, current, kind, user.id, at);
  if (kind === 'baseline' || !current) {
   await run('UPDATE photo_spots SET baseline_file_id=?,baseline_set_at=?,baseline_set_by=?,updated_at=?,version=version+1 WHERE id=?', fileId, at, user.id, at, spot.id);
   await audit(user, 'photo_spot.baseline_set', spot.id);
  }
 }

 // ---------- comparisons for the inspection PDF and the storm report ----------
 /** Before/after pairs for one visit: each spot photo next to the baseline that was in effect when it was taken. */
 async function comparisons(organizationId, inspectionId, timezone) {
  const rows = await all(`SELECT s.file_id,s.baseline_file_id,p.name spot_name,p.location,a.name after_name,a.storage_key after_key,COALESCE(a.captured_at,a.created_at) after_at,b.name before_name,b.storage_key before_key,COALESCE(b.captured_at,b.created_at) before_at
   FROM photo_spot_shots s JOIN photo_spots p ON p.id=s.spot_id JOIN files a ON a.id=s.file_id JOIN files b ON b.id=s.baseline_file_id
   WHERE s.inspection_id=? AND s.organization_id=? AND s.baseline_file_id IS NOT NULL AND s.baseline_file_id<>s.file_id ORDER BY p.name,COALESCE(a.captured_at,a.created_at)`, inspectionId, organizationId);
  const out = [];
  for (const r of rows) {
   try {
    out.push({spot: r.spot_name, location: r.location || '',
     before: {id: r.baseline_file_id, name: r.before_name, bytes: await readBytes(r.before_key), capturedAt: r.before_at, timezone},
     after: {id: r.file_id, name: r.after_name, bytes: await readBytes(r.after_key), capturedAt: r.after_at, timezone}});
   } catch { /* a photo missing from storage is left out of the comparison */ }
  }
  return out;
 }
 async function stormPairs(organizationId, preIds, postIds) {
  const ids = [...preIds, ...postIds]; if (!ids.length) return [];
  const rows = await all(`SELECT s.file_id,s.spot_id,p.name spot_name,COALESCE(f.captured_at,f.created_at) taken FROM photo_spot_shots s JOIN photo_spots p ON p.id=s.spot_id JOIN files f ON f.id=s.file_id WHERE s.organization_id=? AND s.file_id IN (${ids.map(() => '?').join(',')})`, organizationId, ...ids);
  return spotPairs(rows, preIds, postIds);
 }

 // ---------- API ----------
 async function saveSpot(user, b, existing) {
  const fields = {name: str(b.name, 'Spot name', 80, true), location: str(b.location, 'Location or room', 80), checklist_key: str(b.checklistKey, 'Checklist item', 200) || null, checklist_label: str(b.checklistLabel, 'Checklist item', 200), notes: str(b.notes, 'Notes', 500)};
  if (!fields.checklist_key) fields.checklist_label = '';
  return fields;
 }
 async function handle(req, res, url, user) {
  const p = url.pathname, method = req.method;
  if (!p.startsWith('/api/photo-spots')) return false;
  if (!user) fail(401, 'Please sign in.');
  if (!['admin', 'employee', 'client'].includes(user.role)) fail(403, 'Photo spots are not available for this account.');
  const img = p.match(IMAGE);
  if (img && method === 'GET') {
   const shot = await get('SELECT * FROM photo_spot_shots WHERE file_id=? AND organization_id=?', decodeURIComponent(img[1]), user.organization_id);
   if (!shot) fail(404, 'Photo not found.');
   await property(user, shot.property_id, 'read');
   if (user.role === 'client' && shot.inspection_id && !(await published(shot.inspection_id))) fail(404, 'Photo not found.');
   const f = await get('SELECT * FROM files WHERE id=?', shot.file_id);
   if (!f) fail(404, 'Photo not found.');
   const bytes = await readBytes(f.storage_key);
   res.writeHead(200, {'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff'});
   res.end(bytes); return true;
  }
  const m = p.match(ROUTE);
  if (!m || method !== 'POST') fail(404, 'Not found.');
  if (!staff(user)) fail(403, 'Only staff can change photo spots.');
  const b = await body(req), at = now();
  if (!m[1]) {
   const pRow = await property(user, b.propertyId, 'operate');
   const f = await saveSpot(user, b);
   const count = (await get('SELECT COUNT(*) n FROM photo_spots WHERE property_id=? AND archived_at IS NULL', pRow.id))?.n || 0;
   if (Number(count) >= SPOT_LIMIT) fail(422, `A residence can have at most ${SPOT_LIMIT} photo spots.`);
   const key = id();
   await run('INSERT INTO photo_spots(id,organization_id,property_id,name,location,checklist_key,checklist_label,notes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', key, user.organization_id, pRow.id, f.name, f.location, f.checklist_key, f.checklist_label, f.notes, user.id, at, at);
   await audit(user, 'photo_spot.created', key);
   return json(res, 201, {id: key}), true;
  }
  const spot = await spotRow(user, m[1]);
  const pRow = await property(user, spot.property_id, 'operate');
  if (spot.archived_at) fail(409, 'This photo spot was archived.');
  if (!m[2]) {
   const f = await saveSpot(user, b, spot);
   if (b.version != null && Number(b.version) !== Number(spot.version)) fail(409, 'Someone else changed this photo spot. Reload to see the latest.');
   const r = await run('UPDATE photo_spots SET name=?,location=?,checklist_key=?,checklist_label=?,notes=?,updated_at=?,version=version+1 WHERE id=? AND version=?', f.name, f.location, f.checklist_key, f.checklist_label, f.notes, at, spot.id, spot.version);
   if (r && r.changes === 0) fail(409, 'Someone else changed this photo spot. Reload to see the latest.');
   await audit(user, 'photo_spot.updated', spot.id);
   return json(res, 200, {ok: true}), true;
  }
  if (m[2] === 'archive') {
   if (user.role !== 'admin') fail(403, 'Only an administrator can archive a photo spot.');
   await run('UPDATE photo_spots SET archived_at=?,updated_at=?,version=version+1 WHERE id=?', at, at, spot.id);
   await audit(user, 'photo_spot.archived', spot.id);
   return json(res, 200, {ok: true}), true;
  }
  // Set as new baseline: a photo already in this spot's timeline, or another JPEG photo from this residence.
  if (typeof b.fileId !== 'string' || !b.fileId) fail(422, 'Choose a photo.');
  const file = await get('SELECT * FROM files WHERE id=?', b.fileId);
  if (!file || file.property_id !== pRow.id) fail(404, 'Photo not found at this residence.');
  if (file.mime !== 'image/jpeg') fail(422, 'Choose a JPEG photo.');
  if (file.work_order_id) fail(422, 'Use a visit photo or a new photo as the baseline.');
  const shot = await get('SELECT * FROM photo_spot_shots WHERE file_id=?', file.id);
  if (shot && shot.spot_id !== spot.id) fail(422, 'This photo belongs to another photo spot.');
  if (spot.baseline_file_id === file.id) return json(res, 200, {ok: true, unchanged: true}), true;
  await transaction(async () => {
   if (!shot) await run('INSERT INTO photo_spot_shots(file_id,spot_id,organization_id,property_id,inspection_id,baseline_file_id,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', file.id, spot.id, user.organization_id, pRow.id, file.inspection_id || null, spot.baseline_file_id || null, file.inspection_id ? 'visit' : 'baseline', user.id, at);
   await run('UPDATE photo_spots SET baseline_file_id=?,baseline_set_at=?,baseline_set_by=?,updated_at=?,version=version+1 WHERE id=?', file.id, at, user.id, at, spot.id);
   await audit(user, 'photo_spot.baseline_set', spot.id);
  });
  return json(res, 200, {ok: true}), true;
 }
 return {decorate, handle, checkUpload, linkUpload, comparisons, stormPairs};
}
