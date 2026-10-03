// Template pass/fail items answer Pass / Monitor / Fail / N/A. Monitor behaves like the built-in checklist's Monitor:
// accepted everywhere, never alerts the office, never blocks completion, counted in report totals.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import '../public/inspection-checklist.js';
import {templateAnswerPdf,inspectionPdf} from '../pdf.mjs';
import {validateAnswer,starterSets} from '../checklist-templates.mjs';
import * as M from '../public/checklist-editor-model.mjs';
import {alertItems,FAILED_STATUSES} from '../fail-alerts.mjs';
const CK=globalThis.EAChecklist;
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const sandbox={crypto:globalThis.crypto,btoa:globalThis.btoa,console};sandbox.globalThis=sandbox;
vm.createContext(sandbox);vm.runInContext(readFileSync(path.join(root,'public/offline-core.js'),'utf8'),sandbox);
const OC=sandbox.EAOfflineCore;

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

const ITEMS=[
 {section:'Water',label:'Check under sinks for leaks',response_type:'pass_fail_na',required:true,photo_rule:'required_on_fail',alert_on_fail:true},
 {section:'Exterior',label:'Pool equipment running',response_type:'pass_fail_na',required:true,photo_rule:'required_on_fail',alert_on_fail:true},
 {section:'Exterior',label:'Gutters clear',response_type:'pass_fail_na',required:true,photo_rule:'optional'},
 {section:'Security',label:'Alarm armed',response_type:'yes_no',required:true,photo_rule:'none'}
];

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-monitor-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),employee=client(srv),family=client(srv);
  await admin.req('setup',{company:'Monitor Co '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  const fam=await admin.req('clients',{name:'Family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const accept=async(c,role,email,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email,password:pw},201);};
  const emp=await accept(employee,'employee','tech@example.test');await accept(family,'client','fam@example.test',{clientId:fam.id});
  await admin.req('access',{userId:emp.user.id,propertyId:home.id},201);
  const visit=async id=>(await admin.req('data')).inspections.find(i=>i.id===id);
  const alertsFor=async id=>(await admin.req('notifications')).notifications.filter(n=>n.kind==='inspection_fail'&&n.entity_id===id);
  const tid=(await admin.req('checklist-templates',{name:'Weekly home watch',visit_type:'routine',items:ITEMS},201)).id;
  await admin.req('checklist-templates/'+tid+'/publish',{});
  const byLabel=(answers,l)=>answers.find(a=>a.label===l);
  const answer=(answers,values,notes={})=>answers.map(a=>({...a,status:values[a.label]??a.status,note:notes[a.label]??a.note}));

  // ---- an existing visit answered Pass / Fail / N/A (as before Monitor existed) stays exactly as it was.
  const old=await visit((await employee.req('inspections',{propertyId:home.id,date:'2026-09-25',templateId:tid},201)).id);
  const oldAnswers=answer(old.answers,{'Check under sinks for leaks':'pass','Pool equipment running':'pass','Gutters clear':'na','Alarm armed':'yes'},{'Gutters clear':'No gutters on the guest house'});
  await employee.req('inspections/save',{id:old.id,version:old.version,answers:oldAnswers,summary:'All good.',notes:'',internalNotes:''},201);
  await admin.req('inspections/publish',{id:old.id,version:(await visit(old.id)).version,idempotencyKey:randomUUID()},201);
  const oldPublished=await visit(old.id);
  const oldPdf=Buffer.from(await (await admin.raw('inspections/'+old.id+'/pdf')).arrayBuffer()).toString('latin1');
  assert.ok(oldPdf.includes('(Overall condition: Passed)')&&!oldPdf.match(/\(MONITOR\)[^]*\(MONITOR\)/),'old visit: passed, Monitor only as a 0 total');

  // ---- Monitor is accepted on every pass/fail item of the published version (no re-publish, no migration).
  const v=await visit((await employee.req('inspections',{propertyId:home.id,date:'2026-10-02',templateId:tid},201)).id);
  assert.equal(byLabel(v.answers,'Gutters clear').response_type,'pass_fail_na');
  const monitorOnly=answer(v.answers,{'Check under sinks for leaks':'monitor','Pool equipment running':'monitor','Gutters clear':'pass','Alarm armed':'yes'},{'Pool equipment running':'Pump is noisy; watch next visit.'});
  await employee.req('inspections/save',{id:v.id,version:v.version,answers:monitorOnly,summary:'Two items to watch.',notes:'',internalNotes:''},201);
  let saved=await visit(v.id);
  assert.equal(byLabel(saved.answers,'Check under sinks for leaks').status,'monitor');
  // Like the built-in checklist: Monitor needs neither a note nor a photo (even with "photo required on fail"), and does not block completion.
  const submitted=await employee.req('inspections/submit',{id:v.id,version:saved.version},201,{'Idempotency-Key':randomUUID()});
  assert.equal(submitted.status,'submitted');
  assert.deepEqual(await alertsFor(v.id),[],'Monitor never alerts the office, even on alert-on-fail items');
  await admin.req('inspections/publish',{id:v.id,version:(await visit(v.id)).version,idempotencyKey:randomUUID()},201);
  const pdf=Buffer.from(await (await admin.raw('inspections/'+v.id+'/pdf')).arrayBuffer()).toString('latin1');
  for(const part of ['(PASS)','(MONITOR)','(FAIL)','(N/A)','(Overall condition: Monitor)','(Pump is noisy; watch next visit.)'])assert.ok(pdf.includes(part),'PDF has '+part);
  assert.equal(pdf.match(/\(MONITOR\)/g).length,3,'two Monitor pills and the Monitor total');
  const portal=(await family.req('data')).inspections.find(i=>i.id===v.id);
  assert.deepEqual(CK.totals(portal.answers),{pass:1,monitor:2,fail:0,na:0},'family portal totals');

  // ---- Monitor next to a Fail: only the failed item alerts.
  const mixed=await visit((await employee.req('inspections',{propertyId:home.id,date:'2026-10-03',templateId:tid},201)).id);
  const mixedAnswers=answer(mixed.answers,{'Check under sinks for leaks':'fail','Pool equipment running':'monitor','Gutters clear':'pass','Alarm armed':'no'},{'Check under sinks for leaks':'Drip under the kitchen sink'});
  await employee.req('inspections/save',{id:mixed.id,version:mixed.version,answers:mixedAnswers,summary:'Leak found.',notes:'',internalNotes:''},201);
  const blocked=await employee.call('POST','inspections/submit',{id:mixed.id,version:mixed.version+1},{'Idempotency-Key':randomUUID()});
  assert.equal(blocked.status,422);assert.match(blocked.body.error,/Check under sinks for leaks/);assert.doesNotMatch(blocked.body.error,/Pool equipment/,'the photo rule applies to Fail, not Monitor');
  await employee.req('files',{propertyId:home.id,inspectionId:mixed.id,name:'sink.jpg',base64:readFileSync(path.join(root,'tests/fixture.jpg')).toString('base64'),capturedAt:new Date().toISOString(),clientOpId:randomUUID()},201,{'Idempotency-Key':randomUUID()});
  await employee.req('inspections/submit',{id:mixed.id,version:mixed.version+1},201,{'Idempotency-Key':randomUUID()});
  const mixedAlerts=await alertsFor(mixed.id);
  assert.equal(mixedAlerts.length,1);assert.deepEqual(mixedAlerts[0].alert.items.map(i=>i.label),['Check under sinks for leaks'],'Monitor item is not in the alert');

  // ---- offline: fill with Monitor on the device, sync, submit (exactly once).
  const snapOffline=(await employee.req('offline/visits?propertyIds='+home.id)).checklists.find(c=>c.template_id===tid);
  const snap={template_id:snapOffline.template_id,template_version_id:snapOffline.template_version_id,template_version:snapOffline.template_version,name:snapOffline.name,visit_type:snapOffline.visit_type,items:snapOffline.items};
  const id=randomUUID(),store=OC.memoryStore();
  const offlineAnswers=CK.propertyAnswers(snap).map(a=>({...a,status:{'Check under sinks for leaks':'monitor','Pool equipment running':'pass','Gutters clear':'monitor','Alarm armed':'yes'}[a.label]}));
  assert.deepEqual(CK.completionProblems(offlineAnswers,{summary:'Watch the sink.',photoCount:0}),[],'the device lets Monitor through');
  await store.putDraft({inspectionId:id,propertyId:home.id,inspectionDate:'2026-10-04',baseVersion:1,base:OC.content({answers:[],summary:'',notes:'',internalNotes:''}),answers:offlineAnswers,summary:'Watch the sink.',notes:'',internalNotes:'',rev:1,dirty:true,status:'draft',photos:[],localOnly:true,visitType:'routine',checklist:snap});
  await OC.enqueue(store,{type:'start_inspection',inspectionId:id,payload:{propertyId:home.id,date:'2026-10-04',visitType:'routine',templateId:snap.template_id,templateVersionId:snap.template_version_id}});
  await OC.enqueue(store,{type:'save_draft',inspectionId:id});
  await OC.enqueue(store,{type:'complete_inspection',inspectionId:id,payload:{autoPublish:false}});
  const sent=[];
  const send=async(method,p,body,key)=>{const res=await employee.call(method,p.replace(/^\/api\//,''),body,key?{'Idempotency-Key':key}:{});sent.push([p,res.status]);return {status:res.status,body:res.body};};
  await OC.createSyncEngine({store,send}).run();
  assert.equal((await store.getOutbox()).length,0,'synced: '+JSON.stringify(sent));
  const synced=await visit(id);
  assert.equal(synced.status,'submitted');assert.deepEqual(CK.totals(synced.answers),{pass:1,monitor:2,fail:0,na:0});
  assert.deepEqual(await alertsFor(id),[],'offline Monitor submission: no alert');

  // ---- the old visit is untouched by all of the above.
  const oldAfter=await visit(old.id);
  assert.deepEqual(oldAfter.answers,oldPublished.answers);assert.deepEqual(oldAfter.checklist,oldPublished.checklist);
  assert.equal(Buffer.from(await (await admin.raw('inspections/'+old.id+'/pdf')).arrayBuffer()).toString('latin1'),oldPdf);
 }catch(error){error.message+='\n--- server log ---\n'+srv.log;throw error;}
 finally{await srv.stop();}
}
test('Monitor on template pass/fail items (SQLite)',()=>scenario('sqlite',{}));
test('Monitor on template pass/fail items on Postgres (PGlite)',()=>scenario('pg',{pg:true}));

test('Monitor: values, display, tone, totals and note prompt',()=>{
 const item={response_type:'pass_fail_na',required:true,options:[]};
 assert.deepEqual(CK.PASS_FAIL_VALUES,['pass','monitor','fail','na'],'display order');
 for(const v of CK.PASS_FAIL_VALUES)assert.equal(CK.valueProblem(item,v),'',v);
 assert.match(CK.valueProblem(item,'attention'),/Pass, Monitor, Fail or N\/A/);
 assert.equal(CK.TYPE_LABELS.pass_fail_na,'Pass / Monitor / Fail / N/A');
 const a={key:'k',label:'Gutters',...item,status:'monitor',note:''};
 assert.equal(CK.displayValue(a),'Monitor');assert.equal(CK.tone(a),'monitor');assert.equal(CK.isFailed(a),false);
 assert.ok(!FAILED_STATUSES.has('monitor'));
 assert.deepEqual(CK.completionProblems([a,{...a,photo_rule:'required_on_fail'}],{summary:'x',photoCount:0}),[],'no note or photo needed for Monitor');
 assert.match(CK.notePrompt('pass_fail_na','monitor'),/recommended/);assert.equal(CK.notePrompt('pass_fail_na','pass'),'Reading, observation or N/A reason');assert.equal(CK.notePrompt('text','unchecked'),'Extra note (optional)');
 assert.deepEqual(CK.totals([{...a,status:'pass'},a,{...a,status:'fail'},{...a,status:'na'},{...a,status:'na'},{...a,response_type:'yes_no',status:'no'},{key:'legacy',status:'monitor'}]),{pass:1,monitor:1,fail:1,na:2},'pass/fail items only; built-in answers are not counted');
 assert.deepEqual(templateAnswerPdf(a),{style:'monitor',pill:'MONITOR',value:''});
 assert.equal(validateAnswer({response_type:'pass_fail_na',required:true,options:[]},'monitor').ok,true);
 assert.equal(validateAnswer({response_type:'pass_fail_na',required:true,options:[]},'attention').ok,false);
});

test('Monitor never puts an item in a fail alert, for linked or unlinked visits',()=>{
 const tplItem={stable_key:'sinks',section:'Water',label:'Check under sinks for leaks',alert_on_fail:1};
 const answers=status=>[{key:'sinks',item_key:'sinks',label:'Check under sinks for leaks',response_type:'pass_fail_na',status,note:''}];
 assert.deepEqual(alertItems(answers('monitor'),[tplItem],{linked:true}),[]);
 assert.equal(alertItems(answers('fail'),[tplItem],{linked:true}).length,1);
 assert.deepEqual(alertItems(answers('monitor'),[tplItem]),[]);
 assert.deepEqual(alertItems([{key:'sinks',label:'Check under sinks for leaks',status:'monitor',note:''}],[tplItem]),[],'built-in Monitor');
});

test('existing pass/fail items, starters and the editor offer Monitor automatically',()=>{
 for(const set of starterSets())for(const i of set.items.filter(i=>i.response_type==='pass_fail_na'))assert.equal(CK.valueProblem(CK.snapshotItem(i),'monitor'),'',set.key+' '+i.label);
 assert.equal(M.ANSWER_TYPES.find(t=>t.value==='pass_fail_na').label,'Pass / Monitor / Fail');
 assert.deepEqual(M.answerChoices('pass_fail_na').map(c=>[c.label,c.tone]),[['Pass','pass'],['Monitor','monitor'],['Fail','fail'],['N/A','na']]);
});

test('template reports total Pass / Monitor / Fail / N/A; built-in reports keep Pass / Monitor / Attention',()=>{
 const base={id:'r1',company:'Harbor',property:'Ocean House',client:'Family',inspector:'Leo',date:'2026-10-02',completedAt:'2026-10-02T14:00:00Z',overall:'Monitor',summary:'Fine',notes:''};
 const t=(label,status)=>({key:label,item_key:label,section:'S',label,response_type:'pass_fail_na',required:true,status,note:''});
 const text=inspectionPdf({...base,checklist:{name:'Weekly',template_version:2},answers:[t('A','pass'),t('B','monitor'),t('C','monitor'),t('D','fail'),t('E','na')]}).toString('latin1');
 const totals=[...text.matchAll(/\((\d+)\) Tj[^]*?\((PASS|MONITOR|FAIL|N\/A)\) Tj/g)].slice(0,4).map(m=>m[2]+'='+m[1]);
 assert.deepEqual(totals,['PASS=1','MONITOR=2','FAIL=1','N/A=1']);
 const legacy=inspectionPdf({...base,answers:[{key:'a',section:'S',label:'A',status:'monitor',note:''}]}).toString('latin1');
 assert.ok(legacy.includes('(ATTENTION)')&&!legacy.includes('(FAIL)'));
});
