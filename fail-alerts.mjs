// Checklist "Alert the office on fail": when an inspection is completed (submitted, or published straight
// from a draft) and one or more failed items are set to alert the office, every active admin on the
// company account plus the residence's Residence Manager gets ONE alert for that inspection, both in the
// app (notifications) and by email (through the existing email_outbox / Resend queue).
import {createHash} from 'node:crypto';

/** Answer statuses that count as a failed item. Built-in visits use "attention"; template pass/fail items use "fail". */
export const FAILED_STATUSES = new Set(['attention', 'fail']);
export const FALLBACK_TIMEZONE = 'America/New_York';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
/** Item wording compared case-, accent-, spacing- and punctuation-insensitively. */
export const wording = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Which failed answers should alert the office. A failed answer is matched to checklist template items by
 * stable key first, then by item wording. It alerts when a matched template item has alert_on_fail.
 */
export function alertItems(answers, templateItems) {
 const byKey = new Map(), byLabel = new Map();
 const add = (map, key, item) => { if (!key) return; map.set(key, (map.get(key) || false) || !!Number(item.alert_on_fail)); };
 for (const item of templateItems || []) { add(byKey, String(item.stable_key || ''), item); add(byLabel, wording(item.label), item); }
 return (answers || []).filter(a => a && FAILED_STATUSES.has(a.status)).filter(a => byKey.has(a.key) ? byKey.get(a.key) : !!byLabel.get(wording(a.label)))
  .map(a => ({key: a.key, section: String(a.section || ''), label: String(a.label || ''), note: String(a.note || '').trim(), status: a.status}));
}

/** "Oct 2, 2026, 10:05 AM EDT" in the residence's timezone (Eastern when none or invalid). */
export function formatWhen(iso, timezone) {
 const at = new Date(iso || Date.now());
 const format = zone => new Intl.DateTimeFormat('en-US', {timeZone: zone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).format(at);
 try { return format(timezone || FALLBACK_TIMEZONE); } catch { return format(FALLBACK_TIMEZONE); }
}

/** Absolute link that opens the inspection after sign-in. Uses APP_URL when it is a valid https origin. */
export function inspectionLink(inspectionId, env = process.env) {
 let origin = 'https://estateaegis.com';
 try { const base = new URL(env.APP_URL || origin); if (base.protocol === 'https:' && !base.username && !base.password) origin = base.origin; } catch {}
 return origin + '/login?inspection=' + encodeURIComponent(inspectionId);
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** "Oct 2, 2026" for a YYYY-MM-DD visit date (shown as entered, no timezone shift). */
export const visitDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'}) : String(value || '');
export const alertTitle = d => `Inspection alert: ${plural(d.items.length, 'failed item')} at ${d.property_name}`;
export const alertBody = d => `${d.items.map(i => i.label).join('; ')} · Inspector: ${d.inspector_name}`;

/** Subject, plain text and HTML for the alert email. Pure, so it can be tested and rendered for review. */
export function renderFailAlertEmail(d) {
 const subject = alertTitle(d);
 const text = [subject, '', `Residence: ${d.property_name}`, `Address: ${d.address || 'Address not entered'}`, `Inspector: ${d.inspector_name}`, `Completed: ${d.when}`, `Visit date: ${visitDate(d.inspection_date)}`, '', 'Failed items:',
  ...d.items.flatMap(i => [`- ${i.section ? i.section + ' — ' : ''}${i.label}`, `  Note: ${i.note || 'No note added'}`]),
  ...(d.summary ? ['', `Inspector summary: ${d.summary}`] : []), '', `Open the inspection: ${d.link}`, '',
  `You are receiving this because you are an administrator on the ${d.company} account or the Residence Manager for ${d.property_name}.`].join('\n');
 const row = (k, v) => `<tr><td style="padding:6px 0;color:#5f6b76;font-size:13px;width:110px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#1f2933">${esc(v)}</td></tr>`;
 const items = d.items.map(i => `<tr><td style="padding:14px 16px;border-top:1px solid #e2e7eb"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5f6b76">${esc(i.section || 'Checklist item')}</div><div style="font-size:15px;font-weight:bold;color:#1f2933;margin-top:3px"><span style="display:inline-block;background:#f6e7e4;color:#7e202b;border-radius:4px;padding:2px 7px;font-size:11px;margin-right:8px;vertical-align:1px">Failed</span>${esc(i.label)}</div><div style="font-size:14px;color:${i.note ? '#1f2933' : '#8a949d'};margin-top:6px;${i.note ? '' : 'font-style:italic'}">${esc(i.note || 'No note added')}</div></td></tr>`).join('');
 const html = `<div style="margin:0;padding:24px 12px;background:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#1f2933"><div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e7eb;border-radius:12px;overflow:hidden">`
  + `<div style="border-top:4px solid #7e202b;padding:24px 28px 6px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5f6b76">${esc(d.company)} · Inspection alert</div><h1 style="font-size:22px;line-height:1.3;margin:8px 0 6px;color:#7e202b">${esc(plural(d.items.length, 'item'))} failed at ${esc(d.property_name)}</h1><p style="margin:0;color:#5f6b76;font-size:14px">${esc(d.address || 'Address not entered')}</p></div>`
  + `<div style="padding:10px 28px 4px"><table role="presentation" style="width:100%;border-collapse:collapse">${row('Inspector', d.inspector_name)}${row('Completed', d.when)}${row('Visit date', visitDate(d.inspection_date))}</table></div>`
  + `<div style="padding:12px 28px 4px"><table role="presentation" style="width:100%;border-collapse:collapse;border:1px solid #e2e7eb;border-radius:10px;border-top:0">${items}</table></div>`
  + (d.summary ? `<div style="padding:14px 28px 0"><div style="font-size:13px;color:#5f6b76">Inspector summary</div><p style="margin:4px 0 0;font-size:14px">${esc(d.summary)}</p></div>` : '')
  + `<div style="padding:22px 28px 26px"><a href="${esc(d.link)}" style="display:inline-block;background:#7e202b;color:#ffffff;padding:13px 22px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px">Open inspection</a><p style="margin:16px 0 0;font-size:12px;color:#8a949d">If the button does not work, copy this link:<br>${esc(d.link)}</p></div>`
  + `<div style="padding:16px 28px;background:#faf9f6;border-top:1px solid #e2e7eb;font-size:12px;color:#5f6b76">You are receiving this because you are an administrator on the ${esc(d.company)} account or the Residence Manager for ${esc(d.property_name)}. Powered by EstateAegis.</div></div></div>`;
 return {subject, text, html};
}

export function createFailAlerts({get, all, run, id, now, fail, json, body}, {env = process.env, log = console.log} = {}) {
 /** The Residence Manager (properties.account_manager_id) when it is an active staff or admin account. Never a family or vendor account. */
 async function residenceManager(org, property) {
  if (!property?.account_manager_id) return null;
  return await get("SELECT id,name,email,role FROM users WHERE id=? AND organization_id=? AND active=1 AND role IN ('admin','employee')", property.account_manager_id, org) || null;
 }
 /** Every active admin on the company account plus the Residence Manager, once each. */
 async function recipients(org, property) {
  const admins = await all("SELECT id,name,email,role FROM users WHERE organization_id=? AND role='admin' AND active=1 ORDER BY created_at,id", org);
  return [...new Map([...admins, await residenceManager(org, property)].filter(Boolean).map(u => [u.id, u])).values()];
 }
 /** Template items that decide alert_on_fail for this inspection. */
 async function templateItems(row, org) {
  const columns = 'stable_key,label,alert_on_fail';
  if (row.template_id && row.template_version != null) {
   // Linked visit: the exact template version it was started from (published versions are never edited in place).
   const version = await get('SELECT v.id FROM checklist_template_versions v JOIN checklist_templates t ON t.id=v.template_id WHERE v.template_id=? AND v.version=? AND t.organization_id=?', row.template_id, row.template_version, org);
   if (version) return {source: 'linked-template', items: await all(`SELECT ${columns} FROM checklist_template_items WHERE template_version_id=?`, version.id)};
  }
  // Visits are not linked to templates yet (they use the built-in checklist): use the latest published
  // version of every active company template for the same visit type.
  const items = [];
  for (const t of await all('SELECT id FROM checklist_templates WHERE organization_id=? AND visit_type=? AND archived_at IS NULL', org, row.visit_type || 'routine')) {
   const v = await get("SELECT id FROM checklist_template_versions WHERE template_id=? AND status='published' ORDER BY version DESC LIMIT 1", t.id);
   if (v) items.push(...await all(`SELECT ${columns} FROM checklist_template_items WHERE template_version_id=?`, v.id));
  }
  return {source: 'company-templates', items};
 }

 /**
  * Call inside the transaction that completes an inspection. Creates at most one alert per inspection
  * (inspection_fail_alerts primary key), so retries, offline replays, reopen/resubmit and submit-then-publish
  * never send a second alert. Email goes through the outbox, so nothing external runs inside the transaction.
  */
 async function inspectionCompleted(inspectionId, {source = 'submit', completedAt = now()} = {}) {
  const row = await get('SELECT * FROM inspections WHERE id=?', inspectionId);
  if (!row) return {alerted: false};
  if (await get('SELECT inspection_id FROM inspection_fail_alerts WHERE inspection_id=?', row.id)) return {alerted: false, duplicate: true};
  const property = await get('SELECT * FROM properties WHERE id=?', row.property_id), org = property.organization_id;
  const failed = JSON.parse(row.answers || '[]').filter(a => FAILED_STATUSES.has(a?.status));
  if (!failed.length) return {alerted: false};
  const resolved = await templateItems(row, org), items = alertItems(failed, resolved.items);
  if (!items.length) return {alerted: false};
  const people = await recipients(org, property);
  const timezone = property.timezone || FALLBACK_TIMEZONE;
  const details = {
   inspection_id: row.id, property_id: property.id, property_name: property.name, address: property.address || '',
   company: (await get('SELECT name FROM organizations WHERE id=?', org))?.name || 'Your company',
   inspector_name: (await get('SELECT name FROM users WHERE id=?', row.inspector_id))?.name || 'Not recorded',
   inspection_date: row.inspection_date, completed_at: completedAt, timezone, when: formatWhen(completedAt, timezone),
   summary: String(row.summary || '').trim(), items, link: inspectionLink(row.id, env), source: resolved.source
  };
  const claimed = await run('INSERT INTO inspection_fail_alerts(inspection_id,organization_id,property_id,source,items,details,recipient_count,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, org, property.id, source, JSON.stringify(items), JSON.stringify(details), people.length, now());
  if (claimed.changes !== 1) return {alerted: false, duplicate: true};
  const email = renderFailAlertEmail(details), title = alertTitle(details), summary = alertBody(details);
  for (const person of people) await run('INSERT INTO notifications(id,user_id,title,entity_id,read_at,created_at,kind,body) VALUES(?,?,?,?,?,?,?,?)', id(), person.id, title, row.id, null, now(), 'inspection_fail', summary);
  const demo = await get('SELECT organization_id FROM demo_workspaces WHERE organization_id=?', org);
  if (!demo) for (const person of people.filter(p => p.email)) {
   const key = createHash('sha256').update(org + ':inspection-fail:' + row.id + ':' + person.email.toLowerCase()).digest('hex');
   await run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,html,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', key, org, person.id, person.email, email.subject, email.text, email.html, now(), now());
  }
  if (!env.RESEND_API_KEY) log(`Inspection fail alert ${row.id}: in-app alerts created for ${people.length} recipient(s); email is queued but not sent because RESEND_API_KEY is not set.`);
  return {alerted: true, recipients: people.length, items: items.length};
 }

 /** The signed-in user's own notifications, newest first, with fail-alert details attached. */
 async function list(user) {
  const rows = await all("SELECT n.id,n.user_id,n.title,n.entity_id,n.read_at,n.created_at,n.kind,n.body,a.details alert_details FROM notifications n LEFT JOIN inspection_fail_alerts a ON n.kind='inspection_fail' AND a.inspection_id=n.entity_id AND a.organization_id=? WHERE n.user_id=? ORDER BY n.created_at DESC,n.id LIMIT 100", user.organization_id, user.id);
  return rows.map(({alert_details, ...n}) => { let alert = null; try { alert = alert_details ? JSON.parse(alert_details) : null; } catch {} return {...n, alert}; });
 }

 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (p !== '/api/notifications' && !p.startsWith('/api/notifications/')) return false;
  if (!user) fail(401, 'Please sign in.');
  if (p === '/api/notifications' && req.method === 'GET') {
   const notifications = await list(user);
   const unread = Number((await get('SELECT COUNT(*) total FROM notifications WHERE user_id=? AND read_at IS NULL', user.id))?.total || 0);
   json(res, 200, {notifications, unread}); return true;
  }
  if (req.method !== 'POST') fail(404, 'Endpoint not found.');
  const b = await body(req);
  if (p === '/api/notifications/read') {
   const own = await get('SELECT id,read_at FROM notifications WHERE id=? AND user_id=?', String(b.id || ''), user.id);
   if (!own) fail(404, 'Notification not found.');
   if (!own.read_at) await run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL', now(), own.id, user.id);
   json(res, 200, {ok: true}); return true;
  }
  if (p === '/api/notifications/read-all') {
   const changed = await run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), user.id);
   json(res, 200, {ok: true, updated: changed.changes}); return true;
  }
  fail(404, 'Endpoint not found.');
 }
 return {inspectionCompleted, recipients, residenceManager, list, handle};
}
