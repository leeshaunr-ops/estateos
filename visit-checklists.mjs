// Field visits use the company's PUBLISHED checklist templates.
// A new visit picks a published template version (the newest one for its visit type unless the inspector chose
// another), stores a snapshot of that version's items on the inspection, and records template_id,
// template_version and template_version_id. Later template edits create new versions and never touch the snapshot,
// so in-progress and past visits keep the checklist they started with. With no published template for the visit
// type, the visit uses the built-in standard checklist exactly as before (template_id NULL, no snapshot).
import './public/inspection-checklist.js';
import {VISIT_TYPES,VISIT_TYPE_LABELS} from './checklist-templates.mjs';

export const EAChecklist = globalThis.EAChecklist;
const C = EAChecklist;
export const BUILT_IN = 'built-in';
const ITEM_COLUMNS = 'stable_key,section,label,help_text,response_type,options,required,photo_rule,scope,room_types,alert_on_fail,sort_order';
const TYPE_ORDER = [...VISIT_TYPES];

/** Parse an inspection's stored snapshot, or null for a built-in (legacy) visit. */
export function parseSnapshot(value) {
 if (!value) return null;
 try { const s = typeof value === 'string' ? JSON.parse(value) : value; return s && Array.isArray(s.items) ? s : null; } catch { return null; }
}
/** The checklist summary safe to show anyone who can see the visit (no item settings). */
export const checklistLabel = s => s ? {template_id: s.template_id, template_version_id: s.template_version_id, template_version: s.template_version, name: s.name, visit_type: s.visit_type, visit_type_label: VISIT_TYPE_LABELS[s.visit_type] || 'Custom'} : null;
/** Newest published first: the default when several published templates share a visit type. */
const newestFirst = (a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')) || Number(b.template_version) - Number(a.template_version) || a.name.localeCompare(b.name);
export function defaultChecklist(options, visitType) { return options.filter(o => o.visit_type === visitType).sort(newestFirst)[0] || null; }

export function createVisitChecklists({get, all, fail, note}) {
 const versionItems = async versionId => (await all(`SELECT ${ITEM_COLUMNS} FROM checklist_template_items WHERE template_version_id=? ORDER BY sort_order,id`, versionId)).map(C.snapshotItem);
 const snapshotOf = (t, v, items) => ({template_id: t.id ?? t.template_id, template_version_id: v.id ?? v.template_version_id, template_version: Number(v.version ?? v.template_version), name: t.name, visit_type: t.visit_type, published_at: v.published_at || null, items});

 /** Every active company template that has a published version, at its latest published version. Templates with no items are skipped. */
 async function published(org, {items = false} = {}) {
  const rows = await all("SELECT t.id template_id,t.name,t.visit_type,t.description,v.id template_version_id,v.version template_version,v.published_at FROM checklist_templates t JOIN checklist_template_versions v ON v.template_id=t.id WHERE t.organization_id=? AND t.archived_at IS NULL AND v.status='published' AND v.version=(SELECT MAX(v2.version) FROM checklist_template_versions v2 WHERE v2.template_id=t.id AND v2.status='published')", org);
  const out = [];
  for (const r of rows) {
   const list = await versionItems(r.template_version_id);
   if (!list.length) continue;
   out.push({template_id: r.template_id, template_version_id: r.template_version_id, template_version: Number(r.template_version), name: r.name, visit_type: VISIT_TYPES.has(r.visit_type) ? r.visit_type : 'custom', visit_type_label: VISIT_TYPE_LABELS[r.visit_type] || 'Custom', description: r.description || '', published_at: r.published_at || null, item_count: list.length, ...(items ? {items: list} : {})});
  }
  return out.sort((a, b) => TYPE_ORDER.indexOf(a.visit_type) - TYPE_ORDER.indexOf(b.visit_type) || newestFirst(a, b));
 }

 /**
  * Which checklist a new visit uses.
  * - templateId 'built-in': the built-in standard checklist (the inspector chose it).
  * - templateId: that company template at templateVersionId (offline visits send the exact version they were
  *   filled against) or else its latest published version.
  * - neither: the newest published template for the visit type, else the built-in checklist.
  * Returns {snapshot, visit_type}; snapshot is null for the built-in checklist.
  */
 async function resolve(org, {templateId, templateVersionId, visitType} = {}) {
  const type = VISIT_TYPES.has(visitType) ? visitType : 'routine';
  if (templateId === BUILT_IN) return {snapshot: null, visit_type: type};
  if (templateId) {
   const t = await get('SELECT * FROM checklist_templates WHERE id=? AND organization_id=? AND archived_at IS NULL', String(templateId), org);
   if (!t) fail(422, 'Choose a published checklist from your company.');
   const v = templateVersionId
    ? await get("SELECT * FROM checklist_template_versions WHERE id=? AND template_id=? AND status='published'", String(templateVersionId), t.id)
    : await get("SELECT * FROM checklist_template_versions WHERE template_id=? AND status='published' ORDER BY version DESC LIMIT 1", t.id);
   if (!v) fail(422, templateVersionId ? 'That checklist version is not published.' : 'This checklist has not been published yet.');
   const items = await versionItems(v.id);
   if (!items.length) fail(422, 'This checklist has no items yet.');
   return {snapshot: snapshotOf(t, v, items), visit_type: VISIT_TYPES.has(t.visit_type) ? t.visit_type : 'custom'};
  }
  const choice = defaultChecklist(await published(org, {items: true}), type);
  if (!choice) return {snapshot: null, visit_type: type};
  return {snapshot: snapshotOf({id: choice.template_id, name: choice.name, visit_type: choice.visit_type}, {id: choice.template_version_id, version: choice.template_version, published_at: choice.published_at}, choice.items), visit_type: type};
 }

 /**
  * Validate a draft save for a template visit against the visit's own snapshot (never the live template).
  * Item settings (labels, types, options, required, photo and alert flags) are rebuilt from the snapshot, so a
  * device cannot change them. Room items are one set per room, keyed space-<room>-<item key>.
  */
 function validateAnswers(answers, snapshot) {
  if (!Array.isArray(answers)) fail(422, 'Checklist does not match the template.');
  const keys = new Set();
  for (const a of answers) { if (!a || typeof a.key !== 'string' || keys.has(a.key)) fail(422, 'Checklist contains a duplicate or invalid item.'); keys.add(a.key); }
  const items = snapshot.items || [], residence = items.filter(i => i.scope !== 'room'), roomItems = new Map(items.filter(i => i.scope === 'room').map(i => [i.stable_key, i]));
  const residenceKeys = new Set(residence.map(i => i.stable_key));
  const value = (item, a) => { const v = a.status === undefined || a.status === null || a.status === '' ? C.OPEN : String(a.status); const problem = C.valueProblem(item, v); if (problem) fail(422, `${item.label}: ${problem}`); return v; };
  const standard = residence.map(item => { const a = answers.find(x => x.key === item.stable_key); if (!a) fail(422, 'Checklist does not match the template.'); return {...C.answerFor(item), status: value(item, a), note: note(a.note)}; });
  const grouped = new Map();
  const rooms = answers.filter(a => !residenceKeys.has(a.key)).map(a => {
   const item = roomItems.get(String(a.item_key || ''));
   const roomKey = typeof a.room_key === 'string' ? a.room_key : '';
   if (!item || !roomKey || roomKey.length > 200 || a.key !== C.roomAnswerKey(roomKey, item.stable_key)) fail(422, 'Invalid room checklist item.');
   const room = {key: roomKey, name: note(a.room_name, 160), type: note(a.room_type, 100)};
   if (!room.name || note(a.section, 160) !== room.name || !C.roomItemApplies(item, room)) fail(422, 'Invalid room checklist item.');
   if (!grouped.has(roomKey)) grouped.set(roomKey, {room, keys: new Set()});
   grouped.get(roomKey).keys.add(item.stable_key);
   return {...C.answerFor(item, room), status: value(item, a), note: note(a.note)};
  });
  for (const {room, keys: got} of grouped.values()) { const need = [...roomItems.values()].filter(i => C.roomItemApplies(i, room)); if (need.length !== got.size || need.some(i => !got.has(i.stable_key))) fail(422, 'Each room needs all of its checklist items.'); }
  return [...standard, ...rooms];
 }
 return {published, resolve, validateAnswers, versionItems};
}
