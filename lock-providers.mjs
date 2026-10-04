// Smart-lock providers. Every residence lock is either "manual" (the office programs the code on the lock by hand; the
// app keeps the code, shows it only inside the access window and reminds someone to remove it) or a lock reached
// through Seam (https://docs.seam.co), a unified API for time-bound access codes across many lock brands.
//
// The Seam client turns on only when SEAM_API_KEY is set (and SEAM_WEBHOOK_SECRET for lock events). Without them the
// app runs in manual mode. The fake provider is for tests and local demos only and is never available on Render.
import {randomInt} from 'node:crypto';
import {verifySvix, svixSign} from './integration-core.mjs';

export const SEAM_BASE = 'https://connect.getseam.com';
export function generateCode(length = 6) { const n = Math.max(4, Math.min(8, Math.round(Number(length) || 6))); let code = ''; for (let i = 0; i < n; i++) code += randomInt(0, 10); return /^(\d)\1+$/.test(code) ? generateCode(n) : code; }

/** Normalized lock event from a Seam webhook payload (the event object itself is the body). */
export function normalizeSeamEvent(e) {
 if (!e || typeof e !== 'object' || typeof e.event_type !== 'string') return null;
 const t = e.event_type, base = {providerEventId: String(e.event_id || ''), deviceId: e.device_id ? String(e.device_id) : null, occurredAt: e.occurred_at || e.created_at || new Date().toISOString(), raw: e};
 if (t === 'lock.unlocked') return {...base, kind: 'unlocked', method: e.method || 'unknown', providerCodeId: e.access_code_id || null};
 if (t === 'lock.locked') return {...base, kind: 'locked', method: e.method || 'unknown', providerCodeId: e.access_code_id || null};
 if (t === 'lock.access_denied') return {...base, kind: 'access_denied', providerCodeId: e.access_code_id || null};
 if (t === 'device.low_battery') return {...base, kind: 'low_battery', battery: typeof e.battery_level === 'number' ? e.battery_level : null};
 if (t === 'device.battery_status_changed') return {...base, kind: ['low', 'critical'].includes(e.battery_status) ? 'low_battery' : 'battery_ok', battery: typeof e.battery_level === 'number' ? e.battery_level : null};
 if (t === 'device.disconnected' || t === 'device.connection_became_flaky') return {...base, kind: 'offline'};
 if (t === 'device.connected' || t === 'device.connection_stabilized') return {...base, kind: 'online'};
 if (t.startsWith('access_code.')) return {...base, kind: 'code_status', providerCodeId: e.access_code_id || null, status: t.slice('access_code.'.length), code: typeof e.code === 'string' ? e.code : null};
 if (t === 'connected_account.connected') return {...base, kind: 'account_connected', connectedAccountId: e.connected_account_id || null, metadata: e.connected_account_custom_metadata || {}};
 return {...base, kind: 'other'};
}

/** Seam API client (POST with JSON for every endpoint, as the official SDKs do). */
export function createSeamProvider({apiKey, webhookSecret, fetcher = fetch, base = SEAM_BASE}) {
 async function call(path, payload) {
  const res = await fetcher(base + path, {method: 'POST', headers: {Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'EstateAegis'}, body: JSON.stringify(payload || {})});
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(Error(data?.error?.message || `Lock service error (${res.status}).`), {status: 502, providerStatus: res.status, providerType: data?.error?.type || ''});
  return data;
 }
 const device = d => ({deviceId: d.device_id, name: d.display_name || d.properties?.name || d.device_type || 'Lock', model: d.properties?.model?.display_name || d.device_type || '', battery: typeof d.properties?.battery_level === 'number' ? d.properties.battery_level : null, online: d.properties?.online !== false, connectedAccountId: d.connected_account_id || null, canProgramCodes: d.can_program_online_access_codes !== false});
 return {
  kind: 'seam', live: true, label: 'Seam',
  async createCode({deviceId, name, code, startsAt, endsAt}) {
   const payload = {device_id: deviceId, name, starts_at: startsAt, ends_at: endsAt, attempt_for_offline_device: true};
   let out;
   try { out = await call('/access_codes/create', {...payload, code}); }
   catch (error) { if (!code || error.providerStatus !== 400) throw error; out = await call('/access_codes/create', {...payload, preferred_code_length: String(code).length}); }
   const a = out.access_code || {};
   return {providerCodeId: a.access_code_id, code: a.code || null, status: a.status || 'setting'};
  },
  async updateCode({providerCodeId, startsAt, endsAt}) { const out = await call('/access_codes/update', {access_code_id: providerCodeId, starts_at: startsAt, ends_at: endsAt}); return {ok: true, raw: out}; },
  async deleteCode({providerCodeId}) { try { await call('/access_codes/delete', {access_code_id: providerCodeId}); } catch (error) { if (error.providerStatus !== 404) throw error; } return {ok: true}; },
  async getCode({providerCodeId}) { const out = await call('/access_codes/get', {access_code_id: providerCodeId}); return {code: out.access_code?.code || null, status: out.access_code?.status || ''}; },
  async listDevices({connectedAccountIds = [], deviceIds} = {}) {
   if (!connectedAccountIds.length) return [];
   const out = await call('/devices/list', {connected_account_ids: connectedAccountIds, ...(deviceIds ? {device_ids: deviceIds} : {})});
   return (out.devices || []).filter(d => connectedAccountIds.includes(d.connected_account_id)).map(device);
  },
  async createConnectWebview({organizationId, redirectUrl}) { const out = await call('/connect_webviews/create', {provider_category: 'stable', custom_metadata: {ea_org: organizationId}, ...(redirectUrl ? {custom_redirect_url: redirectUrl} : {})}); const w = out.connect_webview || {}; return {webviewId: w.connect_webview_id, url: w.url, status: w.status}; },
  async getConnectWebview({webviewId}) { const out = await call('/connect_webviews/get', {connect_webview_id: webviewId}); const w = out.connect_webview || {}; return {status: w.status, connectedAccountId: w.connected_account_id || null, metadata: w.custom_metadata || {}}; },
  verifyWebhook({headers, body}) { if (!webhookSecret) throw Object.assign(Error('Lock events are not configured.'), {status: 503}); return verifySvix({headers, body, secret: webhookSecret}); },
  normalize: normalizeSeamEvent
 };
}

/** Manual mode: nothing to call; the office programs codes by hand. */
export function createManualProvider() {
 return {kind: 'manual', live: false, label: 'Manual', async createCode() { return null; }, async updateCode() { return null; }, async deleteCode() { return null; }, async listDevices() { return []; }, verifyWebhook() { throw Object.assign(Error('Lock events are not configured.'), {status: 503}); }, normalize: normalizeSeamEvent};
}

/**
 * Fake provider for tests and local demos: behaves like Seam (same event format and Svix signatures) and records every
 * call. Devices are any id starting with "fake-"; a device id containing "reject" refuses new codes.
 */
export function createFakeProvider({webhookSecret = 'whsec_' + Buffer.from('estateaegis-fake-lock-secret').toString('base64')} = {}) {
 const calls = [], codes = new Map(); let n = 0;
 return {
  kind: 'fake', live: true, label: 'Test lock service', calls, codes, webhookSecret,
  async createCode({deviceId, name, code, startsAt, endsAt}) { calls.push(['create', deviceId, startsAt, endsAt]); if (String(deviceId).includes('reject')) throw Object.assign(Error('The lock refused the code.'), {status: 502}); const providerCodeId = 'fake-code-' + (++n); codes.set(providerCodeId, {deviceId, name, code, startsAt, endsAt}); return {providerCodeId, code, status: 'setting'}; },
  async updateCode({providerCodeId, startsAt, endsAt}) { calls.push(['update', providerCodeId, startsAt, endsAt]); const c = codes.get(providerCodeId); if (c) Object.assign(c, {startsAt, endsAt}); return {ok: true}; },
  async deleteCode({providerCodeId}) { calls.push(['delete', providerCodeId]); codes.delete(providerCodeId); return {ok: true}; },
  async getCode({providerCodeId}) { return {code: codes.get(providerCodeId)?.code || null, status: 'set'}; },
  async listDevices({connectedAccountIds = []} = {}) { return connectedAccountIds.length ? [{deviceId: 'fake-front-door', name: 'Front door keypad', model: 'Test deadbolt', battery: 0.82, online: true, connectedAccountId: connectedAccountIds[0], canProgramCodes: true}, {deviceId: 'fake-garage', name: 'Garage entry', model: 'Test lever lock', battery: 0.64, online: true, connectedAccountId: connectedAccountIds[0], canProgramCodes: true}] : []; },
  async createConnectWebview({organizationId}) { return {webviewId: 'fake-webview-' + organizationId, url: '/login#fake-lock-connect', status: 'pending'}; },
  async getConnectWebview({webviewId}) { return {status: 'authorized', connectedAccountId: 'fake-account-' + String(webviewId).slice(-8), metadata: {}}; },
  verifyWebhook({headers, body}) { return verifySvix({headers, body, secret: webhookSecret}); },
  sign(body, {id = 'msg_' + Date.now(), timestamp = Math.floor(Date.now() / 1000)} = {}) { return {'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': svixSign({id, timestamp, body, secret: webhookSecret})}; },
  normalize: normalizeSeamEvent
 };
}

/** Which provider this server uses: Seam when configured, the fake only in tests/local demos, otherwise manual. */
export function lockProvider(env = process.env, {fetcher} = {}) {
 if (env.SEAM_API_KEY) return createSeamProvider({apiKey: env.SEAM_API_KEY, webhookSecret: env.SEAM_WEBHOOK_SECRET || '', fetcher});
 if (env.ESTATEOS_FAKE_LOCKS === '1' && !env.RENDER) return createFakeProvider();
 return createManualProvider();
}
