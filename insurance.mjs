// Insurance and vacancy compliance center: per-residence insurance profile, the compliance status (insurance-core.mjs),
// once-per-window alerts (in-app bell + email through the existing outbox), the visit history certificate PDF and
// expiring, revocable share links that open the certificate without signing in.
//
// Permissions: admins edit everything. Staff (employees) see the residences they can open and may download the
// certificate. Families see their own status and, when the admin turns it on for the residence, may download the
// certificate and create share links. Vendors get nothing.
import {createHash, randomBytes} from 'node:crypto';
import './public/visit-verification.js';
import * as R from './insurance-core.mjs';
import {certificatePdf, CERTIFICATE_DISCLAIMER} from './insurance-pdf.mjs';
import {portalLink} from './storm.mjs';

const V = globalThis.EAVisit;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const VISIT_TYPES = {routine: 'Routine visit', arrival: 'Arrival visit', departure: 'Departure visit', seasonal: 'Seasonal visit', maintenance: 'Maintenance visit', pre_storm: 'Storm preparation visit', post_storm: 'Post-storm visit', custom: 'Visit'};
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROUTE = /^\/api\/insurance\/([^/]+)(\/[a-z-]+(?:\.pdf)?)?$/;
const PUBLIC = /^\/api\/public\/certificates\/([A-Za-z0-9_-]{43})(\/pdf)?$/;
export const tokenHash = token => createHash('sha256').update('insurance-share:' + token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/** Subject, plain text and branded HTML for the compliance and renewal alerts. Pure, so tests can check it. */
export function renderInsuranceEmail(d) {
 const subject = {
  pre_breach: `Insurance visit due ${d.due_label} at ${d.property_name}`,
  breach: `Insurance visit overdue at ${d.property_name}`,
  vacancy_warn: `Vacancy limit approaching at ${d.property_name}`,
  vacancy_breach: `Vacancy limit passed at ${d.property_name}`,
  renewal: `Policy renewal in ${d.days_left} ${d.days_left === 1 ? 'day' : 'days'}: ${d.property_name}`
 }[d.kind];
 const intro = {
  pre_breach: `The policy for ${d.property_name} needs a visit while the home is unoccupied. No visit is scheduled before the deadline.`,
  breach: `The policy for ${d.property_name} required a visit by ${d.deadline_label}. No completed visit has been recorded since.`,
  vacancy_warn: `${d.property_name} will reach the policy's vacancy limit soon.`,
  vacancy_breach: `${d.property_name} has been unoccupied longer than the policy allows.`,
  renewal: `The insurance policy for ${d.property_name} renews on ${d.renewal_label}. Use this checklist before the renewal.`
 }[d.kind];
 const rows = [['Residence', d.property_name], ['Address', d.address || 'Address not entered'], ['Carrier', d.carrier || 'Not recorded'], ['Policy number', d.policy_number || 'Not recorded'], ...(d.kind === 'renewal' ? [['Renewal date', d.renewal_label]] : [['Status', d.status_label], ['Details', d.reason]])];
 const list = d.kind === 'renewal' ? d.checklist || [] : [];
 const text = [subject, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(list.length ? ['', 'Checklist:', ...list.map(i => `- ${i}`)] : []), '', `Open EstateAegis: ${d.link}`, '', `You are receiving this because you are an administrator on the ${d.company} account or the Residence Manager for ${d.property_name}.`].join('\n');
 const row = (k, v) => `<tr><td style="padding:6px 0;color:#5f6b76;font-size:13px;width:120px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#1f2933">${esc(v)}</td></tr>`;
 const html = `<div style="margin:0;padding:24px 12px;background:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#1f2933"><div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e7eb;border-radius:12px;overflow:hidden">`
  + `<div style="border-top:4px solid #7e202b;padding:24px 28px 6px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5f6b76">${esc(d.company)} · Insurance compliance</div><h1 style="font-size:22px;line-height:1.3;margin:8px 0 6px;color:#7e202b">${esc(subject)}</h1><p style="margin:0;color:#1f2933;font-size:15px;line-height:1.5">${esc(intro)}</p></div>`
  + `<div style="padding:10px 28px 4px"><table role="presentation" style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => row(k, v)).join('')}</table></div>`
  + (list.length ? `<div style="padding:8px 28px 0"><div style="font-size:13px;color:#5f6b76;margin-bottom:6px">Checklist</div><ul style="margin:0;padding-left:20px">${list.map(i => `<li style="font-size:14px;line-height:1.5;margin-bottom:4px">${esc(i)}</li>`).join('')}</ul></div>` : '')
  + `<div style="padding:22px 28px 26px"><a href="${esc(d.link)}" style="display:inline-block;background:#7e202b;color:#ffffff;padding:13px 22px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px">Open EstateAegis</a><p style="margin:16px 0 0;font-size:12px;color:#8a949d">If the button does not work, copy this link:<br>${esc(d.link)}</p></div>`
  + `<div style="padding:16px 28px;background:#faf9f6;border-top:1px solid #e2e7eb;font-size:12px;color:#5f6b76">You are receiving this because you are an administrator on the ${esc(d.company)} account or the Residence Manager for ${esc(d.property_name)}. Powered by EstateAegis.</div></div></div>`;
 return {subject, text, html};
}

export function createInsurance({get, all, run, transaction, id, now, fail, json, body, roles, property, audit, visitVerification, failAlerts, readFile, readBytes}, {env = process.env, log = console.log} = {}) {
 const str = (v, label, max) => { if (v == null || v === '') return ''; if (typeof v !== 'string' || v.length > max) fail(422, `${label} must be text of at most ${max} characters.`); return v.trim(); };
 const int = (v, label, min, max, fallback = null) => { if (v == null || v === '') return fallback; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) fail(422, `${label} must be a whole number from ${min} to ${max}.`); return n; };
 const day = (v, label) => { if (v == null || v === '') return null; if (!R.isDay(v)) fail(422, `Choose a valid ${label}.`); return v; };
 const email = v => { const e = str(v, 'Broker email', 200); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(422, 'Enter a valid broker email address.'); return e; };
 const settings = org => visitVerification.settings(org);
 const tzOf = (p, s) => { try { return visitVerification.timezoneFor(p, s) || p?.timezone || 'America/New_York'; } catch { return p?.timezone || 'America/New_York'; } };
 const policyFor = propertyId => get('SELECT * FROM insurance_policies WHERE property_id=?', propertyId);

 /** Compliance inputs for a set of residences of one company, loaded in a few queries. */
 async function compute(org, homes, nowIso = now()) {
  const out = new Map();
  if (!homes.length) return out;
  const ids = homes.map(p => p.id), marks = ids.map(() => '?').join(',');
  const s = await settings(org);
  const [policies, visits, plans, arrivals, events] = await Promise.all([
   all(`SELECT * FROM insurance_policies WHERE organization_id=? AND property_id IN (${marks})`, org, ...ids),
   all(`SELECT id,property_id,status,inspection_date,visit_type,next_due,submitted_at,published_at FROM inspections WHERE property_id IN (${marks})`, ...ids),
   all(`SELECT property_id,next_due,active FROM inspection_plans WHERE property_id IN (${marks})`, ...ids),
   all(`SELECT id,property_id,arrival_at,status FROM arrivals WHERE property_id IN (${marks})`, ...ids),
   all(`SELECT * FROM occupancy_events WHERE organization_id=? AND property_id IN (${marks}) ORDER BY occurred_at,created_at`, org, ...ids)
  ]);
  const by = (rows, key = 'property_id') => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  const P = new Map(policies.map(r => [r.property_id, r])), Vs = by(visits), Pl = by(plans), A = by(arrivals), E = by(events);
  for (const p of homes) {
   const tz = tzOf(p, s), today = R.localDay(nowIso, tz), profile = P.get(p.id) || null;
   const vs = Vs.get(p.id) || [];
   const completed = vs.filter(v => ['submitted', 'published'].includes(v.status) && R.isDay(v.inspection_date) && v.inspection_date <= today);
   const lastVisitDay = completed.map(v => v.inspection_date).sort().at(-1) || null;
   const scheduled = [...vs.filter(v => v.status === 'draft').map(v => v.inspection_date), ...completed.map(v => v.next_due), ...(Pl.get(p.id) || []).filter(x => Number(x.active) !== 0).map(x => x.next_due)].filter(R.isDay);
   const occEvents = [
    ...(A.get(p.id) || []).filter(a => a.status !== 'cancelled').map(a => ({at: a.arrival_at, state: 'occupied', source: 'arrival'})),
    ...completed.filter(v => v.visit_type === 'departure').map(v => ({at: v.submitted_at || v.published_at || v.inspection_date, state: 'vacant', source: 'departure_visit'})),
    ...(E.get(p.id) || []).map(e => ({at: e.occurred_at, state: e.state, source: 'manual', id: e.id, note: e.note}))
   ];
   const occ = R.occupancy(occEvents, nowIso);
   const status = R.evaluate({profile, occ, lastVisitDay, scheduledDays: scheduled, today, timezone: tz});
   out.set(p.id, {profile, status, occupancy: occ, renewal: R.renewal(profile, today), timezone: tz, today, manualEvents: (E.get(p.id) || []).slice(-6).reverse()});
  }
  return out;
 }

 function profileOut(row, role, visibleFiles) {
  if (!row) return null;
  const devices = R.parseDevices(row.devices).map(d => ({...d, file_id: d.file_id && (role !== 'client' || visibleFiles.has(d.file_id)) ? d.file_id : null}));
  const out = {carrier: row.carrier, policy_number: row.policy_number, renewal_date: row.renewal_date || '', broker_name: row.broker_name, broker_email: row.broker_email, broker_phone: row.broker_phone, inspect_every_days: row.inspect_every_days ?? null, max_vacancy_days: row.max_vacancy_days ?? null, warn_days: row.warn_days ?? R.DEFAULT_WARN_DAYS, devices, client_share: !!Number(row.client_share), updated_at: row.updated_at, version: row.version};
  if (role !== 'client') out.notes = row.notes || '';
  return out;
 }
 const linkOut = (l, nowIso) => ({id: l.id, label: l.label, created_at: l.created_at, created_by_name: l.created_by_name || '', expires_at: l.expires_at, revoked_at: l.revoked_at || null, view_count: Number(l.view_count || 0), last_viewed_at: l.last_viewed_at || null, state: l.revoked_at ? 'revoked' : l.expires_at <= nowIso ? 'expired' : 'active'});

 /** Adds data.insurance to the /api/data snapshot for the signed-in user's visible residences. */
 async function decorate(user, data) {
  if (!['admin', 'employee', 'client'].includes(user.role)) return data;
  const nowIso = now(), homes = (data.properties || []).filter(p => p && p.id);
  const full = homes.length ? await all(`SELECT * FROM properties WHERE organization_id=? AND id IN (${homes.map(() => '?').join(',')})`, user.organization_id, ...homes.map(p => p.id)) : [];
  const results = await compute(user.organization_id, full, nowIso);
  const visibleFiles = new Set((data.files || []).map(f => f.id));
  const links = full.length ? await all(`SELECT l.*,u.name created_by_name FROM insurance_share_links l LEFT JOIN users u ON u.id=l.created_by WHERE l.organization_id=? AND l.property_id IN (${full.map(() => '?').join(',')}) ORDER BY l.created_at DESC`, user.organization_id, ...full.map(p => p.id)) : [];
  const residences = [];
  for (const p of full) {
   const r = results.get(p.id);
   if (user.role === 'client' && !r.profile) continue;
   const canShare = user.role === 'admin' || (user.role === 'client' && !!Number(r.profile?.client_share));
   const mine = links.filter(l => l.property_id === p.id && (user.role !== 'client' || l.created_by === user.id)).slice(0, 20).map(l => linkOut(l, nowIso));
   residences.push({
    property_id: p.id, name: p.name, client_name: homes.find(h => h.id === p.id)?.client_name || '', manager_id: p.account_manager_id || null,
    timezone: r.timezone, today: r.today, profile: profileOut(r.profile, user.role, visibleFiles), status: r.status, occupancy: r.occupancy,
    renewal: r.profile?.renewal_date ? {date: r.profile.renewal_date, ...r.renewal} : null,
    events: user.role === 'client' ? [] : r.manualEvents.map(e => ({id: e.id, state: e.state, at: e.occurred_at, note: e.note})),
    canCertificate: !!r.profile && (user.role !== 'client' || canShare), canShare: !!r.profile && canShare, links: canShare || user.role === 'employee' ? mine : []
   });
  }
  data.insurance = {canEdit: user.role === 'admin', residences, devices: R.DEVICES.map(([key, label]) => ({key, label})), shareDefaultDays: R.SHARE_DEFAULT_DAYS, shareMaxDays: R.SHARE_MAX_DAYS};
  return data;
 }

 async function saveProfile(user, p, b) {
  roles(user, 'admin');
  const existing = await policyFor(p.id);
  if (existing && b.version !== undefined && Number(b.version) !== Number(existing.version)) fail(409, 'This insurance profile changed. Reload it before saving.');
  const devicesIn = Array.isArray(b.devices) ? b.devices : [];
  if (devicesIn.length > 10) fail(422, 'Too many devices.');
  const devices = [];
  for (const [key] of R.DEVICES) {
   const d = devicesIn.find(x => x && x.key === key) || {};
   let fileId = typeof d.file_id === 'string' && d.file_id ? d.file_id : null;
   if (fileId && !(await get('SELECT id FROM files WHERE id=? AND property_id=?', fileId, p.id))) fail(422, 'That photo or document belongs to another residence.');
   devices.push({key, name: key === 'other' ? str(d.name, 'Device name', 80) : '', required: !!d.required, discount: !!d.discount, installed: !!d.installed, file_id: fileId});
  }
  const every = int(b.inspect_every_days, 'Inspect every', 1, 365);
  const fields = {carrier: str(b.carrier, 'Carrier', 160), policy_number: str(b.policy_number, 'Policy number', 80), renewal_date: day(b.renewal_date, 'renewal date'), broker_name: str(b.broker_name, 'Broker name', 120), broker_email: email(b.broker_email), broker_phone: str(b.broker_phone, 'Broker phone', 40), inspect_every_days: every, max_vacancy_days: int(b.max_vacancy_days, 'Maximum vacancy', 1, 3650), warn_days: int(b.warn_days, 'Warning days', 0, 30, R.DEFAULT_WARN_DAYS), devices: JSON.stringify(devices), notes: str(b.notes, 'Notes', 2000), client_share: b.client_share ? 1 : 0};
  if (fields.max_vacancy_days && !every) fail(422, 'Add the inspection interval too: the vacancy limit only applies with it.');
  const at = now();
  // The compliance clock starts no earlier than the day the rule was set (or changed) in EstateAegis.
  const ruleStart = existing && Number(existing.inspect_every_days || 0) === Number(every || 0) && existing.rule_started_at ? existing.rule_started_at : every ? at : null;
  if (existing) {
   const done = await run('UPDATE insurance_policies SET carrier=?,policy_number=?,renewal_date=?,broker_name=?,broker_email=?,broker_phone=?,inspect_every_days=?,max_vacancy_days=?,warn_days=?,devices=?,notes=?,client_share=?,rule_started_at=?,updated_by=?,updated_at=?,version=version+1 WHERE property_id=? AND version=?', fields.carrier, fields.policy_number, fields.renewal_date, fields.broker_name, fields.broker_email, fields.broker_phone, fields.inspect_every_days, fields.max_vacancy_days, fields.warn_days, fields.devices, fields.notes, fields.client_share, ruleStart, user.id, at, p.id, existing.version);
   if (done.changes !== 1) fail(409, 'This insurance profile changed. Reload it before saving.');
  } else {
   await run('INSERT INTO insurance_policies(property_id,organization_id,carrier,policy_number,renewal_date,broker_name,broker_email,broker_phone,inspect_every_days,max_vacancy_days,warn_days,devices,notes,client_share,rule_started_at,created_by,updated_by,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)', p.id, user.organization_id, fields.carrier, fields.policy_number, fields.renewal_date, fields.broker_name, fields.broker_email, fields.broker_phone, fields.inspect_every_days, fields.max_vacancy_days, fields.warn_days, fields.devices, fields.notes, fields.client_share, ruleStart, user.id, user.id, at, at);
  }
  await audit(user, 'insurance.updated', p.id);
 }

 /** Everything the certificate shows. Published visits only; internal notes never. */
 async function certificateData(org, propertyId, {months = 12, nowIso = now()} = {}) {
  const p = await get('SELECT * FROM properties WHERE id=? AND organization_id=?', propertyId, org);
  if (!p) fail(404, 'Residence not found.');
  const profile = await policyFor(p.id);
  if (!profile) fail(404, 'This residence has no insurance profile yet.');
  const s = await settings(org), tz = tzOf(p, s), today = R.localDay(nowIso, tz), from = R.addDays(today, -Math.round(months * 30.44));
  const company = (await get('SELECT name FROM organizations WHERE id=?', org))?.name || '';
  const logo = (await get('SELECT logo_data FROM workspace_settings WHERE organization_id=?', org))?.logo_data || '';
  const family = (await get('SELECT name FROM clients WHERE id=?', p.client_id))?.name || '';
  const rows = await all("SELECT i.*,u.name inspector_name FROM inspections i LEFT JOIN users u ON u.id=i.inspector_id WHERE i.property_id=? AND i.status='published' AND i.inspection_date>=? AND i.inspection_date<=? ORDER BY i.inspection_date DESC,i.published_at DESC LIMIT 200", p.id, from, today);
  const visits = [];
  for (const i of rows) {
   let snap = {}; try { snap = JSON.parse(i.report_snapshot || '{}'); } catch {}
   const answers = Array.isArray(snap.answers) ? snap.answers : (() => { try { return JSON.parse(i.answers || '[]'); } catch { return []; } })();
   const counts = {pass: 0, monitor: 0, attention: 0};
   for (const a of answers) { if (a?.status === 'pass' || a?.status === 'yes') counts.pass++; else if (a?.status === 'monitor') counts.monitor++; else if (['attention', 'fail'].includes(a?.status)) counts.attention++; }
   const row = await visitVerification.visitRow(i.id), pv = row ? V.publicVisit(row) : null, d = pv ? V.describe(pv, tz) : null;
   const verified = !!pv && (pv.status === 'verified' || !!pv.override);
   visits.push({
    id: i.id, date: i.inspection_date, dateLabel: R.dayLabel(i.inspection_date), type: VISIT_TYPES[i.visit_type] || 'Visit', inspector: snap.inspector || i.inspector_name || 'Not recorded',
    reportNumber: snap.reportNumber || i.report_number || '', arrivedAt: pv?.check_in?.at || null, departedAt: pv?.check_out?.at || null,
    arrived: pv?.check_in ? V.formatTime(pv.check_in.at, tz, {date: false}) : '', departed: pv?.check_out ? V.formatTime(pv.check_out.at, tz, {date: false}) : '',
    verified, verification: verified ? (pv.override ? 'Verified by administrator' : 'GPS verified at the residence') : d ? d.label : 'Not checked in', findings: counts, summary: String(snap.summary || i.summary || '').trim().slice(0, 400)
   });
  }
  // Longest gap between consecutive visits in the period (calendar days).
  const days = [...new Set(visits.map(v => v.date))].sort();
  let longestGap = null; for (let k = 1; k < days.length; k++) { const g = R.daysBetween(days[k - 1], days[k]); if (longestGap === null || g > longestGap) longestGap = g; }
  const status = (await compute(org, [p], nowIso)).get(p.id).status;
  const rule = profile.inspect_every_days ? `Inspect at least every ${profile.inspect_every_days} ${Number(profile.inspect_every_days) === 1 ? 'day' : 'days'} while unoccupied${profile.max_vacancy_days ? `; unoccupied for no more than ${profile.max_vacancy_days} days` : ''}` : 'Not recorded';
  const devices = R.parseDevices(profile.devices).filter(d => d.required || d.discount || d.installed).map(d => ({label: d.label, required: d.required, discount: d.discount, installed: d.installed, proof: !!d.file_id}));
  const reference = 'VC-' + createHash('sha256').update(p.id + ':' + today).digest('hex').slice(0, 8).toUpperCase();
  return {company, companyLogo: logo, timezone: tz, preparedAt: nowIso, from, to: today, fromLabel: R.dayLabel(from), toLabel: R.dayLabel(today), reference,
   residence: {name: p.name, address: p.address || ''}, policyholder: family,
   policy: {carrier: profile.carrier || '', number: profile.policy_number || '', renewal: profile.renewal_date ? R.dayLabel(profile.renewal_date) : '', rule},
   status: {label: status.label, code: status.code, reason: status.reason}, devices, visits, verifiedCount: visits.filter(v => v.verified).length, longestGap,
   disclaimer: CERTIFICATE_DISCLAIMER(company)};
 }
 const slug = s => String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'Residence';
 function sendPdf(res, cert) {
  const pdf = certificatePdf(cert);
  res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Visit-History-Certificate-${slug(cert.residence.name)}.pdf"`, 'Cache-Control': 'no-store'});
  res.end(pdf);
  return true;
 }

 // Public share links: light per-address rate limit (tokens are 256-bit random, so this only trims noise).
 const hits = new Map();
 function limited(req) {
  const key = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim(), t = Date.now(), cur = hits.get(key) || {at: t, n: 0};
  if (t - cur.at > 60000) { cur.at = t; cur.n = 0; }
  cur.n++; hits.set(key, cur);
  if (hits.size > 2000) for (const [k, v] of hits) if (t - v.at > 120000) hits.delete(k);
  return cur.n > 60;
 }
 async function resolveLink(token) {
  const link = await get('SELECT * FROM insurance_share_links WHERE token_hash=?', tokenHash(token));
  if (!link) fail(404, 'This certificate link is not valid.');
  if (link.revoked_at) fail(410, 'This certificate link was turned off by the sender.');
  if (link.expires_at <= now()) fail(410, 'This certificate link has expired. Ask the sender for a new one.');
  const p = await get('SELECT archived_at FROM properties WHERE id=? AND organization_id=?', link.property_id, link.organization_id);
  if (!p || p.archived_at) fail(410, 'This certificate is no longer available.');
  return link;
 }
 async function logView(req, link, kind) {
  const at = now(), ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  await run('INSERT INTO insurance_share_views(id,link_id,organization_id,kind,viewed_at,ip_hash,user_agent) VALUES(?,?,?,?,?,?,?)', id(), link.id, link.organization_id, kind, at, ip ? createHash('sha256').update('view:' + ip).digest('hex').slice(0, 16) : '', String(req.headers['user-agent'] || '').slice(0, 200));
  await run('UPDATE insurance_share_links SET view_count=view_count+1,last_viewed_at=? WHERE id=?', at, link.id);
  await run('INSERT INTO audit VALUES(?,?,?,?,?,?)', id(), link.organization_id, 'share-link', kind === 'pdf' ? 'insurance_share.downloaded' : 'insurance_share.viewed', link.id, at);
 }

 /** Public routes (no sign-in): the share page data and its PDF. Nothing else is reachable with a token. */
 async function handlePublic(req, res, url) {
  const m = url.pathname.match(PUBLIC);
  if (!m) return false;
  if (req.method !== 'GET') fail(405, 'Method not allowed.');
  if (limited(req)) fail(429, 'Too many requests. Try again in a minute.');
  if (!TOKEN.test(m[1])) fail(404, 'This certificate link is not valid.');
  const link = await resolveLink(m[1]);
  const cert = await certificateData(link.organization_id, link.property_id);
  await logView(req, link, m[2] ? 'pdf' : 'page');
  if (m[2]) return sendPdf(res, cert);
  const {companyLogo, ...rest} = cert;
  json(res, 200, {certificate: {...rest, visits: rest.visits.map(({id, ...v}) => v), companyLogo: /^data:image\/(png|jpeg);base64,/.test(companyLogo) ? companyLogo : ''}, expiresAt: link.expires_at, expiresLabel: R.dayLabel(R.localDay(link.expires_at, cert.timezone))}, {'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow'});
  return true;
 }

 async function handle(req, res, url, user) {
  const p = url.pathname, method = req.method;
  if (!p.startsWith('/api/insurance')) return false;
  if (!user) fail(401, 'Please sign in.');
  if (!['admin', 'employee', 'client'].includes(user.role)) fail(403, 'Insurance compliance is not available for this account.');
  const revoke = p.match(/^\/api\/insurance\/share-links\/([^/]+)\/revoke$/);
  if (revoke && method === 'POST') {
   const link = await get('SELECT * FROM insurance_share_links WHERE id=? AND organization_id=?', revoke[1], user.organization_id);
   if (!link) fail(404, 'Share link not found.');
   await property(user, link.property_id);
   if (user.role !== 'admin' && !(user.role === 'client' && link.created_by === user.id)) fail(403, 'Only an administrator or the person who created this link can turn it off.');
   if (!link.revoked_at) { await run('UPDATE insurance_share_links SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL', now(), user.id, link.id); await audit(user, 'insurance_share.revoked', link.id); }
   return json(res, 200, {ok: true}), true;
  }
  const m = p.match(ROUTE);
  if (!m) fail(404, 'Not found.');
  const pRow = await property(user, m[1]), sub = m[2] || '';
  if (!sub && method === 'POST') { await saveProfile(user, pRow, await body(req)); return json(res, 200, {ok: true}), true; }
  if (sub === '/occupancy' && method === 'POST') {
   roles(user, 'admin');
   const b = await body(req), state = b.state === 'occupied' ? 'occupied' : b.state === 'vacant' ? 'vacant' : fail(422, 'Choose whether the owners arrived or left.');
   const s = await settings(user.organization_id), tz = tzOf(pRow, s);
   let at = now();
   if (b.date) { const d = day(b.date, 'date'); if (d > R.localDay(at, tz)) fail(422, 'The date cannot be in the future.'); if (d !== R.localDay(at, tz)) at = d + 'T12:00:00.000Z'; }
   const key = id();
   await run('INSERT INTO occupancy_events(id,organization_id,property_id,state,occurred_at,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', key, user.organization_id, pRow.id, state, at, str(b.note, 'Note', 300), user.id, now());
   await audit(user, 'occupancy.' + (state === 'occupied' ? 'owners_arrived' : 'owners_left'), pRow.id);
   return json(res, 201, {id: key}), true;
  }
  const profile = await policyFor(pRow.id);
  const canShare = user.role === 'admin' || (user.role === 'client' && !!Number(profile?.client_share));
  if (sub === '/certificate.pdf' && method === 'GET') {
   if (!profile) fail(404, 'This residence has no insurance profile yet.');
   if (user.role === 'client' && !canShare) fail(403, 'Your home watch company has not turned on certificate downloads for this residence.');
   const cert = await certificateData(user.organization_id, pRow.id);
   await audit(user, 'insurance.certificate_downloaded', pRow.id);
   return sendPdf(res, cert);
  }
  if (sub === '/share-links' && method === 'POST') {
   if (!profile) fail(404, 'This residence has no insurance profile yet.');
   if (!canShare) fail(403, user.role === 'client' ? 'Your home watch company has not turned on certificate sharing for this residence.' : 'Only an administrator can create share links.');
   const b = await body(req), days = int(b.days, 'Link lifetime', 1, R.SHARE_MAX_DAYS, R.SHARE_DEFAULT_DAYS), token = newToken(), key = id(), at = now();
   await run('INSERT INTO insurance_share_links(id,organization_id,property_id,token_hash,label,expires_at,created_by,created_by_role,created_at) VALUES(?,?,?,?,?,?,?,?,?)', key, user.organization_id, pRow.id, tokenHash(token), str(b.label, 'Label', 120), new Date(Date.parse(at) + days * 86400000).toISOString(), user.id, user.role, at);
   await audit(user, 'insurance_share.created', key);
   return json(res, 201, {id: key, path: '/certificate/' + token, expires_at: new Date(Date.parse(at) + days * 86400000).toISOString()}), true;
  }
  fail(404, 'Not found.');
 }

 /** Hourly: pre-breach, breach and vacancy-limit alerts, and renewal reminders, each once per window. */
 async function tick(nowIso = now()) {
  const orgs = await all('SELECT DISTINCT organization_id FROM insurance_policies');
  let sent = 0;
  for (const {organization_id: org} of orgs) {
   const homes = await all('SELECT p.* FROM properties p JOIN insurance_policies i ON i.property_id=p.id WHERE p.organization_id=? AND p.archived_at IS NULL', org);
   if (!homes.length) continue;
   const results = await compute(org, homes, nowIso), company = (await get('SELECT name FROM organizations WHERE id=?', org))?.name || 'Your company';
   const demo = await get('SELECT organization_id FROM demo_workspaces WHERE organization_id=?', org);
   for (const p of homes) {
    const r = results.get(p.id), st = r.status, alerts = [];
    if (st.code === 'breached') alerts.push(st.vacancyLeft !== null && st.vacancyLeft < 0 ? ['vacancy_breach', st.vacantSince] : ['breach', st.deadline]);
    else if (st.code === 'at_risk' && st.daysLeft !== null && st.daysLeft <= (r.profile.warn_days ?? R.DEFAULT_WARN_DAYS)) alerts.push(['pre_breach', st.deadline]);
    if (st.code !== 'breached' && st.vacancyLeft !== null && st.vacancyLeft >= 0 && st.vacancyLeft <= (r.profile.warn_days ?? R.DEFAULT_WARN_DAYS)) alerts.push(['vacancy_warn', st.vacantSince]);
    if (r.renewal.due) alerts.push(['renewal', r.profile.renewal_date]);
    for (const [kind, windowKey] of alerts) {
     if (!windowKey) continue;
     const claimed = await run('INSERT INTO insurance_alerts(organization_id,property_id,kind,window_key,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', org, p.id, kind, windowKey, nowIso);
     if (claimed.changes !== 1) continue;
     const people = await failAlerts.recipients(org, p);
     const d = {kind, company, property_name: p.name, address: p.address || '', carrier: r.profile.carrier, policy_number: r.profile.policy_number, status_label: st.label, reason: st.reason, deadline_label: R.dayLabel(st.deadline), due_label: st.daysLeft === 0 ? 'today' : st.daysLeft === 1 ? 'tomorrow' : 'by ' + R.dayLabel(st.deadline), renewal_label: R.dayLabel(r.profile.renewal_date), days_left: r.renewal.daysLeft, checklist: R.renewalChecklist(r.profile), link: portalLink(env)};
     const mail = renderInsuranceEmail(d);
     for (const person of people) await run('INSERT INTO notifications(id,user_id,title,entity_id,read_at,created_at,kind,body) VALUES(?,?,?,?,?,?,?,?)', id(), person.id, mail.subject, p.id, null, nowIso, 'insurance_' + kind, kind === 'renewal' ? 'Renewal checklist: ' + d.checklist.slice(0, 2).join(' ') : st.reason);
     if (!demo) for (const person of people.filter(x => x.email)) {
      const key = createHash('sha256').update(`${org}:insurance-${kind}:${p.id}:${windowKey}:${person.email.toLowerCase()}`).digest('hex');
      await run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,html,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', key, org, person.id, person.email, mail.subject, mail.text, mail.html, nowIso, nowIso);
     }
     sent++;
    }
   }
  }
  if (sent && !env.RESEND_API_KEY) log(`Insurance compliance: ${sent} alert(s) created; email is queued but not sent because RESEND_API_KEY is not set.`);
  return {sent};
 }

 return {decorate, handle, handlePublic, tick, compute, certificateData};
}
