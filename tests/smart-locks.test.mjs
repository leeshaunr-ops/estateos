// Smart-lock access windows: window math (time zones, DST, overnight, buffer), Svix webhook signatures, the Seam client's
// request shapes, and server scenarios on SQLite and Postgres (PGlite) with the test lock service: permissions (assignee
// only, only in-window, every reveal audited), company isolation, revocation on reassign / cancel / completion, manual
// codes with expiry and a removal reminder, signed lock entries on the visit and in the report PDF, low-battery tasks.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {accessWindow,codePhase,lockClock} from '../smart-locks.mjs';
import {zonedToUtc,wallClock,svixSign,verifySvix,signToken,verifyToken} from '../integration-core.mjs';
import {createSeamProvider,createFakeProvider,lockProvider,normalizeSeamEvent,generateCode} from '../lock-providers.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const builtIn=JSON.parse(readFileSync(path.join(root,'inspection-template.json'),'utf8'));
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const words=pdf=>[...pdf.matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');

test('access window: residence time zone, buffer, schedule hours, overnight and clamping',()=>{
 assert.deepEqual(accessWindow({day:'2026-10-05',tz:'America/New_York'}),{windowStart:'2026-10-05T12:00:00.000Z',windowEnd:'2026-10-05T22:00:00.000Z',startsAt:'2026-10-05T11:30:00.000Z',endsAt:'2026-10-05T22:30:00.000Z'});
 const la=accessWindow({day:'2026-10-05',tz:'America/Los_Angeles',bufferMinutes:0});assert.equal(la.startsAt,'2026-10-05T15:00:00.000Z');assert.equal(la.endsAt,'2026-10-06T01:00:00.000Z');
 assert.equal(accessWindow({day:'2026-07-01',tz:'America/Phoenix',bufferMinutes:0}).startsAt,'2026-07-01T15:00:00.000Z','Arizona has no daylight saving');
 assert.equal(accessWindow({day:'2026-07-01',tz:'Pacific/Honolulu',bufferMinutes:0}).startsAt,'2026-07-01T18:00:00.000Z');
 const sched=accessWindow({day:'2026-10-05',startsAt:'2026-10-05T13:15:00Z',endsAt:'2026-10-05T15:45:00Z',tz:'America/Chicago',bufferMinutes:15});
 assert.deepEqual([sched.startsAt,sched.endsAt],['2026-10-05T13:00:00.000Z','2026-10-05T16:00:00.000Z'],'a linked staff schedule decides the hours');
 assert.equal(accessWindow({day:'2026-10-05',startsAt:'2026-10-05T15:00:00Z',endsAt:'2026-10-05T14:00:00Z',tz:'America/New_York',bufferMinutes:0}).startsAt,'2026-10-05T12:00:00.000Z','a backwards schedule falls back to the day hours');
 const night=accessWindow({day:'2026-10-05',tz:'America/New_York',defaultStart:'22:00',defaultEnd:'06:00',bufferMinutes:0});assert.deepEqual([night.startsAt,night.endsAt],['2026-10-06T02:00:00.000Z','2026-10-06T10:00:00.000Z'],'overnight windows end the next morning');
 assert.equal(accessWindow({day:'2026-10-05',tz:'America/New_York',bufferMinutes:999}).startsAt,'2026-10-05T08:00:00.000Z','buffer is clamped to 4 hours');
 assert.equal(accessWindow({day:'2026-10-05',tz:'America/New_York',bufferMinutes:-30}).startsAt,'2026-10-05T12:00:00.000Z','negative buffer is 0');
 assert.equal(accessWindow({day:'2026-10-05',tz:'Mars/Olympus',bufferMinutes:0}).startsAt,'2026-10-05T12:00:00.000Z','unknown zone: Eastern');
 assert.equal(accessWindow({day:'',tz:'America/New_York'}),null);
});
test('access window across daylight saving changes',()=>{
 // Spring forward (Mar 8, 2026): the morning is already EDT, the day before is EST.
 assert.equal(accessWindow({day:'2026-03-07',tz:'America/New_York',bufferMinutes:0}).startsAt,'2026-03-07T13:00:00.000Z');
 assert.equal(accessWindow({day:'2026-03-08',tz:'America/New_York',bufferMinutes:0}).startsAt,'2026-03-08T12:00:00.000Z');
 const spring=accessWindow({day:'2026-03-07',tz:'America/New_York',defaultStart:'20:00',defaultEnd:'08:00',bufferMinutes:0});
 assert.equal(Date.parse(spring.endsAt)-Date.parse(spring.startsAt),11*3600e3,'an overnight window over the change is 11 real hours');
 assert.equal(zonedToUtc('2026-03-08','02:30','America/New_York'),'2026-03-08T07:30:00.000Z','a wall time that does not exist moves forward (3:30 AM EDT)');
 // Fall back (Nov 1, 2026): 1:30 AM happens twice; the earlier (EDT) one is used.
 assert.equal(zonedToUtc('2026-11-01','01:30','America/New_York'),'2026-11-01T05:30:00.000Z');
 assert.equal(accessWindow({day:'2026-11-01',tz:'America/New_York',bufferMinutes:0}).startsAt,'2026-11-01T13:00:00.000Z');
 const fall=accessWindow({day:'2026-10-31',tz:'America/New_York',defaultStart:'20:00',defaultEnd:'08:00',bufferMinutes:0});
 assert.equal(Date.parse(fall.endsAt)-Date.parse(fall.startsAt),13*3600e3,'and 13 real hours in the fall');
 assert.equal(accessWindow({day:'2026-03-29',tz:'Europe/London',bufferMinutes:0}).startsAt,'2026-03-29T07:00:00.000Z','other countries change on their own dates');
 assert.deepEqual(wallClock('2026-11-01T06:30:00Z','America/New_York'),{day:'2026-11-01',time:'01:30'});
});
test('code phase and generated codes',()=>{
 const c={status:'scheduled',starts_at:'2026-10-05T11:30:00.000Z',ends_at:'2026-10-05T22:30:00.000Z'};
 assert.equal(codePhase(c,Date.parse('2026-10-05T11:29:59Z')),'upcoming');assert.equal(codePhase(c,Date.parse('2026-10-05T11:30:00Z')),'active');
 assert.equal(codePhase(c,Date.parse('2026-10-05T22:30:00Z')),'active');assert.equal(codePhase(c,Date.parse('2026-10-05T22:30:01Z')),'ended');
 assert.equal(codePhase({...c,status:'revoked'},Date.parse('2026-10-05T12:00:00Z')),'ended');
 for(let i=0;i<50;i++){const g=generateCode(6);assert.match(g,/^\d{6}$/);assert.ok(!/^(\d)\1+$/.test(g),'no repeated-digit codes');}
 assert.match(generateCode(4),/^\d{4}$/);
 assert.equal(lockClock({ESTATEOS_LOCK_TEST_NOW_FILE:'/nope',RENDER:'true'}).toString().includes('Date.now'),true,'the test clock never runs on Render');
});
test('Svix webhook signatures (Seam): valid, tampered, stale, missing, rotated secrets',()=>{
 const secret='whsec_'+Buffer.from('a-test-signing-secret-32-bytes!!').toString('base64'),body='{"event_type":"lock.unlocked"}',id='msg_1',ts=1_790_000_000;
 const headers={'svix-id':id,'svix-timestamp':String(ts),'svix-signature':svixSign({id,timestamp:ts,body,secret})};
 assert.doesNotThrow(()=>verifySvix({headers,body,secret,nowSeconds:ts+10}));
 assert.doesNotThrow(()=>verifySvix({headers:{...headers,'svix-signature':'v1,bm9wZQ== '+headers['svix-signature']},body:Buffer.from(body),secret,nowSeconds:ts}),'any listed signature may match');
 const bad=(h,b=body,now=ts)=>assert.throws(()=>verifySvix({headers:h,body:b,secret,nowSeconds:now}),e=>e.status===401);
 bad(headers,body.replace('unlocked','locked'));bad(headers,body,ts+301);bad(headers,body,ts-301);
 bad({...headers,'svix-signature':undefined});bad({...headers,'svix-id':undefined});bad({...headers,'svix-timestamp':'abc'});
 bad({...headers,'svix-signature':'v1,'+Buffer.alloc(32).toString('base64')});
 assert.throws(()=>verifySvix({headers,body,secret:'whsec_'+Buffer.from('other').toString('base64'),nowSeconds:ts}),e=>e.status===401);
 const t=signToken('k','flight-1');assert.equal(verifyToken('k','flight-1',t),true);assert.equal(verifyToken('k','flight-2',t),false);assert.equal(verifyToken('k','flight-1','x'),false);
});
test('Seam client sends documented requests; providers pick themselves from the environment',async()=>{
 const sent=[];const reply=(status,obj)=>({ok:status<400,status,json:async()=>obj});
 let failCustom=false;
 const fetcher=async(url,opts)=>{const b=JSON.parse(opts.body);sent.push({url,auth:opts.headers.Authorization,method:opts.method,b});
  if(url.endsWith('/access_codes/create')){if(failCustom&&b.code)return reply(400,{error:{type:'invalid_input',message:'code not supported'}});return reply(200,{access_code:{access_code_id:'ac_1',code:b.code||'4321',status:'setting'}});}
  if(url.endsWith('/access_codes/delete'))return reply(404,{error:{type:'access_code_not_found',message:'gone'}});
  if(url.endsWith('/devices/list'))return reply(200,{devices:[{device_id:'d1',display_name:'Front door',connected_account_id:'ca_1',properties:{battery_level:0.5,online:true,model:{display_name:'Deadbolt'}}},{device_id:'d2',connected_account_id:'ca_other',properties:{}}]});
  if(url.endsWith('/connect_webviews/create'))return reply(200,{connect_webview:{connect_webview_id:'cw_1',url:'https://connect.getseam.com/connect_webviews/view?x',status:'pending'}});
  return reply(200,{});};
 const seam=createSeamProvider({apiKey:'seam_test_key',webhookSecret:'',fetcher});
 const made=await seam.createCode({deviceId:'d1',name:'EstateAegis 1',code:'135790',startsAt:'2026-10-05T11:30:00.000Z',endsAt:'2026-10-05T22:30:00.000Z'});
 assert.deepEqual(made,{providerCodeId:'ac_1',code:'135790',status:'setting'});
 assert.equal(sent[0].url,'https://connect.getseam.com/access_codes/create');assert.equal(sent[0].auth,'Bearer seam_test_key');assert.equal(sent[0].method,'POST');
 assert.deepEqual(sent[0].b,{device_id:'d1',name:'EstateAegis 1',starts_at:'2026-10-05T11:30:00.000Z',ends_at:'2026-10-05T22:30:00.000Z',attempt_for_offline_device:true,code:'135790'});
 failCustom=true;const fallback=await seam.createCode({deviceId:'d1',name:'n',code:'135790',startsAt:'a',endsAt:'b'});
 assert.equal(sent.at(-1).b.preferred_code_length,6,'locks that pick their own codes get a preferred length');assert.equal(fallback.code,'4321');
 await seam.updateCode({providerCodeId:'ac_1',startsAt:'s',endsAt:'e'});assert.deepEqual(sent.at(-1).b,{access_code_id:'ac_1',starts_at:'s',ends_at:'e'});
 assert.deepEqual(await seam.deleteCode({providerCodeId:'ac_1'}),{ok:true},'an already-removed code counts as removed');
 const devices=await seam.listDevices({connectedAccountIds:['ca_1']});assert.deepEqual(devices.map(d=>[d.deviceId,d.name,d.model,d.battery]),[['d1','Front door','Deadbolt',0.5]],'only devices from the company\'s own lock accounts');
 assert.deepEqual(await seam.listDevices({connectedAccountIds:[]}),[]);
 const w=await seam.createConnectWebview({organizationId:'org1',redirectUrl:'https://example.test/#/workspace'});assert.equal(w.webviewId,'cw_1');assert.deepEqual(sent.at(-1).b.custom_metadata,{ea_org:'org1'});
 assert.throws(()=>seam.verifyWebhook({headers:{},body:'{}'}),e=>e.status===503,'no secret: lock events are refused');
 assert.equal(lockProvider({SEAM_API_KEY:'k'}).kind,'seam');assert.equal(lockProvider({}).kind,'manual');assert.equal(lockProvider({ESTATEOS_FAKE_LOCKS:'1'}).kind,'fake');assert.equal(lockProvider({ESTATEOS_FAKE_LOCKS:'1',RENDER:'true'}).kind,'manual','never the test service on Render');
 assert.deepEqual(normalizeSeamEvent({event_id:'e',event_type:'lock.unlocked',device_id:'d1',occurred_at:'2026-10-05T14:00:00Z',method:'keycode',access_code_id:'ac_1'}).kind,'unlocked');
 assert.equal(normalizeSeamEvent({event_type:'device.battery_status_changed',battery_status:'critical'}).kind,'low_battery');
 assert.equal(normalizeSeamEvent({event_type:'device.disconnected'}).kind,'offline');assert.equal(normalizeSeamEvent({}),null);
 const fake=createFakeProvider();const body='{"a":1}';assert.doesNotThrow(()=>fake.verifyWebhook({headers:fake.sign(body),body}));
});

function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body};},
 async req(endpoint,b,expected=200){const r=await c.call(b===undefined?'GET':'POST',endpoint,b);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;},
 raw:endpoint=>fetch(srv.base+'/api/'+endpoint,{headers:{Cookie:cookie}})};return c;}

async function scenario(label,pg){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-locks-'));dirs.push(dir);
 const clockFile=path.join(dir,'now.txt'),setNow=iso=>writeFileSync(clockFile,iso);setNow('2026-10-05T15:00:00Z');
 const env={ESTATEOS_DATA_DIR:dir,ESTATEOS_FAKE_LOCKS:'1',ESTATEOS_LOCK_TEST_NOW_FILE:clockFile,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64'),...(pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})};
 delete process.env.DATABASE_URL;
 const srv=server(env);await srv.start();
 const fake=createFakeProvider();
 const hook=async(event,{tamper=false}={})=>{const body=JSON.stringify(event),headers=fake.sign(body);const res=await fetch(srv.base+'/api/webhooks/seam',{method:'POST',headers:{'content-type':'application/json',...headers},body:tamper?body.replace('}',',"x":1}'):body});return res.status;};
 try{
  const admin=client(srv),leo=client(srv),mia=client(srv),family=client(srv),vendor=client(srv),vendor2=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Harborline Home Watch '+label,name:'Jordan Ellis',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Sample family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Seagrass House',streetAddress:'1 Example Rd',city:'Springfield',state:'IL',postalCode:'62701',country:'United States'},201);
  const cabin=await admin.req('properties',{clientId:fam.id,name:'Ridge Cabin',streetAddress:'2 Example Ln',city:'Springfield',state:'IL',postalCode:'62701',country:'United States'},201);
  await admin.req('properties/location',{id:home.id,timezone:'America/Chicago'});await admin.req('properties/location',{id:cabin.id,timezone:'America/Chicago'});
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return (await c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201)).user;};
  const leoU=await accept(leo,'employee','leo@example.test','Leo Field'),miaU=await accept(mia,'employee','mia@example.test','Mia Field');
  await accept(family,'client','fam@example.test','Sam Sample',{clientId:fam.id});
  const v1=await admin.req('vendors',{name:'Test Pool Care'},201),v2=await admin.req('vendors',{name:'Test Electric'},201);
  await accept(vendor,'vendor','pool@example.test','Pat Pool',{vendorId:v1.id});await accept(vendor2,'vendor','elec@example.test','Eli Electric',{vendorId:v2.id});
  await admin.req('access',{userId:leoU.id,propertyId:home.id},201);await admin.req('access',{userId:miaU.id,propertyId:cabin.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);
  const locks=async c=>(await c.req('data')).smartLocks;

  // Only administrators manage locks; the lock service must be connected before linking a device.
  await leo.req('smart-locks/locks',{propertyId:home.id,name:'Front door',provider:'manual'},403);
  await family.req('smart-locks/settings',{bufferMinutes:30,defaultStart:'08:00',defaultEnd:'18:00',codeLength:6},403);
  await admin.req('smart-locks/locks',{propertyId:home.id,name:'Front door keypad',provider:'seam',deviceId:'fake-front-door'},422);
  assert.equal((await admin.req('smart-locks/connect',{})).url.length>0,true);assert.equal((await admin.req('smart-locks/connect/check',{})).accounts,1);
  assert.deepEqual((await admin.req('smart-locks/devices',{})).devices.map(d=>d.deviceId),['fake-front-door','fake-garage']);
  await admin.req('smart-locks/locks',{propertyId:home.id,name:'Front door keypad',provider:'seam',deviceId:'not-in-account'},422);
  const frontId=(await admin.req('smart-locks/locks',{propertyId:home.id,name:'Front door keypad',provider:'seam',deviceId:'fake-front-door'})).id;
  await admin.req('smart-locks/locks',{propertyId:home.id,name:'Again',provider:'seam',deviceId:'fake-front-door'},409);
  const mudId=(await admin.req('smart-locks/locks',{propertyId:cabin.id,name:'Mudroom keypad',provider:'manual'})).id;
  await outsider.req('smart-locks/locks',{propertyId:home.id,name:'Sneaky',provider:'manual'},404);
  await outsider.req('smart-locks/locks/remove',{id:frontId},404);

  // A visit today (residence in Chicago): window 8 AM to 6 PM CDT plus 30 minutes either side, created on the lock.
  const visit=(await leo.req('inspections',{propertyId:home.id,date:'2026-10-05'},201)).id;
  let S=await locks(admin);let code=S.codes.find(c=>c.source_id===visit);
  assert.ok(code,'a code is created for the visit');
  assert.deepEqual([code.status,code.starts_at,code.ends_at,code.phase,code.assignee_name,code.provider],['scheduled','2026-10-05T12:30:00.000Z','2026-10-05T23:30:00.000Z','active','Leo Field','fake']);
  assert.equal(code.code,undefined,'digits are never in /api/data');assert.equal(code.code_sealed,undefined);
  const leoView=(await locks(leo)).codes;assert.deepEqual(leoView.map(c=>[c.source_id,c.mine,c.can_reveal]),[[visit,true,true]]);
  assert.equal(leoView[0].code_hint,undefined,'field staff do not get the hint');
  assert.deepEqual((await locks(mia)).codes,[],'another staff member sees nothing');assert.deepEqual((await locks(vendor)).codes,[]);
  assert.deepEqual((await locks(family)).codes,[]);assert.deepEqual((await locks(family)).locks,[]);
  assert.deepEqual((await locks(outsider)).codes,[]);assert.deepEqual((await locks(outsider)).locks,[]);
  const shown=await leo.req('smart-locks/codes/reveal',{id:code.id});assert.match(shown.code,/^\d{6}$/);
  await mia.req('smart-locks/codes/reveal',{id:code.id},404);await vendor.req('smart-locks/codes/reveal',{id:code.id},404);
  await family.req('smart-locks/codes/reveal',{id:code.id},403);await outsider.req('smart-locks/codes/reveal',{id:code.id},404);
  const audit=(await admin.req('data')).audit.filter(a=>a.action==='lock_code.viewed'&&a.entity_id===code.id);assert.equal(audit.length,1,'every reveal is audited');
  // Before the window it stays hidden from the assignee (admins can always look, audited).
  setNow('2026-10-05T12:00:00Z');assert.equal((await leo.req('smart-locks/codes/reveal',{id:code.id},403)).error.includes('only during'),true);
  assert.equal((await admin.req('smart-locks/codes/reveal',{id:code.id})).code,shown.code);setNow('2026-10-05T15:00:00Z');

  // A vendor job today: only that vendor sees it; reassigning revokes and deletes on the lock, then reissues.
  const job=(await admin.req('work',{propertyId:home.id,title:'Service the pool pump',priority:'Normal',dueDate:'2026-10-05',vendorId:v1.id},201)).id;
  S=await locks(admin);const jobCode=S.codes.find(c=>c.source_id===job);assert.equal(jobCode.assignee_name,'Test Pool Care');
  assert.equal((await locks(vendor)).codes.length,1);await vendor.req('smart-locks/codes/reveal',{id:jobCode.id});await vendor2.req('smart-locks/codes/reveal',{id:jobCode.id},404);await leo.req('smart-locks/codes/reveal',{id:jobCode.id},404);
  await admin.req('staff/assign',{workId:job,vendorId:v2.id});
  S=await locks(admin);assert.equal(S.codes.find(c=>c.id===jobCode.id).status,'revoked');
  const reissued=S.codes.find(c=>c.source_id===job&&c.status==='scheduled');assert.equal(reissued.assignee_name,'Test Electric');
  await vendor.req('smart-locks/codes/reveal',{id:jobCode.id},409);await vendor2.req('smart-locks/codes/reveal',{id:reissued.id});
  // Unassigning revokes too; an administrator's revoke sticks until they create a code again.
  await admin.req('staff/assign',{workId:job,staffId:miaU.id});S=await locks(admin);
  const miaCode=S.codes.find(c=>c.source_id===job&&c.status==='scheduled');assert.equal(miaCode.assignee_name,'Mia Field');
  await admin.req('smart-locks/codes/revoke',{id:miaCode.id});await admin.req('smart-locks/sync',{});
  assert.equal((await locks(admin)).codes.filter(c=>c.source_id===job&&c.status==='scheduled').length,0,'an admin revoke is not undone automatically');
  await leo.req('smart-locks/codes/create',{sourceType:'work_order',sourceId:job},403);
  assert.equal((await admin.req('smart-locks/codes/create',{sourceType:'work_order',sourceId:job})).created,1);
  await outsider.req('smart-locks/codes/create',{sourceType:'work_order',sourceId:job},404);

  // Signed lock entry during the window attaches to the visit; tampering and replays are refused.
  assert.equal(await hook({event_id:'evt_1',event_type:'lock.unlocked',device_id:'fake-front-door',occurred_at:'2026-10-05T14:10:00Z',method:'keycode'},{tamper:true}),401);
  assert.equal((await fetch(srv.base+'/api/webhooks/seam',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401,'unsigned');
  assert.equal(await hook({event_id:'evt_1',event_type:'lock.unlocked',device_id:'fake-front-door',occurred_at:'2026-10-05T14:10:00Z',method:'keycode'}),200);
  assert.equal(await hook({event_id:'evt_1',event_type:'lock.unlocked',device_id:'fake-front-door',occurred_at:'2026-10-05T14:10:00Z',method:'keycode'}),200);
  assert.equal(await hook({event_id:'evt_x',event_type:'lock.unlocked',device_id:'someone-elses-lock',occurred_at:'2026-10-05T14:10:00Z'}),200,'unknown devices are ignored');
  S=await locks(admin);assert.deepEqual(S.entries.map(e=>[e.source_id,e.kind,e.method_label]),[[visit,'unlocked','temporary code']],'one entry, on the visit');
  assert.equal((await locks(leo)).entries.length,1);assert.deepEqual((await locks(outsider)).entries,[]);assert.deepEqual((await locks(family)).entries,[]);
  // Low battery opens one maintenance work order and alerts the office.
  await hook({event_id:'evt_2',event_type:'device.low_battery',device_id:'fake-front-door',occurred_at:'2026-10-05T14:20:00Z',battery_level:0.12});
  await hook({event_id:'evt_3',event_type:'device.low_battery',device_id:'fake-front-door',occurred_at:'2026-10-05T14:25:00Z',battery_level:0.11});
  let data=await admin.req('data');assert.equal(data.work.filter(w=>w.title==='Replace lock batteries: Front door keypad').length,1,'one battery task');
  assert.equal(data.smartLocks.locks.find(l=>l.id===frontId).battery_level,0.11);
  assert.equal(data.smartLocks.codes.filter(c=>c.status==='scheduled'&&c.source_type==='work_order'&&data.work.find(w=>w.id===c.source_id)?.title.startsWith('Replace lock')).length,0,'lock tasks get no door codes');
  // Offline for more than 30 minutes: a task.
  await hook({event_id:'evt_4',event_type:'device.disconnected',device_id:'fake-front-door',occurred_at:'2026-10-05T14:00:00Z'});
  await admin.req('smart-locks/sync',{});assert.ok((await admin.req('data')).work.some(w=>w.title==='Lock offline: Front door keypad'));
  await hook({event_id:'evt_5',event_type:'device.connected',device_id:'fake-front-door',occurred_at:'2026-10-05T14:40:00Z'});
  assert.equal((await locks(admin)).locks.find(l=>l.id===frontId).online,true);

  // Completing the visit revokes its code on the lock; the lock entry shows in the report's Visit verification box.
  const ins=(await leo.req('data')).inspections.find(i=>i.id===visit);
  await leo.req('inspections/save',{id:visit,version:ins.version,answers:builtIn.map(a=>({...a,status:'pass',note:''})),summary:'All clear.',notes:'',internalNotes:''},201);
  const ins2=(await admin.req('data')).inspections.find(i=>i.id===visit);
  await admin.req('inspections/publish',{id:visit,version:ins2.version,idempotencyKey:'pub-'+label},201);
  S=await locks(admin);const done=S.codes.find(c=>c.id===code.id);assert.equal(done.status,'revoked');assert.equal(done.revoked_reason,'completed');
  await leo.req('smart-locks/codes/reveal',{id:code.id},409);
  const pdf=words(Buffer.from(await (await admin.raw('inspections/'+visit+'/pdf')).arrayBuffer()).toString('latin1'));
  assert.ok(pdf.includes('VISIT VERIFICATION'),'the box appears for lock entries\n'+pdf.slice(0,600));
  assert.ok(pdf.includes('Lock entry')&&pdf.includes('Front door keypad unlocked Oct 5, 2026, 9:10 AM CDT'),'lock entry row in the residence time zone\n'+pdf.slice(0,1200));

  // Deleting a visit (cancel) revokes it.
  const later=(await leo.req('inspections',{propertyId:home.id,date:'2026-10-08'},201)).id;
  const laterCode=(await locks(leo)).codes.find(c=>c.source_id===later);assert.equal(laterCode.phase,'upcoming');assert.equal(laterCode.can_reveal,false);
  await leo.req('smart-locks/codes/reveal',{id:laterCode.id},403);
  await leo.req('inspections/delete',{id:later,version:(await leo.req('data')).inspections.find(i=>i.id===later).version},201);
  S=await locks(admin);assert.equal(S.codes.find(c=>c.id===laterCode.id).status,'revoked');

  // Manual lock: the office enters a code; it shows only in-window, expires after, and a removal reminder opens.
  const cabinVisit=(await mia.req('inspections',{propertyId:cabin.id,date:'2026-10-05'},201)).id;
  S=await locks(admin);const manual=S.codes.find(c=>c.source_id===cabinVisit);assert.deepEqual([manual.status,manual.provider,manual.has_code],['needs_code','manual',false]);
  await mia.req('smart-locks/codes/reveal',{id:manual.id},409);
  await mia.req('smart-locks/codes/set',{id:manual.id,code:'4821'},403);
  await admin.req('smart-locks/codes/set',{id:manual.id,code:'12a4'},422);
  await admin.req('smart-locks/codes/set',{id:manual.id,code:'4821',version:manual.version+5},409);
  await admin.req('smart-locks/codes/set',{id:manual.id,code:'4821',version:manual.version});
  assert.equal((await mia.req('smart-locks/codes/reveal',{id:manual.id})).code,'4821');
  assert.equal((await locks(admin)).codes.find(c=>c.id===manual.id).code_hint,'21');
  const gen=await admin.req('smart-locks/codes/set',{id:manual.id,generate:true});assert.match(gen.code,/^\d{6}$/);
  setNow('2026-10-06T05:00:00Z');await admin.req('smart-locks/sync',{});
  S=await locks(admin);const expired=S.codes.find(c=>c.id===manual.id);assert.equal(expired.status,'expired');assert.ok(expired.removal_work_id,'a removal reminder is linked');
  await mia.req('smart-locks/codes/reveal',{id:manual.id},409);
  data=await admin.req('data');const removal=data.work.find(w=>w.id===expired.removal_work_id);
  assert.equal(removal.title,'Remove temporary door code from Mudroom keypad');assert.ok(removal.description.includes('ending in '+gen.code.slice(-2)));assert.ok(!removal.description.includes(gen.code),'the full code is never written into the task');
  // Removing a lock revokes its codes; settings are validated.
  await admin.req('smart-locks/settings',{bufferMinutes:500,defaultStart:'08:00',defaultEnd:'18:00',codeLength:6},422);
  await admin.req('smart-locks/settings',{bufferMinutes:60,defaultStart:'09:00',defaultEnd:'17:00',codeLength:4,autoCreate:true});
  assert.deepEqual(((await locks(admin)).settings),{bufferMinutes:60,defaultStart:'09:00',defaultEnd:'17:00',codeLength:4,autoCreate:true});
  assert.equal((await locks(leo)).settings?.bufferMinutes,60);
  await admin.req('smart-locks/locks/remove',{id:mudId});assert.equal((await locks(admin)).locks.some(l=>l.id===mudId),false);
  assert.equal(srv.log.includes('Smart locks:'),false,'no reconcile errors\n'+srv.log);
 }finally{await srv.stop();}
}
test('smart locks on SQLite',()=>scenario('SQLite',false));
test('smart locks on Postgres (PGlite)',()=>scenario('PG',true));
