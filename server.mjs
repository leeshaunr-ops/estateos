import http from 'node:http';
import {createSaas,platformOwner} from './saas.mjs';
import {createStaff} from './staff.mjs';
import {seal,unseal} from './vault.mjs';
import { openDatabase } from './database.mjs';
import { openStorage } from './storage.mjs';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectionPdf, jpegSize } from './pdf.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const db = await openDatabase(root);
let storage;
try {
    storage = await openStorage(root);
}
catch (error) {
    await db.close();
    throw error;
}
const { get, all, run, transaction } = db;
const readBytes = key => storage.read(key), putBytes = (key, bytes, mime) => storage.write(key, bytes, mime), deleteBytes = key => storage.remove(key);
const now = () => new Date().toISOString(), id = () => randomUUID(), hash = s => createHash('sha256').update(s).digest('hex');
async function mapAsync(rows, fn) { const result = []; for (const row of rows)
    result.push(await fn(row)); return result; }
async function filterAsync(rows, fn) { const result = []; for (const row of rows)
    if (await fn(row))
        result.push(row); return result; }
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function text(value, label = 'Value', max = 4000) { if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(422, `${label} is required (maximum ${max} characters).`); return value.trim(); }
function note(s, max = 4000) { if (s == null || s === '')
    return ''; return text(s, 'Text', max); }
function contactPreference(value) { const v = value || 'No preference'; if (!['No preference', 'Email', 'Phone call', 'Text message'].includes(v))
    fail(422, 'Choose a contact method.'); return v; }
function clientProfile(b) { return { firstName: note(b.firstName, 160), lastName: note(b.lastName, 160), preferredContact: contactPreference(b.preferredContact), street_address: note(b.streetAddress, 200), address_line2: note(b.addressLine2, 100), city: note(b.city, 100), state: note(b.state, 100), postal_code: note(b.postalCode, 40), country: note(b.country, 100), members: [] }; }
function addressFields(b) {
    const street = text(b.streetAddress, 'Street address', 200), line2 = note(b.addressLine2, 120), city = text(b.city, 'City', 120), state = text(b.state, 'State / province', 100), postal = text(b.postalCode, 'ZIP / postal code', 24), country = text(b.country || 'United States', 'Country', 100);
    if (['united states', 'us', 'usa'].includes(country.toLowerCase()) && !/^\d{5}(-\d{4})?$/.test(postal))
        fail(422, 'Enter a 5-digit ZIP code or ZIP+4.');
    const full = [street, line2, `${city}, ${state} ${postal}`, country].filter(Boolean).join(', ');
    return { street, line2, city, state, postal, country, full };
}
function roomProfile(value) { try {
    const p = typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
    const rooms = Array.isArray(p.rooms) ? p.rooms.filter(r => r && typeof r.key === 'string' && typeof r.name === 'string').map(r => ({ key: r.key, name: r.name, type: note(r.type, 100), floor: note(r.floor, 100), assignment: note(r.assignment, 160), assignedName: note(r.assignedName, 200), notes: note(r.notes) })) : [];
    return { bedrooms: Math.max(0, Number(p.bedrooms) || 0), fullBathrooms: Math.max(0, Number(p.fullBathrooms) || 0), halfBathrooms: Math.max(0, Number(p.halfBathrooms) || 0), rooms };
}
catch {
    return { bedrooms: 0, fullBathrooms: 0, halfBathrooms: 0, rooms: [] };
} }
function roomStatusFor(p) { return roomProfile(p.room_profile).rooms.map(r => ({ ...r, ready: false })); }
function date(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') || Number.isNaN(Date.parse(s + 'T12:00:00Z')) || new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) !== s)
    fail(422, 'Choose a valid date.'); return s; }
function nextDue(value, frequency) { const d = new Date(value + 'T12:00:00Z'); if (frequency === 'Weekly')
    d.setUTCDate(d.getUTCDate() + 7);
else if (frequency === 'Monthly')
    d.setUTCMonth(d.getUTCMonth() + 1);
else if (frequency === 'Quarterly')
    d.setUTCMonth(d.getUTCMonth() + 3);
else
    d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); }
function passwordHash(password) { text(password, 'Password', 200); if (password.length < 12)
    fail(422, 'Use a password with at least 12 characters.'); const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }
function passwordMatches(password, saved) { try {
    const [salt, key] = saved.split(':');
    return timingSafeEqual(Buffer.from(key, 'hex'), scryptSync(String(password), salt, 64));
}
catch {
    return false;
} }
async function actor(req) { const token = (req.headers.cookie || '').match(/(?:^|; )estateos_session=([^;]+)/)?.[1]; if (!token)
    return null; return (await get('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? AND users.active=1', hash(token), Date.now())) || null; }
function safeUser(user) { return user ? { id: user.id, name: user.name, email: user.email, role: user.role, platformOwner: platformOwner(user) } : null; }
function roles(user, ...allowed) { if (!user)
    fail(401, 'Please sign in.'); if (!allowed.includes(user.role))
    fail(403, 'You do not have permission for this action.'); }
async function property(user, propertyId, operation = 'read') {
    if (!user)
        fail(401, 'Please sign in.');
    const p = (await get('SELECT * FROM properties WHERE id=? AND organization_id=?', propertyId, user.organization_id));
    if (!p)
        fail(404, 'Residence not found.');
    if (user.role === 'admin')
        return p;
    if (user.role === 'client' && p.client_id === user.client_id && operation !== 'operate')
        return p;
    if (user.role === 'employee' && p.account_manager_id === user.id)
        return p;
    if (user.role === 'vendor' && operation === 'job' && (await get("SELECT 1 FROM work_orders WHERE property_id=? AND vendor_id=? AND status NOT IN ('cancelled')", p.id, user.vendor_id)))
        return p;
    fail(404, 'Residence not found.');
}
async function entity(user, table, entityId, operation = 'read') { const row = (await get(`SELECT * FROM ${table} WHERE id=?`, entityId)); if (!row)
    fail(404, 'Record not found.'); (await property(user, row.property_id, operation)); return row; }
async function work(user, workId) { if(user.role==='employee'){const assigned=await get('SELECT w.* FROM work_orders w JOIN work_staff a ON a.work_id=w.id JOIN properties p ON p.id=w.property_id WHERE w.id=? AND a.user_id=? AND p.organization_id=?',workId,user.id,user.organization_id);if(assigned)return assigned;} const row = (await entity(user, 'work_orders', workId, user.role === 'vendor' ? 'job' : 'read')); if (user.role === 'vendor' && row.vendor_id !== user.vendor_id)
    fail(404, 'Job not found.'); return row; }
async function audit(user, action, entityId) { (await run('INSERT INTO audit VALUES(?,?,?,?,?,?)', id(), user.organization_id, user.id, action, entityId, now())); }
async function notifyProperty(p, title, entityId, audience = 'staff') { const recipients = (await filterAsync((await all('SELECT * FROM users WHERE organization_id=? AND active=1', p.organization_id)), async (u) => audience === 'client' ? u.role === 'client' && u.client_id === p.client_id : u.role === 'admin' || u.role === 'employee' && (await get('SELECT 1 FROM property_access WHERE user_id=? AND property_id=?', u.id, p.id)))); for (const u of recipients)
    (await run('INSERT INTO notifications VALUES(?,?,?,?,?,?)', id(), u.id, title, entityId, null, now())); }
function json(res, status, data, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); }
async function body(req) { let length = 0; const chunks = []; for await (const chunk of req) {
    length += chunk.length;
    if (length > 15 * 1024 * 1024)
        fail(413, 'Upload exceeds 10 MB.');
    chunks.push(chunk);
} try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
catch {
    fail(400, 'Invalid request.');
} }
const attempts = new Map();
function rate(req, kind, max = 20) { const key = kind + req.socket.remoteAddress; const record = attempts.get(key) || { count: 0, end: Date.now() + 600000 }; if (record.end < Date.now()) {
    record.count = 0;
    record.end = Date.now() + 600000;
} if (++record.count > max)
    fail(429, 'Too many attempts. Please try again later.'); attempts.set(key, record); }
async function session(res, req, user) { const token = randomBytes(32).toString('hex'); (await run('DELETE FROM sessions WHERE expires_at<?', Date.now())); (await run('INSERT INTO sessions VALUES(?,?,?)', hash(token), user.id, Date.now() + 8 * 3600000)); const secure = process.env.ESTATEOS_SECURE_COOKIES === '1'; res.setHeader('Set-Cookie', `estateos_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`); }
function assertVersion(row, b) { if (!Number.isInteger(b.version) || b.version !== row.version)
    fail(409, 'This record changed. Reload it before saving.'); }
const template = JSON.parse(fs.readFileSync(path.join(root, 'inspection-template.json'), 'utf8'));
async function snapshot(user) {
    const profile = await get('SELECT phone,preferred_contact FROM user_profiles WHERE user_id=?', user.id) || {phone:'',preferred_contact:'Email'};
    const allProperties = (await all('SELECT properties.*, clients.name client_name, clients.profile client_profile, manager.name account_manager_name FROM properties JOIN clients ON clients.id=properties.client_id LEFT JOIN users manager ON manager.id=properties.account_manager_id WHERE properties.organization_id=? AND properties.archived_at IS NULL', user.organization_id));
    const archivedProperties = user.role === 'admin' ? (await all('SELECT properties.*, clients.name client_name FROM properties JOIN clients ON clients.id=properties.client_id WHERE properties.organization_id=? AND properties.archived_at IS NOT NULL ORDER BY properties.archived_at DESC', user.organization_id)) : [];
    const props = (await filterAsync(allProperties, async (p) => { try {
        (await property(user, p.id, user.role === 'vendor' ? 'job' : 'read'));
        return true;
    }
    catch {
        return false;
    } }));
    const allowed = new Set(props.map(p => p.id));
    const scoped = async (table) => (await all(`SELECT t.* FROM ${table} t JOIN properties p ON p.id=t.property_id WHERE p.organization_id=?`,user.organization_id)).filter(row => allowed.has(row.property_id));
    let jobs = (await scoped('work_orders'));
    if(user.role==='employee'){const assigned=await all('SELECT w.*,p.name property_name FROM work_orders w JOIN work_staff a ON a.work_id=w.id JOIN properties p ON p.id=w.property_id WHERE a.user_id=? AND p.organization_id=?',user.id,user.organization_id);jobs=[...new Map([...jobs,...assigned].map(w=>[w.id,w])).values()];}
    if (user.role === 'vendor')
        jobs = jobs.filter(j => j.vendor_id === user.vendor_id);
    if (user.role === 'client')
        jobs = jobs.map(({ description, ...j }) => ({ ...j, description: '', service_notes: j.status === 'completed' ? j.service_notes : '' }));
    const inspections = user.role === 'vendor' ? [] : (await scoped('inspections')).filter(i => user.role !== 'client' || i.status === 'published').map(i => { const { internal_notes, report_snapshot, ...visible } = i; return { ...visible, answers: JSON.parse(i.answers), ...(user.role === 'admin' || user.role === 'employee' ? { internal_notes } : {}) }; });
    const jobIds = new Set(jobs.map(j => j.id));
    const inspectionIds = new Set(inspections.map(i => i.id));
    const fileCandidates=await all('SELECT f.* FROM files f JOIN properties p ON p.id=f.property_id WHERE p.organization_id=?',user.organization_id);
    const files = (await filterAsync(fileCandidates.filter(f=>allowed.has(f.property_id)||(user.role==='employee'&&jobIds.has(f.work_order_id))), async (f) => (await fileAllowed(user, f, inspectionIds, jobIds)))).map(({ storage_key, ...f }) => f);
    const assets = user.role === 'vendor' ? [] : (await scoped('assets'));
    const assetIds = new Set(assets.map(a => a.id));
    const assetInspections = assetIds.size ? (await all('SELECT ai.* FROM asset_inspections ai JOIN assets a ON a.id=ai.asset_id WHERE a.id IN (' + [...assetIds].map(() => '?').join(',') + ')', ...assetIds)).map(i => ({ ...i, answers: JSON.parse(i.answers || '[]') })) : [];
    return { workspaceSupport:(await get('SELECT support_email FROM workspace_settings WHERE organization_id=?',user.organization_id))?.support_email||'', user: {...safeUser(user), ...profile}, company: (await get('SELECT name FROM organizations WHERE id=?', user.organization_id)).name, properties: props.map(p => { if (user.role === 'vendor')
            return { id: p.id, name: p.name, address: p.address }; if (user.role === 'client') {
            const { manual, ...safe } = p;
            return safe;
    } return p; }), archivedProperties, clients: user.role === 'admin' ? (await all('SELECT * FROM clients WHERE organization_id=?', user.organization_id)) : [], vendors: ['admin', 'employee'].includes(user.role) ? (await all('SELECT * FROM vendors WHERE organization_id=?', user.organization_id)) : [], users: user.role === 'admin' ? (await all('SELECT id,name,email,role,client_id,vendor_id,active FROM users WHERE organization_id=?', user.organization_id)) : [], assets, asset_inspections: assetInspections, work: jobs, requests: user.role === 'vendor' ? [] : (await scoped('requests')), inspections, files, shopping: user.role === 'vendor' ? [] : (await scoped('shopping_items')), arrivals: user.role === 'vendor' ? [] : (await scoped('arrivals')).map(a => ({ ...a, items: JSON.parse(a.items), room_status: JSON.parse(a.room_status || '[]'), guests: JSON.parse(a.guests || '[]') })), maintenance: ['admin', 'employee'].includes(user.role) ? (await scoped('maintenance_plans')) : [], notes: ['admin', 'employee'].includes(user.role) ? (await scoped('notes')) : [], invoices: user.role === 'admin' ? (await all('SELECT invoices.*,clients.name client_name,COALESCE((SELECT SUM(amount_minor) FROM payments WHERE invoice_id=invoices.id),0) paid_minor FROM invoices JOIN clients ON clients.id=invoices.client_id WHERE invoices.organization_id=?', user.organization_id)) : [], audit: user.role === 'admin' ? (await all('SELECT audit.*,users.name actor_name FROM audit JOIN users ON users.id=audit.actor_id WHERE audit.organization_id=? ORDER BY audit.created_at DESC LIMIT 100', user.organization_id)) : [], notifications: (await all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', user.id)), template };
}
async function fileAllowed(user, f, inspectionIds, jobIds) {
    if (['admin', 'employee'].includes(user.role))
        return true;
    if (user.role === 'vendor')
        return !!f.work_order_id && jobIds.has(f.work_order_id);
    if (f.inspection_id)
        return inspectionIds.has(f.inspection_id) && (await get('SELECT status FROM inspections WHERE id=?', f.inspection_id))?.status === 'published';
    if (f.work_order_id)
        return jobIds.has(f.work_order_id) && (await get('SELECT status FROM work_orders WHERE id=?', f.work_order_id))?.status === 'completed';
    return f.visibility === 'client';
}
async function readFile(user, fileId) { const f = (await get('SELECT * FROM files WHERE id=?', fileId)); if (!f)
    fail(404, 'File not found.'); if(user.role==='employee'&&f.work_order_id){await work(user,f.work_order_id);return f;} (await property(user, f.property_id, user.role === 'vendor' ? 'job' : 'read')); const ins = new Set((await all("SELECT id FROM inspections WHERE property_id=? AND status='published'", f.property_id)).map(x => x.id)); const jobs = new Set((await all('SELECT * FROM work_orders WHERE property_id=?', f.property_id)).filter(x => user.role !== 'vendor' || x.vendor_id === user.vendor_id).map(x => x.id)); if (!(await fileAllowed(user, f, ins, jobs)))
    fail(404, 'File not found.'); return f; }
const saas = createSaas({get,all,run,transaction,fail,text,note,id,hash,now,passwordHash,session,json,body,rate,audit,randomBytes});
const staff = createStaff({get,all,run,transaction,fail,text,note,id,now,passwordHash,json,body,audit});
async function assertWorkspaceActive(organizationId){if((await get('SELECT status FROM workspace_settings WHERE organization_id=?',organizationId))?.status==='suspended')fail(403,'This company workspace is suspended. Contact support.');}
async function api(req, res, url, user) {
    const method = req.method, p = url.pathname;
    if(user)await assertWorkspaceActive(user.organization_id);
    if(await saas(req,res,url,user))return;
    if(await staff.handle(req,res,url,user))return;
    if (p === '/api/status' && method === 'GET')
        return json(res, 200, { configured: !!(await get('SELECT id FROM users LIMIT 1')), user: safeUser(user) });
    if (p === '/api/geocode/autocomplete' && method === 'GET') {
        if (!process.env.GEOAPIFY_API_KEY) return json(res, 503, { error: 'Address search is not configured.' });
        const q = String(url.searchParams.get('q') || '').trim();
        if (q.length < 3) return json(res, 200, { features: [] });
        const remote = await fetch('https://api.geoapify.com/v1/geocode/autocomplete?text=' + encodeURIComponent(q) + '&filter=countrycode:us&limit=5&apiKey=' + encodeURIComponent(process.env.GEOAPIFY_API_KEY));
        if (!remote.ok) return json(res, 502, { error: 'Address search is temporarily unavailable.' });
        return json(res, 200, await remote.json());
    }
    if (p === '/api/geocode/reverse' && method === 'GET') {
        if (!process.env.GEOAPIFY_API_KEY) return json(res, 503, { error: 'Address search is not configured.' });
        const remote = await fetch('https://api.geoapify.com/v1/geocode/reverse?lat=' + encodeURIComponent(url.searchParams.get('lat') || '') + '&lon=' + encodeURIComponent(url.searchParams.get('lon') || '') + '&apiKey=' + encodeURIComponent(process.env.GEOAPIFY_API_KEY));
        if (!remote.ok) return json(res, 502, { error: 'Location lookup is temporarily unavailable.' });
        return json(res, 200, await remote.json());
    }
    if (p === '/api/setup' && method === 'POST') {
        rate(req, 'setup');
        const b = await body(req);
        if ((await get('SELECT id FROM users LIMIT 1')))
            fail(409, 'Setup is already complete.');
        if (process.env.ESTATEOS_HOST && process.env.ESTATEOS_HOST !== '127.0.0.1' && (!process.env.ESTATEOS_SETUP_KEY || b.setupKey !== process.env.ESTATEOS_SETUP_KEY))
            fail(403, 'Setup key required.');
        const pw = passwordHash(b.password);
        const email = text(b.email, 'Email', 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            fail(422, 'Enter a valid email.');
        const org = id(), uid = id();
        (await transaction(async () => { if ((await get('SELECT id FROM users LIMIT 1')))
            fail(409, 'Setup complete.'); (await run('INSERT INTO organizations VALUES(?,?,?)', org, text(b.company, 'Company', 160), now())); (await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)', uid, org, text(b.name, 'Name', 160), email, pw, 'admin', null, null, 1, now())); }));
        const u = (await get('SELECT * FROM users WHERE id=?', uid));
        (await session(res, req, u));
        return json(res, 201, { user: safeUser(u) });
    }
    if (p === '/api/login' && method === 'POST') {
        rate(req, 'login');
        const b = await body(req);
        const u = (await get('SELECT * FROM users WHERE email=? AND active=1', String(b.email).toLowerCase()));
        if (u && b.role && b.role !== u.role)
            fail(403, 'Choose the portal assigned to this account.');
        if (!u || !passwordMatches(b.password, u.password_hash))
            fail(401, 'Email or password is incorrect.');
        await assertWorkspaceActive(u.organization_id);
        (await session(res, req, u));
        return json(res, 200, { user: safeUser(u) });
    }
    if (p === '/api/accept-invite' && method === 'POST') {
        rate(req, 'invite');
        const b = await body(req);
        const invitation = (await get('SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?', hash(String(b.token)), Date.now()));
        if (!invitation)
            fail(422, 'Invitation expired or already used.');
        await assertWorkspaceActive(invitation.organization_id);
        const pw = passwordHash(b.password), uid = id();
        (await transaction(async () => { const fresh = (await get('SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL', hash(String(b.token)))); if (!fresh)
            fail(409, 'Invitation already used.'); (await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)', uid, invitation.organization_id, text(b.name, 'Name', 160), invitation.email, pw, invitation.role, invitation.client_id, invitation.vendor_id, 1, now())); (await run('UPDATE invitations SET used_at=? WHERE token_hash=?', now(), invitation.token_hash)); }));
        const u = (await get('SELECT * FROM users WHERE id=?', uid));
        (await session(res, req, u));
        return json(res, 201, { user: safeUser(u) });
    }
    if (!user)
        fail(401, 'Please sign in.');
    if (p === '/api/logout' && method === 'POST') {
        const token = (req.headers.cookie || '').match(/estateos_session=([^;]+)/)?.[1];
        if (token)
            (await run('DELETE FROM sessions WHERE token_hash=?', hash(token)));
        res.setHeader('Set-Cookie', 'estateos_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return json(res, 200, { ok: true });
    }
    if (p === '/api/data' && method === 'GET')
        return json(res, 200, (await snapshot(user)));
    if (p.startsWith('/api/files/') && method === 'GET') {
        const f = (await readFile(user, p.split('/')[3]));
        const bytes = (await readBytes(f.storage_key));
        res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${f.name.replace(/[^a-zA-Z0-9._ -]/g, '_')}"`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.end(bytes);
    }
    if (/^\/api\/inspections\/[^/]+\/pdf$/.test(p) && method === 'GET') {
        const row = (await entity(user, 'inspections', p.split('/')[3]));
        if (row.status !== 'published')
            fail(409, 'Publish the inspection first.');
        const report = JSON.parse(row.report_snapshot);
        const photos = (await mapAsync(report.fileIds, async (fileId) => { const f = (await readFile(user, fileId)); return { name: f.name, bytes: (await readBytes(f.storage_key)) }; }));
        const pdf = inspectionPdf(report, photos);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="EstateOS-Inspection-${row.id}.pdf"`, 'Cache-Control': 'no-store' });
        return res.end(pdf);
    }
    if (/^\/api\/asset-inspections\/[^/]+\/pdf$/.test(p) && method === 'GET') {
        const row = await get('SELECT ai.*,a.name asset_name,a.category,a.property_id FROM asset_inspections ai JOIN assets a ON a.id=ai.asset_id WHERE ai.id=?', p.split('/')[3]);
        if (!row) fail(404, 'Asset inspection not found.');
        await property(user, row.property_id, 'read');
        const prop = await get('SELECT name FROM properties WHERE id=?', row.property_id);
        const report = { company: (await get('SELECT name FROM organizations WHERE id=?', user.organization_id)).name, property: prop.name, client: '', date: row.inspection_date, inspector: (await get('SELECT name FROM users WHERE id=?', row.inspector_id)).name, overall: JSON.parse(row.answers || '[]').some(a => a.status === 'attention') ? 'Action needed' : 'Passed', answers: JSON.parse(row.answers || '[]'), summary: `${row.asset_name} inspection`, notes: row.notes || '', fileIds: [] };
        const pdf = inspectionPdf(report, []);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="EstateOS-${row.asset_name.replace(/[^a-zA-Z0-9._ -]/g, '_')}-Inspection.pdf`, 'Cache-Control': 'no-store' });
        return res.end(pdf);
    }
    if (p === '/api/backup' && method === 'GET') {
        roles(user, 'admin');
        const tables = ['organizations', 'clients', 'properties', 'vendors', 'assets', 'asset_inspections', 'work_orders', 'requests', 'inspections', 'files', 'shopping_items', 'arrivals', 'maintenance_plans', 'invoices', 'payments', 'notes', 'audit'];
        const backup = { version: 1, createdAt: now(), tables: {} };
        backup.tables.staff_profiles=await all('SELECT sp.* FROM staff_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.organization_id=?',user.organization_id);
        backup.tables.staff_schedules=await all('SELECT * FROM staff_schedules WHERE organization_id=?',user.organization_id);
        backup.tables.work_staff=await all('SELECT a.* FROM work_staff a JOIN work_orders w ON w.id=a.work_id JOIN properties p ON p.id=w.property_id WHERE p.organization_id=?',user.organization_id);
        backup.tables.scheduled_work_types=await all('SELECT t.* FROM scheduled_work_types t JOIN work_orders w ON w.id=t.work_id JOIN properties p ON p.id=w.property_id WHERE p.organization_id=?',user.organization_id);
        for (const table of tables) {
            if(table==='organizations')backup.tables[table]=await all('SELECT * FROM organizations WHERE id=?',user.organization_id);
            else if(['clients','properties','vendors','invoices','audit'].includes(table))backup.tables[table]=await all(`SELECT * FROM ${table} WHERE organization_id=?`,user.organization_id);
            else if(table==='payments')backup.tables[table]=await all('SELECT pay.* FROM payments pay JOIN invoices i ON i.id=pay.invoice_id WHERE i.organization_id=?',user.organization_id);
            else if(table==='asset_inspections')backup.tables[table]=await all('SELECT ai.* FROM asset_inspections ai JOIN assets a ON a.id=ai.asset_id JOIN properties p ON p.id=a.property_id WHERE p.organization_id=?',user.organization_id);
            else backup.tables[table]=await all(`SELECT t.* FROM ${table} t JOIN properties p ON p.id=t.property_id WHERE p.organization_id=?`,user.organization_id);
        }
        return json(res, 200, backup, { 'Content-Disposition': 'attachment; filename="EstateOS-records.json"' });
    }
    if (method !== 'POST')
        fail(404, 'Endpoint not found.');
    const b = await body(req);
    let result;
    if (p === '/api/profile') {
        const name = text(b.name, 'Name', 160), phone = note(b.phone, 80);
        const preference = contactPreference(b.preferredContact);
        await transaction(async () => {
            await run('UPDATE users SET name=? WHERE id=?', name, user.id);
            await run('INSERT INTO user_profiles(user_id,phone,preferred_contact) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,preferred_contact=excluded.preferred_contact', user.id, phone, preference);
            await audit(user, 'profile.updated', user.id);
        });
        result = { saved: true };
    }
    else if (p === '/api/profile/password' || p === '/api/profile/email') {
        rate(req, 'login');
        await transaction(async () => {
            const current = await get('SELECT * FROM users WHERE id=?', user.id);
            if (!passwordMatches(b.currentPassword, current.password_hash)) fail(403, 'Current password is incorrect.');
            if (p.endsWith('/password')) {
                if (b.newPassword !== b.confirmPassword) fail(422, 'New passwords must match.');
                const pw = passwordHash(b.newPassword);
                await run('UPDATE users SET password_hash=? WHERE id=?', pw, user.id);
                await audit(user, 'password.changed', user.id);
            } else {
                const email = text(b.email, 'Email', 254).toLowerCase();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(422, 'Enter a valid email.');
                if (await get('SELECT id FROM users WHERE LOWER(email)=? AND id<>?', email, user.id)) fail(409, 'That email is already in use.');
                await run('UPDATE users SET email=? WHERE id=?', email, user.id);
                await audit(user, 'email.changed', user.id);
            }
            await run('DELETE FROM sessions WHERE user_id=?', user.id);
        });
        await session(res, req, user);
        result = { saved: true };
    }
    else if (p === '/api/clients') {
        roles(user, 'admin');
        const key = id();
        (await run('INSERT INTO clients(id,organization_id,name,email,phone,created_at,profile) VALUES(?,?,?,?,?,?,?)', key, user.organization_id, text(b.name || b.lastName, 'Family name', 160), note(b.email, 254), note(b.phone, 80), now(), JSON.stringify(clientProfile(b))));
        (await audit(user, 'client.created', key));
        result = { id: key };
    }
    else if (p === '/api/clients/update' || p === '/api/clients/member' || p === '/api/clients/member/delete') {
        roles(user, 'admin', 'client');
        const c = (await get('SELECT * FROM clients WHERE id=? AND organization_id=?', b.id, user.organization_id));
        if (!c)
            fail(404, 'Family not found.');
        if (user.role === 'client' && user.client_id !== c.id)
            fail(403, 'You do not have permission for this family.');
        const old = JSON.parse(c.profile || '{}');
        if (p.endsWith('/member/delete')) {
            const members = old.members || [];
            if (!members.some(member => member.id === b.memberId))
                fail(404, 'Family member not found.');
            run('UPDATE clients SET profile=? WHERE id=?', JSON.stringify({ ...old, members: members.filter(member => member.id !== b.memberId) }), c.id);
            audit(user, 'client.member_removed', c.id);
        }
        else if (p.endsWith('/member')) {
            const members = old.members || [];
            members.push({ id: id(), firstName: text(b.firstName, 'First name', 160), lastName: text(b.lastName, 'Last name', 160), relationship: note(b.relationship, 100), email: note(b.email, 254), phone: note(b.phone, 80), preferredContact: contactPreference(b.preferredContact) });
            (await run('UPDATE clients SET profile=? WHERE id=?', JSON.stringify({ ...old, members }), c.id));
            (await audit(user, 'client.member_added', c.id));
        }
        else {
            (await run('UPDATE clients SET name=?,email=?,phone=?,profile=? WHERE id=?', text(b.name || b.lastName, 'Family name', 160), note(b.email, 254), note(b.phone, 80), JSON.stringify({ ...clientProfile(b), members: old.members || [] }), c.id));
            (await audit(user, 'client.updated', c.id));
        }
        result = { id: c.id };
    }
    else if (p === '/api/properties') {
        roles(user, 'admin');
        if (!(await get('SELECT id FROM clients WHERE id=? AND organization_id=?', b.clientId, user.organization_id)))
            fail(422, 'Select a client family.');
        const a = addressFields(b), key = id();
        (await run('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,manual,created_at,street_address,address_line2,city,state,postal_code,country,room_profile) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', key, user.organization_id, b.clientId, text(b.name, 'Residence', 160), a.full, note(b.timezone, 80) || 'America/New_York', '', now(), a.street, a.line2, a.city, a.state, a.postal, a.country, JSON.stringify(roomProfile(b.roomProfile))));
        (await audit(user, 'property.created', key));
        result = { id: key };
    }
    else if (p === '/api/properties/update') {
        roles(user, 'admin');
        const row = (await property(user, b.id, 'operate')), a = addressFields(b);
        (await run('UPDATE properties SET name=?,address=?,street_address=?,address_line2=?,city=?,state=?,postal_code=?,country=?,room_profile=? WHERE id=?', text(b.name, 'Residence', 160), a.full, a.street, a.line2, a.city, a.state, a.postal, a.country, JSON.stringify(roomProfile(b.roomProfile)), row.id));
        (await audit(user, 'property.updated', row.id));
        result = { id: row.id };
    }
    else if (p === '/api/properties/archive') {
        roles(user, 'admin');
        const row = (await property(user, b.id, 'operate'));
        if (!b.confirm)
            fail(422, 'Confirm archiving this residence.');
        (await run('UPDATE properties SET archived_at=? WHERE id=? AND archived_at IS NULL', now(), row.id));
        (await audit(user, 'property.archived', row.id));
        result = { id: row.id, archived: true };
    }
    else if (p === '/api/properties/restore') {
        roles(user, 'admin');
        const row = (await get('SELECT * FROM properties WHERE id=? AND organization_id=?', b.id, user.organization_id));
        if (!row)
            fail(404, 'Residence not found.');
        (await run('UPDATE properties SET archived_at=NULL WHERE id=?', row.id));
        (await audit(user, 'property.restored', row.id));
        result = { id: row.id, archived: false };
    }
    else if (p === '/api/access-codes/read' || p === '/api/access-codes/save') {
        roles(user, 'admin', 'employee');
        result = await transaction(async()=>{
            const home = await property(user, b.propertyId, 'operate');
            const context = home.organization_id + ':' + home.id;
            const saved = await get('SELECT * FROM property_vault WHERE property_id=?',home.id);
            if (p.endsWith('/read')) {
                const details=unseal(saved?.encrypted_details,context);
                await audit(user,'access_codes.viewed',home.id);
                return {details,version:saved?.version||0};
            }
            if(b.version!==(saved?.version||0))fail(409,'These details changed. Close and reopen them before saving.');
            const details={};
            for(const field of ['gate','door','alarm','lockbox','instructions'])details[field]=note(b.details?.[field],4000);
            const encrypted=seal(details,context);
            if(saved)await run('UPDATE property_vault SET encrypted_details=?,version=version+1,updated_at=? WHERE property_id=?',encrypted,now(),home.id);
            else await run('INSERT INTO property_vault VALUES(?,?,?,?)',home.id,encrypted,1,now());
            await audit(user,'access_codes.updated',home.id);
            return {ok:true};
        });
    }
    else if (p === '/api/manual') {
        roles(user, 'admin', 'employee');
        (await property(user, b.propertyId, 'operate'));
        (await run('UPDATE properties SET manual=? WHERE id=?', note(b.manual, 16000), b.propertyId));
        (await audit(user, 'manual.updated', b.propertyId));
        result = { ok: true };
    }
    else if (p === '/api/vendors') {
        roles(user, 'admin');
        const key = id();
        (await run('INSERT INTO vendors VALUES(?,?,?,?,?,?,?)', key, user.organization_id, text(b.name, 'Vendor', 160), note(b.trade, 100), note(b.email, 254), note(b.phone, 80), now()));
        (await audit(user, 'vendor.created', key));
        result = { id: key };
    }
    else if (p === '/api/invitations') {
        roles(user, 'admin');
        const role = b.role;
        if (!['admin', 'employee', 'client', 'vendor'].includes(role))
            fail(422, 'Invalid role.');
        if (role === 'client' && !(await get('SELECT 1 FROM clients WHERE id=? AND organization_id=?', b.clientId, user.organization_id)))
            fail(422, 'Select the client family.');
        if (role === 'vendor' && !(await get('SELECT 1 FROM vendors WHERE id=? AND organization_id=?', b.vendorId, user.organization_id)))
            fail(422, 'Select the vendor company.');
        const token = randomBytes(32).toString('hex');
        const email = text(b.email, 'Email', 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            fail(422, 'Enter a valid email.');
        if ((await get('SELECT 1 FROM users WHERE email=?', email)))
            fail(409, 'That account already exists.');
        (await run('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?)', hash(token), user.organization_id, email, role, role === 'client' ? b.clientId : null, role === 'vendor' ? b.vendorId : null, Date.now() + 48 * 3600000, null));
        (await audit(user, 'invitation.created', email));
        result = { invitePath: '/?invite=' + token, expiresInHours: 48 };
    }
    else if (p === '/api/access' || p === '/api/properties/manager') {
        roles(user, 'admin');
        const member = b.userId ? (await get('SELECT * FROM users WHERE id=? AND organization_id=?', b.userId, user.organization_id)) : null;
        if (b.userId && (!member || !member.active || !['admin','employee'].includes(member.role)))
            fail(422, 'Select an active administrator or employee.');
        (await property(user, b.propertyId));
        await transaction(async () => {
            await run('UPDATE properties SET account_manager_id=? WHERE id=?', member?.id || null, b.propertyId);
            await run('DELETE FROM property_access WHERE property_id=?', b.propertyId);
            if (member?.role === 'employee') await run('INSERT INTO property_access VALUES(?,?)', member.id, b.propertyId);
            await audit(user, 'property.butler_assigned', b.propertyId);
        });
        result = { ok: true };
    }
    else if (p === '/api/users/suspend') {
        roles(user, 'admin');
        const member = (await get('SELECT * FROM users WHERE id=? AND organization_id=?', b.userId, user.organization_id));
        if (!member || member.id === user.id)
            fail(422, 'Cannot suspend your own account.');
        (await run('UPDATE users SET active=0 WHERE id=?', member.id));
        (await run('DELETE FROM sessions WHERE user_id=?', member.id));
        (await audit(user, 'user.suspended', member.id));
        result = { ok: true };
    }
    else if (p === '/api/assets/update') {
        roles(user, 'admin', 'employee');
        const asset = await get('SELECT * FROM assets WHERE id=?', b.id);
        if (!asset) fail(404, 'Asset not found.');
        await property(user, asset.property_id, 'operate');
        await run('UPDATE assets SET name=?,category=?,model=?,serial=?,location=?,warranty=?,mileage=?,hours=?,notes=? WHERE id=?', text(b.name, 'Asset name', 200), text(b.category || 'Other', 'Category', 100), note(b.model, 160), note(b.serial, 160), note(b.location, 200), note(b.warranty, 200), note(b.mileage, 80), note(b.hours, 80), note(b.notes), asset.id);
        await audit(user, 'asset.updated', asset.id); result = {id:asset.id};
    }
    else if (p === '/api/assets') {
        roles(user, 'admin', 'employee');
        (await property(user, b.propertyId, 'operate'));
        const key = id();
        (await run('INSERT INTO assets(id,property_id,name,category,model,serial,location,warranty,created_at,mileage,hours,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', key, b.propertyId, text(b.name, 'Asset', 160), note(b.category, 100), note(b.model, 160), note(b.serial, 160), note(b.location, 200), note(b.warranty, 100), now(), note(b.mileage, 80), note(b.hours, 80), note(b.notes)));
        (await audit(user, 'asset.created', key));
        result = { id: key };
    }
    else if (p === '/api/asset-inspections') {
        roles(user, 'admin', 'employee');
        const asset = await get('SELECT * FROM assets WHERE id=?', b.assetId);
        if (!asset) fail(404, 'Asset not found.');
        await property(user, asset.property_id, 'operate');
        const answers = Array.isArray(b.answers) ? b.answers.map(a => ({ key: text(a.key, 'Checklist item', 80), label: text(a.label, 'Checklist item', 200), status: ['pass', 'attention', 'na'].includes(a.status) ? a.status : 'pass', note: note(a.note, 300) })) : [];
        const id = randomUUID();
        await run('INSERT INTO asset_inspections(id,asset_id,inspector_id,inspection_date,answers,notes,created_at) VALUES(?,?,?,?,?,?,?)', id, asset.id, user.id, date(b.date || now().slice(0, 10)), JSON.stringify(answers), note(b.notes), now());
        await audit(user, 'asset_inspection.completed', id); result = { id };
    }
    else if (p === '/api/work') {
        await transaction(async()=>{
        roles(user, 'admin', 'employee');
        (await property(user, b.propertyId, 'operate'));
        if (b.assetId && !(await get('SELECT id FROM assets WHERE id=? AND property_id=?', b.assetId, b.propertyId)))
            fail(422, 'Asset belongs to another residence.');
        if (b.vendorId && !(await get('SELECT 1 FROM vendors WHERE id=? AND organization_id=?', b.vendorId, user.organization_id)))
            fail(422, 'Unknown vendor.');
        const key = id();
        (await run('INSERT INTO work_orders(id,property_id,asset_id,title,description,priority,due_date,vendor_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', key, b.propertyId, b.assetId || null, text(b.title, 'Work title', 200), note(b.description), ['Normal', 'High', 'Urgent'].includes(b.priority) ? b.priority : 'Normal', b.dueDate ? date(b.dueDate) : '', b.vendorId || null, user.id, now()));
        (await audit(user, 'work.created', key));
        if(b.staffId||b.scheduleId)await staff.assignment(user,key,b);
        result = { id: key };
        });
    }
    else if (p === '/api/work/action') {
        roles(user, 'admin', 'employee', 'vendor');
        const row = (await work(user, b.id));
        assertVersion(row, b);
        const transitions = { start: ['open', 'scheduled'], submit: ['in_progress', 'open', 'scheduled'], accept: ['submitted'], return: ['submitted'] };
        if (!transitions[b.action]?.includes(row.status))
            fail(409, 'That job is not in the right state.');
        if (['accept', 'return'].includes(b.action) && !['admin', 'employee'].includes(user.role))
            fail(403, 'A staff reviewer must verify completion.');
        if (b.action === 'submit' && !(await get('SELECT 1 FROM files WHERE work_order_id=?', row.id)))
            fail(422, 'Add at least one completion photo.');
        const status = { start: 'in_progress', submit: 'submitted', accept: 'completed', return: 'in_progress' }[b.action];
        const pRow = await get('SELECT * FROM properties WHERE id=? AND organization_id=?',row.property_id,user.organization_id);
        (await transaction(async () => { (await run('UPDATE work_orders SET status=?,service_notes=?,completed_at=?,version=version+1 WHERE id=?', status, b.action === 'submit' ? text(b.notes, 'Completion notes') : row.service_notes, status === 'completed' ? now() : null, row.id)); if (status === 'completed') {
            (await run("UPDATE requests SET status='completed' WHERE work_order_id=?", row.id));
            (await notifyProperty(pRow, 'Service completed: ' + row.title, row.id, 'client'));
        }
        else if (status === 'submitted')
            (await notifyProperty(pRow, 'Review completion: ' + row.title, row.id)); (await audit(user, 'work.' + b.action, row.id)); }));
        result = { ok: true };
    }
    else if (p === '/api/requests') {
        roles(user, 'admin', 'employee', 'client');
        const pRow = (await property(user, b.propertyId));
        const key = id();
        const priority=b.priority||'Normal';if(!['Low','Normal','High','Urgent'].includes(priority))fail(422,'Choose a valid priority.');
        (await transaction(async () => { (await run('INSERT INTO requests(id,property_id,created_by,title,description,status,work_order_id,created_at,priority) VALUES(?,?,?,?,?,?,?,?,?)', key, pRow.id, user.id, text(b.title, 'Request', 200), note(b.description), 'new', null, now(),priority)); (await notifyProperty(pRow, 'New request: ' + b.title, key)); (await audit(user, 'request.created', key)); }));
        result = { id: key };
    }
    else if (p === '/api/requests/priority') {
        roles(user,'admin');await entity(user,'requests',b.id,'operate');
        if(!['Low','Normal','High','Urgent'].includes(b.priority))fail(422,'Choose a valid priority.');
        await transaction(async()=>{await run('UPDATE requests SET priority=? WHERE id=?',b.priority,b.id);await audit(user,'request.priority_updated',b.id);});result={ok:true};
    }
    else if (p === '/api/requests/create-work') {
        roles(user,'admin','employee');
        await transaction(async()=>{const row=await entity(user,'requests',b.id,'operate');if(row.work_order_id||row.status==='completed')fail(409,'This request already has work linked or is completed.');const key=id();await run('INSERT INTO work_orders(id,property_id,title,description,priority,created_by,created_at) VALUES(?,?,?,?,?,?,?)',key,row.property_id,row.title,row.description,row.priority,user.id,now());await run("UPDATE requests SET work_order_id=?,status='in_progress' WHERE id=?",key,row.id);await audit(user,'request.work_created',row.id);result={id:key};});
    }
    else if (p === '/api/requests/assign') {
        roles(user, 'admin', 'employee');
        const row = (await entity(user, 'requests', b.id, 'operate'));
        const job = (await work(user, b.workId));
        if (row.property_id !== job.property_id)
            fail(422, 'Choose work at the same residence.');
        (await run("UPDATE requests SET work_order_id=?,status='in_progress' WHERE id=?", job.id, row.id));
        (await audit(user, 'request.assigned', row.id));
        result = { ok: true };
    }
    else if (p === '/api/inspections') {
        roles(user, 'admin', 'employee');
        (await property(user, b.propertyId, 'operate'));
        const key = id();
        const inspectionDate = date(b.date), frequency = ['One-time', '7 days', '30 days', '60 days'].includes(b.frequency) ? b.frequency : (b.frequency === 'Custom' ? 'Custom' : 'One-time');
        const customDays = frequency === 'Custom' ? Math.max(1, Math.min(3650, Number(b.customDays) || 0)) : ({ '7 days': 7, '30 days': 30, '60 days': 60 }[frequency] || 0);
        const next = customDays ? (() => { const d = new Date(inspectionDate + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + customDays); return d.toISOString().slice(0, 10); })() : '';
        (await run('INSERT INTO inspections(id,property_id,inspector_id,inspection_date,answers,created_at,frequency,next_due) VALUES(?,?,?,?,?,?,?,?)', key, b.propertyId, user.id, inspectionDate, JSON.stringify(template), now(), frequency, next));
        (await audit(user, 'inspection.started', key));
        result = { id: key };
    }
    else if (p === '/api/inspections/schedule') {
        roles(user, 'admin', 'employee');
        const row = (await entity(user, 'inspections', b.id, 'operate'));
        const frequency = ['One-time', '7 days', '30 days', '60 days'].includes(b.frequency) ? b.frequency : (b.frequency === 'Custom' ? 'Custom' : 'One-time');
        const days = frequency === 'Custom' ? Math.max(1, Math.min(3650, Number(b.customDays) || 0)) : ({'7 days':7,'30 days':30,'60 days':60}[frequency] || 0);
        let next = ''; if (days) { const d = new Date(date(b.nextDue) + 'T12:00:00Z'); next = d.toISOString().slice(0,10); }
        (await run('UPDATE inspections SET frequency=?,next_due=? WHERE id=?', frequency, next, row.id));
        (await audit(user, 'inspection.schedule_updated', row.id)); result = { id: row.id, frequency, next_due: next };
    }
    else if (p === '/api/inspections/save') {
        roles(user, 'admin', 'employee');
        const row = (await entity(user, 'inspections', b.id, 'operate'));
        assertVersion(row, b);
        if (row.status !== 'draft')
            fail(409, 'Published reports cannot be edited.');
        const answers = validateAnswers(b.answers);
        (await run('UPDATE inspections SET answers=?,summary=?,notes=?,internal_notes=?,version=version+1 WHERE id=?', JSON.stringify(answers), note(b.summary), note(b.notes), note(b.internalNotes), row.id));
        (await audit(user, 'inspection.saved', row.id));
        result = { id: row.id, version: row.version + 1 };
    }
    else if (p === '/api/inspections/publish') {
        roles(user, 'admin');
        const row = (await entity(user, 'inspections', b.id, 'operate'));
        const key = text(b.idempotencyKey, 'Publication key', 100), requestHash = hash(JSON.stringify(b));
        const saved = (await get('SELECT * FROM idempotency WHERE user_id=? AND key=? AND route=?', user.id, key, p));
        if (saved) {
            if (saved.request_hash !== requestHash)
                fail(409, 'Publication key reused for a different request.');
            return json(res, 200, JSON.parse(saved.response));
        }
        assertVersion(row, b);
        if (row.status !== 'draft')
            fail(409, 'Already published.');
        const answers = JSON.parse(row.answers);
        if (!row.summary.trim())
            fail(422, 'Add an inspection summary.');
        const pRow = (await property(user, row.property_id));
        const fileIds = (await all('SELECT id FROM files WHERE inspection_id=? ORDER BY created_at', row.id)).map(f => f.id);
        const report = { id: row.id, company: (await get('SELECT name FROM organizations WHERE id=?', user.organization_id)).name, property: pRow.name, client: (await get('SELECT name FROM clients WHERE id=?', pRow.client_id)).name, date: row.inspection_date, inspector: (await get('SELECT name FROM users WHERE id=?', row.inspector_id)).name, overall: answers.some(a => a.status === 'attention') ? 'Action needed' : answers.some(a => a.status === 'monitor') ? 'Monitor' : answers.every(a => a.status === 'na') ? 'Not assessed' : 'Passed', answers, summary: row.summary, notes: row.notes, fileIds };
        result = { id: row.id, published: true };
        (await transaction(async () => { (await run("UPDATE inspections SET status='published',published_at=?,report_snapshot=?,version=version+1 WHERE id=?", now(), JSON.stringify(report), row.id)); (await notifyProperty(pRow, 'Inspection report available: ' + pRow.name, row.id, 'client')); (await audit(user, 'inspection.published', row.id)); (await run('INSERT INTO idempotency VALUES(?,?,?,?,?)', user.id, key, p, requestHash, JSON.stringify(result))); }));
    }
    else if (p === '/api/files') {
        roles(user, 'admin', 'employee', 'vendor');
        const authorizedJob=b.workId?await work(user,b.workId):null;
        const pRow = authorizedJob&&authorizedJob.property_id===b.propertyId?await get('SELECT * FROM properties WHERE id=? AND organization_id=?',b.propertyId,user.organization_id):(await property(user, b.propertyId, user.role === 'vendor' ? 'job' : 'operate'));
        if (b.inspectionId) {
            roles(user, 'admin', 'employee');
            const inspection = (await entity(user, 'inspections', b.inspectionId, 'operate'));
            if (inspection.property_id !== pRow.id || inspection.status !== 'draft')
                fail(422, 'Photos require a draft at this residence.');
        }
        if (b.workId) {
            const job = (await work(user, b.workId));
            if (job.property_id !== pRow.id || ['completed', 'cancelled', 'submitted'].includes(job.status))
                fail(422, 'Evidence is locked after submission.');
        }
        if (user.role === 'vendor' && !b.workId)
            fail(403, 'Upload evidence to an assigned job.');
        if (b.inspectionId && b.workId)
            fail(422, 'Choose one evidence target.');
        const bytes = Buffer.from(text(b.base64, 'File', 14 * 1024 * 1024), 'base64');
        if (bytes.length > 10 * 1024 * 1024)
            fail(413, 'Maximum file size is 10 MB.');
        const isJpeg = bytes[0] === 255 && bytes[1] === 216;
        if (isJpeg)
            jpegSize(bytes);
        else if (bytes.subarray(0, 5).toString() !== '%PDF-' || b.inspectionId || b.workId)
            fail(422, 'Use JPEG photos or PDF documents.');
        const key = id(), storageKey = id();
        (await putBytes(storageKey, bytes, isJpeg ? 'image/jpeg' : 'application/pdf'));
        try {
            (await run('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?)', key, pRow.id, b.inspectionId || null, b.workId || null, text(b.name, 'Filename', 200), isJpeg ? 'image/jpeg' : 'application/pdf', bytes.length, storageKey, b.visibility === 'client' ? 'client' : 'internal', user.id, now()));
            (await audit(user, 'file.uploaded', key));
        }
        catch (e) {
            (await deleteBytes(storageKey));
            throw e;
        }
        result = { id: key };
    }
    else if (p === '/api/shopping/update' || p === '/api/shopping/delete') {
        roles(user, 'admin', 'employee', 'client');
        const item = await entity(user, 'shopping_items', b.id);
        if (p.endsWith('/delete')) {
            await run('DELETE FROM shopping_items WHERE id=?', item.id);
            await audit(user, 'shopping.removed', item.id);
        } else {
            await run('UPDATE shopping_items SET name=?,quantity=?,category=?,notes=? WHERE id=?', text(b.name, 'Item', 200), text(b.quantity, 'Quantity', 80), note(b.category, 100), note(b.notes), item.id);
            await audit(user, 'shopping.updated', item.id);
        }
        result = {id:item.id};
    }
    else if (p === '/api/shopping') {
        roles(user, 'admin', 'employee', 'client');
        (await property(user, b.propertyId));
        const key = id();
        (await run('INSERT INTO shopping_items VALUES(?,?,?,?,?,?,?)', key, b.propertyId, text(b.name, 'Item', 200), text(b.quantity || '1', 'Quantity', 80), note(b.category, 100), note(b.notes), now()));
        (await audit(user, 'shopping.added', key));
        result = { id: key };
    }
    else if (p === '/api/arrivals') {
        roles(user, 'admin', 'employee', 'client');
        const pRow = (await property(user, b.propertyId));
        if (!b.arrivalAt || Number.isNaN(Date.parse(b.arrivalAt)))
            fail(422, 'Choose arrival date and time.');
        const ids = Array.isArray(b.itemIds) ? b.itemIds : [];
        const guestIds = new Set((Array.isArray(b.guestIds) ? b.guestIds : []).map(String));
        const profileRow = (await get('SELECT profile FROM clients WHERE id=? AND organization_id=?', pRow.client_id, user.organization_id));
        let profile = {}; try { profile = JSON.parse(profileRow?.profile || '{}'); } catch { profile = {}; }
        const guests = (Array.isArray(profile.members) ? profile.members : []).filter(m => guestIds.has(String(m.id))).map(m => ({ id: m.id, firstName: m.firstName || '', lastName: m.lastName || '', relationship: m.relationship || 'Guest', email: m.email || '', phone: m.phone || '', preferredContact: m.preferredContact || '' }));
        const items = (await mapAsync(ids, async (itemId) => { const item = (await get('SELECT * FROM shopping_items WHERE id=? AND property_id=?', itemId, pRow.id)); if (!item)
            fail(422, 'Shopping item belongs to another residence.'); return { id: item.id, name: item.name, quantity: item.quantity, notes: item.notes, status: 'requested', substitutionNeeded: false, substitution: '' }; }));
        const key = id(), roomStatus = roomStatusFor(pRow);
        (await transaction(async () => { (await run('INSERT INTO arrivals(id,property_id,created_by,arrival_at,needs,status,items,created_at,version,room_status,guests) VALUES(?,?,?,?,?,?,?,?,?,?,?)', key, pRow.id, user.id, b.arrivalAt, note(b.needs), 'submitted', JSON.stringify(items), now(), 1, JSON.stringify(roomStatus), JSON.stringify(guests))); (await notifyProperty(pRow, 'Arrival preparation requested', key)); (await audit(user, 'arrival.created', key)); }));
        result = { id: key };
    }
    else if (p === '/api/arrivals/update') {
        roles(user, 'admin', 'employee');
        const row = (await entity(user, 'arrivals', b.id, 'operate'));
        assertVersion(row, b);
        const items = JSON.parse(row.items), roomStatus = JSON.parse(row.room_status || '[]');
        if (b.itemId && b.itemStatus !== undefined) {
            const item = items.find(i => i.id === b.itemId);
            if (!item || !['requested', 'purchased', 'stocked'].includes(b.itemStatus))
                fail(422, 'Invalid shopping status.');
            item.status = b.itemStatus;
        }
        if (b.itemId && b.substitutionNeeded !== undefined) {
            const item = items.find(i => i.id === b.itemId);
            if (item) {
                item.substitutionNeeded = !!b.substitutionNeeded;
                item.substitution = note(b.substitution, 500);
            }
        }
        if (b.roomKey) {
            const room = roomStatus.find(r => r.key === b.roomKey);
            if (!room)
                fail(422, 'Unknown room.');
            if (b.roomReady !== undefined)
                room.ready = !!b.roomReady;
            if (b.roomNotes !== undefined)
                room.notes = note(b.roomNotes, 500);
        }
        let status = b.status || row.status;
        if (!['submitted', 'preparing', 'ready', 'completed', 'cancelled'].includes(status))
            fail(422, 'Invalid arrival status.');
        if (status === 'ready' && items.some(i => !['purchased', 'stocked'].includes(i.status)))
            fail(422, 'Mark every selected item purchased before completing arrival preparation.');
        if (status === 'ready' && roomStatus.some(r => !r.ready))
            fail(422, 'Mark every residence room ready before completing arrival preparation.');
        if (status === 'ready' && !b.confirmNeeds)
            fail(422, 'Confirm all additional preparation needs are complete.');
        (await run('UPDATE arrivals SET items=?,room_status=?,status=?,version=version+1 WHERE id=?', JSON.stringify(items), JSON.stringify(roomStatus), status, row.id));
        (await audit(user, 'arrival.updated', row.id));
        result = { ok: true };
    }
    else if (p === '/api/maintenance') {
        roles(user, 'admin', 'employee');
        (await property(user, b.propertyId, 'operate'));
        if (!['Weekly', 'Monthly', 'Quarterly', 'Annual'].includes(b.frequency))
            fail(422, 'Choose a frequency.');
        const key = id();
        (await run('INSERT INTO maintenance_plans VALUES(?,?,?,?,?,?,?)', key, b.propertyId, text(b.title, 'Maintenance title', 200), b.frequency, date(b.nextDue), 1, now()));
        (await audit(user, 'maintenance.created', key));
        result = { id: key };
    }
    else if (p === '/api/maintenance/generate') {
        roles(user, 'admin', 'employee');
        const row = (await entity(user, 'maintenance_plans', b.id, 'operate'));
        result = (await transaction(async () => { const existing = (await get('SELECT * FROM maintenance_occurrences WHERE plan_id=? AND due_date=?', row.id, row.next_due)); if (existing)
            return { id: existing.work_order_id }; const key = id(); (await run('INSERT INTO work_orders(id,property_id,title,due_date,created_by,created_at) VALUES(?,?,?,?,?,?)', key, row.property_id, row.title, row.next_due, user.id, now())); (await run('INSERT INTO maintenance_occurrences VALUES(?,?,?,?)', id(), row.id, row.next_due, key)); (await audit(user, 'maintenance.scheduled', key)); return { id: key }; }));
    }
    else if (p === '/api/maintenance/run-due') {
        roles(user, 'admin', 'employee');
        const until = date(b.until || new Date().toISOString().slice(0, 10));
        const plans = (await filterAsync((await all("SELECT * FROM maintenance_plans WHERE active=1 AND next_due<=?", until)), async (plan) => { try {
            (await property(user, plan.property_id, 'operate'));
            return true;
        }
        catch {
            return false;
        } }));
        const generated = [];
        (await transaction(async () => { for (const plan of plans) {
            const due = plan.next_due;
            const existing = (await get('SELECT * FROM maintenance_occurrences WHERE plan_id=? AND due_date=?', plan.id, due));
            let workId = existing?.work_order_id;
            if (!workId) {
                workId = id();
                (await run('INSERT INTO work_orders(id,property_id,title,due_date,created_by,created_at) VALUES(?,?,?,?,?,?)', workId, plan.property_id, plan.title, due, user.id, now()));
                (await run('INSERT INTO maintenance_occurrences VALUES(?,?,?,?)', id(), plan.id, due, workId));
                (await audit(user, 'maintenance.scheduled', workId));
                generated.push(workId);
            }
            const following = nextDue(due, plan.frequency);
            (await run('UPDATE maintenance_plans SET next_due=? WHERE id=? AND next_due=?', following, plan.id, due));
        } }));
        result = { until, generatedCount: generated.length, workOrderIds: generated };
    }
    else if (p === '/api/invoices') {
        roles(user, 'admin');
        if (!(await get('SELECT 1 FROM clients WHERE id=? AND organization_id=?', b.clientId, user.organization_id)))
            fail(422, 'Choose a family.');
        if (!Number.isSafeInteger(b.amountMinor) || b.amountMinor <= 0)
            fail(422, 'Amount must be greater than zero.');
        const key = id();
        (await run('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?)', key, user.organization_id, b.clientId, text(b.number, 'Invoice number', 80), text(b.description, 'Description', 1000), b.amountMinor, date(b.dueDate), 'USD', now()));
        (await audit(user, 'invoice.created', key));
        result = { id: key };
    }
    else if (p === '/api/payments') {
        roles(user, 'admin');
        result = (await transaction(async () => { const invoice = (await get('SELECT * FROM invoices WHERE id=? AND organization_id=?', b.invoiceId, user.organization_id)); if (!invoice)
            fail(404, 'Invoice not found.'); const paid = (await get('SELECT COALESCE(SUM(amount_minor),0) paid FROM payments WHERE invoice_id=?', invoice.id)).paid; if (!Number.isSafeInteger(b.amountMinor) || b.amountMinor <= 0 || b.amountMinor > invoice.amount_minor - paid)
            fail(422, 'Payment exceeds the outstanding balance or is invalid.'); const key = id(); (await run('INSERT INTO payments VALUES(?,?,?,?,?,?)', key, invoice.id, b.amountMinor, note(b.reference, 200), user.id, now())); (await audit(user, 'payment.recorded', key)); return { id: key }; }));
    }
    else if (p === '/api/notes') {
        roles(user, 'admin', 'employee');
        (await property(user, b.propertyId, 'operate'));
        const key = id();
        (await run('INSERT INTO notes VALUES(?,?,?,?,?)', key, b.propertyId, text(b.body, 'Note'), user.id, now()));
        (await audit(user, 'note.created', key));
        result = { id: key };
    }
    else if (p === '/api/notifications/read') {
        (await run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', now(), b.id, user.id));
        result = { ok: true };
    }
    else
        fail(404, 'Endpoint not found.');
    return json(res, 201, result);
}
function validateAnswers(answers) { if (!Array.isArray(answers) || answers.length !== template.length)
    fail(422, 'Checklist does not match the template.'); return template.map(t => { const a = answers.find(x => x.key === t.key); if (!a || !['unchecked', 'pass', 'monitor', 'attention', 'na'].includes(a.status))
    fail(422, 'Invalid inspection result.'); return { ...t, status: a.status, note: note(a.note) }; }); }
const server = http.createServer(async (req, res) => {
    try {
        const host = req.headers.host || '';
        const url = new URL(req.url, 'http://' + host);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        const localHost = process.env.ESTATEOS_HOST || '127.0.0.1';
        if (localHost === '127.0.0.1' && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
            fail(403, 'Invalid host.');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const origin = req.headers.origin;
            if (!origin || new URL(origin).host !== host)
                fail(403, 'Same-origin request required.');
            if (!String(req.headers['content-type'] || '').startsWith('application/json'))
                fail(415, 'JSON content required.');
        }
        if (url.pathname.startsWith('/api/'))
            return await api(req, res, url, (await actor(req)));
        if (['/waterfront.mp4', '/waterfront.jpg'].includes(url.pathname)) {
            const mediaPath = path.join(root, 'public', url.pathname.slice(1));
            const size = fs.statSync(mediaPath).size;
            res.writeHead(200, {'Content-Type': url.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Content-Length': size, 'Cache-Control': 'public, max-age=86400'});
            if (req.method === 'HEAD') return res.end();
            return fs.createReadStream(mediaPath).pipe(res);
        }
        const names = { '/': 'live.html', '/live.js': 'live.js', '/live.css': 'live.css' };
        const file = names[url.pathname];
        if (!file)
            fail(404, 'Page not found.');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://nominatim.openstreetmap.org https://photon.komoot.io; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' });
        fs.createReadStream(path.join(root, 'public', file)).pipe(res);
    }
    catch (error) {
        if (res.headersSent) {
            res.end();
            return;
        }
        const status = error.status || 500;
        if (status === 500)
            console.error('Request failed:', error.message);
        json(res, status, { error: status === 500 ? 'The action could not be saved. Check the server log.' : error.message });
    }
});
const port = Number(process.env.PORT || 4317), host = process.env.ESTATEOS_HOST || '127.0.0.1';
if (host !== '127.0.0.1' && (!process.env.ESTATEOS_SETUP_KEY || process.env.ESTATEOS_SETUP_KEY.length < 24 || process.env.ESTATEOS_SECURE_COOKIES !== '1'))
    throw Error('Nonlocal hosting requires a strong setup key, HTTPS termination and secure cookies. Complete the production deployment review first.');
server.listen(port, host, () => console.log(`EstateOS running at http://${host}:${server.address().port}`));
process.on('SIGTERM', () => server.close(async () => { await db.close(); process.exit(0); }));
