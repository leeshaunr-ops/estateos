import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../database.mjs';
import {createFailAlerts,alertItems,formatWhen,inspectionLink,renderFailAlertEmail,wording} from '../fail-alerts.mjs';
import {createCommunications} from '../communications.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-fail-alerts-'));dirs.push(d);return d;};

// ---------- pure helpers ----------
test('alertItems: failed answers alert only when the matching template item has alert-on-fail',()=>{
 const template=[{stable_key:'sinks',label:'Check under sinks for leaks',alert_on_fail:1},{stable_key:'toilets',label:'Flush every toilet',alert_on_fail:0},{stable_key:'item-0-2',label:'Something else',alert_on_fail:1}];
 const answers=[
  {key:'item-0-4',section:'Water & Plumbing',label:'Check under  sinks for LEAKS.',status:'attention',note:' Drip '},// wording match, alert on
  {key:'item-0-3',label:'Flush every toilet',status:'attention',note:''},// alert off
  {key:'item-0-2',label:'Run showers and tubs',status:'fail',note:''},// key match wins over wording
  {key:'item-0-5',label:'Check under sinks for leaks',status:'monitor',note:''},// not failed
  {key:'item-0-6',label:'Unknown item',status:'attention'}// no template item
 ];
 assert.deepEqual(alertItems(answers,template).map(i=>[i.key,i.note]),[['item-0-4','Drip'],['item-0-2','']]);
 assert.deepEqual(alertItems(answers,[]),[]);
 assert.equal(wording('Run every sink faucet for 2–3 minutes'),'run every sink faucet for 2 3 minutes');
});

test('alert email: residence, inspector, time in the residence timezone, every failed item with notes',()=>{
 assert.equal(formatWhen('2026-10-02T14:05:00.000Z','America/New_York'),'Oct 2, 2026, 10:05 AM EDT');
 assert.equal(formatWhen('2026-10-02T14:05:00.000Z',''),'Oct 2, 2026, 10:05 AM EDT','Eastern when no timezone');
 assert.equal(formatWhen('2026-10-02T14:05:00.000Z','Not/AZone'),'Oct 2, 2026, 10:05 AM EDT','Eastern when the timezone is invalid');
 assert.equal(inspectionLink('abc',{APP_URL:'https://app.example.test/x'}),'https://app.example.test/login?inspection=abc');
 assert.equal(inspectionLink('abc',{APP_URL:'http://insecure.test'}),'https://estateaegis.com/login?inspection=abc');
 const mail=renderFailAlertEmail({company:'Harbor <Co>',property_name:'Ocean House',address:'1 Ocean Dr, Stuart, FL 34994',inspector_name:'Tess Tech',when:'Oct 2, 2026, 10:05 AM EDT',inspection_date:'2026-10-02',summary:'Leak found',link:'https://estateaegis.com/login?inspection=abc',items:[{section:'Water & Plumbing',label:'Check under sinks for leaks',note:'Drip under kitchen sink'},{section:'Exterior',label:'Walk exterior perimeter',note:''}]});
 assert.equal(mail.subject,'Inspection alert: 2 failed items at Ocean House');
 for(const part of ['Ocean House','1 Ocean Dr, Stuart, FL 34994','Tess Tech','Oct 2, 2026, 10:05 AM EDT','Check under sinks for leaks','Drip under kitchen sink','No note added','https://estateaegis.com/login?inspection=abc'])assert.ok(mail.text.includes(part)&&mail.html.includes(part),part);
 assert.ok(mail.html.includes('Harbor &lt;Co&gt;')&&!mail.html.includes('Harbor <Co>'),'HTML is escaped');
 assert.ok(mail.html.includes('#7e202b'));
});

// ---------- email delivery through the existing outbox (Resend) ----------
test('fail alert email is queued once per recipient and sent as HTML through the existing Resend outbox',async()=>{
 const db=await openDatabase(root,{ESTATEOS_DATA_DIR:tmp()});
 try{
  const t='2026-10-02T14:05:00.000Z',ins=(sql,...a)=>db.run(sql,...a);
  await ins('INSERT INTO organizations VALUES(?,?,?)','org','Harbor Co',t);
  await ins('INSERT INTO workspace_settings(organization_id) VALUES(?)','org');
  const user=(id,role,email,extra={})=>ins('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',id,'org',id,email,'x',role,extra.client||null,null,extra.active??1,t);
  await user('admin1','admin','a1@example.test');await user('admin2','admin','a2@example.test');await user('gone','admin','gone@example.test',{active:0});
  await user('mgr','employee','mgr@example.test');await user('tech2','employee','tech2@example.test');
  await ins('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)','fam','org','Family',t);await user('family','client','fam@example.test',{client:'fam'});
  await ins('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,created_at,account_manager_id) VALUES(?,?,?,?,?,?,?,?)','home','org','fam','Ocean House','1 Ocean Dr, Stuart, FL 34994','America/New_York',t,'mgr');
  await ins("INSERT INTO checklist_templates(id,organization_id,name,visit_type,created_at,updated_at) VALUES('tpl','org','Routine','routine',?,?)",t,t);
  await ins("INSERT INTO checklist_template_versions(id,template_id,version,status,created_at) VALUES('v1','tpl',1,'published',?)",t);
  await ins("INSERT INTO checklist_template_items(id,template_version_id,section,label,stable_key,alert_on_fail) VALUES('i1','v1','Water','Check under sinks for leaks','sinks',1)");
  const answers=[{key:'item-0-4',section:'Water & Plumbing',label:'Check under sinks for leaks',status:'attention',note:'Drip under kitchen sink'},{key:'item-0-0',section:'Water & Plumbing',label:'Exercise main water shutoff valve',status:'pass',note:''}];
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at) VALUES('insp','home','tech2','2026-10-02','submitted',?,'Leak found',?)",JSON.stringify(answers),t);
  const logs=[],id=(()=>{let n=0;return()=>'n'+(++n);})(),now=()=>new Date().toISOString();
  const alerts=createFailAlerts({...db,id,now,fail:(s,m)=>{throw Object.assign(Error(m),{status:s});},json(){},body(){}},{env:{APP_URL:'https://app.example.test'},log:m=>logs.push(m)});
  const first=await db.transaction(()=>alerts.inspectionCompleted('insp',{source:'submit',completedAt:t}));
  assert.deepEqual(first,{alerted:true,recipients:3,items:1});
  assert.match(logs[0],/RESEND_API_KEY is not set/,'logs that email is not configured');
  assert.equal((await alerts.inspectionCompleted('insp',{source:'publish'})).duplicate,true,'second completion never alerts again');
  const notes=await db.all("SELECT user_id FROM notifications WHERE kind='inspection_fail' ORDER BY user_id");
  assert.deepEqual(notes.map(n=>n.user_id),['admin1','admin2','mgr'],'all active admins plus the Residence Manager; not other staff, family or suspended admins');
  const queued=await db.all("SELECT * FROM email_outbox ORDER BY email");
  assert.deepEqual(queued.map(r=>r.email),['a1@example.test','a2@example.test','mgr@example.test']);
  const sent=[];const fetcher=async(url,init)=>{sent.push({url,headers:init.headers,body:JSON.parse(init.body)});return {ok:true,json:async()=>({id:'re_'+sent.length})};};
  const comm=createCommunications({...db,id,now,fail(){},text(){},json(){},body(){},rate(){},audit(){}},{env:{RESEND_API_KEY:'re_test',APP_URL:'https://app.example.test'},fetcher});
  await comm.drain();
  assert.equal(sent.length,3);assert.ok(sent.every(s=>s.url==='https://api.resend.com/emails'));
  const mail=sent[0].body;
  assert.equal(mail.subject,'Inspection alert: 1 failed item at Ocean House');
  for(const part of ['Ocean House','1 Ocean Dr, Stuart, FL 34994','tech2','Oct 2, 2026, 10:05 AM EDT','Check under sinks for leaks','Drip under kitchen sink','https://app.example.test/login?inspection=insp'])assert.ok(mail.html.includes(part),part);
  assert.ok(mail.text.includes('Drip under kitchen sink'));
  assert.deepEqual((await db.all('SELECT DISTINCT status FROM email_outbox')).map(r=>r.status),['sent']);
  await comm.drain();assert.equal(sent.length,3,'nothing is sent twice');
  // A visit linked to a template version uses exactly that version, not the company's latest published one.
  await ins("INSERT INTO checklist_template_versions(id,template_id,version,status,created_at) VALUES('v2','tpl',2,'published',?)",t);
  await ins("INSERT INTO checklist_template_items(id,template_version_id,section,label,stable_key,alert_on_fail) VALUES('i2','v2','Water','Check under sinks for leaks','sinks',0)");
  // Linked visits carry the template's own item keys (they are created from the version's items).
  const linkedAnswers=[{key:'sinks',item_key:'sinks',section:'Water',label:'Check under sinks for leaks',response_type:'pass_fail_na',status:'fail',note:'Drip under kitchen sink'}];
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,template_id,template_version) VALUES('linked1','home','mgr','2026-10-02','submitted',?,'x',?,'tpl',1)",JSON.stringify(linkedAnswers),t);
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,template_id,template_version) VALUES('linked2','home','mgr','2026-10-02','submitted',?,'x',?,'tpl',2)",JSON.stringify(linkedAnswers),t);
  // A linked visit never falls back to wording: an answer whose key is not in its version does not alert, even with matching words.
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,template_id,template_version) VALUES('linked3','home','mgr','2026-10-02','submitted',?,'x',?,'tpl',1)",JSON.stringify(answers),t);
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at) VALUES('unlinked','home','mgr','2026-10-02','submitted',?,'x',?)",JSON.stringify(answers),t);
  assert.equal((await alerts.inspectionCompleted('linked1')).alerted,true,'linked to v1, where the item alerts');
  assert.equal((await alerts.inspectionCompleted('linked2')).alerted,false,'linked to v2, where the item does not alert');
  assert.equal((await alerts.inspectionCompleted('linked3')).alerted,false,'linked visits match by item key only (no wording fallback)');
  assert.equal((await alerts.inspectionCompleted('unlinked')).alerted,false,'unlinked visits follow the latest published version (v2)');
  assert.equal((await db.get("SELECT source FROM inspection_fail_alerts WHERE inspection_id='linked1'")).source,'submit');
  assert.equal(JSON.parse((await db.get("SELECT details FROM inspection_fail_alerts WHERE inspection_id='linked1'")).details).source,'linked-template');
 }finally{await db.close();}
});

// ---------- API, SQLite and Postgres ----------
function server(env){
 let proc,base,log='';
 return {
  get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',RESEND_API_KEY:'',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});proc.stdout.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}
 };
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;}};return c;}

async function scenario(label,pg){
 const dir=tmp();
 const dbEnv={ESTATEOS_DATA_DIR:dir,...(pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})};
 const srv=server(dbEnv);
 await srv.start();
 try{
  const admin=client(srv),admin2=client(srv),manager=client(srv),tech=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Alert Co '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const a2=await accept(admin2,'admin','second@example.test','Second Admin');
  const mgr=await accept(manager,'employee','manager@example.test','Mia Manager');
  const other=await accept(tech,'employee','tech@example.test','Other Tech');
  await accept(family,'client','fam@example.test','Family Member',{clientId:fam.id});
  const v=await admin.req('vendors',{name:'Pool Co'},201);await accept(vendor,'vendor','vendor@example.test','Vendor',{vendorId:v.id});
  await admin.req('access',{userId:mgr.user.id,propertyId:home.id},201);// Mia is the Residence Manager
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);

  // Company checklist template: "Check under sinks for leaks" alerts the office, "Flush every toilet" does not.
  const item=(stable_key,section,label,alert_on_fail)=>({stable_key,section,label,help_text:'',response_type:'pass_fail_na',options:[],required:false,photo_rule:'none',scope:'property',room_types:[],alert_on_fail});
  const tpl=await admin.req('checklist-templates',{name:'Routine visit',visit_type:'routine',items:[item('sinks','Water & Plumbing','Check under sinks for leaks',true),item('toilets','Water & Plumbing','Flush every toilet',false),item('perimeter','Exterior','Walk exterior perimeter',true)]},201);
  await admin.req('checklist-templates/'+tpl.id+'/publish',{});
  // An unpublished draft must not count: start a new draft that turns the toilet item on.
  await admin.req('checklist-templates/'+tpl.id+'/items',{items:[item('sinks','Water & Plumbing','Check under sinks for leaks',true),item('toilets','Water & Plumbing','Flush every toilet',true)]});

  const failAlerts=async c=>(await c.req('notifications')).notifications.filter(n=>n.kind==='inspection_fail');
  const visit=async(c,statuses,{summary='Visit complete',date='2026-10-02'}={})=>{
   const visitId=randomUUID();await c.req('inspections',{id:visitId,propertyId:home.id,date},201,{'Idempotency-Key':randomUUID()});
   const row=(await c.req('data')).inspections.find(i=>i.id===visitId);
   const answers=row.answers.map(a=>({...a,status:statuses[a.label]?.[0]||'pass',note:statuses[a.label]?.[1]||''}));
   await c.req('inspections/save',{id:visitId,version:row.version,answers,summary,notes:'',internalNotes:''},201);
   return {id:visitId,version:row.version+1};
  };

  // 1) A failed alert item: one alert to every admin plus the Residence Manager, in-app and email.
  const failing=await visit(manager,{'Check under sinks for leaks':['attention','Drip under kitchen sink'],'Flush every toilet':['attention','Runs constantly'],'Walk exterior perimeter':['monitor','Mulch low']},{summary:'Leak under the kitchen sink'});
  const key=randomUUID();
  const submitted=await manager.req('inspections/submit',{id:failing.id,version:failing.version},201,{'Idempotency-Key':key});
  assert.equal(submitted.status,'submitted');
  for(const c of [admin,admin2,manager]){
   const mine=await failAlerts(c);
   assert.equal(mine.length,1,'exactly one alert each');
   const n=mine[0];assert.equal(n.entity_id,failing.id);assert.equal(n.read_at,null);
   assert.equal(n.title,'Inspection alert: 1 failed item at Ocean House');
   assert.deepEqual(n.alert.items.map(i=>[i.label,i.note]),[['Check under sinks for leaks','Drip under kitchen sink']],'only alert-on-fail items; alert-off and monitor items are left out');
   assert.equal(n.alert.property_name,'Ocean House');assert.equal(n.alert.address,'1 Ocean Dr, Stuart, FL 34994, United States');assert.equal(n.alert.inspector_name,'Mia Manager');assert.match(n.alert.when,/E[DS]T$/);
  }
  for(const c of [tech,family,vendor,outsider])assert.equal((await failAlerts(c)).length,0,'other staff, family, vendor and other companies get nothing');
  assert.ok(!(await family.req('data')).notifications.some(n=>n.kind==='inspection_fail'));

  // 2) Idempotent retries never duplicate: same key replays, a new key sees alreadyCompleted, reopen/resubmit and publish.
  const replay=await manager.call('POST','inspections/submit',{id:failing.id,version:failing.version},{'Idempotency-Key':key});
  assert.equal(replay.status,201);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  assert.equal((await manager.req('inspections/submit',{id:failing.id,version:failing.version},201,{'Idempotency-Key':randomUUID()})).alreadyCompleted,true);
  await admin.req('inspections/reopen',{id:failing.id,version:failing.version+1},201);
  await manager.req('inspections/submit',{id:failing.id,version:failing.version+2},201,{'Idempotency-Key':randomUUID()});
  await admin.req('inspections/publish',{id:failing.id,version:failing.version+3,idempotencyKey:randomUUID()},201);
  for(const c of [admin,admin2,manager])assert.equal((await failAlerts(c)).length,1,'still exactly one alert after retries, resubmit and publish');

  // 3) No alert when nothing failed, or when only alert-off items failed.
  const clean=await visit(manager,{'Walk exterior perimeter':['monitor','Mulch low']});
  await manager.req('inspections/submit',{id:clean.id,version:clean.version},201,{'Idempotency-Key':randomUUID()});
  const alertOff=await visit(manager,{'Flush every toilet':['attention','Runs constantly']});
  await manager.req('inspections/submit',{id:alertOff.id,version:alertOff.version},201,{'Idempotency-Key':randomUUID()});
  for(const c of [admin,admin2,manager])assert.equal((await failAlerts(c)).length,1,'no new alerts');

  // 4) Publishing straight from a draft (admin) also alerts, once, listing every failed alert item.
  const direct=await visit(admin,{'Check under sinks for leaks':['attention','Still dripping'],'Walk exterior perimeter':['attention','']});
  await admin.req('inspections/publish',{id:direct.id,version:direct.version,idempotencyKey:randomUUID()},201);
  const latest=(await failAlerts(admin2)).find(n=>n.entity_id===direct.id);
  assert.deepEqual(latest.alert.items.map(i=>i.label),['Check under sinks for leaks','Walk exterior perimeter']);
  assert.equal(latest.title,'Inspection alert: 2 failed items at Ocean House');
  assert.equal((await failAlerts(manager)).length,2);

  // 5) Notifications are private to their recipient.
  const adminAlert=(await failAlerts(admin))[0];
  await tech.req('notifications/read',{id:adminAlert.id},404);
  await outsider.req('notifications/read',{id:adminAlert.id},404);
  await family.req('notifications/read',{id:adminAlert.id},404);
  await tech.req('notifications/read-all',{});
  assert.equal((await failAlerts(admin)).find(n=>n.id===adminAlert.id).read_at,null,'other accounts cannot mark it read');
  assert.ok(!(await tech.req('data')).notifications.some(n=>n.id===adminAlert.id));
  await admin.req('notifications/read',{id:adminAlert.id});
  assert.ok((await failAlerts(admin)).find(n=>n.id===adminAlert.id).read_at,'the recipient can mark it read');
  assert.equal((await failAlerts(admin2)).filter(n=>!n.read_at).length,2,'reading your copy does not touch anyone else');
  await admin2.req('notifications/read-all',{});
  assert.equal((await admin2.req('notifications')).unread,0);
  await (async()=>{const r=await fetch(srv.base+'/api/notifications');assert.equal(r.status,401);})();
  assert.match(srv.log,/RESEND_API_KEY is not set/);
  await srv.stop();

  // Email: one queued HTML message per recipient per failed inspection (Resend sends it when configured).
  const db=await openDatabase(root,dbEnv);
  try{
   const rows=await db.all("SELECT email,subject,html FROM email_outbox WHERE subject LIKE 'Inspection alert:%' ORDER BY email,subject");
   assert.deepEqual(rows.map(r=>r.email),['manager@example.test','manager@example.test','owner@example.test','owner@example.test','second@example.test','second@example.test']);
   assert.ok(rows.every(r=>r.html.includes('Ocean House')&&r.html.includes('Check under sinks for leaks')));
   assert.equal(Number((await db.get('SELECT COUNT(*) n FROM inspection_fail_alerts')).n),2);
  }finally{await db.close();}
 }catch(error){error.message+='\n--- server log ---\n'+srv.log;throw error;}
 finally{await srv.stop();}
}
test('fail alerts API: admins + Residence Manager, no duplicates, private notifications (SQLite)',()=>scenario('sqlite',false));
test('fail alerts API on Postgres (PGlite) — same migration runner and SQL as Render',()=>scenario('pg',true));
