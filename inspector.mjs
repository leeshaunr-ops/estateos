// Field inspector logins (Oct 2026). An inspector runs the visits assigned to them and nothing else:
//  - Every API request from an inspector must match INSPECTOR_ROUTES (an explicit allow-list). Anything else is refused
//    with 403 before any other handler runs, so a new endpoint is closed to inspectors until it is added here.
//  - Allowed routes that touch a visit check that the visit is assigned to this inspector (404 otherwise, including any
//    other company's records). Door and alarm codes open only on the day of an assigned visit.
//  - /api/data for an inspector is a separate, minimal payload: their open visits, those residences' addresses and room
//    lists, their own photos and notifications. No clients, other people, work orders, invoices, notes or reports.
//  - Inspectors never use an admin/staff seat. They have their own allowance (free up to 2x the plan's seats, then the
//    $5 add-on), enforced in billing.assertCapacity(org,'inspectors').
import {EAChecklist, parseSnapshot} from './visit-checklists.mjs';

export const INSPECTOR = 'inspector';
const path = (method, p, check) => ({method, path: p, check});
const pattern = (method, re, check) => ({method, pattern: re, check});
/** Every request an inspector may make. `check` names an extra ownership rule applied before the handler runs. */
export const INSPECTOR_ROUTES = Object.freeze([
 // Session and account (no privileges involved).
 path('GET', '/api/status'), path('POST', '/api/login'), path('POST', '/api/logout'), path('POST', '/api/accept-invite'),
 path('GET', '/api/invite-info'), path('POST', '/api/password-reset/request'), path('POST', '/api/password-reset'),
 // Their own workspace payload, profile, sign-in security and notifications.
 path('GET', '/api/data'),
 path('POST', '/api/profile'), path('POST', '/api/profile/password'), path('POST', '/api/profile/email'),
 path('GET', '/api/security'), path('POST', '/api/security/setup'), path('POST', '/api/security/enable'), path('POST', '/api/security/disable'),
 path('GET', '/api/notifications'), path('POST', '/api/notifications/read'), path('POST', '/api/notifications/read-all'),
 // Running an assigned visit: checklist answers and notes, mark complete, GPS check-in/out, photos.
 path('POST', '/api/inspections/save', 'visit'), path('POST', '/api/inspections/submit', 'visit'),
 pattern('POST', /^\/api\/inspections\/([^/]+)\/(?:check-in|check-out)$/, 'visitInPath'),
 path('POST', '/api/files', 'photo'), pattern('GET', /^\/api\/files\/[^/]+$/),
 // Door, gate and alarm codes: read only, on the day of an assigned visit.
 path('POST', '/api/access-codes/read', 'codes'),
 // Offline copies of their own open visits.
 path('GET', '/api/offline/visits'), pattern('GET', /^\/api\/offline\/inspections\/([^/]+)$/, 'visitInPath')
]);
export function inspectorRoute(method, p) {
 return INSPECTOR_ROUTES.find(r => r.method === method && (r.path ? r.path === p : r.pattern.test(p))) || null;
}
const localDay = (timezone, at = Date.now()) => { try { return new Intl.DateTimeFormat('en-CA', {timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at)); } catch { return new Date(at).toISOString().slice(0, 10); } };
// Residence fields an inspector needs to find the home and fill its room checklist. Never the manual, the family,
// the residence manager, report recipients or notes.
const HOME_FIELDS = ['id', 'name', 'address', 'street_address', 'address_line2', 'city', 'state', 'postal_code', 'country', 'timezone', 'room_profile', 'latitude', 'longitude', 'geofence_radius_m', 'timezone_source'];
/** Room list for the checklist, without who each room is assigned to (family member or guest names). */
export function inspectorRooms(value) {
 try {
  const p = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
  return JSON.stringify({...p, rooms: (Array.isArray(p.rooms) ? p.rooms : []).map(({assignment, assignedName, ...room}) => room)});
 } catch { return JSON.stringify({rooms: []}); }
}
const FILE_FIELDS = 'id,property_id,inspection_id,name,mime,bytes,visibility,created_by,created_at';

export function createInspectors({get, all, run, transaction, id, now, fail, json, body, roles, property, audit, date, communications, failAlerts, visitChecklists, visitVerification, demos, template, clock = () => Date.now()}) {
 const isInspector = user => user?.role === INSPECTOR;
 /** A visit assigned to this inspector in their company, or 404. */
 async function ownVisit(user, inspectionId) {
  const row = await get('SELECT i.* FROM inspections i JOIN properties p ON p.id=i.property_id WHERE i.id=? AND p.organization_id=? AND p.archived_at IS NULL AND i.inspector_id=?', String(inspectionId || ''), user.organization_id, user.id);
  if (!row) fail(404, 'Visit not found.');
  return row;
 }
 async function residenceToday(propertyRow, org) {
  let tz = propertyRow.timezone || 'America/New_York';
  try { if (visitVerification?.timezoneFor) tz = visitVerification.timezoneFor(propertyRow, await visitVerification.settings(org)) || tz; } catch {}
  return localDay(tz, clock());
 }
 const CHECKS = {
  async visit(user, req) { const b = await body(req); await ownVisit(user, b.id); },
  async visitInPath(user, req, url, route) { await ownVisit(user, decodeURIComponent(route.pattern.exec(url.pathname)[1])); },
  async photo(user, req) {
   const b = await body(req);
   if (b.workId || !b.inspectionId) fail(403, 'Field inspectors can only add photos to their own visits.');
   const visit = await ownVisit(user, b.inspectionId);
   if (visit.property_id !== b.propertyId || visit.status !== 'draft') fail(422, 'Photos require a draft at this residence.');
  },
  async codes(user, req) {
   const b = await body(req);
   const visits = await all("SELECT p.*,i.inspection_date visit_day FROM inspections i JOIN properties p ON p.id=i.property_id WHERE i.property_id=? AND i.inspector_id=? AND i.status='draft' AND p.organization_id=? AND p.archived_at IS NULL", String(b.propertyId || ''), user.id, user.organization_id);
   if (!visits.length) fail(404, 'Residence not found.');
   const today = await residenceToday(visits[0], user.organization_id);
   if (!visits.some(v => v.visit_day === today)) fail(403, 'Door and alarm codes open only on the day of a visit assigned to you.');
  }
 };
 /** Runs first for every API request. Inspectors may only use INSPECTOR_ROUTES (plus that route's ownership check). */
 async function gate(req, url, user) {
  if (!isInspector(user)) return;
  const route = inspectorRoute(req.method, url.pathname);
  if (!route) fail(403, 'Field inspector logins can only open their assigned visits. Ask your office if you need more access.');
  if (route.check) await CHECKS[route.check](user, req, url, route);
 }
 /** property() helper: an inspector reaches a residence only through an open visit or recurring schedule assigned to them. */
 async function assigned(user, propertyId) {
  if (!isInspector(user)) return false;
  return !!(await get("SELECT 1 FROM inspections WHERE property_id=? AND inspector_id=? AND status IN ('draft','submitted')", propertyId, user.id))
   || !!(await get('SELECT 1 FROM inspection_plans WHERE property_id=? AND assigned_to=? AND active=1', propertyId, user.id));
 }
 /** readFile helper: photos on this inspector's own open visits only. */
 async function fileAllowed(user, f) {
  if (!f?.inspection_id) return false;
  return !!(await get("SELECT 1 FROM inspections i JOIN properties p ON p.id=i.property_id WHERE i.id=? AND i.inspector_id=? AND i.status IN ('draft','submitted') AND p.organization_id=?", f.inspection_id, user.id, user.organization_id));
 }
 /** The whole /api/data payload for an inspector. Same keys as everyone else's so the app never meets undefined. */
 async function snapshot(user, {safeUser, profile = {}}) {
  const org = user.organization_id;
  const visits = await all("SELECT i.* FROM inspections i JOIN properties p ON p.id=i.property_id WHERE p.organization_id=? AND p.archived_at IS NULL AND i.inspector_id=? AND i.status IN ('draft','submitted') ORDER BY i.inspection_date,i.created_at,i.id", org, user.id);
  const homeIds = [...new Set(visits.map(v => v.property_id))];
  const homes = homeIds.length ? await all(`SELECT * FROM properties WHERE organization_id=? AND id IN (${homeIds.map(() => '?').join(',')})`, org, ...homeIds) : [];
  const visitIds = visits.map(v => v.id);
  const files = visitIds.length ? await all(`SELECT ${FILE_FIELDS} FROM files WHERE inspection_id IN (${visitIds.map(() => '?').join(',')}) ORDER BY created_at`, ...visitIds) : [];
  return {
   unreadMessages: 0, companyLogo: '', primaryAdminId: '', clientPortalTitle: '', clientPortalSubtitle: '',
   demo: demos ? await demos.lookup(org) : null,
   user: {...safeUser(user), platformAccess: false, ...profile},
   company: (await get('SELECT name FROM organizations WHERE id=?', org))?.name || '',
   properties: homes.map(h => ({...Object.fromEntries(HOME_FIELDS.map(k => [k, h[k] ?? null])), room_profile: inspectorRooms(h.room_profile)})),
   archivedProperties: [], invitations: [], clients: [], vendors: [], users: [], assets: [], asset_inspections: [], work: [], requests: [],
   inspections: visits.map(i => {
    const {report_snapshot, report_email, email_status, email_error, email_attempted_at, checklist_snapshot, ...visible} = i;
    return {...visible, checklist: parseSnapshot(checklist_snapshot) || null, inspector_name: user.name, answers: JSON.parse(i.answers || '[]')};
   }),
   files, shopping: [], arrivals: [], maintenance: [], notes: [], invoices: [], audit: [],
   notifications: failAlerts ? await failAlerts.list(user) : [], template, checklists: []
  };
 }

 // ---- Office side (admins): invite limits live in billing; here admins assign visits to inspectors. ----
 async function activeInspector(user, inspectorId) {
  const row = await get("SELECT * FROM users WHERE id=? AND organization_id=? AND role='inspector' AND active=1", String(inspectorId || ''), user.organization_id);
  if (!row) fail(422, 'Choose an active field inspector.');
  return row;
 }
 async function tell(user, inspector, inspectionId, homeName, day) {
  // enqueue() writes the in-app notification and the email together (nothing is emailed from demo workspaces).
  await communications.enqueue(user.organization_id, 'visit-assigned:' + inspectionId + ':' + inspector.id + ':' + day, [{id: inspector.id, email: inspector.email}], `Visit assigned: ${homeName} on ${day}`, `A visit at ${homeName} on ${day} has been assigned to you. Sign in to EstateAegis to see the address and checklist.`, inspectionId);
 }
 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (!p.startsWith('/api/inspectors/')) return false;
  if (!user) fail(401, 'Please sign in.');
  roles(user, 'admin');
  if (req.method !== 'POST') fail(404, 'Endpoint not found.');
  const b = await body(req);
  if (p === '/api/inspectors/assign') {
   // A new visit at a residence, assigned to a field inspector for a given day.
   const home = await property(user, b.propertyId, 'operate');
   const inspector = await activeInspector(user, b.inspectorId);
   const day = date(b.date);
   const chosen = await visitChecklists.resolve(user.organization_id, {templateId: b.templateId || undefined, visitType: b.visitType || 'routine'});
   const snap = chosen.snapshot, key = id();
   await transaction(async () => {
    await run('INSERT INTO inspections(id,property_id,inspector_id,inspection_date,answers,created_at,frequency,next_due,visit_type,template_id,template_version,template_version_id,checklist_snapshot,report_email) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', key, home.id, inspector.id, day, JSON.stringify(snap ? EAChecklist.propertyAnswers(snap) : template), now(), 'One-time', '', chosen.visit_type, snap?.template_id ?? null, snap?.template_version ?? null, snap?.template_version_id ?? null, snap ? JSON.stringify(snap) : null, home.inspection_report_email || '');
    await audit(user, 'inspection.assigned', key);
    await tell(user, inspector, key, home.name, day);
   });
   json(res, 201, {id: key, inspectorId: inspector.id}); return true;
  }
  if (p === '/api/inspectors/reassign') {
   // Move an open (draft) visit to a field inspector.
   const row = await get('SELECT i.*,p.name home_name FROM inspections i JOIN properties p ON p.id=i.property_id WHERE i.id=? AND p.organization_id=?', String(b.inspectionId || ''), user.organization_id);
   if (!row) fail(404, 'Visit not found.');
   if (row.status !== 'draft') fail(409, 'Only a visit that has not been completed can be reassigned.');
   const inspector = await activeInspector(user, b.inspectorId);
   await transaction(async () => {
    const changed = await run("UPDATE inspections SET inspector_id=?,version=version+1 WHERE id=? AND status='draft'", inspector.id, row.id);
    if (changed.changes !== 1) fail(409, 'This visit changed. Refresh and try again.');
    await audit(user, 'inspection.assigned', row.id);
    await tell(user, inspector, row.id, row.home_name, row.inspection_date);
   });
   json(res, 200, {id: row.id, inspectorId: inspector.id}); return true;
  }
  fail(404, 'Endpoint not found.');
 }
 return {gate, assigned, fileAllowed, snapshot, handle, isInspector, ownVisit, localDay};
}
