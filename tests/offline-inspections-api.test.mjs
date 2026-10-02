import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const jpeg=readFileSync(path.join(root,'tests/fixture.jpg')).toString('base64');
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});

function server(env){
 let proc,base,log='';
 return {
  get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}
 };
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;},
 raw:endpoint=>fetch(srv.base+'/api/'+endpoint,{headers:{Cookie:cookie}})};return c;}

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-offline-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),employee=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Offline Co '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  // Restart as platform owner so a second company can be created for the cross-company checks.
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States',roomProfile:{rooms:[{key:'kitchen',name:'Kitchen'}]}},201);
  const other=await admin.req('properties',{clientId:fam.id,name:'Not assigned',streetAddress:'2 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const accept=async(c,role,email,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email,password:pw},201);};
  const emp=await accept(employee,'employee','tech@example.test');await accept(family,'client','fam@example.test',{clientId:fam.id});
  const v=await admin.req('vendors',{name:'Pool Co'},201);await accept(vendor,'vendor','vendor@example.test',{vendorId:v.id});
  await admin.req('access',{userId:emp.user.id,propertyId:home.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);

  // Offline snapshot: staff only, scoped to residences the user can operate, no access codes / documents.
  await family.req('offline/visits?propertyIds='+home.id,undefined,403);await vendor.req('offline/visits?propertyIds='+home.id,undefined,403);
  const snap=await employee.req('offline/visits?propertyIds='+home.id+','+other.id);
  assert.deepEqual(snap.properties.map(p=>p.id),[home.id],'employee only gets residences they can operate');
  assert.ok(snap.template.length>10);assert.equal(snap.checklist.template_id,null);assert.ok(!JSON.stringify(snap).includes('manual'));
  assert.equal((await outsider.req('offline/visits?propertyIds='+home.id)).properties.length,0,'other companies get nothing');

  // start_inspection with a client UUID + Idempotency-Key: exactly one inspection.
  const visitId=randomUUID(),k1=randomUUID();
  const start={id:visitId,propertyId:home.id,date:'2026-10-02'};
  assert.equal((await employee.req('inspections',start,201,{'Idempotency-Key':k1})).id,visitId);
  const replay=await employee.call('POST','inspections',start,{'Idempotency-Key':k1});assert.equal(replay.status,201);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  assert.equal((await employee.req('inspections',start,201,{'Idempotency-Key':randomUUID()})).existing,true,'same visit ID from the same inspector is the same visit');
  await admin.req('inspections',start,409,{'Idempotency-Key':randomUUID()});
  await employee.req('inspections',{...start,id:'not-a-uuid'},422);
  await employee.req('inspections',start,422,{'Idempotency-Key':'nope'});
  let visits=(await admin.req('data')).inspections.filter(i=>i.id===visitId);assert.equal(visits.length,1);

  // save_draft: replays don't bump the version twice; a reused key with another body is refused.
  const base=visits[0];const answers=[...base.answers.map(a=>({...a,status:'pass',note:a.key==='item-0-0'?'Valve exercised':''})),...['condition','readiness','fixtures'].map((c,n)=>({key:'space-kitchen-'+c,section:'Kitchen',label:['Overall condition','Cleanliness and readiness','Fixtures and equipment'][n],status:'pass',note:'',room_key:'kitchen',room_name:'Kitchen'}))];
  const save={id:visitId,version:1,answers,summary:'',notes:'All good',internalNotes:'Gate code changed'},k2=randomUUID();
  assert.equal((await employee.req('inspections/save',save,201,{'Idempotency-Key':k2})).version,2);
  assert.equal((await employee.req('inspections/save',save,201,{'Idempotency-Key':k2})).version,2,'replayed response, no second write');
  await employee.req('inspections/save',{...save,notes:'different'},422,{'Idempotency-Key':k2});
  await employee.req('inspections/save',{...save,notes:'stale'},409,{'Idempotency-Key':randomUUID()});
  assert.equal((await admin.req('data')).inspections.find(i=>i.id===visitId).version,2);
  await outsider.req('inspections/save',save,404,{'Idempotency-Key':k2});

  // Concurrent duplicates of one key still write once.
  const k3=randomUUID();const both=await Promise.all([1,2].map(()=>employee.call('POST','inspections/save',{...save,version:2,summary:'Quick check'},{'Idempotency-Key':k3})));
  assert.ok(both.some(r=>r.status===201));assert.ok(both.every(r=>[201,425].includes(r.status)),JSON.stringify(both.map(r=>r.status)));
  assert.equal((await admin.req('data')).inspections.find(i=>i.id===visitId).version,3);

  // upload_photo: one file per op even when retried, with captured_at and received_at.
  const k4=randomUUID(),capturedAt='2026-10-02T14:05:00.000Z',photo={propertyId:home.id,inspectionId:visitId,name:'kitchen.jpg',base64:jpeg,capturedAt,clientOpId:k4};
  const f1=await employee.req('files',photo,201,{'Idempotency-Key':k4});
  const f2=await employee.req('files',photo,201,{'Idempotency-Key':k4});assert.equal(f2.id,f1.id);
  assert.equal((await employee.req('files',photo,201,{'Idempotency-Key':randomUUID()})).existing,true,'clientOpId alone also dedupes');
  await employee.req('files',{...photo,clientOpId:'bad'},422);
  await employee.req('files',{...photo,clientOpId:undefined,capturedAt:'not a date',name:'b.jpg'},201);
  let files=(await admin.req('data')).files.filter(f=>f.inspection_id===visitId);
  assert.equal(files.length,2);const stored=files.find(f=>f.id===f1.id);assert.equal(stored.captured_at,capturedAt);assert.ok(stored.received_at);assert.equal(files.find(f=>f.id!==f1.id).captured_at,null);

  // Cross-company isolation of keys: the same key in another company is a different key.
  const rivalFam=await outsider.req('clients',{name:'Rival family'},201);
  const rivalHome=await outsider.req('properties',{clientId:rivalFam.id,name:'Rival home',streetAddress:'9 Main St',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const rivalVisit=await outsider.req('inspections',{id:randomUUID(),propertyId:rivalHome.id,date:'2026-10-02'},201,{'Idempotency-Key':k1});
  assert.notEqual(rivalVisit.id,visitId);
  await outsider.req('offline/inspections/'+visitId,undefined,404);

  // submit: validation, then `submitted`; employees cannot publish; client never sees it.
  await employee.req('inspections/save',{...save,version:3,summary:''},201);
  const noSummary=await employee.call('POST','inspections/submit',{id:visitId,version:4},{'Idempotency-Key':randomUUID()});assert.equal(noSummary.status,422);assert.match(noSummary.body.error,/summary/);
  const naAnswers=answers.map((a,n)=>n===1?{...a,status:'na',note:''}:a);
  await employee.req('inspections/save',{...save,version:4,answers:naAnswers,summary:'Quick check'},201);
  const blocked=await employee.call('POST','inspections/submit',{id:visitId,version:5});assert.equal(blocked.status,422);assert.match(blocked.body.error,/Not applicable/);
  await employee.req('inspections/save',{...save,version:5,answers,summary:'Quick check'},201);
  const k5=randomUUID();const sub=await employee.req('inspections/submit',{id:visitId,version:6,autoPublish:true},201,{'Idempotency-Key':k5});
  assert.equal(sub.status,'submitted','autoPublish is ignored for employees');assert.equal(sub.version,7);
  assert.equal((await employee.req('inspections/submit',{id:visitId,version:6},201)).alreadyCompleted,true);
  await employee.req('inspections/save',{...save,version:7},409);
  await employee.req('files',{...photo,clientOpId:randomUUID()},422);
  await employee.req('inspections/publish',{id:visitId,version:7,idempotencyKey:randomUUID()},403);
  assert.ok(!(await family.req('data')).inspections.some(i=>i.id===visitId),'families never see submitted visits');
  const submitted=(await admin.req('data')).inspections.find(i=>i.id===visitId);assert.equal(submitted.status,'submitted');assert.ok(submitted.submitted_at);
  assert.ok((await admin.req('data')).audit.some(a=>a.action==='inspection.submitted'&&a.entity_id===visitId));
  // Admin can return it to draft and submit again, then publish; the PDF prints the capture time.
  await employee.req('inspections/reopen',{id:visitId,version:7},403);
  await admin.req('inspections/reopen',{id:visitId,version:7},201);
  await admin.req('inspections/submit',{id:visitId,version:8},201);
  const pub=await admin.req('inspections/publish',{id:visitId,version:9,idempotencyKey:randomUUID()},201);assert.equal(pub.published,true);
  const pdf=Buffer.from(await (await admin.raw(`inspections/${visitId}/pdf`)).arrayBuffer()).toString('latin1');
  assert.ok(pdf.includes('Taken Oct 2, 2026, 10:05 AM EDT'),'capture time in the residence timezone');
  assert.ok((await family.req('data')).inspections.some(i=>i.id===visitId&&i.status==='published'));

  // Admin auto-publish on submit.
  const autoId=randomUUID();await admin.req('inspections',{id:autoId,propertyId:home.id,date:'2026-10-03'},201);
  await admin.req('inspections/save',{...save,id:autoId,version:1,summary:'Auto'},201);
  const auto=await admin.req('inspections/submit',{id:autoId,version:2,autoPublish:true},201,{'Idempotency-Key':randomUUID()});
  assert.equal(auto.status,'published');assert.equal(auto.published,true);

  // Conflict resolution is audited.
  const cId=randomUUID();await employee.req('inspections',{id:cId,propertyId:home.id,date:'2026-10-04'},201);
  await employee.req('inspections/save',{...save,id:cId,version:1,conflictResolution:'kept 1 of mine, 0 from server'},201);
  assert.ok((await admin.req('data')).audit.some(a=>a.action==='inspection.conflict_resolved'&&a.entity_id===cId));
  const serverCopy=await employee.req('offline/inspections/'+cId);assert.equal(serverCopy.inspection.version,2);assert.equal(serverCopy.inspection.internal_notes,'Gate code changed');

  // Sensitive responses are never cacheable; the shell assets are.
  const codes=await admin.call('POST','access-codes/read',{propertyId:home.id});assert.equal(codes.headers.get('cache-control'),'no-store');
  assert.equal((await admin.call('GET','offline/visits?propertyIds='+home.id)).headers.get('cache-control'),'no-store');
  const sw=await fetch(srv.base+'/sw.js');const swText=await sw.text();assert.equal(sw.status,200);assert.match(swText,/const VERSION='[0-9a-f]{12}'/);assert.ok(!swText.includes('__SHELL_VERSION__'));
  const manifest=await (await fetch(srv.base+'/manifest.webmanifest')).json();assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/login?source=pwa');
  assert.equal((await fetch(srv.base+'/icon-192.png')).status,200);
 }catch(error){error.message+='\n--- server log ---\n'+srv.log;throw error;}
 finally{await srv.stop();}
}
test('offline inspection API: idempotency, submitted status, photo times, scoping (SQLite)',()=>scenario('sqlite',{}));
test('offline inspection API on Postgres (PGlite) — same migration runner and SQL as Render',()=>scenario('pg',{pg:true}));
