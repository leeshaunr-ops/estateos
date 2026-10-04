// Prospects: each company's own sales leads (prospective clients), from the first enquiry to an accepted quote and a
// new client family + residence.
//
// - Stages: New, Contacted, Walkthrough booked, Quote sent, Won, Lost. Notes timeline, next follow-up date, assigned
//   staff member, source and estimated monthly value.
// - Public "Request a quote" form per company at /quote/<company-slug> (company branding, honeypot, per-IP and
//   per-company rate limits, validation). New leads land in New; admins get a bell notification and an email through the
//   existing outbox.
// - Quotes: built from a prospect, sent by email with a link to /quotes/<token> (random 256-bit token, stored hashed).
//   The prospect types their name and accepts; the name, time, IP address and browser are recorded and the prospect
//   moves to Won. No payment collection.
// - Convert: an administrator turns a Won prospect into a client family + residence (the same create logic as the
//   Client families and Residences screens, including the plan's residence limit) and the records link back.
//
// Permissions: administrators always; staff (employees) only when an administrator grants them Prospects access.
// Families, vendors and field inspectors never. Every query is scoped to the signed-in user's company.
import {createHash, randomBytes} from 'node:crypto';

export const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['walkthrough', 'Walkthrough booked'], ['quote_sent', 'Quote sent'], ['won', 'Won'], ['lost', 'Lost']];
export const SOURCES = [['website', 'Website form'], ['referral', 'Referral'], ['phone', 'Phone'], ['other', 'Other']];
export const FREQUENCIES = ['Weekly', 'Every two weeks', 'Twice a month', 'Monthly', 'Twice a week'];
const STAGE = Object.fromEntries(STAGES), SOURCE = Object.fromEntries(SOURCES), CLOSED = ['won', 'lost'];
const TOKEN = /^[A-Za-z0-9_-]{43}$/, ID = /^[A-Za-z0-9-]{1,64}$/;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const slugOf = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const quoteTokenHash = token => createHash('sha256').update('prospect-quote:' + token).digest('hex');
export const newQuoteToken = () => randomBytes(32).toString('base64url');
export const dollars = minor => '$' + (Number(minor || 0) / 100).toLocaleString('en-US', {minimumFractionDigits: Number(minor) % 100 ? 2 : 0, maximumFractionDigits: 2});
/** https origin for links in emails: APP_URL when it is https, else the public site (same rule as other alert emails). */
export function publicOrigin(env = process.env) { let origin = 'https://estateaegis.com'; try { const base = new URL(env.APP_URL || origin); if (base.protocol === 'https:' && !base.username && !base.password) origin = base.origin; } catch {} return origin; }
export function localDay(iso, tz) { const at = new Date(iso); try { return new Intl.DateTimeFormat('en-CA', {timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'}).format(at); } catch { return new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'}).format(at); } }
export const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T12:00:00Z')) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
export const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dayLabel = day => isDay(day) ? new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'}).format(new Date(day + 'T12:00:00Z')) : '';
/** overdue | today | upcoming | null (no date, or the prospect is closed). */
export function followUpState(p, today) { if (!p?.next_follow_up || CLOSED.includes(p.stage)) return null; return p.next_follow_up < today ? 'overdue' : p.next_follow_up === today ? 'today' : 'upcoming'; }
export function addressOf(p) { return [p.street_address, p.address_line2, [p.city, [p.state, p.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', '); }
export function splitName(name) { const parts = String(name || '').trim().split(/\s+/).filter(Boolean); if (parts.length < 2) return {firstName: '', lastName: parts[0] || ''}; return {firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)}; }

function emailShell({company, kicker, title, intro, rows = [], link, button, footer, extra = ''}) {
 const row = (k, v) => `<tr><td style="padding:6px 0;color:#5f6b76;font-size:13px;width:130px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#1f2933">${esc(v)}</td></tr>`;
 return `<div style="margin:0;padding:24px 12px;background:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#1f2933"><div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e7eb;border-radius:12px;overflow:hidden">`
  + `<div style="border-top:4px solid #8b242b;padding:24px 28px 6px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5f6b76">${esc(company)}${kicker ? ' · ' + esc(kicker) : ''}</div><h1 style="font-family:Georgia,serif;font-size:22px;line-height:1.3;margin:8px 0 6px;color:#8b242b">${esc(title)}</h1><p style="margin:0;color:#1f2933;font-size:15px;line-height:1.5">${esc(intro)}</p></div>`
  + (rows.length ? `<div style="padding:10px 28px 4px"><table role="presentation" style="width:100%;border-collapse:collapse">${rows.filter(([, v]) => v).map(([k, v]) => row(k, v)).join('')}</table></div>` : '') + extra
  + `<div style="padding:22px 28px 26px"><a href="${esc(link)}" style="display:inline-block;background:#8b242b;color:#ffffff;padding:13px 22px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px">${esc(button)}</a><p style="margin:16px 0 0;font-size:12px;color:#8a949d">If the button does not work, copy this link:<br>${esc(link)}</p></div>`
  + `<div style="padding:16px 28px;background:#faf9f6;border-top:1px solid #e2e7eb;font-size:12px;color:#5f6b76">${esc(footer)}</div></div></div>`;
}
/** Email to the company's administrators about a new website quote request. */
export function renderLeadEmail(d) {
 const subject = `New quote request: ${d.name}`;
 const intro = `${d.name} asked for a quote through your website form. The lead is in Prospects under New.`;
 const rows = [['Name', d.name], ['Email', d.email], ['Phone', d.phone], ['Property', d.address], ['Message', d.message]];
 const text = [subject, '', intro, '', ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '', `Open Prospects: ${d.link}`, '', `You are receiving this because you are an administrator on the ${d.company} account.`].join('\n');
 return {subject, text, html: emailShell({company: d.company, kicker: 'Prospects', title: subject, intro, rows, link: d.link, button: 'Open Prospects', footer: `You are receiving this because you are an administrator on the ${d.company} account.`})};
}
/** Email to the prospect with the link to view and accept their quote. Carries the company's name, not ours. */
export function renderQuoteEmail(d) {
 const subject = `Your home watch quote from ${d.company}`;
 const intro = `Hello ${d.name}, thank you for considering ${d.company}. Your quote is ready to view. You can accept it online in a minute.`;
 const rows = [['Property', d.address], ['Plan', d.plan], ['Visits', d.frequency], ['Monthly price', dollars(d.monthly_minor) + ' per month'], ['Valid until', d.valid_label]];
 const contact = d.supportEmail ? `Questions? Reply to ${d.supportEmail}.` : 'Questions? Reply to the person who sent you this quote.';
 const text = [subject, '', intro, '', ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '', `View and accept your quote: ${d.link}`, '', contact].join('\n');
 return {subject, text, html: emailShell({company: d.company, kicker: 'Quote', title: 'Your quote is ready', intro, rows, link: d.link, button: 'View your quote', footer: `${contact} Sent by ${d.company}.`})};
}
/** Email to administrators when a prospect accepts a quote. */
export function renderAcceptedEmail(d) {
 const subject = `Quote accepted: ${d.name}`;
 const intro = `${d.accepted_name} accepted the ${dollars(d.monthly_minor)} per month quote for ${d.name}. The prospect moved to Won and is ready to convert into a client family.`;
 const rows = [['Accepted by', d.accepted_name], ['When', d.when], ['Property', d.address], ['Monthly price', dollars(d.monthly_minor) + ' per month']];
 const text = [subject, '', intro, '', ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '', `Open Prospects: ${d.link}`, '', `You are receiving this because you are an administrator on the ${d.company} account or assigned to this prospect.`].join('\n');
 return {subject, text, html: emailShell({company: d.company, kicker: 'Prospects', title: subject, intro, rows, link: d.link, button: 'Open Prospects', footer: `You are receiving this because you are an administrator on the ${d.company} account or assigned to this prospect.`})};
}

function limiter(max, windowMs) {
 const hits = new Map();
 return key => { const t = Date.now(); let cur = hits.get(key); if (!cur || t - cur.at > windowMs) cur = {at: t, n: 0}; cur.n++; hits.set(key, cur); if (hits.size > 5000) for (const [k, v] of hits) if (t - v.at > windowMs) hits.delete(k); return cur.n <= max; };
}
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 64);

export function createProspects({get, all, run, transaction, id, now, fail, json, body, audit, insertClient, insertProperty, afterAddressSave}, {env = process.env, limits = {}} = {}) {
 const L = {formPerIp: 5, formPerCompany: 30, acceptPerIp: 10, viewPerIp: 120, ...limits};
 const formIp = limiter(L.formPerIp, 600000), formCompany = limiter(L.formPerCompany, 3600000), acceptIp = limiter(L.acceptPerIp, 600000), viewIp = limiter(L.viewPerIp, 600000);
 const str = (v, label, max) => { if (v == null || v === '') return ''; if (typeof v !== 'string') fail(422, `${label} must be text.`); const s = v.trim(); if (s.length > max) fail(422, `${label} can be at most ${max} characters.`); return s; };
 const need = (v, label, max) => { const s = str(v, label, max); if (!s) fail(422, `${label} is required.`); return s; };
 const email = (v, label = 'Email') => { const e = str(v, label, 254).toLowerCase(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(422, `Enter a valid ${label.toLowerCase()} address.`); return e; };
 const phone = v => { const p = str(v, 'Phone', 40); if (p && !/^[0-9+().\s-]+$/.test(p)) fail(422, 'Enter a valid phone number.'); const digits = p.replace(/\D/g, ''); if (p && (digits.length < 7 || digits.length > 15)) fail(422, 'Enter a valid phone number.'); return p; };
 const day = (v, label) => { if (v == null || v === '') return null; if (!isDay(v)) fail(422, `Choose a valid ${label}.`); return v; };
 const money = (v, label, {required = false} = {}) => { if (v == null || v === '') { if (required) fail(422, `${label} is required.`); return null; } const n = Number(String(v).replace(/[$,\s]/g, '')); if (!Number.isFinite(n) || n < 0 || n > 1000000) fail(422, `${label} must be an amount from $0 to $1,000,000.`); if (required && n <= 0) fail(422, `${label} must be more than $0.`); return Math.round(n * 100); };
 const postal = (country, code) => { if (code && ['', 'united states', 'us', 'usa'].includes(String(country || '').toLowerCase()) && !/^\d{5}(-\d{4})?$/.test(code)) fail(422, 'Enter a 5-digit ZIP code or ZIP+4.'); return code; };
 const address = b => { const a = {street_address: str(b.streetAddress, 'Street address', 200), address_line2: str(b.addressLine2, 'Address line 2', 120), city: str(b.city, 'City', 120), state: str(b.state, 'State', 100), postal_code: str(b.postalCode, 'ZIP / postal code', 24), country: str(b.country, 'Country', 100)}; postal(a.country, a.postal_code); return a; };
 const orgTz = async org => (await get('SELECT timezone FROM workspace_settings WHERE organization_id=?', org))?.timezone || 'America/New_York';
 const company = async org => { const o = await get('SELECT name FROM organizations WHERE id=?', org); const s = await get('SELECT logo_data,support_email,status FROM workspace_settings WHERE organization_id=?', org); return {name: o?.name || 'Your home watch company', logo: s?.logo_data || '', supportEmail: s?.support_email || '', suspended: s?.status === 'suspended'}; };
 const settingsOf = async org => { const s = await get('SELECT form_enabled,form_intro FROM prospect_settings WHERE organization_id=?', org); return {form_enabled: s ? Number(s.form_enabled) === 1 : true, form_intro: s?.form_intro || ''}; };
 const appLink = () => publicOrigin(env) + '/login#/prospects';
 const admins = org => all("SELECT id,name,email FROM users WHERE organization_id=? AND role='admin' AND active=1 ORDER BY created_at,id", org);
 async function granted(user) { if (!user || !['admin', 'employee'].includes(user.role)) return false; if (user.role === 'admin') return true; return !!await get('SELECT user_id FROM prospect_staff WHERE organization_id=? AND user_id=?', user.organization_id, user.id); }
 async function access(user, {admin = false} = {}) {
  if (!user) fail(401, 'Please sign in.');
  if (admin) { if (user.role !== 'admin') fail(403, 'Only administrators can do this.'); return; }
  if (!await granted(user)) fail(403, 'You do not have access to Prospects. Ask an administrator.');
 }
 const load = async (user, pid) => { if (!ID.test(String(pid || ''))) fail(404, 'Prospect not found.'); const p = await get('SELECT * FROM prospects WHERE id=? AND organization_id=?', pid, user.organization_id); if (!p) fail(404, 'Prospect not found.'); return p; };
 const addNote = (org, pid, kind, text, author, at = now()) => run('INSERT INTO prospect_notes(id,organization_id,prospect_id,kind,body,author_id,created_at) VALUES(?,?,?,?,?,?,?)', id(), org, pid, kind, String(text).slice(0, 4000), author || null, at);
 const notify = (userId, title, entity, kind, text, at = now()) => run('INSERT INTO notifications(id,user_id,title,entity_id,read_at,created_at,kind,body) VALUES(?,?,?,?,?,?,?,?)', id(), userId, String(title).slice(0, 200), entity, null, at, kind, String(text || '').slice(0, 500));
 const enqueue = (org, userId, to, mail, at = now()) => run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,html,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', id(), org, userId || null, to, mail.subject, mail.text, mail.html, at, at);
 const publicAudit = (org, actor, action, entity) => run('INSERT INTO audit VALUES(?,?,?,?,?,?)', id(), org, actor, action, entity, now());
 /** Staff who can be assigned: administrators and employees with Prospects access. */
 const team = org => all("SELECT u.id,u.name,u.role FROM users u WHERE u.organization_id=? AND u.active=1 AND (u.role='admin' OR (u.role='employee' AND EXISTS(SELECT 1 FROM prospect_staff s WHERE s.organization_id=u.organization_id AND s.user_id=u.id))) ORDER BY u.name,u.id", org);
 async function assignee(org, v) { if (v == null || v === '') return null; const t = await team(org); if (!t.some(u => u.id === v)) fail(422, 'Choose a team member who has Prospects access.'); return v; }

 function out(p, today, names, quote) {
  return {id: p.id, name: p.name, email: p.email, phone: p.phone, street_address: p.street_address, address_line2: p.address_line2, city: p.city, state: p.state, postal_code: p.postal_code, country: p.country, address: addressOf(p),
   source: p.source, source_label: SOURCE[p.source] || 'Other', stage: p.stage, stage_label: STAGE[p.stage] || p.stage, monthly_value_minor: p.monthly_value_minor == null ? null : Number(p.monthly_value_minor),
   next_follow_up: p.next_follow_up || null, follow_up: followUpState(p, today), assigned_to: p.assigned_to || null, assigned_name: (p.assigned_to && names.get(p.assigned_to)) || '', lost_reason: p.lost_reason || '', message: p.message || '',
   client_id: p.client_id || null, property_id: p.property_id || null, won_at: p.won_at || null, converted_at: p.converted_at || null, created_at: p.created_at, updated_at: p.updated_at, version: Number(p.version),
   quote: quote ? {id: quote.id, status: quote.status, monthly_minor: Number(quote.monthly_minor), sent_at: quote.sent_at || null, accepted_at: quote.accepted_at || null, view_count: Number(quote.view_count || 0)} : null};
 }
 const quoteOut = q => ({id: q.id, plan_name: q.plan_name, frequency: q.frequency, items: parseItems(q.items), monthly_minor: Number(q.monthly_minor), notes: q.notes, status: q.status, valid_until: q.valid_until || null, sent_at: q.sent_at || null, sent_to: q.sent_to || '', view_count: Number(q.view_count || 0), viewed_at: q.viewed_at || null,
  accepted_at: q.accepted_at || null, accepted_name: q.accepted_name || '', accepted_ip: q.accepted_ip || '', accepted_user_agent: q.accepted_user_agent || '', created_at: q.created_at, updated_at: q.updated_at, version: Number(q.version), reference: reference(q)});
 const parseItems = raw => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.map(i => ({label: String(i.label || ''), amount_minor: i.amount_minor == null ? null : Number(i.amount_minor)})) : []; } catch { return []; } };
 const reference = q => 'Q-' + String(q.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
 const userNames = async org => new Map((await all('SELECT id,name FROM users WHERE organization_id=?', org)).map(u => [u.id, u.name]));
 async function latestQuotes(org, ids) {
  const m = new Map(); if (!ids.length) return m;
  const rows = await all(`SELECT id,prospect_id,status,monthly_minor,sent_at,accepted_at,view_count,created_at FROM prospect_quotes WHERE organization_id=? AND prospect_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at,id`, org, ...ids);
  for (const q of rows) if (q.status !== 'withdrawn' || !m.has(q.prospect_id)) m.set(q.prospect_id, q);
  return m;
 }

 /** Light summary for /api/data: access flag plus follow-up counts for the bell, Overview and the sidebar badge. */
 async function decorate(user, data) {
  if (!user || !await granted(user)) return data;
  const today = localDay(now(), await orgTz(user.organization_id));
  const due = await all("SELECT id,name,stage,next_follow_up,assigned_to FROM prospects WHERE organization_id=? AND next_follow_up IS NOT NULL AND next_follow_up<=? AND stage NOT IN ('won','lost') ORDER BY next_follow_up,name LIMIT 200", user.organization_id, today);
  const fresh = await get("SELECT COUNT(*) n FROM prospects WHERE organization_id=? AND stage='new'", user.organization_id);
  const overdue = due.filter(p => p.next_follow_up < today);
  data.prospects = {access: true, admin: user.role === 'admin', today, overdue: overdue.length, dueToday: due.length - overdue.length, newLeads: Number(fresh?.n || 0),
   due: due.slice(0, 8).map(p => ({id: p.id, name: p.name, stage: p.stage, stage_label: STAGE[p.stage], next_follow_up: p.next_follow_up, follow_up: followUpState(p, today), mine: p.assigned_to === user.id}))};
  return data;
 }

 async function list(user) {
  const org = user.organization_id, today = localDay(now(), await orgTz(org));
  const rows = await all('SELECT * FROM prospects WHERE organization_id=? ORDER BY created_at DESC,id LIMIT 2000', org);
  const names = await userNames(org), quotes = await latestQuotes(org, rows.map(r => r.id));
  const c = await all('SELECT name FROM organizations WHERE id=?', org), slug = slugOf(c[0]?.name);
  const result = {prospects: rows.map(r => out(r, today, names, quotes.get(r.id))), team: await team(org), admin: user.role === 'admin', today,
   stages: STAGES.map(([key, label]) => ({key, label})), sources: SOURCES.map(([key, label]) => ({key, label})), frequencies: FREQUENCIES, settings: {...await settingsOf(org), slug, path: '/quote/' + slug}};
  if (user.role === 'admin') result.employees = (await all("SELECT u.id,u.name,u.email,EXISTS(SELECT 1 FROM prospect_staff s WHERE s.organization_id=u.organization_id AND s.user_id=u.id) granted FROM users u WHERE u.organization_id=? AND u.role='employee' AND u.active=1 ORDER BY u.name,u.id", org)).map(u => ({id: u.id, name: u.name, email: u.email, access: !!Number(u.granted) || u.granted === true}));
  return result;
 }
 async function detail(user, p) {
  const org = user.organization_id, today = localDay(now(), await orgTz(org)), names = await userNames(org);
  const quotes = await all('SELECT * FROM prospect_quotes WHERE organization_id=? AND prospect_id=? ORDER BY created_at DESC,id', org, p.id);
  const notes = await all('SELECT * FROM prospect_notes WHERE organization_id=? AND prospect_id=? ORDER BY created_at DESC,id DESC LIMIT 300', org, p.id);
  const latest = await latestQuotes(org, [p.id]);
  return {prospect: out(p, today, names, latest.get(p.id)), quotes: quotes.map(quoteOut), notes: notes.map(n => ({id: n.id, kind: n.kind, body: n.body, author_name: n.author_id ? names.get(n.author_id) || '' : '', created_at: n.created_at})), canConvert: user.role === 'admin' && p.stage === 'won' && !p.converted_at, team: await team(org), today};
 }
 async function bump(p, fields, user) {
  const keys = Object.keys(fields); if (!keys.length) return;
  const r = await run(`UPDATE prospects SET ${keys.map(k => k + '=?').join(',')},updated_at=?,version=version+1 WHERE id=? AND organization_id=? AND version=?`, ...keys.map(k => fields[k]), now(), p.id, user.organization_id, p.version);
  if (!r.changes) fail(409, 'Someone else changed this prospect. Reload and try again.');
 }
 async function changeStage(user, p, stage, reason = '') {
  if (!STAGE[stage]) fail(422, 'Choose a stage.');
  if (p.converted_at && stage !== 'won') fail(409, 'This prospect is already a client family, so it stays in Won.');
  if (stage === p.stage && reason === (p.lost_reason || '')) return false;
  await bump(p, {stage, lost_reason: stage === 'lost' ? reason : '', won_at: stage === 'won' ? p.won_at || now() : null}, user);
  await addNote(user.organization_id, p.id, 'stage', `Moved from ${STAGE[p.stage]} to ${STAGE[stage]}${stage === 'lost' && reason ? ': ' + reason : ''}.`, user.id);
  return true;
 }

 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (p !== '/api/prospects' && !p.startsWith('/api/prospects/')) return false;
  const method = req.method;
  if (p === '/api/prospects' && method === 'GET') { await access(user); json(res, 200, await list(user)); return true; }
  if (method !== 'GET' && method !== 'POST') fail(405, 'Method not allowed.');
  if (p === '/api/prospects' && method === 'POST') {
   await access(user); const b = await body(req), at = now(), key = id();
   const stage = b.stage ? b.stage : 'new'; if (!STAGE[stage] || stage === 'won' || stage === 'lost') fail(422, 'New prospects start in New, Contacted, Walkthrough booked or Quote sent.');
   const source = b.source || 'other'; if (!SOURCE[source]) fail(422, 'Choose where the lead came from.');
   const row = {name: need(b.name, 'Name', 120), email: email(b.email), phone: phone(b.phone), ...address(b), source, stage, monthly_value_minor: money(b.monthlyValue, 'Estimated monthly value'), next_follow_up: day(b.nextFollowUp, 'follow-up date'), assigned_to: await assignee(user.organization_id, b.assignedTo), message: ''};
   const first = str(b.note, 'Note', 4000);
   await transaction(async () => {
    await run('INSERT INTO prospects(id,organization_id,name,email,phone,street_address,address_line2,city,state,postal_code,country,source,stage,monthly_value_minor,next_follow_up,assigned_to,message,created_by,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)', key, user.organization_id, row.name, row.email, row.phone, row.street_address, row.address_line2, row.city, row.state, row.postal_code, row.country, row.source, row.stage, row.monthly_value_minor, row.next_follow_up, row.assigned_to, row.message, user.id, at, at);
    await addNote(user.organization_id, key, 'system', `Added by ${user.name || 'a team member'} (${SOURCE[source]}).`, user.id, at);
    if (first) await addNote(user.organization_id, key, 'note', first, user.id, at);
    await audit(user, 'prospect.created', key);
   });
   if (row.assigned_to && row.assigned_to !== user.id) await notify(row.assigned_to, `Prospect assigned to you: ${row.name}`, key, 'prospect_assigned', `${user.name || 'A team member'} assigned you this prospect.`);
   json(res, 201, {id: key}); return true;
  }
  if (p === '/api/prospects/settings') {
   await access(user, {admin: true}); const b = await body(req);
   const cur = await settingsOf(user.organization_id), enabled = b.form_enabled === undefined ? cur.form_enabled : !!b.form_enabled, intro = b.form_intro === undefined ? cur.form_intro : str(b.form_intro, 'Form introduction', 500);
   await run('INSERT INTO prospect_settings(organization_id,form_enabled,form_intro,updated_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET form_enabled=excluded.form_enabled,form_intro=excluded.form_intro,updated_at=excluded.updated_at', user.organization_id, enabled ? 1 : 0, intro, now());
   await audit(user, 'prospect.settings_updated', user.organization_id);
   json(res, 200, {settings: await settingsOf(user.organization_id)}); return true;
  }
  if (p === '/api/prospects/staff') {
   await access(user, {admin: true}); const b = await body(req);
   const target = await get("SELECT id FROM users WHERE id=? AND organization_id=? AND role='employee' AND active=1", String(b.userId || ''), user.organization_id);
   if (!target) fail(404, 'Staff member not found.');
   if (b.access) await run('INSERT INTO prospect_staff(organization_id,user_id,granted_by,granted_at) VALUES(?,?,?,?) ON CONFLICT(organization_id,user_id) DO NOTHING', user.organization_id, target.id, user.id, now());
   else await run('DELETE FROM prospect_staff WHERE organization_id=? AND user_id=?', user.organization_id, target.id);
   await audit(user, b.access ? 'prospect.access_granted' : 'prospect.access_removed', target.id);
   json(res, 200, {userId: target.id, access: !!b.access}); return true;
  }
  let m = p.match(/^\/api\/prospects\/quotes\/([A-Za-z0-9-]{1,64})\/(send|withdraw)$/);
  if (m && method === 'POST') {
   await access(user); const b = await body(req), org = user.organization_id;
   const q = await get('SELECT * FROM prospect_quotes WHERE id=? AND organization_id=?', m[1], org); if (!q) fail(404, 'Quote not found.');
   const pr = await load(user, q.prospect_id);
   if (m[2] === 'withdraw') {
    if (!['draft', 'sent'].includes(q.status)) fail(409, 'Only a draft or sent quote can be withdrawn.');
    await transaction(async () => { await run("UPDATE prospect_quotes SET status='withdrawn',updated_at=?,version=version+1 WHERE id=?", now(), q.id); await addNote(org, pr.id, 'quote', `Quote ${reference(q)} withdrawn.`, user.id); await audit(user, 'prospect.quote_withdrawn', q.id); });
    json(res, 200, {id: q.id, status: 'withdrawn'}); return true;
   }
   if (!['draft', 'sent'].includes(q.status)) fail(409, q.status === 'accepted' ? 'This quote was already accepted.' : 'This quote was withdrawn. Create a new quote.');
   const to = b.email === undefined ? pr.email : email(b.email);
   const days = b.validDays == null || b.validDays === '' ? 30 : Number(b.validDays); if (!Number.isInteger(days) || days < 7 || days > 90) fail(422, 'A quote can stay open for 7 to 90 days.');
   const token = newQuoteToken(), at = now(), tz = await orgTz(org), validUntil = addDays(localDay(at, tz), days), path = '/quotes/' + token, link = publicOrigin(env) + path;
   const c = await company(org);
   await transaction(async () => {
    await run("UPDATE prospect_quotes SET status='withdrawn',updated_at=?,version=version+1 WHERE organization_id=? AND prospect_id=? AND status='sent' AND id<>?", at, org, pr.id, q.id);
    await run("UPDATE prospect_quotes SET status='sent',token_hash=?,valid_until=?,sent_at=?,sent_to=?,updated_at=?,version=version+1 WHERE id=?", quoteTokenHash(token), validUntil, at, to || '', at, q.id);
    if (['new', 'contacted', 'walkthrough'].includes(pr.stage)) { await bump(pr, {stage: 'quote_sent'}, user); await addNote(org, pr.id, 'stage', `Moved from ${STAGE[pr.stage]} to Quote sent.`, user.id, at); }
    await addNote(org, pr.id, 'quote', `Quote ${reference(q)} for ${dollars(q.monthly_minor)} per month ${q.status === 'sent' ? 'sent again (the earlier link no longer works)' : 'sent'}${to ? ' to ' + to : ' (link copied, not emailed)'}.`, user.id, at);
    if (to) await enqueue(org, null, to, renderQuoteEmail({company: c.name, name: pr.name, address: addressOf(pr), plan: q.plan_name, frequency: q.frequency, monthly_minor: q.monthly_minor, valid_label: dayLabel(validUntil), link, supportEmail: c.supportEmail}), at);
    await audit(user, 'prospect.quote_sent', q.id);
   });
   json(res, 200, {id: q.id, status: 'sent', path, url: link, emailed: !!to, valid_until: validUntil}); return true;
  }
  m = p.match(/^\/api\/prospects\/([A-Za-z0-9-]{1,64})(?:\/(stage|notes|quotes|convert|delete))?$/);
  if (!m) fail(404, 'Endpoint not found.');
  await access(user);
  const pr = await load(user, m[1]), org = user.organization_id, action = m[2] || '';
  if (method === 'GET') { if (action) fail(405, 'Use POST.'); json(res, 200, await detail(user, pr)); return true; }
  const b = await body(req);
  if (b.version != null && Number(b.version) !== Number(pr.version)) fail(409, 'Someone else changed this prospect. Reload and try again.');
  if (!action) {
   const f = {};
   if ('name' in b) f.name = need(b.name, 'Name', 120);
   if ('email' in b) f.email = email(b.email);
   if ('phone' in b) f.phone = phone(b.phone);
   if ('streetAddress' in b) Object.assign(f, address(b));
   if ('source' in b) { if (!SOURCE[b.source]) fail(422, 'Choose where the lead came from.'); f.source = b.source; }
   if ('monthlyValue' in b) f.monthly_value_minor = money(b.monthlyValue, 'Estimated monthly value');
   if ('nextFollowUp' in b) f.next_follow_up = day(b.nextFollowUp, 'follow-up date');
   if ('assignedTo' in b) f.assigned_to = await assignee(org, b.assignedTo);
   await transaction(async () => {
    await bump(pr, f, user);
    if ('assigned_to' in f && f.assigned_to !== (pr.assigned_to || null)) { const n = f.assigned_to ? (await get('SELECT name FROM users WHERE id=?', f.assigned_to))?.name : ''; await addNote(org, pr.id, 'system', f.assigned_to ? `Assigned to ${n}.` : 'Unassigned.', user.id); }
    if ('next_follow_up' in f && f.next_follow_up !== (pr.next_follow_up || null)) await addNote(org, pr.id, 'system', f.next_follow_up ? `Next follow-up set for ${dayLabel(f.next_follow_up)}.` : 'Follow-up date cleared.', user.id);
    await audit(user, 'prospect.updated', pr.id);
   });
   if (f.assigned_to && f.assigned_to !== pr.assigned_to && f.assigned_to !== user.id) await notify(f.assigned_to, `Prospect assigned to you: ${f.name || pr.name}`, pr.id, 'prospect_assigned', `${user.name || 'A team member'} assigned you this prospect.`);
   json(res, 200, {id: pr.id}); return true;
  }
  if (action === 'stage') {
   const reason = str(b.lostReason, 'Reason', 200);
   await transaction(async () => { if (await changeStage(user, pr, String(b.stage || ''), reason)) await audit(user, 'prospect.stage_changed', pr.id); });
   json(res, 200, {id: pr.id, stage: b.stage}); return true;
  }
  if (action === 'notes') {
   const text = need(b.body, 'Note', 4000);
   await transaction(async () => { await addNote(org, pr.id, 'note', text, user.id); await run('UPDATE prospects SET updated_at=? WHERE id=?', now(), pr.id); });
   json(res, 201, {id: pr.id}); return true;
  }
  if (action === 'quotes') {
   const items = Array.isArray(b.items) ? b.items : []; if (items.length > 20) fail(422, 'A quote can have at most 20 line items.');
   const clean = items.map((i, n) => ({label: need(i?.label, `Line item ${n + 1}`, 160), amount_minor: money(i?.amount, `Line item ${n + 1} amount`)})).filter(i => i.label);
   const q = {plan_name: str(b.planName, 'Plan name', 120), frequency: need(b.frequency, 'Visit frequency', 80), items: JSON.stringify(clean), monthly_minor: money(b.monthly, 'Monthly price', {required: true}), notes: str(b.notes, 'Notes', 2000)};
   const at = now();
   if (b.quoteId) {
    const old = await get('SELECT * FROM prospect_quotes WHERE id=? AND organization_id=? AND prospect_id=?', String(b.quoteId), org, pr.id); if (!old) fail(404, 'Quote not found.');
    if (old.status !== 'draft') fail(409, 'Only a draft quote can be edited. Create a new quote instead.');
    await run('UPDATE prospect_quotes SET plan_name=?,frequency=?,items=?,monthly_minor=?,notes=?,updated_at=?,version=version+1 WHERE id=?', q.plan_name, q.frequency, q.items, q.monthly_minor, q.notes, at, old.id);
    json(res, 200, {id: old.id}); return true;
   }
   const key = id();
   await transaction(async () => {
    await run("INSERT INTO prospect_quotes(id,organization_id,prospect_id,plan_name,frequency,items,monthly_minor,notes,status,created_by,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,'draft',?,?,?,1)", key, org, pr.id, q.plan_name, q.frequency, q.items, q.monthly_minor, q.notes, user.id, at, at);
    if (pr.monthly_value_minor == null) await run('UPDATE prospects SET monthly_value_minor=?,updated_at=?,version=version+1 WHERE id=?', q.monthly_minor, at, pr.id);
    await addNote(org, pr.id, 'quote', `Draft quote for ${dollars(q.monthly_minor)} per month created.`, user.id, at);
    await audit(user, 'prospect.quote_created', key);
   });
   json(res, 201, {id: key}); return true;
  }
  if (action === 'delete') {
   await access(user, {admin: true});
   if (pr.converted_at) fail(409, 'This prospect is already a client family. Keep it as the record of how they joined.');
   await transaction(async () => {
    await run('DELETE FROM prospect_followup_alerts WHERE prospect_id=?', pr.id);
    await run('DELETE FROM prospect_notes WHERE organization_id=? AND prospect_id=?', org, pr.id);
    await run('DELETE FROM prospect_quotes WHERE organization_id=? AND prospect_id=?', org, pr.id);
    await run('DELETE FROM prospects WHERE id=? AND organization_id=?', pr.id, org);
    await audit(user, 'prospect.deleted', pr.id);
   });
   json(res, 200, {deleted: true}); return true;
  }
  if (action === 'convert') {
   await access(user, {admin: true});
   if (pr.converted_at) fail(409, 'This prospect is already a client family.');
   if (pr.stage !== 'won') fail(409, 'Move the prospect to Won (or have them accept a quote) before converting.');
   if (!pr.street_address || !pr.city || !pr.state || !pr.postal_code) fail(422, 'Add the property address (street, city, state and ZIP) before converting.');
   const names = splitName(pr.name), familyName = str(b.familyName, 'Family name', 160) || (names.lastName ? `${names.lastName} family` : pr.name), residenceName = str(b.residenceName, 'Residence name', 160) || (names.lastName ? `${names.lastName} residence` : pr.street_address);
   const addr = {streetAddress: pr.street_address, addressLine2: pr.address_line2, city: pr.city, state: pr.state, postalCode: pr.postal_code, country: pr.country || 'United States'};
   const notes = await all("SELECT kind,body,created_at FROM prospect_notes WHERE organization_id=? AND prospect_id=? AND kind IN ('note','form') ORDER BY created_at,id", org, pr.id);
   const quote = await get("SELECT * FROM prospect_quotes WHERE organization_id=? AND prospect_id=? AND status='accepted' ORDER BY accepted_at DESC LIMIT 1", org, pr.id);
   const at = now();
   let clientId, propertyId;
   await transaction(async () => {
    clientId = await insertClient(user, {name: familyName, firstName: names.firstName, lastName: names.lastName, email: pr.email, phone: pr.phone, preferredContact: 'No preference', ...addr});
    propertyId = await insertProperty(user, {clientId, name: residenceName, ...addr});
    const lines = [`Converted from Prospects on ${dayLabel(localDay(at, await orgTz(org)))} (source: ${SOURCE[pr.source] || 'Other'}).`];
    if (quote) lines.push(`Accepted quote ${reference(quote)}: ${dollars(quote.monthly_minor)} per month, ${quote.frequency}${quote.plan_name ? ' (' + quote.plan_name + ')' : ''}. Accepted by ${quote.accepted_name} on ${quote.accepted_at}.`);
    for (const n of notes) lines.push(`${n.kind === 'form' ? 'Website request' : 'Note'} (${String(n.created_at).slice(0, 10)}): ${n.body}`);
    await run('INSERT INTO notes VALUES(?,?,?,?,?)', id(), propertyId, lines.join('\n\n').slice(0, 4000), user.id, at);
    const r = await run('UPDATE prospects SET client_id=?,property_id=?,converted_at=?,converted_by=?,updated_at=?,version=version+1 WHERE id=? AND organization_id=? AND converted_at IS NULL', clientId, propertyId, at, user.id, at, pr.id, org);
    if (!r.changes) fail(409, 'This prospect is already a client family.');
    await addNote(org, pr.id, 'system', `Converted to the client family "${familyName}" with the residence "${residenceName}".`, user.id, at);
    await audit(user, 'prospect.converted', pr.id);
   });
   await afterAddressSave(propertyId, addr, null);
   await audit(user, 'property.created', propertyId);
   json(res, 200, {clientId, propertyId}); return true;
  }
  fail(404, 'Endpoint not found.');
 }

 async function orgBySlug(slug) {
  if (!/^[a-z0-9-]{2,80}$/.test(slug)) fail(404, 'This quote form was not found.');
  const org = (await all('SELECT id,name FROM organizations ORDER BY created_at,id')).find(o => slugOf(o.name) === slug);
  if (!org) fail(404, 'This quote form was not found.');
  return org;
 }
 async function publicQuote(token) {
  const q = await get('SELECT * FROM prospect_quotes WHERE token_hash=?', quoteTokenHash(token));
  if (!q || q.status === 'draft') fail(404, 'This quote link is not valid. Check that the whole link was copied.');
  const c = await company(q.organization_id);
  if (q.status === 'withdrawn') fail(410, `This quote was replaced or withdrawn. Contact ${c.name} for the latest quote.`);
  const pr = await get('SELECT * FROM prospects WHERE id=? AND organization_id=?', q.prospect_id, q.organization_id); if (!pr) fail(404, 'This quote link is not valid.');
  const today = localDay(now(), await orgTz(q.organization_id));
  return {q, pr, c, today, expired: q.status === 'sent' && !!q.valid_until && q.valid_until < today};
 }
 const publicQuoteOut = ({q, pr, c, expired}) => ({company: c.name, logo: c.logo, supportEmail: c.supportEmail, reference: reference(q), prospect: {name: pr.name, address: addressOf(pr)}, plan_name: q.plan_name, frequency: q.frequency, items: parseItems(q.items), monthly_minor: Number(q.monthly_minor), notes: q.notes, sent_at: q.sent_at, valid_until: q.valid_until, valid_label: dayLabel(q.valid_until), status: q.status, expired, accepted: q.status === 'accepted' ? {name: q.accepted_name, at: q.accepted_at} : null});

 async function handlePublic(req, res, url) {
  const p = url.pathname;
  let m = p.match(/^\/api\/public\/quote-form\/([^/]{1,100})$/);
  if (m) {
   const slug = decodeURIComponent(m[1]).toLowerCase();
   if (req.method === 'GET') {
    if (!viewIp(ipOf(req))) fail(429, 'Too many requests. Wait a few minutes and try again.');
    const org = await orgBySlug(slug), c = await company(org.id), s = await settingsOf(org.id);
    json(res, 200, {company: c.name, logo: c.logo, supportEmail: c.supportEmail, intro: s.form_intro, enabled: s.form_enabled && !c.suspended, sources: SOURCES.filter(([k]) => k !== 'website').map(([key, label]) => ({key, label}))}); return true;
   }
   if (req.method !== 'POST') fail(405, 'Method not allowed.');
   const ip = ipOf(req);
   if (!formIp(ip)) fail(429, 'Too many requests from this connection. Wait a few minutes and try again.');
   const b = await body(req);
   const org = await orgBySlug(slug), c = await company(org.id), s = await settingsOf(org.id);
   if (!s.form_enabled || c.suspended) fail(403, `${c.name} is not taking online quote requests right now. Please contact them directly.`);
   // Honeypot: a hidden field people never see. Bots that fill it get the normal thank-you, and nothing is stored.
   if (b.website || b.company_website) { json(res, 201, {received: true}); return true; }
   if (!formCompany(org.id)) fail(429, 'This form is receiving a lot of requests. Please try again later or contact the company directly.');
   const row = {name: need(b.name, 'Your name', 120), email: email(b.email), phone: phone(b.phone), ...address(b), message: str(b.message, 'Message', 2000)};
   if (!row.email && !row.phone) fail(422, 'Enter an email address or a phone number so we can reply.');
   const at = now(), key = id();
   const people = await admins(org.id), link = appLink();
   await transaction(async () => {
    await run("INSERT INTO prospects(id,organization_id,name,email,phone,street_address,address_line2,city,state,postal_code,country,source,stage,message,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,'website','new',?,?,?,1)", key, org.id, row.name, row.email, row.phone, row.street_address, row.address_line2, row.city, row.state, row.postal_code, row.country, row.message, at, at);
    await addNote(org.id, key, 'form', row.message || 'Quote requested through the website form (no message).', null, at);
    const mail = renderLeadEmail({company: c.name, name: row.name, email: row.email, phone: row.phone, address: addressOf(row), message: row.message, link});
    for (const u of people) { await notify(u.id, `New quote request: ${row.name}`, key, 'prospect_new', [addressOf(row), row.phone || row.email].filter(Boolean).join(' · '), at); await enqueue(org.id, u.id, u.email, mail, at); }
    await publicAudit(org.id, 'quote-form', 'prospect.form_submitted', key);
   });
   json(res, 201, {received: true}); return true;
  }
  m = p.match(/^\/api\/public\/quotes\/([A-Za-z0-9_-]{43})(\/accept)?$/);
  if (!m) { if (p.startsWith('/api/public/quotes/')) fail(404, 'This quote link is not valid. Check that the whole link was copied.'); return false; }
  if (!TOKEN.test(m[1])) fail(404, 'This quote link is not valid.');
  if (!m[2]) {
   if (req.method !== 'GET') fail(405, 'Method not allowed.');
   if (!viewIp(ipOf(req))) fail(429, 'Too many requests. Wait a few minutes and try again.');
   const v = await publicQuote(m[1]);
   if (v.q.status === 'sent') { await run('UPDATE prospect_quotes SET view_count=view_count+1,viewed_at=? WHERE id=?', now(), v.q.id); if (!Number(v.q.view_count)) await addNote(v.q.organization_id, v.pr.id, 'quote', `Quote ${reference(v.q)} opened by the prospect.`, null); }
   json(res, 200, {quote: publicQuoteOut(v)}); return true;
  }
  if (req.method !== 'POST') fail(405, 'Method not allowed.');
  const ip = ipOf(req);
  if (!acceptIp(ip)) fail(429, 'Too many attempts. Wait a few minutes and try again.');
  const b = await body(req), v = await publicQuote(m[1]);
  if (v.q.status === 'accepted') fail(409, `This quote was already accepted by ${v.q.accepted_name}.`);
  if (v.expired) fail(410, `This quote expired on ${dayLabel(v.q.valid_until)}. Contact ${v.c.name} for an updated quote.`);
  const name = need(b.name, 'Your full name', 120); if (name.length < 2) fail(422, 'Type your full name to accept.');
  if (b.agree !== true) fail(422, 'Tick the box to confirm you accept the quote.');
  const at = now(), ua = String(req.headers['user-agent'] || '').slice(0, 300), org = v.q.organization_id;
  await transaction(async () => {
   const r = await run("UPDATE prospect_quotes SET status='accepted',accepted_at=?,accepted_name=?,accepted_ip=?,accepted_user_agent=?,updated_at=?,version=version+1 WHERE id=? AND status='sent'", at, name, ip, ua, at, v.q.id);
   if (!r.changes) fail(409, 'This quote was already accepted or replaced.');
   const pr = await get('SELECT * FROM prospects WHERE id=?', v.pr.id);
   if (pr.stage !== 'won') { await run("UPDATE prospects SET stage='won',lost_reason='',won_at=?,updated_at=?,version=version+1 WHERE id=?", at, at, pr.id); await addNote(org, pr.id, 'stage', `Moved from ${STAGE[pr.stage]} to Won.`, null, at); }
   await addNote(org, pr.id, 'quote', `Quote ${reference(v.q)} accepted online by ${name} (IP ${ip}).`, null, at);
   const people = await admins(org), extra = pr.assigned_to ? await get("SELECT id,name,email FROM users WHERE id=? AND organization_id=? AND active=1", pr.assigned_to, org) : null;
   const everyone = [...new Map([...people, extra].filter(Boolean).map(u => [u.id, u])).values()];
   const mail = renderAcceptedEmail({company: v.c.name, name: pr.name, accepted_name: name, when: new Intl.DateTimeFormat('en-US', {timeZone: await orgTz(org), dateStyle: 'medium', timeStyle: 'short'}).format(new Date(at)), address: addressOf(pr), monthly_minor: v.q.monthly_minor, link: appLink()});
   for (const u of everyone) { await notify(u.id, `Quote accepted: ${pr.name}`, pr.id, 'prospect_won', `${name} accepted ${dollars(v.q.monthly_minor)} per month.`, at); await enqueue(org, u.id, u.email, mail, at); }
   await publicAudit(org, 'quote-acceptance', 'prospect.quote_accepted', v.q.id);
  });
  json(res, 200, {accepted: true, accepted_name: name, accepted_at: at}); return true;
 }

 /** Hourly: one bell notification per prospect per follow-up date when it comes due (assignee, else administrators). */
 async function tick(nowIso = now()) {
  const horizon = addDays(nowIso.slice(0, 10), 1);
  const rows = await all("SELECT id,organization_id,name,next_follow_up,assigned_to,stage FROM prospects WHERE next_follow_up IS NOT NULL AND next_follow_up<=? AND stage NOT IN ('won','lost')", horizon);
  const tz = new Map(); let sent = 0;
  for (const p of rows) {
   if (!tz.has(p.organization_id)) tz.set(p.organization_id, await orgTz(p.organization_id));
   const today = localDay(nowIso, tz.get(p.organization_id)); if (p.next_follow_up > today) continue;
   const r = await run('INSERT INTO prospect_followup_alerts(prospect_id,follow_up,created_at) VALUES(?,?,?) ON CONFLICT(prospect_id,follow_up) DO NOTHING', p.id, p.next_follow_up, nowIso);
   if (!r.changes) continue;
   let people = [];
   if (p.assigned_to) { const u = await get("SELECT id,role FROM users WHERE id=? AND organization_id=? AND active=1", p.assigned_to, p.organization_id); if (u && await granted({...u, organization_id: p.organization_id})) people = [u]; }
   if (!people.length) people = await admins(p.organization_id);
   const overdue = p.next_follow_up < today;
   for (const u of people) { await notify(u.id, overdue ? `Follow-up overdue: ${p.name}` : `Follow up today: ${p.name}`, p.id, 'prospect_followup', `${STAGE[p.stage]} · follow-up ${overdue ? 'was due ' : 'due '}${dayLabel(p.next_follow_up)}`, nowIso); sent++; }
  }
  return {sent};
 }

 return {handle, handlePublic, decorate, tick, granted};
}
