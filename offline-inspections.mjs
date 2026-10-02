// Offline mobile inspections: replay-safe writes (Idempotency-Key) and the per-user offline visit snapshot.
// Everything here is scoped to the caller's company and the residences their role can operate.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = value => typeof value === 'string' && UUID.test(value);
export const IDEMPOTENT_ROUTES = new Set(['/api/inspections', '/api/inspections/save', '/api/inspections/submit', '/api/inspections/publish', '/api/files']);
const KEY_TTL_MS = 30 * 24 * 3600000, STALE_CLAIM_MS = 120000;

/** Parse a device capture time. Returns an ISO string, or null when missing or implausible. */
export function captureTime(value, reference = Date.now()) {
 if (value == null || value === '') return null;
 const t = Date.parse(String(value));
 if (!Number.isFinite(t) || t > reference + 24 * 3600000 || t < reference - 365 * 24 * 3600000) return null;
 return new Date(t).toISOString();
}

/** Validation used when a field tech marks a visit complete (stricter than drafts: N/A needs a reason). */
export function submissionProblems(row) {
 const answers = JSON.parse(row.answers || '[]'), problems = [];
 const open = answers.filter(a => a.status === 'unchecked').length;
 if (open) problems.push(`${open} checklist item${open === 1 ? '' : 's'} still need a result.`);
 const naWithoutNote = answers.filter(a => a.status === 'na' && !String(a.note || '').trim()).length;
 if (naWithoutNote) problems.push(`Add a note to ${naWithoutNote} item${naWithoutNote === 1 ? '' : 's'} marked Not applicable.`);
 if (!String(row.summary || '').trim()) problems.push('Add an inspection summary.');
 return problems;
}

export function createOfflineInspections({ get, all, run, body, json, fail, roles, property, entity, hash, now, template }) {
 /** Wrap a mutating handler so a repeated Idempotency-Key replays the first successful response instead of writing twice. */
 async function idempotent(req, res, url, user, handler) {
  const key = req.headers['idempotency-key'];
  if (!user || req.method !== 'POST' || !key || !IDEMPOTENT_ROUTES.has(url.pathname)) return handler();
  if (!isUuid(key)) fail(422, 'Idempotency-Key must be a UUID.');
  const b = await body(req), endpoint = url.pathname, org = user.organization_id;
  const requestHash = hash(endpoint + '\n' + JSON.stringify(b));
  let claimed = (await run('INSERT INTO idempotency_keys(organization_id,key,endpoint,user_id,request_hash,status,response,created_at) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT DO NOTHING', org, key, endpoint, user.id, requestHash, '', now())).changes === 1;
  if (!claimed) {
   const saved = await get('SELECT * FROM idempotency_keys WHERE organization_id=? AND key=?', org, key);
   if (!saved) fail(425, 'Please retry this change.');
   if (saved.user_id !== user.id || saved.endpoint !== endpoint || saved.request_hash !== requestHash) fail(422, 'This change ID was already used for a different request.');
   if (Number(saved.status) > 0) {
    res.writeHead(Number(saved.status), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Idempotency-Replayed': 'true' });
    return res.end(saved.response);
   }
   // A previous attempt is still running, or crashed before finishing: take over only stale claims.
   if (Date.parse(saved.created_at) > Date.now() - STALE_CLAIM_MS) fail(425, 'This change is still being saved. It will retry automatically.');
   claimed = (await run('UPDATE idempotency_keys SET created_at=? WHERE organization_id=? AND key=? AND status=0 AND created_at=?', now(), org, key, saved.created_at)).changes === 1;
   if (!claimed) fail(425, 'This change is still being saved. It will retry automatically.');
  }
  let status = 200; const chunks = [], writeHead = res.writeHead.bind(res), end = res.end.bind(res);
  res.writeHead = (code, ...rest) => { status = code; return writeHead(code, ...rest); };
  res.end = (chunk, ...rest) => { if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk)); return end(chunk, ...rest); };
  const release = () => run('DELETE FROM idempotency_keys WHERE organization_id=? AND key=? AND status=0', org, key);
  try { await handler(); }
  catch (error) { await release(); throw error; }
  if (status >= 200 && status < 300) await run('UPDATE idempotency_keys SET status=?,response=? WHERE organization_id=? AND key=?', status, Buffer.concat(chunks).toString(), org, key);
  else await release();
 }
 const purge = () => run('DELETE FROM idempotency_keys WHERE created_at<?', new Date(Date.now() - KEY_TTL_MS).toISOString());

 const inspectionFields = (i, names) => ({ id: i.id, property_id: i.property_id, inspector_id: i.inspector_id, inspector_name: names.get(i.inspector_id) || 'Not recorded', inspection_date: i.inspection_date, status: i.status, answers: JSON.parse(i.answers || '[]'), summary: i.summary, notes: i.notes, internal_notes: i.internal_notes, version: i.version, frequency: i.frequency, next_due: i.next_due, report_email: i.report_email, published_at: i.published_at, submitted_at: i.submitted_at, template_id: i.template_id ?? null, template_version: i.template_version ?? null, visit_type: i.visit_type || 'routine', created_at: i.created_at });

 /** GET routes. Returns true when handled. */
 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (p === '/api/offline/visits' && req.method === 'GET') {
   roles(user, 'admin', 'employee');
   const requested = String(url.searchParams.get('propertyIds') || '').split(',').map(s => s.trim()).filter(Boolean);
   if (requested.length > 100) fail(422, 'Choose at most 100 residences.');
   const homes = [];
   for (const propertyId of [...new Set(requested)]) { try { homes.push(await property(user, propertyId, 'operate')); } catch { /* skip residences this user cannot operate */ } }
   const ids = homes.map(h => h.id), marks = ids.map(() => '?').join(',');
   const names = new Map((await all('SELECT id,name FROM users WHERE organization_id=?', user.organization_id)).map(u => [u.id, u.name]));
   let visits = [], files = [];
   if (ids.length) {
    const open = await all(`SELECT * FROM inspections WHERE property_id IN (${marks}) AND status IN ('draft','submitted') ORDER BY inspection_date`, ...ids);
    const lastPublished = [];
    for (const id of ids) { const row = await get("SELECT * FROM inspections WHERE property_id=? AND status='published' ORDER BY inspection_date DESC,published_at DESC LIMIT 1", id); if (row) lastPublished.push(row); }
    visits = [...open, ...lastPublished].map(i => inspectionFields(i, names));
    const visitIds = open.map(i => i.id);
    if (visitIds.length) files = await all(`SELECT id,property_id,inspection_id,name,mime,bytes,created_at,captured_at FROM files WHERE inspection_id IN (${visitIds.map(() => '?').join(',')}) ORDER BY created_at`, ...visitIds);
   }
   const client = new Map((await all('SELECT id,name FROM clients WHERE organization_id=?', user.organization_id)).map(c => [c.id, c.name]));
   const settings = await get('SELECT logo_data FROM workspace_settings WHERE organization_id=?', user.organization_id);
   json(res, 200, {
    generatedAt: now(),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    company: (await get('SELECT name FROM organizations WHERE id=?', user.organization_id))?.name || '',
    companyLogo: settings?.logo_data || '',
    // Visits are not linked to checklist templates yet (inspections.template_id is never set), so the built-in checklist is what every visit uses.
    checklist: { source: 'built-in', template_id: null, template_version: null, items: template },
    template,
    properties: homes.map(h => ({ id: h.id, name: h.name, address: h.address, client_id: h.client_id, client_name: client.get(h.client_id) || '', account_manager_id: h.account_manager_id, account_manager_name: names.get(h.account_manager_id) || '', timezone: h.timezone || '', room_profile: h.room_profile, inspection_report_email: h.inspection_report_email || '' })),
    inspections: visits,
    files
   });
   return true;
  }
  const match = /^\/api\/offline\/inspections\/([^/]+)$/.exec(p);
  if (match && req.method === 'GET') {
   roles(user, 'admin', 'employee');
   const row = await entity(user, 'inspections', decodeURIComponent(match[1]), 'operate');
   const names = new Map([[row.inspector_id, (await get('SELECT name FROM users WHERE id=?', row.inspector_id))?.name]]);
   json(res, 200, { inspection: inspectionFields(row, names) });
   return true;
  }
  return false;
 }
 return { idempotent, handle, purge };
}
