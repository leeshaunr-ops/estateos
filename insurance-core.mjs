// EstateAegis insurance and vacancy compliance rules. Pure functions shared by the server (API, alerts, certificate)
// and Node tests. Everything works on whole days in the residence's own time zone.
//
// A residence's policy may say "while unoccupied, have the home inspected at least every N days" and, optionally,
// "the home may not stay unoccupied for more than M days". The compliance clock starts at the latest of: the last
// completed visit, the day the home became unoccupied, and the day the rule was set up in EstateAegis. The visit is
// due by clock start + N days (a visit ON that day is still in time).
//   OK        - owners in residence, or the deadline is comfortably ahead with a visit scheduled in time
//   Due soon  - the deadline (or the vacancy limit) is within the warning window (default 3 days)
//   At risk   - no visit is scheduled on or before the deadline
//   Breached  - the deadline has passed with no visit, or the home has been unoccupied longer than the policy allows

export const DEVICES = [
 ['water_shutoff', 'Automatic water shut-off'],
 ['monitored_alarm', 'Monitored alarm'],
 ['generator', 'Generator'],
 ['other', 'Other device']
];
export const STATUS = {
 not_set: {label: 'Not set up', tone: 'muted', rank: 0},
 ok: {label: 'OK', tone: 'ok', rank: 1},
 due_soon: {label: 'Due soon', tone: 'amber', rank: 2},
 at_risk: {label: 'At risk', tone: 'amber', rank: 3},
 breached: {label: 'Breached', tone: 'red', rank: 4}
};
export const DEFAULT_WARN_DAYS = 3;
export const RENEWAL_REMINDER_DAYS = 30;
export const SHARE_DEFAULT_DAYS = 14;
export const SHARE_MAX_DAYS = 90;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = v => DAY.test(String(v || '')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
export const serial = day => Math.round(Date.parse(day + 'T00:00:00Z') / 86400000);
export const addDays = (day, n) => new Date((serial(day) + n) * 86400000).toISOString().slice(0, 10);
export const daysBetween = (from, to) => serial(to) - serial(from);

/** The calendar day of an instant in a time zone ('YYYY-MM-DD'). A bare day is returned as is. */
export function localDay(value, timezone = 'America/New_York') {
 if (isDay(value)) return value;
 const at = new Date(value || Date.now());
 if (Number.isNaN(at.getTime())) return '';
 const fmt = zone => new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(at);
 try { return fmt(timezone || 'America/New_York'); } catch { return fmt('America/New_York'); }
}
/** "Oct 9, 2026" for a day key. */
export const dayLabel = day => isDay(day) ? new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'}) : '';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Who is at the home right now, from dated occupancy events: {at (ISO or day), state:'occupied'|'vacant', source}.
 * Events in the future are ignored. With no events the home is treated as unoccupied (the normal home watch case),
 * with no known start. Ties on the same instant: the later entry in the list wins.
 */
export function occupancy(events, nowIso = new Date().toISOString()) {
 const nowMs = Date.parse(nowIso);
 const ms = v => isDay(v) ? Date.parse(v + 'T00:00:00Z') : Date.parse(v);
 const past = (events || []).map((e, i) => ({...e, i, ms: ms(e.at)})).filter(e => ['occupied', 'vacant'].includes(e.state) && Number.isFinite(e.ms) && e.ms <= nowMs).sort((a, b) => a.ms - b.ms || a.i - b.i);
 const last = past.at(-1);
 if (!last) return {state: 'vacant', since: null, source: 'none'};
 return {state: last.state, since: last.at, source: last.source || 'manual'};
}

/**
 * Compliance for one residence.
 * profile: {inspect_every_days, max_vacancy_days, warn_days, rule_started_at}
 * occ: result of occupancy(); lastVisitDay: latest completed visit day; scheduledDays: days with a visit planned;
 * today: 'YYYY-MM-DD' in the residence time zone; timezone is used to turn occ.since / rule_started_at into days.
 */
export function evaluate({profile, occ = {state: 'vacant', since: null}, lastVisitDay = null, scheduledDays = [], today, timezone = 'America/New_York'}) {
 const every = Number(profile?.inspect_every_days) || 0;
 const out = {code: 'not_set', ...STATUS.not_set, reason: '', occupied: occ.state === 'occupied', occupiedSince: null, vacantSince: null, vacancyDays: null, lastVisit: isDay(lastVisitDay) ? lastVisitDay : null, nextScheduled: null, clockStart: null, deadline: null, daysLeft: null, maxVacancy: Number(profile?.max_vacancy_days) || null, vacancyLeft: null};
 const future = [...new Set((scheduledDays || []).filter(isDay))].filter(d => d >= today).sort();
 out.nextScheduled = future[0] || null;
 if (!profile || every < 1) { out.reason = profile ? 'Add the inspection interval from the policy to track compliance.' : 'No insurance profile yet.'; return out; }
 const warn = Number.isInteger(Number(profile.warn_days)) && Number(profile.warn_days) >= 0 ? Number(profile.warn_days) : DEFAULT_WARN_DAYS;
 const set = (code, reason) => Object.assign(out, {code, ...STATUS[code], reason});
 if (occ.state === 'occupied') {
  out.occupiedSince = occ.since ? localDay(occ.since, timezone) : null;
  return set('ok', out.occupiedSince ? `Owners in residence since ${dayLabel(out.occupiedSince)}.` : 'Owners in residence.');
 }
 out.vacantSince = occ.since ? localDay(occ.since, timezone) : null;
 if (out.vacantSince && out.vacantSince > today) out.vacantSince = today;
 const ruleDay = profile.rule_started_at ? localDay(profile.rule_started_at, timezone) : null;
 const starts = [out.lastVisit, out.vacantSince, ruleDay].filter(d => isDay(d) && d <= today).sort();
 out.clockStart = starts.at(-1) || today;
 out.deadline = addDays(out.clockStart, every);
 out.daysLeft = daysBetween(today, out.deadline);
 if (out.vacantSince) out.vacancyDays = daysBetween(out.vacantSince, today);
 if (out.maxVacancy && out.vacancyDays !== null) out.vacancyLeft = out.maxVacancy - out.vacancyDays;
 const due = out.daysLeft === 0 ? 'today' : out.daysLeft === 1 ? 'tomorrow' : `by ${dayLabel(out.deadline)}`;
 if (out.vacancyLeft !== null && out.vacancyLeft < 0) return set('breached', `Unoccupied for ${plural(out.vacancyDays, 'day')}; the policy allows ${plural(out.maxVacancy, 'day')}.`);
 if (out.daysLeft < 0) return set('breached', `Visit was due by ${dayLabel(out.deadline)} (every ${plural(every, 'day')} while unoccupied). ${plural(-out.daysLeft, 'day')} overdue.`);
 const inTime = out.nextScheduled && out.nextScheduled <= out.deadline;
 if (!inTime) return set('at_risk', `Visit due ${due}, but none is scheduled before then.`);
 if (out.daysLeft <= warn) return set('due_soon', `Visit due ${due}. Scheduled ${dayLabel(out.nextScheduled)}.`);
 if (out.vacancyLeft !== null && out.vacancyLeft <= warn) return set('due_soon', `The policy's vacancy limit is reached in ${plural(out.vacancyLeft, 'day')}.`);
 return set('ok', `Next visit due ${due}. Scheduled ${dayLabel(out.nextScheduled)}.`);
}

/** Renewal reminder window: renewal within the next 30 days (inclusive), not passed. */
export function renewal(profile, today) {
 if (!isDay(profile?.renewal_date)) return {due: false, daysLeft: null};
 const daysLeft = daysBetween(today, profile.renewal_date);
 return {due: daysLeft >= 0 && daysLeft <= RENEWAL_REMINDER_DAYS, passed: daysLeft < 0, daysLeft};
}

/** Checklist sent with the renewal reminder. */
export function renewalChecklist(profile) {
 const devices = parseDevices(profile?.devices).filter(d => d.required || d.discount);
 return [
  'Confirm the carrier, policy number and renewal date with the broker.',
  `Confirm the unoccupancy clause (currently: ${profile?.inspect_every_days ? `inspect every ${plural(Number(profile.inspect_every_days), 'day')}` : 'not recorded'}${profile?.max_vacancy_days ? `, at most ${plural(Number(profile.max_vacancy_days), 'day')} unoccupied` : ''}).`,
  ...devices.map(d => `${d.label}: ${d.required ? 'required' : 'discount'}${d.file_id ? ' (proof on file)' : ' (add a photo or certificate)'}.`),
  'Send the visit history certificate to the broker.',
  'Update the renewal date in EstateAegis once the policy renews.'
 ];
}

/** Devices checklist from stored JSON: always the four known devices, in order. */
export function parseDevices(value) {
 let list = [];
 try { list = Array.isArray(value) ? value : JSON.parse(value || '[]'); } catch {}
 const byKey = new Map((Array.isArray(list) ? list : []).filter(d => d && typeof d === 'object').map(d => [d.key, d]));
 return DEVICES.map(([key, label]) => {
  const d = byKey.get(key) || {};
  return {key, label: key === 'other' && String(d.name || '').trim() ? String(d.name).trim().slice(0, 80) : label, name: key === 'other' ? String(d.name || '').slice(0, 80) : '', required: !!d.required, discount: !!d.discount, installed: !!d.installed, file_id: typeof d.file_id === 'string' && d.file_id ? d.file_id : null};
 });
}

/** Status ordering for the compliance list: worst first, then the nearest deadline, then name. */
export function compare(a, b) {
 return (b.status.rank - a.status.rank) || String(a.status.deadline || '9999').localeCompare(String(b.status.deadline || '9999')) || String(a.name || '').localeCompare(String(b.name || ''));
}
