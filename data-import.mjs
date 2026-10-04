// "Import from another system" (Oct 2026): company admins bring clients + residences, contacts, vendors, staff and
// past visit history in from a CSV or Excel file. Steps: upload -> map columns -> preview (per-row errors, warnings,
// duplicates) -> import (one transaction) -> results, with Undo of everything a batch created for 7 days.
// - Admins only, own company only (every lookup is scoped to user.organization_id); field inspectors are refused by
//   the inspector allow-list before this handler runs. Same-origin JSON POSTs, like every other form (CSRF).
// - The file is never stored: the browser sends it again for preview and import, so no raw rows (or codes) sit in the
//   database. Gate/door/alarm/lockbox codes and access notes go into property_vault sealed with the same AES-GCM
//   vault as Access & codes, are masked in previews, and never reach a log line or an audit entry.
// - Plan limits: residences, admin/staff seats and field inspector logins (imported staff are inactive with no
//   password until they accept an invitation; an import never adds more of them than there are free seats, and the
//   seat is checked again when the admin sends the invitation).
// - Staff are created inactive and no email is sent; the admin sends each invitation later (Send invite).
import {TYPES, TYPE_ORDER, LIMITS, KNOWN_SOURCES, readUpload, autoMap, cleanMapping, pick, normalize, normName, normStreet, addressKey, isUS, timezoneFor, parseDate, checkEmail, checkPhone, staffRole, templateCsv, csvLine} from './import-core.mjs';

export const UNDO_DAYS = 7;
const SECRET_KEYS = ['gate', 'door', 'alarm', 'lockbox', 'accessNotes'];
const VAULT_FIELD = {gate: 'gate', door: 'door', alarm: 'alarm', lockbox: 'lockbox', accessNotes: 'instructions'};
const MASK = '•••• saved encrypted';
// Records that someone created in EstateAegis after the import; any of these on an imported residence blocks Undo.
const PROPERTY_BLOCKERS = [['inspections', 'visits'], ['work_orders', 'work orders'], ['requests', 'service requests'], ['files', 'files'], ['assets', 'assets'], ['arrivals', 'arrivals'], ['maintenance_plans', 'maintenance plans'], ['shopping_items', 'shopping list items'], ['notes', 'notes'], ['inspection_plans', 'visit schedules'], ['staff_schedules', 'staff schedules'], ['storm_event_residences', 'storm events'], ['residence_locks', 'smart locks'], ['insurance_policies', 'insurance policies'], ['occupancy_events', 'occupancy records'], ['arrival_flights', 'flights'], ['photo_spots', 'photo spots']];
// Light links that go with the residence (no user work in them).
const PROPERTY_LINKS = ['property_vault', 'property_access', 'property_checklist_settings', 'weather_alert_residences', 'imported_visits'];

export function createDataImport({get, all, run, transaction, id, now, fail, json, body, roles, audit, billing, addressFields, clientProfile, seal, unseal, vaultReady, sendWorkspaceInvitation, hash, randomBytes}) {
 const chunk = (list, n = 200) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
 const marks = n => Array(n).fill('?').join(',');
 const many = (n, label) => Number(n) === 1 ? '1 ' + label.replace(/ies$/, 'y').replace(/s$/, '') : `${n} ${label}`;

 async function context(user, type) {
  const org = user.organization_id, ctx = {org, type};
  ctx.timezone = (await get('SELECT timezone FROM workspace_settings WHERE organization_id=?', org))?.timezone || '';
  ctx.capacity = await billing.capacity(org);
  ctx.pendingStaff = (await all("SELECT role FROM users WHERE organization_id=? AND active=0 AND password_hash='' AND role IN ('employee','inspector')", org));
  if (type === 'clients' || type === 'contacts') ctx.clients = await all('SELECT id,name,email,phone,profile FROM clients WHERE organization_id=?', org);
  if (type === 'clients' || type === 'history') ctx.properties = await all('SELECT id,client_id,name,street_address,postal_code,archived_at FROM properties WHERE organization_id=?', org);
  if (type === 'vendors') ctx.vendors = await all('SELECT id,name,email FROM vendors WHERE organization_id=?', org);
  if (type === 'staff') ctx.users = await all("SELECT id,name,email,role,active,password_hash='' pending FROM users WHERE organization_id=?", org);
  if (type === 'history') ctx.visits = await all('SELECT property_id,visit_date,notes FROM imported_visits WHERE organization_id=?', org);
  return ctx;
 }
 const room = (ctx, kind) => { const c = ctx.capacity; if (!c) return Infinity; if (c.blocked) return 0; const pending = kind === 'residences' ? 0 : ctx.pendingStaff.filter(u => (u.role === 'inspector') === (kind === 'inspectors')).length; return Math.max(0, c.limits[kind] - c.usage[kind] - pending); };
 const limitMessage = (ctx, kind) => ctx.capacity?.blocked ? 'Resolve your subscription in Company settings before importing.' : kind === 'residences' ? `Over your plan’s limit of ${ctx.capacity.limits.residences} active residences. Archive residences or upgrade, then import the rest.` : kind === 'seats' ? `No admin/staff seat left on your plan (${ctx.capacity.limits.seats} included). Add seats or suspend someone, then import the rest.` : `No field inspector login left on your plan (${ctx.capacity.limits.inspectors}). Suspend an inspector or contact sales@estateaegis.com, then import the rest.`;
 const cells = (type, mapping, row) => TYPES[type].fields.filter(f => mapping[f.key] !== undefined && String(row.cells[mapping[f.key]] ?? '').trim()).map(f => ({label: f.label, value: SECRET_KEYS.includes(f.key) && type === 'clients' ? MASK : String(row.cells[mapping[f.key]]).trim().slice(0, 200), secret: SECRET_KEYS.includes(f.key) && type === 'clients' || undefined}));
 const clip = (s, max, warnings, label) => { if (s.length > max) { warnings.push(`${label} was longer than ${max} characters and was shortened.`); return s.slice(0, max); } return s; };

 // ---------- per-type analysis: what each row will do ----------
 function analyzeClients(ctx, rows, mapping, mode, vaultOk) {
  const byEmail = new Map(), byName = new Map(), byAddress = new Map();
  for (const c of ctx.clients) { if (c.email) byEmail.set(c.email.toLowerCase(), c); const k = normName(c.name); if (!byName.has(k)) byName.set(k, c); }
  for (const p of ctx.properties) { const k = addressKey(p.street_address, p.postal_code); if (k && !byAddress.has(k)) byAddress.set(k, p); }
  const fileFamilies = new Map(), fileAddresses = new Map(); let newHomes = 0; const free = room(ctx, 'residences');
  return rows.map(row => {
   const v = pick(row, mapping), errors = [], warnings = [], out = {line: row.line};
   const family = (v.family || v.company || v.lastName || [v.firstName, v.lastName].filter(Boolean).join(' ')).trim();
   if (!family) errors.push('Add a family name (or a first and last name).');
   else if (family.length > 160) errors.push('Family name is longer than 160 characters.');
   const email = checkEmail(v.email); if (email.bad) warnings.push(`Email “${v.email.slice(0, 60)}” isn’t valid; it was left blank.`); else if (email.extra) warnings.push('Only the first email address was kept.');
   const phone = checkPhone(v.phone); if (phone.bad) warnings.push(`Check the phone number “${v.phone.slice(0, 40)}”.`);
   const codes = SECRET_KEYS.filter(k => v[k]);
   const hasAddress = ['street', 'line2', 'city', 'state', 'postal'].some(k => v[k]);
   let address = null, tz = null;
   if (hasAddress) {
    let postal = v.postal;
    if (isUS(v.country) && /^\d{3,4}$/.test(postal)) { const padded = postal.padStart(5, '0'); warnings.push(`ZIP ${postal} was read as ${padded} (spreadsheets drop leading zeros).`); postal = padded; }
    if (isUS(v.country) && /^\d{9}$/.test(postal)) postal = postal.slice(0, 5) + '-' + postal.slice(5);
    try { address = addressFields({streetAddress: v.street, addressLine2: v.line2, city: v.city, state: v.state, postalCode: postal, country: v.country || 'United States'}); }
    catch (e) { errors.push(e.message.replace(' is required (maximum', ' is missing (maximum').replace(/ \(maximum \d+ characters\)\.$/, '.')); }
    const t = timezoneFor(v.timezone, v.state, v.country, ctx.timezone); tz = t.tz; if (t.warning) warnings.push(t.warning);
   } else if (v.residenceName || codes.length || v.propertyNotes) errors.push('Add the street address, city, state and ZIP for this residence.');
   if (codes.length && !vaultOk) errors.push('Access codes can’t be saved until the encryption key is set up. Remove the code columns from the mapping, or ask support to set the key.');
   const residenceName = address ? clip(v.residenceName || address.street, 160, warnings, 'Residence name') : '';
   const manual = v.propertyNotes ? clip(v.propertyNotes, 16000, warnings, 'Residence notes') : '';
   const vault = {}; for (const k of codes) vault[VAULT_FIELD[k]] = clip(v[k], 4000, warnings, TYPES.clients.fields.find(f => f.key === k).label);
   Object.assign(out, {title: (v.residenceName && residenceName) || family || residenceName || `Row ${row.line}`, subtitle: address ? (v.residenceName && family ? `${family} · ${address.full}` : address.full) : hasAddress ? 'Address incomplete' : (v.residenceName || codes.length || v.propertyNotes) ? 'No address in this row' : family ? 'Family only (no residence)' : '', family: family || '', cells: cells('clients', mapping, row), errors, warnings});
   if (errors.length) return {...out, status: 'error', reason: errors[0]};
   // Which family: an existing one (email, then name), one created by an earlier row of this file, or a new one.
   const fKey = email.value ? 'e:' + email.value : 'n:' + normName(family);
   const existingFamily = (email.value && byEmail.get(email.value)) || byName.get(normName(family)) || null;
   const earlier = fileFamilies.get(fKey) || fileFamilies.get('n:' + normName(family));
   const familyPlan = existingFamily ? {existing: existingFamily.id, name: existingFamily.name} : earlier ? {sameAs: earlier.line, name: family} : {create: true, name: family};
   const familyData = {name: family, email: email.value, phone: phone.value, firstName: v.firstName.slice(0, 160), lastName: v.lastName.slice(0, 160)};
   if (!existingFamily && !earlier) { fileFamilies.set(fKey, {line: row.line}); fileFamilies.set('n:' + normName(family), {line: row.line}); }
   if (!address) {
    if (existingFamily) return mode === 'update' ? {...out, status: 'update', action: `Update family ${existingFamily.name}`, plan: {family: familyPlan, familyData, updateFamily: true}} : {...out, status: 'skip', duplicate: true, reason: `Family already in EstateAegis: ${existingFamily.name}`};
    if (earlier) return {...out, status: 'skip', duplicate: true, reason: `Same family as row ${earlier.line}`};
    return {...out, status: 'create', action: 'New family', plan: {family: familyPlan, familyData}};
   }
   const aKey = addressKey(address.street, address.postal), existingHome = byAddress.get(aKey), earlierHome = fileAddresses.get(aKey);
   const home = {name: residenceName, address, timezone: tz, manual, vault};
   if (existingHome) {
    if (mode !== 'update') return {...out, status: 'skip', duplicate: true, reason: `Residence already in EstateAegis: ${existingHome.name}`};
    if (existingHome.archived_at) return {...out, status: 'skip', duplicate: true, reason: `Matches an archived residence (${existingHome.name}). Restore it first to update it.`};
    if (existingFamily && existingHome.client_id !== existingFamily.id) warnings.push(`${existingHome.name} belongs to another family in EstateAegis; only the residence was updated.`);
    return {...out, status: 'update', action: `Update ${existingHome.name}`, plan: {homeId: existingHome.id, home, family: existingFamily && existingHome.client_id === existingFamily.id ? familyPlan : null, familyData, updateFamily: true}};
   }
   if (earlierHome) return {...out, status: 'skip', duplicate: true, reason: `Same residence as row ${earlierHome}`};
   fileAddresses.set(aKey, row.line);
   if (++newHomes > free) return {...out, status: 'error', reason: limitMessage(ctx, 'residences'), errors: [limitMessage(ctx, 'residences')]};
   return {...out, status: 'create', action: existingFamily ? `New residence for ${existingFamily.name}` : earlier ? `New residence (family from row ${earlier.line})` : 'New family and residence', plan: {family: familyPlan, familyData, home, updateFamily: mode === 'update'}};
  });
 }

 function analyzeContacts(ctx, rows, mapping, mode) {
  const byEmail = new Map(), byName = new Map();
  for (const c of ctx.clients) { if (c.email) byEmail.set(c.email.toLowerCase(), c); const k = normName(c.name); byName.set(k, [...(byName.get(k) || []), c]); }
  const seen = new Map();
  return rows.map(row => {
   const v = pick(row, mapping), errors = [], warnings = [];
   let first = v.firstName, last = v.lastName;
   if (!first && !last && v.fullName) { const parts = v.fullName.trim().split(/\s+/); first = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]; last = parts.length > 1 ? parts.at(-1) : ''; }
   const fam = checkEmail(v.familyEmail);
   let family = fam.value ? byEmail.get(fam.value) : null;
   if (!family && v.family) { const list = byName.get(normName(v.family)) || []; if (list.length > 1) errors.push(`More than one family is called “${v.family.slice(0, 60)}”. Add the family email to choose one.`); else family = list[0] || null; }
   if (!family && !errors.length) errors.push(v.family || v.familyEmail ? `Family “${(v.family || v.familyEmail).slice(0, 60)}” isn’t in EstateAegis yet. Import clients first, or add the family.` : 'Add the family name or family email this contact belongs to.');
   if (!first && !last) errors.push('Add the contact’s name.');
   if (family && first && !last) { last = family.name; warnings.push(`No last name; used the family name (${family.name}).`); }
   const email = checkEmail(v.email); if (email.bad) warnings.push(`Email “${v.email.slice(0, 60)}” isn’t valid; it was left blank.`);
   const phone = checkPhone(v.phone); if (phone.bad) warnings.push(`Check the phone number “${v.phone.slice(0, 40)}”.`);
   const name = [first, last].filter(Boolean).join(' ');
   const out = {line: row.line, title: name || `Row ${row.line}`, subtitle: family ? family.name : v.family || '', cells: cells('contacts', mapping, row), errors, warnings};
   if (errors.length) return {...out, status: 'error', reason: errors[0]};
   const member = {firstName: first.slice(0, 160), lastName: last.slice(0, 160), relationship: v.relationship.slice(0, 100), email: email.value, phone: phone.value};
   const members = JSON.parse(family.profile || '{}').members || [];
   const match = members.find(m => (email.value && String(m.email || '').toLowerCase() === email.value) || normName(`${m.firstName} ${m.lastName}`) === normName(name));
   const key = family.id + '|' + normName(name);
   if (seen.has(key)) return {...out, status: 'skip', duplicate: true, reason: `Same contact as row ${seen.get(key)}`};
   seen.set(key, row.line);
   if (match) return mode === 'update' ? {...out, status: 'update', action: `Update ${name} (${family.name})`, plan: {familyId: family.id, memberId: match.id, member}} : {...out, status: 'skip', duplicate: true, reason: `Already a contact of ${family.name}`};
   return {...out, status: 'create', action: `New contact for ${family.name}`, plan: {familyId: family.id, member}};
  });
 }

 function analyzeVendors(ctx, rows, mapping, mode) {
  const byEmail = new Map(), byName = new Map(); for (const x of ctx.vendors) { if (x.email) byEmail.set(x.email.toLowerCase(), x); byName.set(normName(x.name), x); }
  const seen = new Map();
  return rows.map(row => {
   const v = pick(row, mapping), errors = [], warnings = [];
   if (!v.name) errors.push('Add the vendor name.'); else if (v.name.length > 160) errors.push('Vendor name is longer than 160 characters.');
   const email = checkEmail(v.email); if (email.bad) warnings.push(`Email “${v.email.slice(0, 60)}” isn’t valid; it was left blank.`);
   const phone = checkPhone(v.phone); if (phone.bad) warnings.push(`Check the phone number “${v.phone.slice(0, 40)}”.`);
   const trade = clip(v.trade || '', 100, warnings, 'Trade');
   const out = {line: row.line, title: v.name || `Row ${row.line}`, subtitle: trade, cells: cells('vendors', mapping, row), errors, warnings};
   if (errors.length) return {...out, status: 'error', reason: errors[0]};
   const key = normName(v.name), match = (email.value && byEmail.get(email.value)) || byName.get(key);
   if (seen.has(key) || (email.value && seen.has('e:' + email.value))) return {...out, status: 'skip', duplicate: true, reason: `Same vendor as row ${seen.get(key) || seen.get('e:' + email.value)}`};
   seen.set(key, row.line); if (email.value) seen.set('e:' + email.value, row.line);
   const vendor = {name: v.name, trade, email: email.value, phone: phone.value};
   if (match) return mode === 'update' ? {...out, status: 'update', action: `Update ${match.name}`, plan: {vendorId: match.id, vendor}} : {...out, status: 'skip', duplicate: true, reason: `Vendor already in EstateAegis: ${match.name}`};
   return {...out, status: 'create', action: 'New vendor', plan: {vendor}};
  });
 }

 async function analyzeStaff(ctx, rows, mapping, mode) {
  const mine = new Map(ctx.users.map(u => [u.email.toLowerCase(), u]));
  const emails = [...new Set(rows.map(r => checkEmail(pick(r, mapping).email).value).filter(Boolean))];
  const taken = new Set();
  for (const part of chunk(emails)) for (const r of await all(`SELECT LOWER(email) email FROM users WHERE organization_id<>? AND LOWER(email) IN (${marks(part.length)})`, ctx.org, ...part)) taken.add(r.email);
  const seen = new Map(), free = {seats: room(ctx, 'seats'), inspectors: room(ctx, 'inspectors')}, used = {seats: 0, inspectors: 0};
  return rows.map(row => {
   const v = pick(row, mapping), errors = [], warnings = [];
   const name = (v.fullName || [v.firstName, v.lastName].filter(Boolean).join(' ')).trim();
   if (!name) errors.push('Add the person’s name.'); else if (name.length > 160) errors.push('Name is longer than 160 characters.');
   const email = checkEmail(v.email);
   if (!v.email) errors.push('Add an email address: each person signs in with their own email.'); else if (email.bad) errors.push(`Email “${v.email.slice(0, 60)}” isn’t valid.`);
   const r = staffRole(v.role); if (r.error) errors.push(r.error); if (r.warning) warnings.push(r.warning);
   const phone = checkPhone(v.phone); if (phone.bad) warnings.push(`Check the phone number “${v.phone.slice(0, 40)}”.`);
   const start = parseDate(v.startDate); if (v.startDate && !start) warnings.push(`Start date “${v.startDate.slice(0, 30)}” wasn’t recognized; it was left blank.`);
   const roleLabel = r.role === 'inspector' ? 'Field inspector' : 'Staff';
   const out = {line: row.line, title: name || `Row ${row.line}`, subtitle: [email.value, r.role ? roleLabel : ''].filter(Boolean).join(' · '), cells: cells('staff', mapping, row), errors, warnings};
   if (!errors.length && taken.has(email.value)) errors.push('That email already has an EstateAegis login.');
   if (errors.length) return {...out, status: 'error', reason: errors[0]};
   const details = {phone: phone.value, jobTitle: clip(v.jobTitle || '', 500, warnings, 'Job title'), startDate: start, notes: clip(v.notes || '', 2000, warnings, 'Notes')};
   if (seen.has(email.value)) return {...out, status: 'skip', duplicate: true, reason: `Same email as row ${seen.get(email.value)}`};
   seen.set(email.value, row.line);
   const existing = mine.get(email.value);
   if (existing) {
    if (mode !== 'update') return {...out, status: 'skip', duplicate: true, reason: `Already on your team: ${existing.name}`};
    if (!['employee', 'inspector'].includes(existing.role)) return {...out, status: 'skip', duplicate: true, reason: `${existing.name} has a ${existing.role} login; it wasn’t changed.`};
    return {...out, status: 'update', action: `Update ${existing.name}’s profile`, plan: {userId: existing.id, pending: !!Number(existing.pending), name, details}};
   }
   const kind = r.role === 'inspector' ? 'inspectors' : 'seats';
   if (++used[kind] > free[kind]) { const m = limitMessage(ctx, kind); return {...out, status: 'error', reason: m, errors: [m]}; }
   return {...out, status: 'create', action: `New ${roleLabel.toLowerCase()} (inactive until you send an invite)`, plan: {name, email: email.value, role: r.role, details}};
  });
 }

 function analyzeHistory(ctx, rows, mapping) {
  const live = ctx.properties.filter(p => !p.archived_at);
  const byName = new Map(), byStreet = new Map();
  for (const p of live) { const n = normName(p.name); byName.set(n, [...(byName.get(n) || []), p]); const s = normStreet(p.street_address); if (s) byStreet.set(s, [...(byStreet.get(s) || []), p]); }
  const prior = new Set(ctx.visits.map(x => x.property_id + '|' + x.visit_date + '|' + normalize(x.notes).slice(0, 200)));
  const today = new Date().toISOString().slice(0, 10), seen = new Map();
  return rows.map(row => {
   const v = pick(row, mapping), errors = [], warnings = [];
   let matches = [];
   if (v.address) matches = byStreet.get(normStreet(v.address)) || [];
   if (!matches.length && v.residence) matches = byName.get(normName(v.residence)) || byStreet.get(normStreet(v.residence)) || [];
   if (!v.residence && !v.address) errors.push('Add the residence name or street address.');
   else if (matches.length > 1) errors.push(`More than one residence matches “${(v.residence || v.address).slice(0, 60)}”. Add the street address.`);
   else if (!matches.length) errors.push(`Residence “${(v.residence || v.address).slice(0, 60)}” isn’t in EstateAegis yet. Import clients and residences first.`);
   const date = parseDate(v.date);
   if (!v.date) errors.push('Add the visit date.'); else if (!date) errors.push(`Visit date “${v.date.slice(0, 30)}” wasn’t recognized. Use a date like 2026-03-02 or 3/2/2026.`); else if (date > today) errors.push('Visit date is in the future. Only past visits are imported.');
   const home = matches.length === 1 ? matches[0] : null;
   const notes = clip(v.notes || '', 4000, warnings, 'Notes');
   const out = {line: row.line, title: home ? home.name : (v.residence || v.address || `Row ${row.line}`), subtitle: [date, v.inspector].filter(Boolean).join(' · '), cells: cells('history', mapping, row), errors, warnings};
   if (errors.length) return {...out, status: 'error', reason: errors[0]};
   const key = home.id + '|' + date + '|' + normalize(notes).slice(0, 200);
   if (prior.has(key)) return {...out, status: 'skip', duplicate: true, reason: 'This visit was already imported.'};
   if (seen.has(key)) return {...out, status: 'skip', duplicate: true, reason: `Same visit as row ${seen.get(key)}`};
   seen.set(key, row.line);
   return {...out, status: 'create', action: `Visit history for ${home.name}`, plan: {propertyId: home.id, visit: {date, inspector: clip(v.inspector || '', 160, warnings, 'Inspector'), visitType: clip(v.visitType || '', 100, warnings, 'Visit type'), outcome: clip(v.outcome || '', 100, warnings, 'Result'), notes}}};
  });
 }

 async function analyze(user, type, parsed, mapping, mode) {
  const ctx = await context(user, type);
  const vaultOk = vaultReady();
  const rows = type === 'clients' ? analyzeClients(ctx, parsed.rows, mapping, mode, vaultOk) : type === 'contacts' ? analyzeContacts(ctx, parsed.rows, mapping, mode) : type === 'vendors' ? analyzeVendors(ctx, parsed.rows, mapping, mode) : type === 'staff' ? await analyzeStaff(ctx, parsed.rows, mapping, mode) : analyzeHistory(ctx, parsed.rows, mapping);
  const count = s => rows.filter(r => r.status === s).length;
  const counts = {total: rows.length, create: count('create'), update: count('update'), skip: count('skip'), error: count('error'), duplicates: rows.filter(r => r.duplicate).length, warnings: rows.filter(r => r.warnings.length).length};
  const cap = ctx.capacity;
  return {rows, counts, ctx, limits: cap ? {blocked: cap.blocked, residences: room(ctx, 'residences'), seats: room(ctx, 'seats'), inspectors: room(ctx, 'inspectors')} : null};
 }

 /** Fields the mapping still needs before a preview makes sense. */
 function missing(type, mapping) {
  const has = k => mapping[k] !== undefined;
  if (type === 'clients' && !['family', 'firstName', 'lastName', 'company'].some(has)) return 'Match a column to Family name (or First name and Last name).';
  if (type === 'contacts' && !(has('family') || has('familyEmail'))) return 'Match a column to Family name or Family email so each contact finds its family.';
  if (type === 'contacts' && !['fullName', 'firstName', 'lastName'].some(has)) return 'Match a column to the contact’s name.';
  if (type === 'vendors' && !has('name')) return 'Match a column to Vendor name.';
  if (type === 'staff' && !['fullName', 'firstName', 'lastName'].some(has)) return 'Match a column to Name (or First name and Last name).';
  if (type === 'staff' && !has('email')) return 'Match a column to Email: each person signs in with their own email.';
  if (type === 'history' && !(has('residence') || has('address'))) return 'Match a column to Residence or Street address.';
  if (type === 'history' && !has('date')) return 'Match a column to Visit date.';
  return '';
 }

 async function readRequest(b) {
  const type = String(b.type || '');
  if (!TYPES[type]) fail(422, 'Choose what you are importing.');
  const parsed = await readUpload({fileName: b.fileName, data: b.data});
  return {type, parsed};
 }
 const publicRow = r => ({line: r.line, status: r.status, title: r.title, subtitle: r.subtitle, action: r.action || '', reason: r.reason || '', duplicate: !!r.duplicate, errors: r.errors, warnings: r.warnings, cells: r.cells});

 // ---------- writing ----------
 async function execute(user, batchId, type, rows) {
  const records = [], skipped = [], created = {}, at = now();
  const seenRecords = new Set();
  const record = (entity, entityId, action, parentId = null) => { const k = entity + ':' + entityId; if (seenRecords.has(k)) return; seenRecords.add(k); records.push([entity, entityId, action, parentId]); };
  const familyIds = new Map(); // line -> client id (families created by this batch)
  let createdCount = 0, updatedCount = 0;
  for (const r of rows) {
   if (r.status !== 'create' && r.status !== 'update') { skipped.push(r); continue; }
   const p = r.plan;
   try {
    if (type === 'clients') {
     let clientId = null;
     if (p.family?.existing) {
      clientId = p.family.existing;
      if (p.updateFamily && p.familyData) {
       const c = await get('SELECT * FROM clients WHERE id=? AND organization_id=?', clientId, user.organization_id), profile = JSON.parse(c.profile || '{}');
       await run('UPDATE clients SET email=?,phone=?,profile=? WHERE id=?', p.familyData.email || c.email, p.familyData.phone || c.phone, JSON.stringify({...profile, firstName: p.familyData.firstName || profile.firstName || '', lastName: p.familyData.lastName || profile.lastName || ''}), clientId);
       record('client', clientId, 'updated');
      }
     } else if (p.family?.sameAs) clientId = familyIds.get(p.family.sameAs);
     else if (p.family?.create) {
      clientId = id(); const d = p.familyData;
      await run('INSERT INTO clients(id,organization_id,name,email,phone,created_at,profile) VALUES(?,?,?,?,?,?,?)', clientId, user.organization_id, d.name, d.email, d.phone, at, JSON.stringify(clientProfile({firstName: d.firstName, lastName: d.lastName})));
      familyIds.set(r.line, clientId); record('client', clientId, 'created'); created.clients = (created.clients || 0) + 1;
     }
     if (p.home && !p.homeId) {
      if (!clientId) throw Object.assign(Error('The family for this row was skipped.'), {status: 422});
      await billing.assertCapacity(user.organization_id, 'residences');
      const key = id(), a = p.home.address;
      await run('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,manual,created_at,street_address,address_line2,city,state,postal_code,country,room_profile) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', key, user.organization_id, clientId, p.home.name, a.full, p.home.timezone, p.home.manual, at, a.street, a.line2, a.city, a.state, a.postal, a.country, '{}');
      if (Object.keys(p.home.vault).length) { const details = {gate: '', door: '', alarm: '', lockbox: '', instructions: '', ...p.home.vault}; await run('INSERT INTO property_vault VALUES(?,?,?,?)', key, seal(details, user.organization_id + ':' + key), 1, at); }
      record('property', key, 'created', clientId); created.residences = (created.residences || 0) + 1;
     } else if (p.homeId) {
      const home = await get('SELECT * FROM properties WHERE id=? AND organization_id=?', p.homeId, user.organization_id), a = p.home.address;
      const given = label => r.cells.some(c => c.label === label);
      await run('UPDATE properties SET name=?,address_line2=?,timezone=?,manual=? WHERE id=?', given('Residence name') ? p.home.name : home.name, a.line2 || home.address_line2, given('Time zone') ? p.home.timezone : home.timezone, p.home.manual ? (home.manual ? home.manual + '\n\n' + p.home.manual : p.home.manual) : home.manual, home.id);
      if (a.line2 && a.line2 !== home.address_line2) await run('UPDATE properties SET address=? WHERE id=?', [home.street_address, a.line2, `${home.city}, ${home.state} ${home.postal_code}`, home.country].filter(Boolean).join(', '), home.id);
      if (Object.keys(p.home.vault).length) {
       const context = user.organization_id + ':' + home.id, saved = await get('SELECT * FROM property_vault WHERE property_id=?', home.id);
       const old = saved ? unseal(saved.encrypted_details, context) : {};
       const details = {gate: '', door: '', alarm: '', lockbox: '', instructions: '', ...old, ...p.home.vault};
       if (saved) await run('UPDATE property_vault SET encrypted_details=?,version=version+1,updated_at=? WHERE property_id=?', seal(details, context), at, home.id); else await run('INSERT INTO property_vault VALUES(?,?,?,?)', home.id, seal(details, context), 1, at);
      }
      if (p.family?.existing && p.updateFamily && p.familyData) { const c = await get('SELECT * FROM clients WHERE id=?', p.family.existing), profile = JSON.parse(c.profile || '{}'); await run('UPDATE clients SET email=?,phone=?,profile=? WHERE id=?', p.familyData.email || c.email, p.familyData.phone || c.phone, JSON.stringify({...profile, firstName: p.familyData.firstName || profile.firstName || '', lastName: p.familyData.lastName || profile.lastName || ''}), c.id); }
      record('property', home.id, 'updated');
     }
    } else if (type === 'contacts') {
     const c = await get('SELECT * FROM clients WHERE id=? AND organization_id=?', p.familyId, user.organization_id), profile = JSON.parse(c.profile || '{}'), members = profile.members || [];
     if (p.memberId) { const m = members.find(x => x.id === p.memberId); if (m) { for (const k of ['relationship', 'email', 'phone']) if (p.member[k]) m[k] = p.member[k]; } record('contact', p.memberId, 'updated', c.id); }
     else { const memberId = id(); members.push({id: memberId, ...p.member, preferredContact: 'No preference'}); record('contact', memberId, 'created', c.id); created.contacts = (created.contacts || 0) + 1; }
     await run('UPDATE clients SET profile=? WHERE id=?', JSON.stringify({...profile, members}), c.id);
    } else if (type === 'vendors') {
     if (p.vendorId) { const x = await get('SELECT * FROM vendors WHERE id=? AND organization_id=?', p.vendorId, user.organization_id); await run('UPDATE vendors SET trade=?,email=?,phone=? WHERE id=?', p.vendor.trade || x.trade, p.vendor.email || x.email, p.vendor.phone || x.phone, x.id); record('vendor', x.id, 'updated'); }
     else { const key = id(); await run('INSERT INTO vendors VALUES(?,?,?,?,?,?,?)', key, user.organization_id, p.vendor.name, p.vendor.trade, p.vendor.email, p.vendor.phone, at); record('vendor', key, 'created'); created.vendors = (created.vendors || 0) + 1; }
    } else if (type === 'staff') {
     if (p.userId) {
      const old = JSON.parse((await get('SELECT details FROM staff_profiles WHERE user_id=?', p.userId))?.details || '{}'), merged = {...old};
      for (const [k, val] of Object.entries(p.details)) if (val) merged[k] = val;
      if (p.pending) await run('UPDATE users SET name=? WHERE id=? AND organization_id=?', p.name, p.userId, user.organization_id);
      await run('INSERT INTO staff_profiles(user_id,details) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET details=excluded.details', p.userId, JSON.stringify(merged));
      record('staff', p.userId, 'updated');
     } else {
      // Inactive, with no usable password: they can't sign in until they accept an invitation the admin sends.
      const key = id();
      await run('INSERT INTO users(id,organization_id,name,email,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?,?)', key, user.organization_id, p.name, p.email, '', p.role, 0, at);
      await run('INSERT INTO staff_profiles(user_id,details) VALUES(?,?)', key, JSON.stringify({payRate: null, payBasis: 'hour', currency: 'USD', address: '', employmentType: '', endDate: '', emergencyName: '', emergencyPhone: '', ...p.details}));
      record('staff', key, 'created'); created[p.role === 'inspector' ? 'inspectors' : 'staff'] = (created[p.role === 'inspector' ? 'inspectors' : 'staff'] || 0) + 1;
     }
    } else if (type === 'history') {
     const key = id(), x = p.visit;
     await run('INSERT INTO imported_visits(id,organization_id,property_id,batch_id,visit_date,inspector_name,visit_type,outcome,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', key, user.organization_id, p.propertyId, batchId, x.date, x.inspector, x.visitType, x.outcome, x.notes, at);
     record('visit', key, 'created', p.propertyId); created.visits = (created.visits || 0) + 1;
    }
    if (r.status === 'create') createdCount++; else updatedCount++;
   } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    skipped.push({...r, status: 'error', reason: error.message});
   }
  }
  for (const part of chunk(records, 100)) await run(`INSERT INTO import_records(batch_id,organization_id,entity_type,entity_id,action,parent_id) VALUES ${part.map(() => '(?,?,?,?,?,?)').join(',')}`, ...part.flatMap(r => [batchId, user.organization_id, ...r]));
  return {createdCount, updatedCount, skipped, created};
 }

 function skippedCsv(parsed, skipped) {
  if (!skipped.length) return '';
  const byLine = new Map(parsed.rows.map(r => [r.line, r]));
  return '\ufeff' + [csvLine(['Row', 'Reason', ...parsed.headers]), ...skipped.map(s => csvLine([s.line, s.reason || 'Skipped', ...(byLine.get(s.line)?.cells || [])]))].join('\r\n') + '\r\n';
 }

 async function batches(user) {
  const rows = await all('SELECT b.*,u.name created_by_name FROM import_batches b LEFT JOIN users u ON u.id=b.created_by WHERE b.organization_id=? ORDER BY b.created_at DESC LIMIT 20', user.organization_id);
  const t = Date.now();
  return rows.map(b => ({id: b.id, type: b.data_type, typeLabel: TYPES[b.data_type]?.label || b.data_type, fileName: b.file_name, createdAt: b.created_at, createdBy: b.created_by_name || '', created: Number(b.created_count), updated: Number(b.updated_count), skipped: Number(b.skipped_count), status: b.status, undoneAt: b.undone_at, undoUntil: b.undo_until, canUndo: b.status === 'completed' && Number(b.created_count) > 0 && Date.parse(b.undo_until) > t, detail: JSON.parse(b.summary || '{}').created || {}}));
 }
 async function pendingStaff(user) {
  return (await all("SELECT u.id,u.name,u.email,u.role FROM users u WHERE u.organization_id=? AND u.active=0 AND u.password_hash='' AND u.role IN ('employee','inspector') AND EXISTS(SELECT 1 FROM import_records r WHERE r.organization_id=u.organization_id AND r.entity_type='staff' AND r.entity_id=u.id) ORDER BY u.name", user.organization_id))
   .map(u => ({...u, invited: false}));
 }

 // ---------- Undo ----------
 async function undo(user, batchId) {
  return transaction(async () => {
   const batch = await get('SELECT * FROM import_batches WHERE id=? AND organization_id=?', batchId, user.organization_id);
   if (!batch) fail(404, 'Import not found.');
   if (batch.status !== 'completed') fail(409, 'This import was already undone.');
   if (Date.parse(batch.undo_until) <= Date.now()) fail(409, `Imports can be undone for ${UNDO_DAYS} days. This one is older.`);
   const recs = await all("SELECT * FROM import_records WHERE batch_id=? AND organization_id=? AND action='created'", batch.id, user.organization_id);
   const ids = kind => recs.filter(r => r.entity_type === kind).map(r => r.entity_id);
   const props = ids('property'), clients = ids('client'), vendors = ids('vendor'), staff = ids('staff'), contacts = recs.filter(r => r.entity_type === 'contact'), visits = ids('visit');
   const blockers = [], propSet = new Set(props);
   const name = async (table, key) => (await get(`SELECT name FROM ${table} WHERE id=?`, key))?.name || 'A record';
   for (const part of chunk(props)) for (const [table, label] of PROPERTY_BLOCKERS) for (const r of await all(`SELECT property_id,COUNT(*) n FROM ${table} WHERE property_id IN (${marks(part.length)}) GROUP BY property_id`, ...part)) blockers.push(`${await name('properties', r.property_id)} has ${many(r.n, label)}`);
   for (const part of chunk(clients)) {
    for (const r of await all(`SELECT id,client_id,name FROM properties WHERE client_id IN (${marks(part.length)}) AND organization_id=?`, ...part, user.organization_id)) if (!propSet.has(r.id)) blockers.push(`${await name('clients', r.client_id)} has a residence that wasn’t part of this import (${r.name})`);
    for (const r of await all(`SELECT client_id,COUNT(*) n FROM invoices WHERE client_id IN (${marks(part.length)}) GROUP BY client_id`, ...part)) blockers.push(`${await name('clients', r.client_id)} has ${many(r.n, 'invoices')}`);
    for (const r of await all(`SELECT client_id,COUNT(*) n FROM users WHERE client_id IN (${marks(part.length)}) GROUP BY client_id`, ...part)) blockers.push(`${await name('clients', r.client_id)} has ${many(r.n, 'client portal logins')}`);
   }
   // Later imports that built on this one (past visits on these residences, contacts on these families) come off first.
   for (const part of chunk(props)) for (const r of await all(`SELECT v.property_id,COUNT(*) n FROM imported_visits v JOIN import_batches b ON b.id=v.batch_id WHERE v.property_id IN (${marks(part.length)}) AND v.batch_id<>? AND b.status='completed' GROUP BY v.property_id`, ...part, batch.id)) blockers.push(`${await name('properties', r.property_id)} has ${many(r.n, 'past visits')} from a later import (undo that import first)`);
   for (const part of chunk(clients)) for (const r of await all(`SELECT r.parent_id,COUNT(*) n FROM import_records r JOIN import_batches b ON b.id=r.batch_id WHERE r.entity_type='contact' AND r.action='created' AND r.parent_id IN (${marks(part.length)}) AND r.batch_id<>? AND b.status='completed' GROUP BY r.parent_id`, ...part, batch.id)) blockers.push(`${await name('clients', r.parent_id)} has ${many(r.n, 'contacts')} from a later import (undo that import first)`);
   for (const part of chunk(vendors)) {
    for (const r of await all(`SELECT vendor_id,COUNT(*) n FROM work_orders WHERE vendor_id IN (${marks(part.length)}) GROUP BY vendor_id`, ...part)) blockers.push(`${await name('vendors', r.vendor_id)} has ${many(r.n, 'work orders')}`);
    for (const r of await all(`SELECT vendor_id,COUNT(*) n FROM users WHERE vendor_id IN (${marks(part.length)}) GROUP BY vendor_id`, ...part)) blockers.push(`${await name('vendors', r.vendor_id)} has ${many(r.n, 'vendor logins')}`);
   }
   for (const part of chunk(staff)) for (const r of await all(`SELECT name FROM users WHERE id IN (${marks(part.length)}) AND (active=1 OR password_hash<>'')`, ...part)) blockers.push(`${r.name} has accepted their invitation`);
   if (blockers.length) fail(409, `This import can’t be undone because some of its records are now in use: ${blockers.slice(0, 5).join('; ')}${blockers.length > 5 ? `; and ${blockers.length - 5} more` : ''}. Remove those first, or keep the import.`);
   try {
    for (const part of chunk(visits)) await run(`DELETE FROM imported_visits WHERE id IN (${marks(part.length)}) AND organization_id=?`, ...part, user.organization_id);
    const clientSet = new Set(clients);
    const byFamily = new Map(); for (const r of contacts) byFamily.set(r.parent_id, [...(byFamily.get(r.parent_id) || []), r]);
    for (const [clientId, list] of byFamily) {
     if (clientSet.has(clientId)) continue;
     const c = await get('SELECT * FROM clients WHERE id=? AND organization_id=?', clientId, user.organization_id); if (!c) continue;
     const drop = new Set(list.map(r => r.entity_id)), profile = JSON.parse(c.profile || '{}');
     await run('UPDATE clients SET profile=? WHERE id=?', JSON.stringify({...profile, members: (profile.members || []).filter(m => !drop.has(m.id))}), c.id);
    }
    for (const part of chunk(props)) {
     for (const table of PROPERTY_LINKS) await run(`DELETE FROM ${table} WHERE property_id IN (${marks(part.length)})`, ...part);
     await run(`DELETE FROM properties WHERE id IN (${marks(part.length)}) AND organization_id=?`, ...part, user.organization_id);
    }
    for (const part of chunk(clients)) { await run(`DELETE FROM invitations WHERE client_id IN (${marks(part.length)}) AND organization_id=? AND used_at IS NULL`, ...part, user.organization_id); await run(`DELETE FROM clients WHERE id IN (${marks(part.length)}) AND organization_id=?`, ...part, user.organization_id); }
    for (const part of chunk(vendors)) { await run(`DELETE FROM invitations WHERE vendor_id IN (${marks(part.length)}) AND organization_id=? AND used_at IS NULL`, ...part, user.organization_id); await run(`DELETE FROM vendors WHERE id IN (${marks(part.length)}) AND organization_id=?`, ...part, user.organization_id); }
    for (const part of chunk(staff)) {
     await run(`DELETE FROM invitations WHERE organization_id=? AND used_at IS NULL AND LOWER(email) IN (SELECT LOWER(email) FROM users WHERE id IN (${marks(part.length)}))`, user.organization_id, ...part);
     for (const table of ['staff_profiles', 'user_profiles', 'sessions', 'notifications', 'weather_user_prefs']) await run(`DELETE FROM ${table} WHERE user_id IN (${marks(part.length)})`, ...part);
     await run(`DELETE FROM users WHERE id IN (${marks(part.length)}) AND organization_id=? AND active=0 AND password_hash=''`, ...part, user.organization_id);
    }
   } catch (error) {
    if (error.status) throw error;
    console.error('Import undo failed:', error.code || error.name || 'error');
    fail(409, 'Some imported records are now linked to other work, so this import can’t be undone automatically.');
   }
   await run('UPDATE import_batches SET status=?,undone_at=?,undone_by=? WHERE id=?', 'undone', now(), user.id, batch.id);
   await audit(user, 'import.undone', batch.id);
   return {undone: true, removed: {residences: props.length, clients: clients.length, contacts: contacts.length, vendors: vendors.length, staff: staff.length, visits: visits.length}};
  });
 }

 // ---------- invitations for imported staff ----------
 async function inviteStaff(user, userId) {
  const person = await get("SELECT u.* FROM users u WHERE u.id=? AND u.organization_id=? AND u.active=0 AND u.password_hash='' AND u.role IN ('employee','inspector') AND EXISTS(SELECT 1 FROM import_records r WHERE r.organization_id=u.organization_id AND r.entity_type='staff' AND r.entity_id=u.id)", String(userId || ''), user.organization_id);
  if (!person) fail(404, 'This person isn’t waiting for an invitation.');
  await billing.assertCapacity(user.organization_id, person.role === 'inspector' ? 'inspectors' : 'seats');
  const token = randomBytes(32).toString('hex');
  await transaction(async () => {
   await run('UPDATE invitations SET expires_at=0 WHERE organization_id=? AND LOWER(email)=? AND used_at IS NULL', user.organization_id, person.email.toLowerCase());
   await run('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?)', hash(token), user.organization_id, person.email, person.role, null, null, Date.now() + 48 * 3600000, null);
   await audit(user, 'invitation.created', person.email);
  });
  return {invitePath: '/client-login?invite=' + token, expiresInHours: 48, email: person.email, ...await sendWorkspaceInvitation(user, {to: person.email, invitePath: '/client-login?invite=' + token})};
 }

 /** Read-only imported visit history for staff (residence Inspections tab). */
 async function decorate(user, data) {
  if (!['admin', 'employee'].includes(user.role)) return data;
  const allowed = new Set((data.properties || []).map(p => p.id));
  const rows = await all('SELECT id,property_id,visit_date,inspector_name,visit_type,outcome,notes FROM imported_visits WHERE organization_id=? ORDER BY visit_date DESC,created_at DESC', user.organization_id);
  data.importedVisits = rows.filter(r => allowed.has(r.property_id));
  return data;
 }

 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (!p.startsWith('/api/import/')) return false;
  if (!user) fail(401, 'Please sign in.');
  roles(user, 'admin');
  const method = req.method;
  if (p === '/api/import/info' && method === 'GET') {
   json(res, 200, {types: TYPE_ORDER.map(k => ({key: k, label: TYPES[k].label, short: TYPES[k].short, help: TYPES[k].help, fields: TYPES[k].fields.map(f => ({key: f.key, label: f.label, hint: f.hint || '', required: !!f.required, secret: k === 'clients' && SECRET_KEYS.includes(f.key)}))})), limits: {...LIMITS}, undoDays: UNDO_DAYS, knownSources: KNOWN_SOURCES, vaultReady: vaultReady(), batches: await batches(user), pendingStaff: await pendingStaff(user)});
   return true;
  }
  const tpl = p.match(/^\/api\/import\/template\/([a-z]+)\.csv$/);
  if (tpl && method === 'GET') {
   if (!TYPES[tpl[1]]) fail(404, 'Template not found.');
   res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="EstateAegis-import-${tpl[1]}.csv"`, 'Cache-Control': 'no-store'});
   res.end(templateCsv(tpl[1])); return true;
  }
  const skippedFile = p.match(/^\/api\/import\/batches\/([^/]+)\/skipped\.csv$/);
  if (skippedFile && method === 'GET') {
   const batch = await get('SELECT * FROM import_batches WHERE id=? AND organization_id=?', decodeURIComponent(skippedFile[1]), user.organization_id);
   if (!batch) fail(404, 'Import not found.');
   const list = JSON.parse(batch.summary || '{}').skipped || [];
   res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="EstateAegis-import-skipped-rows.csv"`, 'Cache-Control': 'no-store'});
   res.end('\ufeff' + [csvLine(['Row', 'Reason']), ...list.map(s => csvLine([s.line, s.reason]))].join('\r\n') + '\r\n'); return true;
  }
  if (method !== 'POST') fail(404, 'Endpoint not found.');
  const b = await body(req);
  if (p === '/api/import/parse') {
   const {type, parsed} = await readRequest(b);
   const mapping = autoMap(type, parsed.headers);
   const secretCols = new Set(Object.entries(mapping).filter(([k]) => type === 'clients' && SECRET_KEYS.includes(k)).map(([, i]) => i));
   json(res, 200, {fileName: parsed.fileName, headers: parsed.headers, rowCount: parsed.rows.length, mapping, samples: parsed.headers.map((_, i) => secretCols.has(i) ? [] : parsed.rows.map(r => r.cells[i]).filter(Boolean).slice(0, 2).map(s => s.slice(0, 80)))});
   return true;
  }
  if (p === '/api/import/preview' || p === '/api/import/run') {
   const {type, parsed} = await readRequest(b);
   const mapping = cleanMapping(type, b.mapping, parsed.headers.length), mode = b.mode === 'update' ? 'update' : 'skip';
   const need = missing(type, mapping); if (need) fail(422, need);
   if (p === '/api/import/preview') {
    const result = await analyze(user, type, parsed, mapping, mode);
    json(res, 200, {fileName: parsed.fileName, type, mode, counts: result.counts, limits: result.limits, rows: result.rows.map(publicRow)});
    return true;
   }
   const batchId = id(), started = now();
   const outcome = await transaction(async () => {
    await run('INSERT INTO import_batches(id,organization_id,created_by,data_type,file_name,status,created_at,undo_until) VALUES(?,?,?,?,?,?,?,?)', batchId, user.organization_id, user.id, type, parsed.fileName, 'completed', started, new Date(Date.now() + UNDO_DAYS * 86400000).toISOString());
    const result = await analyze(user, type, parsed, mapping, mode);
    const done = await execute(user, batchId, type, result.rows);
    const summary = {mode, created: done.created, skipped: done.skipped.map(s => ({line: s.line, reason: s.reason || 'Skipped'}))};
    await run('UPDATE import_batches SET created_count=?,updated_count=?,skipped_count=?,summary=? WHERE id=?', done.createdCount, done.updatedCount, done.skipped.length, JSON.stringify(summary), batchId);
    await audit(user, 'import.completed', batchId);
    return done;
   });
   json(res, 200, {batchId, type, fileName: parsed.fileName, created: outcome.createdCount, updated: outcome.updatedCount, skipped: outcome.skipped.length, detail: outcome.created, skippedRows: outcome.skipped.slice(0, 200).map(s => ({line: s.line, title: s.title, reason: s.reason || 'Skipped'})), skippedCsv: skippedCsv(parsed, outcome.skipped), undoUntil: new Date(Date.now() + UNDO_DAYS * 86400000).toISOString(), pendingStaff: type === 'staff' ? await pendingStaff(user) : []});
   return true;
  }
  if (p === '/api/import/undo') { json(res, 200, await undo(user, String(b.batchId || ''))); return true; }
  if (p === '/api/import/staff-invite') { json(res, 200, await inviteStaff(user, b.userId)); return true; }
  fail(404, 'Endpoint not found.');
 }
 return {handle, decorate, analyze, undo, inviteStaff};
}
