// Data import (Oct 2026): pure helpers for "Import from another system". No database access here, so every rule is
// unit-tested directly: reading CSV/Excel files, the field list for each data type, header auto-matching (synonyms,
// including the documented Jobber and Housecall Pro column names), value clean-up and per-row checks.
import {readSheet} from 'read-excel-file/node';

export const LIMITS = Object.freeze({bytes: 5 * 1024 * 1024, rows: 1500, columns: 80, unzippedBytes: 60 * 1024 * 1024, cell: 4000});
export const TYPE_ORDER = ['clients', 'contacts', 'vendors', 'staff', 'history'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// field: [key, label, synonyms, extra]. extra.required = always needed; extra.secret = never echoed back (stored encrypted).
// Synonyms are compared after normalize(): lower case, punctuation and underscores removed.
const F = (key, label, synonyms, extra = {}) => ({key, label, synonyms, ...extra});
export const TYPES = {
 clients: {
  label: 'Clients and residences', short: 'Clients', unit: 'row',
  help: 'One row per residence. Rows with the same family name go to the same family. Leave the address empty to add a family without a residence.',
  fields: [
   F('family', 'Family name', ['family', 'client', 'client name', 'client full name', 'customer', 'customer name', 'owner', 'owner name', 'owners', 'homeowner', 'homeowner name', 'household', 'household name', 'client or household name', 'display name', 'account', 'account name', 'name', 'full name', 'client display name'], {hint: 'Required, or a first and last name, or a company.'}),
   F('firstName', 'First name', ['first name', 'first', 'given name', 'owner first name', 'client first name', 'firstname']),
   F('lastName', 'Last name', ['last name', 'last', 'surname', 'family name', 'owner last name', 'client last name', 'lastname']),
   F('company', 'Company', ['company', 'company name', 'organization', 'organization name', 'org', 'business name', 'trust', 'llc']),
   F('email', 'Email', ['email', 'e mail', 'email address', 'client email', 'owner email', 'primary email', 'primary contact email', 'emails', 'customer email']),
   F('phone', 'Phone', ['phone', 'phone number', 'main phone', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'home phone', 'work phone', 'work number', 'telephone', 'tel', 'primary phone', 'contact phone', 'owner phone', 'client phone', 'text message enabled phone number']),
   F('residenceName', 'Residence name', ['residence', 'residence name', 'property', 'property name', 'home', 'home name', 'house name', 'location', 'location name', 'site name', 'nickname', 'property nickname']),
   F('street', 'Street address', ['street', 'street address', 'address', 'address 1', 'address line 1', 'street 1', 'street line 1', 'property address', 'service address', 'service street', 'service street 1', 'address 1 street line 1', 'property street', 'home address', 'residence address']),
   F('line2', 'Address line 2', ['address 2', 'address line 2', 'street 2', 'street line 2', 'unit', 'apt', 'apartment', 'suite', 'unit number', 'service street 2', 'address 1 street line 2']),
   F('city', 'City', ['city', 'town', 'property city', 'service city', 'address 1 city', 'city town']),
   F('state', 'State / province', ['state', 'province', 'state province', 'province or state', 'province state', 'region', 'property state', 'service state', 'service province', 'address 1 state', 'st']),
   F('postal', 'ZIP / postal code', ['zip', 'zip code', 'zipcode', 'postal code', 'postcode', 'postal', 'postal code or zip code', 'zip postal code', 'zip postal', 'postal zip', 'address 1 postal code', 'service zip', 'service postal code', 'property zip']),
   F('country', 'Country', ['country', 'service country', 'property country']),
   F('timezone', 'Time zone', ['time zone', 'timezone', 'tz']),
   F('gate', 'Gate code', ['gate code', 'gate', 'community gate code', 'gate access code', 'gate pin'], {secret: true}),
   F('door', 'Door / keypad code', ['door code', 'door', 'keypad', 'keypad code', 'entry code', 'door keypad', 'garage code', 'key code', 'door pin'], {secret: true}),
   F('alarm', 'Alarm code', ['alarm code', 'alarm', 'security code', 'alarm pin', 'security system code', 'disarm code', 'alarm system code'], {secret: true}),
   F('lockbox', 'Lockbox / key location', ['lockbox', 'lockbox code', 'lock box', 'key box', 'key location', 'key safe', 'hidden key', 'keys'], {secret: true}),
   F('accessNotes', 'Access notes', ['access notes', 'access instructions', 'entry instructions', 'entry notes', 'key notes', 'alarm instructions', 'gate instructions', 'access'], {secret: true}),
   F('propertyNotes', 'Residence notes', ['property notes', 'residence notes', 'house notes', 'home notes', 'service address notes', 'address 1 notes', 'special instructions', 'notes', 'note', 'comments', 'description'])
  ]
 },
 contacts: {
  label: 'Contacts', short: 'Contacts', unit: 'contact',
  help: 'People linked to a family that is already in EstateAegis (import clients first). Matched by family name or family email.',
  fields: [
   F('family', 'Family name', ['family', 'client', 'client name', 'customer', 'customer name', 'owner', 'owner name', 'homeowner', 'household', 'account', 'account name', 'family name']),
   F('familyEmail', 'Family email', ['family email', 'client email', 'owner email', 'customer email', 'account email']),
   F('fullName', 'Contact name', ['contact name', 'contact', 'name', 'full name', 'contact full name', 'person']),
   F('firstName', 'First name', ['first name', 'first', 'given name', 'contact first name']),
   F('lastName', 'Last name', ['last name', 'last', 'surname', 'contact last name']),
   F('relationship', 'Relationship', ['relationship', 'relation', 'role', 'contact type', 'type', 'relationship to owner']),
   F('email', 'Email', ['email', 'e mail', 'email address', 'contact email']),
   F('phone', 'Phone', ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'contact phone', 'telephone', 'work phone', 'home phone'])
  ]
 },
 vendors: {
  label: 'Vendors', short: 'Vendors', unit: 'vendor',
  help: 'Contractors and service companies you send work to.',
  fields: [
   F('name', 'Vendor name', ['vendor', 'vendor name', 'company', 'company name', 'business', 'business name', 'name', 'supplier', 'contractor', 'contractor name', 'service provider'], {required: true}),
   F('trade', 'Trade', ['trade', 'category', 'service', 'services', 'specialty', 'vendor type', 'type', 'service type', 'trade category']),
   F('email', 'Email', ['email', 'e mail', 'email address', 'vendor email', 'contact email']),
   F('phone', 'Phone', ['phone', 'phone number', 'main phone', 'mobile', 'mobile phone', 'cell', 'office phone', 'telephone', 'work phone', 'contact phone'])
  ]
 },
 staff: {
  label: 'Staff and field inspectors', short: 'Staff', unit: 'person',
  help: 'Added as inactive accounts. No email is sent: you choose when to send each invitation.',
  fields: [
   F('fullName', 'Name', ['name', 'full name', 'staff name', 'employee', 'employee name', 'team member', 'technician', 'inspector name', 'display name']),
   F('firstName', 'First name', ['first name', 'first', 'given name']),
   F('lastName', 'Last name', ['last name', 'last', 'surname']),
   F('email', 'Email', ['email', 'e mail', 'email address', 'work email', 'login email', 'staff email'], {required: true}),
   F('role', 'Role', ['role', 'user role', 'user type', 'access level', 'permission', 'account type', 'staff type']),
   F('phone', 'Phone', ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'work phone', 'work number', 'telephone']),
   F('jobTitle', 'Job title', ['job title', 'title', 'position']),
   F('startDate', 'Start date', ['start date', 'hire date', 'date hired', 'started', 'employment start']),
   F('notes', 'Notes', ['notes', 'note', 'comments'])
  ]
 },
 history: {
  label: 'Past visit history', short: 'Visit history', unit: 'visit',
  help: 'Earlier visits from your old system, kept as read-only history on each residence. They never become reports, overdue visits or compliance counts.',
  fields: [
   F('residence', 'Residence', ['residence', 'residence name', 'property', 'property name', 'home', 'location', 'location name', 'site', 'client property', 'house']),
   F('address', 'Street address', ['street', 'street address', 'address', 'property address', 'service address', 'address 1 street line 1']),
   F('date', 'Visit date', ['date', 'visit date', 'inspection date', 'service date', 'completed', 'completed date', 'completed on', 'date completed', 'scheduled date', 'job date', 'visit'], {required: true}),
   F('inspector', 'Inspector', ['inspector', 'inspector name', 'technician', 'tech', 'staff', 'assigned to', 'completed by', 'employee', 'home watcher', 'team member', 'performed by']),
   F('visitType', 'Visit type', ['visit type', 'type', 'service', 'service type', 'job type', 'inspection type']),
   F('outcome', 'Result', ['status', 'result', 'outcome', 'condition', 'overall', 'issues found']),
   F('notes', 'Notes', ['notes', 'note', 'findings', 'comments', 'summary', 'report notes', 'visit notes', 'description', 'details'])
  ]
 }
};

/** Where synonyms came from, shown on the Import page (only formats with published column names). */
export const KNOWN_SOURCES = [
 {name: 'Jobber', detail: 'client export or import sheet: First name, Last name, Company name, Main/Mobile Phone, Email, Street, City, Province or State, Postal Code or Zip Code, Country, Note'},
 {name: 'Housecall Pro', detail: 'customers export: First Name, Last Name, Mobile Number, Email, Company, Work Number, Notes, Address_1 Street Line 1 / Line 2 / City / State / Postal Code / Notes'},
 {name: 'Spreadsheets', detail: 'common headings such as Owner, Client Name, Property Address, Zip, Gate Code, Alarm Code, Access Notes'}
];

export function normalize(header) {
 return String(header ?? '').replace(/^\uFEFF/, '').toLowerCase().replace(/[_\-./\\()#:?*]+/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}

/** Suggested mapping {fieldKey: columnIndex}. Exact synonym first, then a header that starts with a synonym ("Gate code (main)"). Each column is used once. */
export function autoMap(type, headers) {
 const def = TYPES[type]; if (!def) return {};
 const norm = headers.map(normalize), used = new Set(), out = {};
 for (const pass of ['exact', 'prefix']) {
  for (const field of def.fields) {
   if (out[field.key] !== undefined) continue;
   const syns = [normalize(field.label), ...field.synonyms.map(normalize)];
   for (const syn of syns) {
    const i = norm.findIndex((h, n) => !used.has(n) && h && (pass === 'exact' ? h === syn : syn.length > 3 && (h.startsWith(syn + ' ') || h === syn)));
    if (i >= 0) { out[field.key] = i; used.add(i); break; }
   }
  }
 }
 return out;
}

/** RFC 4180 CSV with quoted fields, CRLF/LF, a UTF-8 BOM, and comma, semicolon or tab separators (picked from the header line). */
export function parseCsv(text) {
 text = String(text).replace(/^\uFEFF/, '');
 const firstLine = text.slice(0, Math.max(text.indexOf('\n'), 0) || text.length);
 const count = c => firstLine.split(c).length - 1;
 const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
 const rows = []; let row = [], field = '', quoted = false;
 for (let n = 0; n < text.length; n++) {
  const c = text[n];
  if (quoted) { if (c === '"') { if (text[n + 1] === '"') { field += '"'; n++; } else quoted = false; } else field += c; continue; }
  if (c === '"' && field === '') quoted = true;
  else if (c === sep) { row.push(field); field = ''; }
  else if (c === '\n' || c === '\r') { if (c === '\r' && text[n + 1] === '\n') n++; row.push(field); rows.push(row); row = []; field = ''; }
  else field += c;
 }
 if (field !== '' || row.length) { row.push(field); rows.push(row); }
 return rows;
}

/** Sum of uncompressed sizes from a zip's central directory, so a tiny "zip bomb" .xlsx is refused before it is unpacked. */
export function zipUncompressedSize(buf) {
 let eocd = -1;
 for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
 if (eocd < 0) return null;
 const entries = buf.readUInt16LE(eocd + 10); let at = buf.readUInt32LE(eocd + 16), total = 0;
 for (let n = 0; n < entries; n++) {
  if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
  const size = buf.readUInt32LE(at + 24); if (size === 0xffffffff) return Infinity;
  total += size; at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
 }
 return total;
}

const cellText = v => {
 if (v == null) return '';
 if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
 if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
 if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
 return String(v);
};

/** Read an uploaded file (base64) into {headers, rows}. Throws {status:422} with a plain message for anything we cannot read. */
export async function readUpload({fileName, data}) {
 const bad = message => { throw Object.assign(new Error(message), {status: 422}); };
 const name = String(fileName || '').slice(0, 200), ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
 if (typeof data !== 'string' || !data) bad('Choose a CSV or Excel (.xlsx) file.');
 if (data.length > Math.ceil(LIMITS.bytes / 3) * 4 + 8) bad('This file is larger than 5 MB. Split it into smaller files.');
 const buf = Buffer.from(data, 'base64');
 if (!buf.length) bad('This file is empty.');
 if (buf.length > LIMITS.bytes) bad('This file is larger than 5 MB. Split it into smaller files.');
 let table;
 const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
 if (ext === 'xls' || (buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0)) bad('Old Excel (.xls) files can’t be read. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV, then upload again.');
 if (ext === 'xlsx' || isZip) {
  if (!isZip) bad('This file doesn’t look like an Excel (.xlsx) file.');
  const size = zipUncompressedSize(buf);
  if (size == null) bad('This Excel file looks damaged. Open it in Excel or Google Sheets and save it again.');
  if (size > LIMITS.unzippedBytes) bad('This Excel file is too large to import. Save it as CSV or split it into smaller files.');
  try { table = (await readSheet(buf)).map(r => r.map(cellText)); }
  catch { bad('This Excel file couldn’t be read. Save it as CSV (or .xlsx again) and upload it again.'); }
 } else if (['csv', 'txt', 'tsv', ''].includes(ext)) {
  const text = buf.toString('utf8');
  if (text.includes('\u0000')) bad('This file doesn’t look like a CSV file.');
  table = parseCsv(text);
 } else bad('Upload a .csv or .xlsx file.');
 table = table.map(r => r.map(v => String(v ?? '').trim()));
 while (table.length && table[0].every(v => !v)) table.shift();
 if (!table.length) bad('This file has no rows.');
 const headers = table[0].map((h, i) => h || `Column ${i + 1}`);
 if (headers.length > LIMITS.columns) bad(`This file has ${headers.length} columns. The limit is ${LIMITS.columns}.`);
 const rows = [];
 for (let i = 1; i < table.length; i++) {
  if (table[i].every(v => !v)) continue;
  rows.push({line: i + 1, cells: headers.map((_, n) => String(table[i][n] ?? '').slice(0, LIMITS.cell))});
 }
 if (!rows.length) bad('This file has a header row but no data rows.');
 if (rows.length > LIMITS.rows) bad(`This file has ${rows.length.toLocaleString('en-US')} rows. The limit is ${LIMITS.rows.toLocaleString('en-US')} per file; split it into smaller files.`);
 return {fileName: name, headers, rows};
}

/** Validate a mapping sent by the browser: known fields only, each column used once, in range. */
export function cleanMapping(type, mapping, columns) {
 const def = TYPES[type], out = {}, used = new Set();
 for (const field of def.fields) {
  const v = mapping?.[field.key];
  if (v === undefined || v === null || v === '') continue;
  const i = Number(v);
  if (!Number.isInteger(i) || i < 0 || i >= columns || used.has(i)) continue;
  out[field.key] = i; used.add(i);
 }
 return out;
}

// ---------- value clean-up ----------
export const normName = s => normalize(s).replace(/\b(the|family|residence|household)\b/g, '').replace(/\s+/g, ' ').trim();
const STREET_ABBR = {street: 'st', avenue: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', boulevard: 'blvd', place: 'pl', terrace: 'ter', circle: 'cir', parkway: 'pkwy', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w', trail: 'trl', way: 'way', point: 'pt', square: 'sq'};
export const normStreet = s => normalize(s).split(' ').map(w => STREET_ABBR[w] || w).join(' ');
export const addressKey = (street, postal) => street ? normStreet(street) + '|' + String(postal || '').replace(/[^0-9a-z]/gi, '').slice(0, 5).toLowerCase() : '';
const US = new Set(['united states', 'united states of america', 'us', 'usa', 'u s', 'u s a', 'america']);
export const isUS = c => !c || US.has(normalize(c));

const STATE_TZ = (() => {
 const z = {'America/New_York': 'CT DE DC FL GA ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV IN KY', 'America/Chicago': 'AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI', 'America/Denver': 'CO ID MT NM UT WY', 'America/Phoenix': 'AZ', 'America/Los_Angeles': 'CA NV OR WA', 'America/Anchorage': 'AK', 'Pacific/Honolulu': 'HI', 'America/Puerto_Rico': 'PR VI'};
 const out = {}; for (const [tz, list] of Object.entries(z)) for (const s of list.split(' ')) out[s] = tz; return out;
})();
const STATE_NAMES = {alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR'};
const TZ_ALIAS = {eastern: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', 'us eastern': 'America/New_York', central: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago', 'us central': 'America/Chicago', mountain: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver', 'us mountain': 'America/Denver', arizona: 'America/Phoenix', pacific: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles', 'us pacific': 'America/Los_Angeles', alaska: 'America/Anchorage', akst: 'America/Anchorage', hawaii: 'Pacific/Honolulu', hst: 'Pacific/Honolulu', atlantic: 'America/Puerto_Rico', ast: 'America/Puerto_Rico'};
export function validTimezone(tz) { try { return !!tz && /^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(tz) && !!new Intl.DateTimeFormat('en-US', {timeZone: tz}); } catch { return false; } }
/** Time zone from the file (IANA name or Eastern/Central/…); otherwise from the US state; otherwise the company default. */
export function timezoneFor(value, state, country, fallback) {
 const v = String(value || '').trim();
 if (v) { if (validTimezone(v)) return {tz: v}; const alias = TZ_ALIAS[normalize(v).replace(/ time$/, '').replace(/ standard$/, '')]; if (alias) return {tz: alias}; }
 const code = String(state || '').trim().length === 2 ? String(state).trim().toUpperCase() : STATE_NAMES[normalize(state)];
 const fromState = isUS(country) && code ? STATE_TZ[code] : '';
 const tz = fromState || fallback || 'America/New_York';
 return v ? {tz, warning: `Time zone “${v.slice(0, 40)}” wasn’t recognized; using ${tz}.`} : {tz};
}

/** Dates as YYYY-MM-DD from ISO, US month/day/year, "Mar 2, 2026", or an Excel serial number. */
export function parseDate(value) {
 const v = String(value || '').trim(); if (!v) return '';
 const ok = (y, m, d) => { const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; const t = new Date(s + 'T12:00:00Z'); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : ''; };
 let m;
 if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) return ok(m[1], m[2], m[3]);
 if ((m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/))) { let y = Number(m[3]); if (y < 100) y += y < 70 ? 2000 : 1900; return ok(y, m[1], m[2]); }
 if (/^\d{5}(\.\d+)?$/.test(v)) { const n = Number(v); if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10); }
 if (/[a-z]/i.test(v)) { const t = Date.parse(v.replace(/(\d)(st|nd|rd|th)\b/gi, '$1') + ' 12:00 UTC'); if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10); }
 return '';
}

export function checkEmail(v) { const s = String(v || '').trim(); if (!s) return {value: ''}; const first = s.split(/[,;\s]+/).filter(Boolean)[0].toLowerCase(); return EMAIL.test(first) && first.length <= 254 ? {value: first, extra: s.split(/[,;\s]+/).filter(Boolean).length > 1} : {value: '', bad: true}; }
export function checkPhone(v) { const s = String(v || '').trim().slice(0, 80); if (!s) return {value: ''}; const digits = s.replace(/\D/g, ''); return {value: s, bad: digits.length < 7 || digits.length > 15 || /[a-wyz]/i.test(s.replace(/\b(ext|x)\b\.?/gi, ''))}; }

/** Staff role from the file: Staff (default) or Field inspector. Admin rows are refused (invite admins yourself). */
export function staffRole(v) {
 const s = normalize(v); if (!s) return {role: 'employee'};
 if (/admin|owner|administrator/.test(s)) return {error: 'Admin accounts aren’t imported. Invite admins from Team & access.'};
 if (/inspector|field|home watcher|watcher|technician|tech/.test(s)) return {role: 'inspector'};
 if (/staff|employee|office|manager|team|member|user|coordinator/.test(s)) return {role: 'employee'};
 return {role: 'employee', warning: `Role “${String(v).slice(0, 40)}” wasn’t recognized; added as staff.`};
}

/** The cells of one row as {fieldKey: text} for the mapped fields. */
// Every known field is present ('' when the column isn't mapped), so callers never see undefined.
const ALL_KEYS = [...new Set(Object.values(TYPES).flatMap(t => t.fields.map(f => f.key)))];
export function pick(row, mapping) { const out = Object.fromEntries(ALL_KEYS.map(k => [k, ''])); for (const [k, i] of Object.entries(mapping)) out[k] = String(row.cells[i] ?? '').trim(); return out; }

/** Template CSV for a type: every field's label as a header plus two demo rows. */
const EXAMPLES = {
 clients: [['Whitcombe family', 'Eleanor', 'Whitcombe', '', 'eleanor.whitcombe@example.com', '(555) 201-4410', 'Seagrape House', '412 Seagrape Lane', '', 'Stuart', 'FL', '34996', 'United States', 'America/New_York', '4127', 'Keypad 2580', '7316', 'Side gate lockbox 0412', 'Enter through the side gate; alarm panel inside the garage door', 'Pool service Tuesdays'],
  ['Marchetti family', 'Paolo', 'Marchetti', '', 'paolo.marchetti@example.com', '555-310-7782', 'Aspen Ridge Cabin', '88 Ridgeline Road', 'Unit B', 'Aspen', 'CO', '81611', 'United States', '', '', '', '2468', '', 'Snow removal service has a garage code', '']],
 contacts: [['Whitcombe family', '', 'Daniel Whitcombe', '', '', 'Son', 'daniel.whitcombe@example.com', '(555) 201-4499'], ['Marchetti family', 'paolo.marchetti@example.com', '', 'Lucia', 'Marchetti', 'Spouse', '', '555-310-7790']],
 vendors: [['Bayside Pool Care', 'Pool service', 'office@baysidepool.example.com', '(555) 410-2200'], ['Summit HVAC', 'Heating and cooling', 'service@summithvac.example.com', '555-430-1188']],
 staff: [['Alex Kim', '', '', 'alex.kim@harborline.example.com', 'Staff', '(555) 600-1010', 'Office coordinator', '2025-03-01', ''], ['Sam Rivera', '', '', 'sam.rivera@harborline.example.com', 'Field inspector', '555-600-2020', 'Home watch inspector', '2025-06-15', 'Covers the north route']],
 history: [['Seagrape House', '412 Seagrape Lane', '2026-08-28', 'Sam Rivera', 'Routine visit', 'No issues', 'All systems normal; ran faucets and checked for leaks'], ['Aspen Ridge Cabin', '88 Ridgeline Road', '2026-09-04', 'Riley Chen', 'After-storm check', 'Attention needed', 'Gutter debris on the north side; vendor notified']]
};
export function csvCell(v) { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) || s !== String(v ?? '') ? '"' + s.replace(/"/g, '""') + '"' : s; }
export const csvLine = cells => cells.map(csvCell).join(',');
export function templateCsv(type) { const def = TYPES[type]; return '\ufeff' + [csvLine(def.fields.map(f => f.label)), ...EXAMPLES[type].map(csvLine)].join('\r\n') + '\r\n'; }
