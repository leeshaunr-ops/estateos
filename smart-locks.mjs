// Smart-lock access windows (Competitor opportunities #2). Residences can have locks; every visit or work order that
// has an assignee and a time window gets a temporary door code per lock, valid only for the window plus the company's
// buffer. The code is shown to the assignee (staff app or vendor portal) only inside that window, and every reveal is
// audit-logged like the residence's access codes. Codes are revoked when the visit or job is cancelled, reassigned or
// completed, and expire after the window.
//
// Manual mode (no lock account connected): the office enters or generates the code and programs it on the lock; after
// the window (or an early revoke) the app opens a reminder task to remove it. Seam mode (SEAM_API_KEY set): codes are
// created on the lock through Seam with starts_at / ends_at and deleted on revoke; signed Seam webhooks bring lock
// entries (shown as "Lock entry" next to GPS check-in and in the report's Visit verification box) and low-battery /
// offline events (which open a maintenance task and alert the office).
import {readFileSync} from 'node:fs';
import {seal, unseal} from './vault.mjs';
import {lockProvider, generateCode} from './lock-providers.mjs';
import {zonedToUtc, wallClock, addMinutes, addDays, formatIn, readRaw, validTimezone} from './integration-core.mjs';

export const LIVE = ['needs_code', 'scheduled'];
export const HORIZON_DAYS = 14;
export const OFFLINE_TASK_MINUTES = 30;
const LOCK_TASK_TITLES = {battery: 'Replace lock batteries', offline: 'Lock offline', removal: 'Remove temporary door code'};
const METHODS = {keycode: 'temporary code', manual: 'by hand (key or thumb turn)', remote: 'remotely (app)', automatic: 'automatically', unknown: 'method not reported'};

/** Window math (pure): the job window and the code's validity (window ± buffer), as UTC ISO strings. */
export function accessWindow({day, startsAt, endsAt, tz, defaultStart = '08:00', defaultEnd = '18:00', bufferMinutes = 30}) {
 let start, end;
 if (startsAt && endsAt && Number.isFinite(Date.parse(startsAt)) && Number.isFinite(Date.parse(endsAt)) && Date.parse(endsAt) > Date.parse(startsAt)) { start = new Date(startsAt).toISOString(); end = new Date(endsAt).toISOString(); }
 else if (/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
  const zone = validTimezone(tz) ? tz : 'America/New_York';
  start = zonedToUtc(day, defaultStart, zone);
  end = defaultEnd > defaultStart ? zonedToUtc(day, defaultEnd, zone) : zonedToUtc(addDays(day, 1), defaultEnd, zone);
 } else return null;
 const buffer = Math.max(0, Math.min(240, Math.round(Number(bufferMinutes) || 0)));
 return {windowStart: start, windowEnd: end, startsAt: addMinutes(start, -buffer), endsAt: addMinutes(end, buffer)};
}
/** Where a code is in its life right now: upcoming, active (revealable), ended. */
export function codePhase(code, nowMs = Date.now()) {
 if (!LIVE.includes(code.status)) return 'ended';
 if (nowMs < Date.parse(code.starts_at)) return 'upcoming';
 if (nowMs > Date.parse(code.ends_at)) return 'ended';
 return 'active';
}
/** Tests (never on Render or in production) can move the lock clock with a file holding an ISO time. */
export function lockClock(env = process.env) {
 const file = env.ESTATEOS_LOCK_TEST_NOW_FILE;
 if (!file || env.RENDER || env.NODE_ENV === 'production') return () => Date.now();
 return () => { try { const t = Date.parse(readFileSync(file, 'utf8').trim()); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); } };
}
const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

export function createSmartLocks({get, all, run, transaction, id, now, fail, text, note, json, body, roles, property, audit, communications, timezoneFor, env = process.env, provider: injected, fetcher, clock = lockClock(env)}) {
 const provider = injected || lockProvider(env, {fetcher});
 const sealContext = code => `${code.organization_id}:lock-code:${code.id}`;
 const vaultReady = () => { try { seal({}, 'probe'); return true; } catch { return false; } };

 async function settings(orgId) {
  const s = await get('SELECT * FROM lock_settings WHERE organization_id=?', orgId) || {};
  let accounts = []; try { accounts = JSON.parse(s.seam_accounts || '[]'); } catch {}
  return {bufferMinutes: s.buffer_minutes ?? 30, defaultStart: s.default_start || '08:00', defaultEnd: s.default_end || '18:00', codeLength: s.code_length ?? 6, autoCreate: s.auto_create === undefined || s.auto_create === null ? true : Number(s.auto_create) === 1, accounts: Array.isArray(accounts) ? accounts : [], webviewId: s.seam_webview_id || null};
 }
 async function saveSettings(user, b) {
  roles(user, 'admin');
  const buffer = Math.round(Number(b.bufferMinutes)), length = Math.round(Number(b.codeLength));
  if (!Number.isFinite(buffer) || buffer < 0 || buffer > 240) fail(422, 'The buffer must be between 0 and 240 minutes.');
  if (!hhmm(b.defaultStart) || !hhmm(b.defaultEnd) || b.defaultStart === b.defaultEnd) fail(422, 'Choose a start and end time for visits without set hours.');
  if (!Number.isFinite(length) || length < 4 || length > 8) fail(422, 'Codes must be 4 to 8 digits.');
  const current = await settings(user.organization_id);
  await run('INSERT INTO lock_settings(organization_id,buffer_minutes,default_start,default_end,code_length,auto_create,seam_accounts,seam_webview_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET buffer_minutes=excluded.buffer_minutes,default_start=excluded.default_start,default_end=excluded.default_end,code_length=excluded.code_length,auto_create=excluded.auto_create,updated_at=excluded.updated_at', user.organization_id, buffer, b.defaultStart, b.defaultEnd, length, b.autoCreate === false || b.autoCreate === 'off' ? 0 : 1, JSON.stringify(current.accounts), current.webviewId, now());
  await audit(user, 'smart_locks.settings_updated', user.organization_id);
  changed(user.organization_id);
  return settings(user.organization_id);
 }
 async function storeAccounts(orgId, accounts, webviewId) {
  const s = await settings(orgId);
  await run('INSERT INTO lock_settings(organization_id,seam_accounts,seam_webview_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET seam_accounts=excluded.seam_accounts,seam_webview_id=excluded.seam_webview_id,updated_at=excluded.updated_at', orgId, JSON.stringify([...new Set(accounts)]), webviewId === undefined ? s.webviewId : webviewId, now());
 }
 const residenceTz = async (pRow) => (timezoneFor ? await timezoneFor(pRow) : pRow.timezone) || 'America/New_York';

 /* ---------- notifications and tasks ---------- */
 async function staffFor(pRow) {
  const primary = await communications.primary(pRow.organization_id);
  const manager = pRow.account_manager_id ? await get('SELECT id,name,email,role FROM users WHERE id=? AND organization_id=? AND active=1', pRow.account_manager_id, pRow.organization_id) : null;
  return {primary, manager, recipients: [primary, manager].filter(Boolean)};
 }
 async function openTask(lock, kind, {title, description, codeId = null, due = now().slice(0, 10)}) {
  const open = await get(`SELECT t.work_order_id FROM lock_tasks t JOIN work_orders w ON w.id=t.work_order_id WHERE t.lock_id=? AND t.kind=? AND w.status NOT IN ('completed','cancelled')${codeId ? ' AND t.code_id=?' : ''}`, lock.id, kind, ...(codeId ? [codeId] : []));
  if (open) return open.work_order_id;
  const pRow = await get('SELECT * FROM properties WHERE id=?', lock.property_id);
  const {primary, manager, recipients} = await staffFor(pRow);
  if (!primary) return null;
  const workId = id();
  await transaction(async () => {
   await run('INSERT INTO work_orders(id,property_id,title,description,priority,due_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', workId, pRow.id, title, description, kind === 'removal' ? 'Normal' : 'High', due, primary.id, now());
   if (manager && ['admin', 'employee'].includes(manager.role)) await run('INSERT INTO work_staff(work_id,user_id,schedule_id) VALUES(?,?,?) ON CONFLICT(work_id) DO NOTHING', workId, manager.id, null);
   await run('INSERT INTO lock_tasks(id,organization_id,lock_id,kind,work_order_id,code_id,created_at) VALUES(?,?,?,?,?,?,?)', id(), lock.organization_id, lock.id, kind, workId, codeId, now());
   await run('INSERT INTO audit VALUES(?,?,?,?,?,?)', id(), lock.organization_id, primary.id, 'smart_locks.task_created', workId, now());
  });
  await communications.enqueue(lock.organization_id, `lock-task:${kind}:${workId}`, recipients, `${title}: ${pRow.name}`, `${description}\n\nSign in to EstateAegis to see the work order.`, workId);
  return workId;
 }
 const isLockTask = async workId => !!await get('SELECT 1 FROM lock_tasks WHERE work_order_id=?', workId);

 /* ---------- code lifecycle ---------- */
 async function sourceLabel(code) {
  if (code.source_type === 'inspection') { const i = await get('SELECT inspection_date FROM inspections WHERE id=?', code.source_id); return i ? `visit on ${i.inspection_date}` : 'visit'; }
  const w = await get('SELECT title FROM work_orders WHERE id=?', code.source_id); return w ? `work order “${w.title}”` : 'work order';
 }
 async function assigneeRecipients(code) {
  if (code.assignee_user_id) return [await get('SELECT id,email FROM users WHERE id=? AND organization_id=? AND active=1', code.assignee_user_id, code.organization_id)].filter(Boolean);
  if (code.assignee_vendor_id) return all("SELECT id,email FROM users WHERE vendor_id=? AND organization_id=? AND role='vendor' AND active=1", code.assignee_vendor_id, code.organization_id);
  return [];
 }
 async function setCodeValue(code, value, source) {
  await run("UPDATE lock_access_codes SET code_sealed=?,code_hint=?,code_source=?,status='scheduled',provider_error=NULL,version=version+1,updated_at=? WHERE id=?", seal({code: value}, sealContext(code)), String(value).slice(-2), source, now(), code.id);
  const fresh = await get('SELECT * FROM lock_access_codes WHERE id=?', code.id);
  const pRow = await get('SELECT name,timezone,timezone_source,organization_id FROM properties WHERE id=?', code.property_id);
  const tz = await residenceTz(pRow), lock = await get('SELECT name FROM residence_locks WHERE id=?', code.lock_id);
  await communications.enqueue(code.organization_id, `lock-code-ready:${code.id}:${fresh.version}`, await assigneeRecipients(fresh), `Door code ready: ${pRow.name}`, `A temporary door code for the ${lock?.name || 'lock'} at ${pRow.name} is ready for your ${await sourceLabel(fresh)}. It shows in EstateAegis from ${formatIn(fresh.starts_at, tz)} until ${formatIn(fresh.ends_at, tz)}. Codes are never sent by email.`, code.source_id);
  return fresh;
 }
 async function pushToProvider(code, lock, st) {
  const value = generateCode(st.codeLength);
  try {
   const out = await provider.createCode({deviceId: lock.device_id, name: `EstateAegis ${code.id.slice(0, 8)}`, code: value, startsAt: code.starts_at, endsAt: code.ends_at});
   await run('UPDATE lock_access_codes SET provider_code_id=?,provider_status=?,provider_error=NULL,updated_at=? WHERE id=?', out.providerCodeId, out.status || 'setting', now(), code.id);
   if (out.code) await setCodeValue({...code, provider_code_id: out.providerCodeId}, out.code, 'provider');
  } catch (error) {
   await run('UPDATE lock_access_codes SET provider_error=?,updated_at=? WHERE id=?', String(error.message || 'The lock service did not accept the code.').slice(0, 300), now(), code.id);
  }
 }
 async function createCode(org, lock, want, st) {
  const key = id(), at = now();
  const inserted = await run('INSERT OR IGNORE INTO lock_access_codes(id,organization_id,property_id,lock_id,source_type,source_id,assignee_user_id,assignee_vendor_id,window_start,window_end,starts_at,ends_at,status,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', key, org, lock.property_id, lock.id, want.sourceType, want.sourceId, want.userId || null, want.vendorId || null, want.windowStart, want.windowEnd, want.startsAt, want.endsAt, 'needs_code', lock.provider === 'manual' || !lock.device_id ? 'manual' : provider.kind, at, at);
  if (!inserted.changes) return null;
  const code = await get('SELECT * FROM lock_access_codes WHERE id=?', key);
  if (code.provider !== 'manual' && provider.live) await pushToProvider(code, lock, st);
  else {
   const pRow = await get('SELECT * FROM properties WHERE id=?', lock.property_id), {recipients} = await staffFor(pRow), tz = await residenceTz(pRow);
   await communications.enqueue(org, `lock-code-needed:${key}`, recipients, `Door code needed: ${pRow.name}`, `Enter or generate a temporary code for the ${lock.name} at ${pRow.name} for the ${await sourceLabel(code)}, then program it on the lock. It should work from ${formatIn(code.starts_at, tz)} until ${formatIn(code.ends_at, tz)}.`, code.source_id);
  }
  return code;
 }
 async function revoke(code, reason, user = null) {
  const changedRow = await run(`UPDATE lock_access_codes SET status='revoked',revoked_at=?,revoked_reason=?,version=version+1,updated_at=? WHERE id=? AND status IN ('needs_code','scheduled')`, now(), reason, now(), code.id);
  if (!changedRow.changes) return false;
  if (code.provider_code_id) await deleteAtProvider(code);
  else if (code.code_sealed) await removalReminder(code, reason);
  if (user) await audit(user, 'lock_code.revoked', code.id);
  return true;
 }
 async function deleteAtProvider(code) {
  try { await provider.deleteCode({providerCodeId: code.provider_code_id}); await run('UPDATE lock_access_codes SET provider_deleted_at=?,provider_error=NULL WHERE id=?', now(), code.id); }
  catch (error) { await run('UPDATE lock_access_codes SET provider_error=? WHERE id=?', ('Could not remove the code from the lock yet: ' + (error.message || '')).slice(0, 300), code.id); }
 }
 async function removalReminder(code, why) {
  const lock = await get('SELECT * FROM residence_locks WHERE id=?', code.lock_id); if (!lock) return;
  const pRow = await get('SELECT * FROM properties WHERE id=?', code.property_id), tz = await residenceTz(pRow);
  const reason = {expired: 'its access window ended', completed: 'the visit or job was completed', cancelled: 'the visit or job was cancelled', reassigned: 'the visit or job was reassigned', unassigned: 'the visit or job no longer has an assignee', rescheduled: 'the visit or job moved outside the next two weeks', removed: 'the lock was removed from EstateAegis', admin: 'an administrator revoked it'}[why] || 'it is no longer needed';
  const workId = await openTask(lock, 'removal', {codeId: code.id, title: `${LOCK_TASK_TITLES.removal} from ${lock.name}`, description: `Remove the temporary door code ending in ${code.code_hint || '••'} from the ${lock.name} at ${pRow.name}: ${reason}. It was set for ${formatIn(code.starts_at, tz)} to ${formatIn(code.ends_at, tz)}. Mark this work order complete once the code is deleted from the lock.`, due: wallClock(now(), tz).day});
  if (workId) await run('UPDATE lock_access_codes SET removal_work_id=? WHERE id=?', workId, code.id);
 }

 /** What codes should exist right now for one company (pure database reads). */
 async function desired(org, st) {
  const locks = await all('SELECT l.* FROM residence_locks l JOIN properties p ON p.id=l.property_id WHERE l.organization_id=? AND l.active=1 AND p.organization_id=? AND p.archived_at IS NULL', org, org);
  const byHome = new Map(); for (const l of locks) { if (!byHome.has(l.property_id)) byHome.set(l.property_id, []); byHome.get(l.property_id).push(l); }
  const out = [], nowMs = clock(), horizon = nowMs + HORIZON_DAYS * 864e5;
  for (const [homeId, homeLocks] of byHome) {
   const pRow = await get('SELECT * FROM properties WHERE id=?', homeId), tz = await residenceTz(pRow), today = wallClock(new Date(nowMs).toISOString(), tz).day;
   const visits = await all("SELECT i.id,i.inspection_date,i.inspector_id FROM inspections i JOIN users u ON u.id=i.inspector_id AND u.active=1 WHERE i.property_id=? AND i.status='draft' AND i.inspection_date>=? AND i.inspection_date<=?", homeId, addDays(today, -1), addDays(today, HORIZON_DAYS));
   for (const v of visits) { const w = accessWindow({day: v.inspection_date, tz, ...st}); if (w) out.push({sourceType: 'inspection', sourceId: v.id, userId: v.inspector_id, ...w, homeLocks}); }
   const jobs = await all("SELECT w.id,w.due_date,w.vendor_id,a.user_id staff_id,s.starts_at,s.ends_at FROM work_orders w LEFT JOIN work_staff a ON a.work_id=w.id LEFT JOIN staff_schedules s ON s.id=a.schedule_id WHERE w.property_id=? AND w.status IN ('open','scheduled','in_progress') AND w.id NOT IN (SELECT work_order_id FROM lock_tasks)", homeId);
   for (const j of jobs) {
    if (!j.staff_id && !j.vendor_id) continue;
    const w = accessWindow({day: j.due_date, startsAt: j.starts_at, endsAt: j.ends_at, tz, ...st}); if (!w) continue;
    out.push({sourceType: 'work_order', sourceId: j.id, userId: j.staff_id || null, vendorId: j.staff_id ? null : j.vendor_id, ...w, homeLocks});
   }
  }
  return out.filter(w => Date.parse(w.endsAt) >= nowMs && Date.parse(w.startsAt) <= horizon).flatMap(w => w.homeLocks.map(lock => ({...w, lock})));
 }
 async function whyGone(code) {
  if (code.source_type === 'inspection') { const i = await get('SELECT status,inspector_id FROM inspections WHERE id=?', code.source_id); if (!i) return 'cancelled'; if (i.status !== 'draft') return 'completed'; if (i.inspector_id !== code.assignee_user_id) return 'reassigned'; return 'rescheduled'; }
  const w = await get('SELECT w.status,w.vendor_id,a.user_id staff_id FROM work_orders w LEFT JOIN work_staff a ON a.work_id=w.id WHERE w.id=?', code.source_id);
  if (!w || w.status === 'cancelled') return 'cancelled'; if (['completed', 'submitted'].includes(w.status)) return 'completed';
  if (!w.staff_id && !w.vendor_id) return 'unassigned';
  if ((w.staff_id || null) !== (code.assignee_user_id || null) || (w.staff_id ? null : w.vendor_id) !== (code.assignee_vendor_id || null)) return 'reassigned';
  return 'rescheduled';
 }
 async function reconcileNow(org, {force = false} = {}) {
  const st = await settings(org), nowIso = new Date(clock()).toISOString();
  // Expire codes whose window (plus buffer) has passed.
  for (const code of await all("SELECT * FROM lock_access_codes WHERE organization_id=? AND status IN ('needs_code','scheduled') AND ends_at<?", org, nowIso)) {
   const done = await run("UPDATE lock_access_codes SET status='expired',expired_at=?,version=version+1,updated_at=? WHERE id=? AND status IN ('needs_code','scheduled')", nowIso, nowIso, code.id);
   if (done.changes && code.code_sealed && !code.provider_code_id) await removalReminder(code, 'expired');
  }
  const want = await desired(org, st), live = await all("SELECT * FROM lock_access_codes WHERE organization_id=? AND status IN ('needs_code','scheduled')", org);
  const keyOf = (lockId, type, sourceId) => `${lockId}|${type}|${sourceId}`;
  const wanted = new Map(want.map(w => [keyOf(w.lock.id, w.sourceType, w.sourceId), w]));
  for (const code of live) {
   const w = wanted.get(keyOf(code.lock_id, code.source_type, code.source_id));
   if (!w) { await revoke(code, await whyGone(code)); continue; }
   if ((w.userId || null) !== (code.assignee_user_id || null) || (w.vendorId || null) !== (code.assignee_vendor_id || null)) { await revoke(code, 'reassigned'); continue; }
   if (w.startsAt !== code.starts_at || w.endsAt !== code.ends_at) {
    await run('UPDATE lock_access_codes SET window_start=?,window_end=?,starts_at=?,ends_at=?,version=version+1,updated_at=? WHERE id=?', w.windowStart, w.windowEnd, w.startsAt, w.endsAt, nowIso, code.id);
    if (code.provider_code_id) { try { await provider.updateCode({providerCodeId: code.provider_code_id, startsAt: w.startsAt, endsAt: w.endsAt}); } catch (error) { await run('UPDATE lock_access_codes SET provider_error=? WHERE id=?', String(error.message).slice(0, 300), code.id); } }
   }
   wanted.delete(keyOf(code.lock_id, code.source_type, code.source_id));
  }
  for (const w of wanted.values()) {
   // An administrator's revoke sticks: the same visit/job, lock and assignee is not given a new code automatically.
   if (await get("SELECT 1 FROM lock_access_codes WHERE lock_id=? AND source_type=? AND source_id=? AND status='revoked' AND revoked_reason='admin' AND COALESCE(assignee_user_id,'')=? AND COALESCE(assignee_vendor_id,'')=?", w.lock.id, w.sourceType, w.sourceId, w.userId || '', w.vendorId || '')) continue;
   if (!st.autoCreate && !force) continue;
   await createCode(org, w.lock, w, st);
  }
  // Retry pushes and removals that the lock service did not accept the first time.
  if (provider.live) {
   for (const code of await all("SELECT c.*,l.device_id FROM lock_access_codes c JOIN residence_locks l ON l.id=c.lock_id WHERE c.organization_id=? AND c.status='needs_code' AND c.provider<>'manual' AND c.provider_code_id IS NULL AND c.code_sealed IS NULL AND c.provider_error IS NOT NULL", org)) await pushToProvider(code, {device_id: code.device_id}, st);
   for (const code of await all("SELECT * FROM lock_access_codes WHERE organization_id=? AND status IN ('revoked') AND provider_code_id IS NOT NULL AND provider_deleted_at IS NULL", org)) await deleteAtProvider(code);
  }
  // Locks offline for more than 30 minutes get a maintenance task.
  for (const lock of await all('SELECT * FROM residence_locks WHERE organization_id=? AND active=1 AND offline_since IS NOT NULL AND offline_since<?', org, new Date(clock() - OFFLINE_TASK_MINUTES * 60000).toISOString())) {
   const pRow = await get('SELECT name FROM properties WHERE id=?', lock.property_id);
   await openTask(lock, 'offline', {title: `${LOCK_TASK_TITLES.offline}: ${lock.name}`, description: `The ${lock.name} at ${pRow?.name || 'the residence'} has been offline since ${formatIn(lock.offline_since, 'America/New_York')}. Temporary codes and entry records need the lock online. Check its Wi-Fi bridge or hub and batteries.`});
  }
 }
 const running = new Map(), again = new Set();
 function changed(org) {
  if (!org) return Promise.resolve();
  if (running.has(org)) { again.add(org); return running.get(org); }
  const task = (async () => { try { do { again.delete(org); if (await get('SELECT 1 FROM residence_locks WHERE organization_id=? LIMIT 1', org) || await get("SELECT 1 FROM lock_access_codes WHERE organization_id=? AND status IN ('needs_code','scheduled') LIMIT 1", org)) await reconcileNow(org); } while (again.has(org)); } catch (error) { console.error('Smart locks:', error.message); } finally { running.delete(org); } })();
  running.set(org, task); return task;
 }
 async function tick() { for (const r of await all("SELECT DISTINCT organization_id FROM residence_locks WHERE active=1 UNION SELECT DISTINCT organization_id FROM lock_access_codes WHERE status IN ('needs_code','scheduled')")) await changed(r.organization_id); }

 /* ---------- what each role sees ---------- */
 const canReveal = (user, code) => code.organization_id === user.organization_id && (user.role === 'admin' || (user.role === 'employee' && code.assignee_user_id === user.id) || (user.role === 'vendor' && !!code.assignee_vendor_id && code.assignee_vendor_id === user.vendor_id));
 async function view(user, code, names) {
  const nowMs = clock(), phase = codePhase(code, nowMs), admin = user.role === 'admin';
  return {id: code.id, property_id: code.property_id, lock_id: code.lock_id, lock_name: names.locks.get(code.lock_id) || 'Lock', source_type: code.source_type, source_id: code.source_id, assignee_name: code.assignee_user_id ? names.users.get(code.assignee_user_id) || 'Team member' : names.vendors.get(code.assignee_vendor_id) || 'Vendor', window_start: code.window_start, window_end: code.window_end, starts_at: code.starts_at, ends_at: code.ends_at, status: code.status, phase, has_code: !!code.code_sealed, mine: (user.role !== 'admin' && canReveal(user, code)) || (admin && code.assignee_user_id === user.id), can_reveal: canReveal(user, code) && !!code.code_sealed && (admin || phase === 'active'), provider: code.provider, ...(admin ? {code_hint: code.code_hint || '', code_source: code.code_source || '', provider_status: code.provider_status || '', provider_error: code.provider_error || '', revoked_reason: code.revoked_reason || '', removal_work_id: code.removal_work_id || '', updated_at: code.updated_at, version: code.version} : {})};
 }
 async function decorate(user, data) {
  await (running.get(user.organization_id) || Promise.resolve());
  const org = user.organization_id, staff = ['admin', 'employee'].includes(user.role), admin = user.role === 'admin';
  const visibleHomes = new Set((data.properties || []).map(p => p.id));
  const st = await settings(org);
  const locksAll = await all('SELECT * FROM residence_locks WHERE organization_id=? AND active=1 ORDER BY name', org);
  const names = {locks: new Map(locksAll.map(l => [l.id, l.name])), users: new Map((await all('SELECT id,name FROM users WHERE organization_id=?', org)).map(u => [u.id, u.name])), vendors: new Map((await all('SELECT id,name FROM vendors WHERE organization_id=?', org)).map(v => [v.id, v.name]))};
  const since = new Date(clock() - 30 * 864e5).toISOString();
  let codes = await all("SELECT * FROM lock_access_codes WHERE organization_id=? AND (status IN ('needs_code','scheduled') OR updated_at>=?) ORDER BY starts_at", org, since);
  if (!admin) codes = codes.filter(c => canReveal(user, c));
  const out = {mode: provider.kind, live: !!provider.live, providerLabel: provider.label, vaultReady: staff ? vaultReady() : undefined};
  if (staff) out.settings = {bufferMinutes: st.bufferMinutes, defaultStart: st.defaultStart, defaultEnd: st.defaultEnd, codeLength: st.codeLength, autoCreate: st.autoCreate};
  if (admin) out.connection = {provider: provider.kind, configured: !!provider.live, accounts: st.accounts.length, events: provider.kind === 'seam' ? !!env.SEAM_WEBHOOK_SECRET : provider.kind === 'fake', webhookPath: '/api/webhooks/seam'};
  out.locks = staff ? locksAll.filter(l => visibleHomes.has(l.property_id)).map(l => ({id: l.id, property_id: l.property_id, name: l.name, provider: l.provider, device_id: admin ? l.device_id || '' : undefined, battery_level: l.battery_level, online: !!Number(l.online), offline_since: l.offline_since, last_event_at: l.last_event_at})) : [];
  out.codes = []; for (const c of codes) out.codes.push(await view(user, c, names));
  // Lock entries attached to visits and jobs the person can see (clients: published visits only).
  const sources = new Set([...(data.inspections || []).map(i => 'inspection:' + i.id), ...(user.role === 'client' ? [] : (data.work || []).map(w => 'work_order:' + w.id))]);
  const events = await all("SELECT * FROM lock_events WHERE organization_id=? AND kind IN ('unlocked','access_denied') AND source_id IS NOT NULL ORDER BY occurred_at", org);
  out.entries = events.filter(e => sources.has(e.source_type + ':' + e.source_id)).map(e => ({id: e.id, source_type: e.source_type, source_id: e.source_id, kind: e.kind, lock_name: names.locks.get(e.lock_id) || 'Lock', method: e.method || 'unknown', method_label: METHODS[e.method] || METHODS.unknown, occurred_at: e.occurred_at, by_code: e.code_id ? (staff ? entryWho(e, codes, names) : 'Temporary code') : ''}));
  data.smartLocks = out;
  return data;
 }
 function entryWho(e, codes, names) { const c = codes.find(x => x.id === e.code_id); if (!c) return 'Temporary code'; return 'Temporary code for ' + (c.assignee_user_id ? names.users.get(c.assignee_user_id) || 'a team member' : names.vendors.get(c.assignee_vendor_id) || 'a vendor'); }
 /** Visit verification box in the PDF (and email): add a "Lock entry" row for each lock entry on the visit. */
 async function reportRows(inspectionId, tz) {
  const rows = await all("SELECT e.*,l.name lock_name FROM lock_events e JOIN residence_locks l ON l.id=e.lock_id WHERE e.source_type='inspection' AND e.source_id=? AND e.kind='unlocked' ORDER BY e.occurred_at", inspectionId);
  return rows.map(e => ['Lock entry', `${e.lock_name} unlocked ${formatIn(e.occurred_at, tz)} (${METHODS[e.method] || METHODS.unknown})`]);
 }
 function extendReports(visitVerification) {
  const base = visitVerification.reportForPdf;
  visitVerification.reportForPdf = async (user, inspection, report) => {
   const out = await base(user, inspection, report);
   const rows = await reportRows(inspection.id, out.timezone);
   if (!rows.length) return out;
   if (out.visit) out.visit = {...out.visit, rows: [...out.visit.rows, ...rows]};
   else out.visit = {status: 'lock', label: 'Lock entry recorded', tone: 'pass', rows, notes: []};
   return out;
  };
 }

 /* ---------- lock events (webhooks) ---------- */
 async function applyEvent(ev) {
  if (!ev || ev.kind === 'other') return {ignored: true};
  if (ev.kind === 'account_connected') { const org = ev.metadata?.ea_org; if (org && ev.connectedAccountId && await get('SELECT id FROM organizations WHERE id=?', org)) { const st = await settings(org); await storeAccounts(org, [...st.accounts, ev.connectedAccountId]); } return {ok: true}; }
  if (!ev.deviceId) return {ignored: true};
  const locks = await all("SELECT * FROM residence_locks WHERE device_id=? AND provider<>'manual' AND active=1", ev.deviceId);
  if (!locks.length) return {ignored: true};
  const lock = locks[0];
  if (ev.providerEventId && await get('SELECT 1 FROM lock_events WHERE provider_event_id=?', ev.providerEventId)) return {duplicate: true};
  const at = Number.isFinite(Date.parse(ev.occurredAt)) ? new Date(ev.occurredAt).toISOString() : now();
  let code = null, source = null;
  if (ev.providerCodeId) code = await get('SELECT * FROM lock_access_codes WHERE provider_code_id=? AND lock_id=?', ev.providerCodeId, lock.id);
  if (['unlocked', 'access_denied'].includes(ev.kind)) {
   if (code) source = {type: code.source_type, id: code.source_id};
   else { const covering = await get("SELECT * FROM lock_access_codes WHERE lock_id=? AND starts_at<=? AND ends_at>=? AND (status IN ('needs_code','scheduled','expired') OR (status='revoked' AND revoked_at>=?)) ORDER BY CASE source_type WHEN 'inspection' THEN 0 ELSE 1 END, starts_at DESC LIMIT 1", lock.id, at, at, at); if (covering) source = {type: covering.source_type, id: covering.source_id}; }
  }
  const details = {battery: ev.battery ?? null, status: ev.status || null};
  await run('INSERT OR IGNORE INTO lock_events(id,organization_id,property_id,lock_id,kind,method,code_id,source_type,source_id,provider_event_id,occurred_at,details,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id(), lock.organization_id, lock.property_id, lock.id, ev.kind, ev.method || null, code?.id || null, source?.type || null, source?.id || null, ev.providerEventId || null, at, JSON.stringify(details), now());
  await run('UPDATE residence_locks SET last_event_at=?,updated_at=? WHERE id=?', at, now(), lock.id);
  const pRow = await get('SELECT name FROM properties WHERE id=?', lock.property_id);
  if (ev.kind === 'low_battery') {
   await run('UPDATE residence_locks SET battery_level=COALESCE(?,battery_level) WHERE id=?', ev.battery, lock.id);
   await openTask(lock, 'battery', {title: `${LOCK_TASK_TITLES.battery}: ${lock.name}`, description: `The ${lock.name} at ${pRow?.name || 'the residence'} reported a low battery${typeof ev.battery === 'number' ? ` (${Math.round(ev.battery * 100)}%)` : ''}. Replace the batteries before the next visit so temporary codes keep working.`});
  }
  if (ev.kind === 'battery_ok') await run('UPDATE residence_locks SET battery_level=COALESCE(?,battery_level) WHERE id=?', ev.battery, lock.id);
  if (ev.kind === 'offline') await run('UPDATE residence_locks SET online=0,offline_since=COALESCE(offline_since,?) WHERE id=?', at, lock.id);
  if (ev.kind === 'online') await run('UPDATE residence_locks SET online=1,offline_since=NULL WHERE id=?', lock.id);
  if (ev.kind === 'code_status' && code) {
   await run('UPDATE lock_access_codes SET provider_status=?,updated_at=? WHERE id=?', ev.status, now(), code.id);
   if (ev.code && !code.code_sealed && LIVE.includes(code.status)) await setCodeValue(code, ev.code, 'provider');
   if (/failed/.test(ev.status || '')) await run('UPDATE lock_access_codes SET provider_error=? WHERE id=?', 'The lock reported that the code could not be set.', code.id);
  }
  changed(lock.organization_id);
  return {ok: true, lockId: lock.id};
 }
 async function webhook(req, res, url) {
  if (url.pathname !== '/api/webhooks/seam') return false;
  if (req.method !== 'POST') fail(405, 'Use POST.');
  if (!provider.live) fail(404, 'Endpoint not found.');
  const raw = await readRaw(req);
  provider.verifyWebhook({headers: req.headers, body: raw});
  let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid webhook.'); }
  const result = await applyEvent(provider.normalize(payload));
  json(res, 200, {received: true, ...(result.duplicate ? {duplicate: true} : {})});
  return true;
 }

 /* ---------- API ---------- */
 async function codeFor(user, codeId) { const code = await get('SELECT * FROM lock_access_codes WHERE id=? AND organization_id=?', String(codeId || ''), user.organization_id); if (!code) fail(404, 'Door code not found.'); return code; }
 async function lockFor(user, lockId) { const lock = await get('SELECT * FROM residence_locks WHERE id=? AND organization_id=? AND active=1', String(lockId || ''), user.organization_id); if (!lock) fail(404, 'Lock not found.'); await property(user, lock.property_id, 'operate'); return lock; }
 async function handle(req, res, url, user) {
  const p = url.pathname;
  if (!p.startsWith('/api/smart-locks/')) return false;
  if (!user) fail(401, 'Please sign in.');
  if (req.method !== 'POST') fail(405, 'Use POST.');
  const b = await body(req), org = user.organization_id;
  const done = data => { json(res, 200, data); return true; };
  if (p === '/api/smart-locks/codes/reveal') {
   roles(user, 'admin', 'employee', 'vendor');
   const code = await codeFor(user, b.id);
   if (!canReveal(user, code)) fail(404, 'Door code not found.');
   if (!LIVE.includes(code.status)) fail(409, code.status === 'expired' ? 'This door code has expired.' : 'This door code was revoked.');
   if (!code.code_sealed) fail(409, 'The door code is not ready yet.');
   const phase = codePhase(code, clock());
   if (user.role !== 'admin' && phase !== 'active') fail(403, phase === 'upcoming' ? 'This door code shows only during the access window.' : 'This door code has expired.');
   const value = unseal(code.code_sealed, sealContext(code)).code;
   await audit(user, 'lock_code.viewed', code.id);
   return done({code: value, endsAt: code.ends_at});
  }
  roles(user, 'admin');
  if (p === '/api/smart-locks/settings') return done({settings: await saveSettings(user, b)});
  if (p === '/api/smart-locks/locks') {
   const pRow = await property(user, String(b.propertyId || ''), 'operate');
   const name = text(b.name, 'Lock name', 120), providerKind = b.provider === 'seam' ? 'seam' : 'manual';
   let deviceId = null;
   if (providerKind === 'seam') {
    if (!provider.live) fail(422, 'Connect a lock account first. Until then, add the lock as Manual.');
    deviceId = text(b.deviceId, 'Lock device', 200);
    const st = await settings(org), devices = await provider.listDevices({connectedAccountIds: st.accounts});
    if (!devices.some(d => d.deviceId === deviceId)) fail(422, 'That lock is not in your connected lock account.');
    if (await get("SELECT 1 FROM residence_locks WHERE device_id=? AND provider<>'manual' AND active=1", deviceId)) fail(409, 'That lock is already linked to a residence.');
   }
   const key = id();
   await run('INSERT INTO residence_locks(id,organization_id,property_id,name,provider,device_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', key, org, pRow.id, name, providerKind === 'seam' ? provider.kind : 'manual', deviceId, user.id, now(), now());
   await audit(user, 'smart_lock.created', key); changed(org);
   return done({id: key});
  }
  if (p === '/api/smart-locks/locks/update') { const lock = await lockFor(user, b.id); await run('UPDATE residence_locks SET name=?,updated_at=? WHERE id=?', text(b.name, 'Lock name', 120), now(), lock.id); await audit(user, 'smart_lock.updated', lock.id); return done({id: lock.id}); }
  if (p === '/api/smart-locks/locks/remove') {
   const lock = await lockFor(user, b.id);
   await run('UPDATE residence_locks SET active=0,updated_at=? WHERE id=?', now(), lock.id);
   for (const code of await all("SELECT * FROM lock_access_codes WHERE lock_id=? AND status IN ('needs_code','scheduled')", lock.id)) await revoke(code, 'removed');
   await audit(user, 'smart_lock.removed', lock.id); return done({removed: true});
  }
  if (p === '/api/smart-locks/devices') { if (!provider.live) return done({devices: []}); const st = await settings(org); const used = new Set((await all("SELECT device_id FROM residence_locks WHERE provider<>'manual' AND active=1")).map(r => r.device_id)); return done({devices: (await provider.listDevices({connectedAccountIds: st.accounts})).map(d => ({...d, linked: used.has(d.deviceId)}))}); }
  if (p === '/api/smart-locks/connect') {
   if (!provider.live) fail(422, 'The lock connection is not turned on for EstateAegis yet. Use manual codes for now.');
   const host = String(req.headers.host || ''), redirect = /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${env.ESTATEOS_SECURE_COOKIES === '1' ? 'https' : 'http'}://${host}/#/workspace` : undefined;
   const w = await provider.createConnectWebview({organizationId: org, redirectUrl: redirect});
   const st = await settings(org); await storeAccounts(org, st.accounts, w.webviewId);
   await audit(user, 'smart_locks.connect_started', org);
   return done({url: w.url});
  }
  if (p === '/api/smart-locks/connect/check') {
   const st = await settings(org); if (!provider.live || !st.webviewId) fail(422, 'Start the lock account connection first.');
   const w = await provider.getConnectWebview({webviewId: st.webviewId});
   if (w.status === 'authorized' && w.connectedAccountId) { await storeAccounts(org, [...st.accounts, w.connectedAccountId], null); await audit(user, 'smart_locks.connected', org); }
   return done({status: w.status, accounts: (await settings(org)).accounts.length});
  }
  if (p === '/api/smart-locks/codes/set') {
   const code = await codeFor(user, b.id); await property(user, code.property_id, 'operate');
   if (!LIVE.includes(code.status)) fail(409, 'This door code is no longer active.');
   if (Number.isInteger(b.version) && b.version !== code.version) fail(409, 'This door code changed. Reload before saving.');
   const st = await settings(org);
   const value = b.generate ? generateCode(st.codeLength) : String(b.code || '').trim();
   if (!/^\d{4,12}$/.test(value)) fail(422, 'Enter a door code of 4 to 12 digits.');
   await setCodeValue(code, value, b.generate ? 'generated' : 'entered');
   await audit(user, b.generate ? 'lock_code.generated' : 'lock_code.entered', code.id);
   return done({id: code.id, code: value});
  }
  if (p === '/api/smart-locks/codes/revoke') { const code = await codeFor(user, b.id); await property(user, code.property_id, 'operate'); if (!await revoke(code, 'admin', user)) fail(409, 'This door code is no longer active.'); return done({revoked: true}); }
  if (p === '/api/smart-locks/codes/create') {
   const type = b.sourceType === 'work_order' ? 'work_order' : 'inspection', sourceId = String(b.sourceId || '');
   const row = type === 'inspection' ? await get('SELECT property_id FROM inspections WHERE id=?', sourceId) : await get('SELECT property_id FROM work_orders WHERE id=?', sourceId);
   if (!row) fail(404, 'Record not found.'); await property(user, row.property_id, 'operate');
   await run("DELETE FROM lock_access_codes WHERE source_type=? AND source_id=? AND status='revoked' AND revoked_reason='admin'", type, sourceId);
   await reconcileNow(org, {force: true});
   const made = await all("SELECT id FROM lock_access_codes WHERE source_type=? AND source_id=? AND status IN ('needs_code','scheduled')", type, sourceId);
   if (!made.length) fail(422, 'A door code needs a lock at the residence, an assignee and a date within the next two weeks.');
   return done({created: made.length});
  }
  if (p === '/api/smart-locks/sync') { await reconcileNow(org); return done({ok: true}); }
  fail(404, 'Endpoint not found.');
 }
 return {settings, handle, webhook, decorate, extendReports, reconcileNow, changed, tick, applyEvent, provider, isLockTask, reportRows};
}
