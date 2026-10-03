// Audit batch 5: work order "Export CSV", "Remind client" and "Assign all" (Staff schedules), plus the CSV helpers.
// Server scenarios run on SQLite and on Postgres (PGlite): permissions, company isolation, CSV-injection escaping,
// the once-per-24h reminder limit, single summary notifications and audit entries.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {csvCell,csvRow,readableDay,readableStamp,statusLabel,exportCsv,remindWait,EXPORT_HEAD,REMIND_EVERY_MS} from '../work-extras.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});

test('CSV helpers: formula cells neutralised, quotes doubled, readable dates in the residence time zone',()=>{
 for(const [raw,want] of [['=HYPERLINK("http://x")',`"'=HYPERLINK(""http://x"")"`],['+1 555',`"'+1 555"`],['-2+3',`"'-2+3"`],['@SUM(A1)',`"'@SUM(A1)"`],['\tTab',`"'\tTab"`],['Plain',`"Plain"`],['a=b',`"a=b"`],[null,'""'],[3,'"3"']])assert.equal(csvCell(raw),want,String(raw));
 assert.equal(csvRow(['a','say "hi"']),'"a","say ""hi"""');
 assert.equal(readableDay('2026-10-05'),'Mon, Oct 5, 2026');assert.equal(readableDay(''),'');assert.equal(readableDay('nope'),'');
 assert.equal(readableStamp('2026-10-03T18:15:00Z','America/New_York'),'Oct 3, 2026, 2:15 PM EDT');
 assert.equal(readableStamp('2026-10-03T18:15:00Z','America/Chicago'),'Oct 3, 2026, 1:15 PM CDT');
 assert.equal(readableStamp('2026-10-03T18:15:00Z','Not/AZone'),'Oct 3, 2026, 2:15 PM EDT','a bad zone falls back to Eastern');
 assert.equal(readableStamp(null,'America/New_York'),'');
 assert.equal(statusLabel({status:'open'},true),'Waiting on client');assert.equal(statusLabel({status:'submitted'},true),'Ready to check');assert.equal(statusLabel({status:'in_progress'},false),'In progress');assert.equal(statusLabel({status:'completed'},true),'Completed');
 const csv=exportCsv([{title:'=cmd|calc',property_name:'Ocean House',status:'open',approval_pending:false,priority:'High',staff_name:'',vendor_name:'',due_date:'',created_at:'2026-10-03T18:15:00Z',timezone:'America/New_York',completed_at:null}]);
 const lines=csv.trim().split('\r\n');assert.equal(lines[0],csvRow(EXPORT_HEAD));
 assert.equal(lines[1],`"'=cmd|calc","Ocean House","Open","High","Unassigned","No due date","Oct 3, 2026, 2:15 PM EDT",""`);
 assert.equal(REMIND_EVERY_MS,86400000);
 const sentAt='2026-10-03T12:00:00.000Z',t=Date.parse(sentAt);
 assert.equal(remindWait(sentAt,t+23*3600000),3600000,'23 h later: one more hour to wait');
 assert.equal(remindWait(sentAt,t+24*3600000),0,'24 h later: allowed');assert.equal(remindWait(sentAt,t+25*3600000),0);assert.equal(remindWait(null,t),0,'never reminded');
});

function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',RESEND_API_KEY:'',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,text,headers:res.headers};},
 async req(endpoint,b,expected=200){const r=await c.call(b===undefined?'GET':'POST',endpoint,b);assert.equal(r.status,expected,`${endpoint}: ${r.text.slice(0,300)}`);return r.body;}};return c;}

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-b5-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),leo=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Coastal Care '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const lee=await admin.req('clients',{name:'Lee family'},201);
  const ocean=await admin.req('properties',{clientId:lee.id,name:'Ocean House',streetAddress:'1 Ocean Rd',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const leoU=(await accept(leo,'employee','leo@example.test','Leo Tech')).user;
  await accept(family,'client','lee@example.test','Ana Lee',{clientId:lee.id});
  const acme=await admin.req('vendors',{name:'Acme Roofing'},201);await accept(vendor,'vendor','vendor@example.test','Vic Vendor',{vendorId:acme.id});
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);
  const job=(title,extra={})=>admin.req('work',{propertyId:ocean.id,title,dueDate:'2026-10-05',...extra},201).then(r=>r.id);
  const gate=await job('=HYPERLINK("http://evil")',{priority:'High'}),pump=await job('+Pump service'),roof=await job('-Roof check',{vendorId:acme.id}),pool=await job('@Pool heater',{dueDate:''});
  const notes=async c=>(await c.req('notifications')).notifications;
  const auditOf=async action=>(await admin.req('data')).audit.filter(a=>a.action===action);

  // ---- Export CSV: admins only, company-scoped, board order kept, formulas neutralised.
  await admin.req('operations/approval',{workId:gate,amountMinor:125000,description:'Replace gate motor'});
  const rivalProp=await (async()=>{const c=await outsider.req('clients',{name:'Rival family'},201);return outsider.req('properties',{clientId:c.id,name:'Rival House',streetAddress:'9 Rival Rd',city:'Naples',state:'FL',postalCode:'34102',country:'United States'},201);})();
  const rivalJob=(await outsider.req('work',{propertyId:rivalProp.id,title:'Rival secret job'},201)).id;
  const exp=await admin.call('POST','work-orders/export',{ids:[pool,gate,rivalJob,roof],view:'open'});
  assert.equal(exp.status,200,exp.text);assert.match(exp.headers.get('content-type'),/^text\/csv/);
  assert.match(exp.headers.get('content-disposition'),/^attachment; filename="Work-orders-open-\d{4}-\d{2}-\d{2}\.csv"$/);
  const rows=exp.text.replace(/^\ufeff/,'').trim().split('\r\n');
  assert.equal(rows[0],'"Title","Residence","Status","Priority","Assigned to","Due","Created","Completed"');
  assert.equal(rows.length,4,'the other company’s job is dropped');assert.ok(!exp.text.includes('Rival'),'nothing from another company');
  assert.ok(rows[1].startsWith(`"'@Pool heater","Ocean House","Open","Normal","Unassigned","No due date","`),rows[1]);
  assert.ok(rows[2].startsWith(`"'=HYPERLINK(""http://evil"")","Ocean House","Waiting on client","High","Unassigned","Mon, Oct 5, 2026","`),rows[2]);
  assert.match(rows[2],/"[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M E[DS]T",""$/,'created in the residence time zone, not completed');
  assert.ok(rows[3].startsWith(`"'-Roof check","Ocean House","Open","Normal","Acme Roofing","Mon, Oct 5, 2026"`),rows[3]);
  assert.equal((await auditOf('work.exported')).length,1,'export is audit-logged');
  for(const c of [leo,vendor,family])assert.equal((await c.call('POST','work-orders/export',{ids:[gate]})).status,403,'only admins export');
  assert.equal((await outsider.call('POST','work-orders/export',{ids:[gate,pump]})).status,422,'another company gets nothing');
  assert.equal((await admin.call('POST','work-orders/export',{ids:'all'})).status,422);
  assert.equal((await admin.call('POST','work-orders/export',{ids:Array(5001).fill('x')})).status,422);
  assert.equal((await admin.call('GET','work-orders/export')).status,405);

  // ---- Remind client: staff/admin only, only while waiting on approval, once per work order per 24 h.
  await admin.req('staff/assign',{workId:gate,staffId:leoU.id});
  for(const c of [vendor,family])assert.equal((await c.call('POST','work-orders/remind',{workId:gate})).status,403);
  assert.equal((await outsider.call('POST','work-orders/remind',{workId:gate})).status,404,'another company cannot see it');
  assert.equal((await admin.call('POST','work-orders/remind',{workId:pump})).status,409,'no approval waiting');
  const before=(await notes(family)).length;
  const sent=await leo.req('work-orders/remind',{workId:gate});assert.equal(sent.recipients,1);assert.ok(sent.remindedAt);
  const fam=await notes(family);assert.equal(fam.length,before+1,'one in-app notification');
  const approval=(await admin.req('operations')).approvals.find(a=>a.work_order_id===gate);
  assert.equal(fam[0].title,'Reminder: your approval is needed for =HYPERLINK("http://evil")');assert.equal(fam[0].entity_id,approval.id,'the notification opens the approval');
  assert.equal(approval.reminded_at,sent.remindedAt,'staff see when the family was reminded');
  assert.equal((await family.req('operations')).approvals.find(a=>a.work_order_id===gate).reminded_at,null,'families do not');
  assert.ok((await admin.req('operations')).email.some(e=>e.email==='lee@example.test'&&e.subject.startsWith('Reminder: your approval is needed')),'queued on the normal email outbox (no Resend key: stays pending)');
  const again=await admin.call('POST','work-orders/remind',{workId:gate});assert.equal(again.status,429,'rate limited for everyone on this work order');
  assert.equal(again.body.remindedAt,sent.remindedAt);assert.ok(Date.parse(again.body.nextAt)-Date.parse(sent.remindedAt)===REMIND_EVERY_MS);
  assert.equal((await notes(family)).length,before+1,'no second notification');
  assert.equal((await auditOf('approval.reminder_sent')).length,1,'audit-logged once');
  await family.req('operations/approval-decision',{id:approval.id,decision:'approved',version:approval.version});
  assert.equal((await admin.call('POST','work-orders/remind',{workId:gate})).status,409,'nothing to remind once decided');

  // ---- Assign all: admins only, one summary notification, already-assigned jobs skipped.
  const a1=await job('Clean gutters'),a2=await job('Check generator');
  for(const c of [leo,vendor,family])assert.ok([403].includes((await c.call('POST','staff/assign-all',{workIds:[a1],staffId:leoU.id})).status));
  assert.equal((await admin.call('POST','staff/assign-all',{workIds:[a1],staffId:leoU.id,vendorId:acme.id})).status,422,'one assignee');
  assert.equal((await admin.call('POST','staff/assign-all',{workIds:[],staffId:leoU.id})).status,422);
  assert.equal((await admin.call('POST','staff/assign-all',{workIds:[rivalJob],staffId:leoU.id})).status,404,'other company jobs are not found');
  const leoBefore=(await notes(leo)).length,adminBefore=(await notes(admin)).length;
  const bulk=await admin.req('staff/assign-all',{workIds:[a1,a2,roof],staffId:leoU.id});
  assert.deepEqual(bulk,{assigned:2,skipped:1,assignee:'Leo Tech'},'the vendor job keeps its vendor');
  const leoNotes=await notes(leo);assert.equal(leoNotes.length,leoBefore+1,'one notification, not one per job');assert.equal(leoNotes[0].title,'2 work orders assigned to you');
  assert.equal((await notes(admin)).length,adminBefore,'the admin is not notified about their own bulk assignment');
  const work=(await admin.req('data')).work;for(const k of [a1,a2])assert.equal(work.find(w=>w.id===k).staff_id,leoU.id);assert.equal(work.find(w=>w.id===roof).vendor_id,acme.id);
  assert.equal((await auditOf('work.bulk_assigned')).length,1);assert.ok((await auditOf('work.assignment_updated')).some(a=>a.entity_id===a1));
  assert.equal((await admin.call('POST','staff/assign-all',{workIds:[a1,a2],staffId:leoU.id})).status,409,'nothing left to assign');
  const v1=await job('Patch soffit'),vBefore=(await notes(vendor)).length;
  assert.equal((await admin.req('staff/assign-all',{workIds:[v1],vendorId:acme.id})).assigned,1);
  const vNotes=await notes(vendor);assert.equal(vNotes.length,vBefore+1);assert.equal(vNotes[0].title,'Work order assigned: Patch soffit');
  assert.ok(!/Request failed/.test(srv.log),srv.log);
 }finally{await srv.stop();}
}
test('batch 5 extras on SQLite',()=>scenario('SQLite',{}));
test('batch 5 extras on Postgres (PGlite)',()=>scenario('PG',{pg:true}));
