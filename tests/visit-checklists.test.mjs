// Field visits use the company's PUBLISHED checklist templates (server, offline flow, fail alerts, PDF, portal).
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
import {submissionProblems} from '../offline-inspections.mjs';
import {inspectionPdf} from '../pdf.mjs';
const CK=globalThis.EAChecklist;
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const jpeg=readFileSync(path.join(root,'tests/fixture.jpg')).toString('base64');
const builtIn=JSON.parse(readFileSync(path.join(root,'inspection-template.json'),'utf8'));
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const sandbox={crypto:globalThis.crypto,btoa:globalThis.btoa,console};sandbox.globalThis=sandbox;
vm.createContext(sandbox);vm.runInContext(readFileSync(path.join(root,'public/offline-core.js'),'utf8'),sandbox);
const OC=sandbox.EAOfflineCore;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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

const ROOMS=[{key:'kitchen',name:'Kitchen',type:'Kitchen'},{key:'bed-1',name:'Primary bedroom',type:'Bedroom'}];
const WEEKLY=[
 {section:'Security',label:'Front door locks work',response_type:'pass_fail_na',required:true,photo_rule:'required_on_fail',alert_on_fail:true,help_text:'Try every exterior door.'},
 {section:'Security',label:'Mail and packages collected',response_type:'yes_no',required:true,photo_rule:'none'},
 {section:'Interior',label:'Overall tidiness',response_type:'rating',required:false,photo_rule:'none'},
 {section:'Systems',label:'Thermostat reading (°F)',response_type:'number',required:true,photo_rule:'none'},
 {section:'Systems',label:'Pool water',response_type:'select',options:['Clear','Cloudy','Green'],required:true,photo_rule:'none'},
 {section:'Systems',label:'Lights left on',response_type:'multi_select',options:['Kitchen','Porch','Garage'],required:false,photo_rule:'none'},
 {section:'Notes',label:'Notes for the owner',response_type:'text',required:false,photo_rule:'none'},
 {section:'Rooms',label:'Windows closed and latched',response_type:'pass_fail_na',required:true,scope:'room',photo_rule:'optional'},
 {section:'Rooms',label:'Bed linens fresh',response_type:'yes_no',required:true,scope:'room',room_types:['Bedroom'],photo_rule:'none'}
];
const fill={'front-door-locks-work':'pass','mail-and-packages-collected':'yes','overall-tidiness':'4','thermostat-reading-f':'78','pool-water':'Clear','lights-left-on':JSON.stringify(['Porch']),'notes-for-the-owner':'Owner asked us to water the ferns.','windows-closed-and-latched':'pass','bed-linens-fresh':'yes'};

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-visits-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),employee=client(srv),family=client(srv);
  await admin.req('setup',{company:'Visits Co '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  const fam=await admin.req('clients',{name:'Family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States',roomProfile:{rooms:ROOMS}},201);
  const accept=async(c,role,email,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email,password:pw},201);};
  const emp=await accept(employee,'employee','tech@example.test');await accept(family,'client','fam@example.test',{clientId:fam.id});
  await admin.req('access',{userId:emp.user.id,propertyId:home.id},201);
  const visit=async id=>(await admin.req('data')).inspections.find(i=>i.id===id);

  // ---- legacy: a visit started before any template is published uses the built-in checklist, exactly as before.
  const legacyId=(await employee.req('inspections',{propertyId:home.id,date:'2026-10-01'},201)).id;
  let legacy=await visit(legacyId);
  assert.equal(legacy.template_id,null);assert.equal(legacy.template_version_id,null);assert.equal(legacy.checklist,null);
  assert.deepEqual(legacy.answers,builtIn,'fallback: the built-in checklist, unchanged');
  const legacyAnswers=[...legacy.answers.map((a,n)=>({...a,status:n===0?'monitor':n===1?'attention':'pass',note:n<2?'Seen':''})),...ROOMS.flatMap(r=>[['condition','Overall condition'],['readiness','Cleanliness and readiness'],['fixtures','Fixtures and equipment']].map(([c,l])=>({key:'space-'+encodeURIComponent(r.key)+'-'+c,section:r.name,label:l,status:'pass',note:'',room_key:r.key,room_name:r.name})))];
  await employee.req('inspections/save',{id:legacyId,version:1,answers:legacyAnswers,summary:'Legacy visit',notes:'',internalNotes:''},201);
  await admin.req('inspections/publish',{id:legacyId,version:(await visit(legacyId)).version,idempotencyKey:randomUUID()},201);
  legacy=await visit(legacyId);
  assert.deepEqual(legacy.answers.map(a=>Object.keys(a).sort().join()),legacyAnswers.map(a=>Object.keys(a).sort().join()),'legacy answers keep their original shape (no template fields)');
  const legacyPdf=Buffer.from(await (await admin.raw('inspections/'+legacyId+'/pdf')).arrayBuffer()).toString('latin1');
  assert.ok(legacyPdf.includes('(MONITOR)')&&legacyPdf.includes('(ATTENTION)'),'legacy report keeps Pass / Monitor / Attention');
  assert.ok(!legacyPdf.includes('(Checklist)'),'legacy report has no checklist line');

  // ---- templates: two published Routine templates, one Hurricane prep, one never published.
  const make=async(name,visit_type,items)=>(await admin.req('checklist-templates',{name,visit_type,items},201)).id;
  const publish=id=>admin.req('checklist-templates/'+id+'/publish',{});
  const weekly=await make('Weekly routine','routine',WEEKLY);await publish(weekly);await sleep(15);
  const shortRoutine=await make('Quick routine','routine',[{section:'General',label:'Walk the exterior',response_type:'pass_fail_na',required:true}]);await publish(shortRoutine);await sleep(15);
  const storm=await make('Storm prep','pre_storm',[{section:'Openings',label:'Shutters installed',response_type:'pass_fail_na',required:true,alert_on_fail:true}]);await publish(storm);
  const draftOnly=await make('Draft only','routine',[{section:'General',label:'Unpublished item',response_type:'pass_fail_na'}]);
  const weeklyV1=(await admin.req('checklist-templates/'+weekly+'/published')).version;

  // Pickers get every published checklist (latest published version, with items), grouped by visit type, newest first.
  const lists=(await employee.req('data')).checklists;
  assert.deepEqual(lists.map(c=>c.name),['Quick routine','Weekly routine','Storm prep'],'published only, routine first, newest first');
  assert.ok(lists.every(c=>c.items.length===c.item_count&&c.template_version_id));
  assert.deepEqual((await family.req('data')).checklists,[],'families never get checklist templates');

  // ---- creation picks the right template and version.
  const create=async body=>visit((await employee.req('inspections',{propertyId:home.id,date:'2026-10-02',...body},201)).id);
  const byDefault=await create({});
  assert.equal(byDefault.template_id,shortRoutine,'no choice: the newest published template for the visit type');
  const picked=await create({templateId:weekly});
  assert.equal(picked.template_id,weekly);assert.equal(picked.template_version,1);assert.equal(picked.template_version_id,weeklyV1.id);assert.equal(picked.visit_type,'routine');
  assert.deepEqual(picked.answers.map(a=>a.key),picked.checklist.items.filter(i=>i.scope!=='room').map(i=>i.stable_key),'residence-wide items in template order');
  assert.deepEqual(picked.answers.map(a=>a.label),WEEKLY.filter(i=>i.scope!=='room').map(i=>i.label));
  assert.equal(picked.answers.length,7);assert.ok(picked.answers.every(a=>a.status==='unchecked'&&a.response_type));
  assert.equal(picked.checklist.items.length,9,'the snapshot keeps every item, including room items');
  assert.equal((await create({visitType:'pre_storm'})).template_id,storm,'visit type picks that type\'s template');
  const chosenBuiltIn=await create({templateId:'built-in'});assert.equal(chosenBuiltIn.template_id,null);assert.deepEqual(chosenBuiltIn.answers,builtIn);
  const arrival=await create({visitType:'arrival'});assert.equal(arrival.template_id,null);assert.equal(arrival.visit_type,'arrival');assert.deepEqual(arrival.answers,builtIn,'no published template for the type: built-in fallback');
  await employee.req('inspections',{propertyId:home.id,date:'2026-10-02',templateId:draftOnly},422);
  await employee.req('inspections',{propertyId:home.id,date:'2026-10-02',templateId:'no-such-template'},422);

  // ---- the device downloads residences for offline use while Weekly routine is at version 1.
  const offlineSnap=await employee.req('offline/visits?propertyIds='+home.id);
  const offlineWeekly=offlineSnap.checklists.find(c=>c.template_id===weekly);
  assert.equal(offlineWeekly.template_version,1);assert.equal(offlineWeekly.items.length,9,'offline copy carries the template items');
  assert.equal(offlineSnap.checklist.template_id,shortRoutine,'default routine checklist for offline starts');
  assert.equal(offlineSnap.inspections.find(i=>i.id===picked.id).checklist.items.length,9,'cached visits carry their snapshot');

  // ---- snapshot isolation: v2 changes wording and turns the alert off; started visits keep v1.
  const v2items=WEEKLY.map(i=>i.label==='Front door locks work'?{...i,label:'Exterior doors locked',stable_key:'front-door-locks-work',alert_on_fail:false}:i);
  await admin.req('checklist-templates/'+weekly+'/items',{items:v2items});await publish(weekly);
  const after=await visit(picked.id);
  assert.equal(after.template_version,1);assert.equal(after.answers[0].label,'Front door locks work');assert.equal(after.checklist.items[0].alert_on_fail,true,'started visit is unchanged by later edits');
  const fresh=await create({templateId:weekly});assert.equal(fresh.template_version,2);assert.equal(fresh.answers[0].label,'Exterior doors locked');

  // ---- filling a template visit: values are validated per answer type; item settings come from the snapshot.
  const rooms=CK.roomAnswers(after.checklist,ROOMS);
  assert.deepEqual(rooms.map(a=>a.key),['space-kitchen-windows-closed-and-latched','space-bed-1-windows-closed-and-latched','space-bed-1-bed-linens-fresh'],'room items per room; room types filter');
  const all=[...after.answers,...rooms].map(a=>({...a}));
  const save=(answers,version,extra={})=>employee.call('POST','inspections/save',{id:picked.id,version,answers,summary:'',notes:'',internalNotes:'',...extra});
  for(const [key,bad] of [['front-door-locks-work','attention'],['mail-and-packages-collected','maybe'],['overall-tidiness','9'],['thermostat-reading-f','warm'],['pool-water','Purple'],['lights-left-on','["Attic"]']]){
   const r=await save(all.map(a=>a.key===key?{...a,status:bad}:a),1);assert.equal(r.status,422,key+' rejects '+bad);
  }
  assert.equal((await save(all.filter(a=>a.key!=='space-bed-1-bed-linens-fresh'),1)).status,422,'each room needs all its items');
  assert.equal((await save(all.filter(a=>a.key!=='pool-water'),1)).status,422,'every template item must be present');
  const partial=all.map(a=>a.key==='front-door-locks-work'?{...a,status:'fail',note:'Back door latch broken',label:'Tampered label',alert_on_fail:false}:a.item_key&&a.required?{...a,status:fill[a.item_key]}:a);
  assert.equal((await save(partial,1)).status,201);
  let saved=await visit(picked.id);
  const door=saved.answers.find(a=>a.key==='front-door-locks-work');
  assert.equal(door.label,'Front door locks work');assert.equal(door.alert_on_fail,true,'labels and flags are rebuilt from the snapshot');assert.equal(door.status,'fail');
  assert.equal(saved.answers.find(a=>a.key==='overall-tidiness').status,'unchecked','optional items can stay blank');

  // ---- completion follows the template: summary, photo required on fail.
  let r=await employee.call('POST','inspections/submit',{id:picked.id,version:2},{'Idempotency-Key':randomUUID()});
  assert.equal(r.status,422);assert.match(r.body.error,/Add a photo for the failed item/);assert.match(r.body.error,/Add an inspection summary/);assert.doesNotMatch(r.body.error,/still need a result/,'optional blanks do not block');
  const missingRequired=partial.map(a=>a.key==='pool-water'?{...a,status:'unchecked'}:a);
  assert.equal((await save(missingRequired,2,{summary:'x'})).status,201);
  r=await employee.call('POST','inspections/submit',{id:picked.id,version:3},{'Idempotency-Key':randomUUID()});assert.match(r.body.error,/1 checklist item still need a result/,'a blank Required item blocks completion');
  const full=all.map(a=>({...a,status:a.key==='front-door-locks-work'?'fail':fill[a.item_key],note:a.key==='front-door-locks-work'?'Back door latch broken':''}));
  assert.equal((await save(full,3,{summary:'Back door latch needs a locksmith.'})).status,201);
  await employee.req('files',{propertyId:home.id,inspectionId:picked.id,name:'latch.jpg',base64:jpeg,capturedAt:new Date().toISOString(),clientOpId:randomUUID()},201,{'Idempotency-Key':randomUUID()});
  const submitted=await employee.req('inspections/submit',{id:picked.id,version:4},201,{'Idempotency-Key':randomUUID()});assert.equal(submitted.status,'submitted');

  // ---- fail alert from the LINKED template version (v1 alerts on this item; v2 does not).
  const note=(await admin.req('notifications')).notifications.find(n=>n.kind==='inspection_fail'&&n.entity_id===picked.id);
  assert.ok(note,'the office is alerted');assert.equal(note.alert.source,'linked-template');assert.deepEqual(note.alert.items.map(i=>i.label),['Front door locks work']);

  // ---- publish: report, PDF and the family's portal view.
  await admin.req('inspections/publish',{id:picked.id,version:(await visit(picked.id)).version,idempotencyKey:randomUUID()},201);
  const pdf=Buffer.from(await (await admin.raw('inspections/'+picked.id+'/pdf')).arrayBuffer()).toString('latin1');
  for(const part of ['(Checklist)','(Weekly routine \\(version 1\\))','(FAIL)','(PASS)','(YES)','(78)','(4/5)','(CLEAR)','(RECORDED)','(Answer: Owner asked us to water the ferns.)','(Answer: Porch)'])assert.ok(pdf.includes(part),'PDF has '+part);
  const portal=(await family.req('data')).inspections.find(i=>i.id===picked.id);
  assert.deepEqual(Object.keys(portal.checklist).sort(),['name','template_id','template_version','template_version_id','visit_type','visit_type_label'],'families see the checklist name, not its settings');
  assert.equal(portal.answers.find(a=>a.key==='pool-water').status,'Clear');
  assert.equal(portal.checklist_snapshot,undefined);

  // ---- offline: start against the downloaded v1 copy (now v2 on the server), fill, sync, submit. Idempotent replays.
  const store=OC.memoryStore();const id=randomUUID();
  const snap={template_id:offlineWeekly.template_id,template_version_id:offlineWeekly.template_version_id,template_version:offlineWeekly.template_version,name:offlineWeekly.name,visit_type:offlineWeekly.visit_type,items:offlineWeekly.items};
  const answers=[...CK.propertyAnswers(snap),...CK.roomAnswers(snap,ROOMS)].map(a=>({...a,status:fill[a.item_key]||'unchecked'}));
  await store.putDraft({inspectionId:id,propertyId:home.id,inspectionDate:'2026-10-03',baseVersion:1,base:OC.content({answers:[],summary:'',notes:'',internalNotes:''}),answers,summary:'All clear offline.',notes:'',internalNotes:'',rev:1,dirty:true,status:'draft',photos:[],localOnly:true,visitType:'routine',checklist:snap});
  await OC.enqueue(store,{type:'start_inspection',inspectionId:id,payload:{propertyId:home.id,date:'2026-10-03',visitType:'routine',templateId:snap.template_id,templateVersionId:snap.template_version_id}});
  await OC.enqueue(store,{type:'save_draft',inspectionId:id});
  await OC.enqueue(store,{type:'complete_inspection',inspectionId:id,payload:{autoPublish:false}});
  const sent=[];
  const send=async(method,p,body,key)=>{const res=await employee.call(method,p.replace(/^\/api\//,''),body,key?{'Idempotency-Key':key}:{});sent.push({p,key,body,status:res.status});return {status:res.status,body:res.body};};
  await OC.createSyncEngine({store,send}).run();
  assert.equal((await store.getOutbox()).length,0,'everything synced: '+JSON.stringify(sent.map(s=>[s.p,s.status])));
  const synced=await visit(id);
  assert.equal(synced.status,'submitted');assert.equal(synced.template_version,1,'the server honours the exact version the device filled');
  assert.equal(synced.template_version_id,snap.template_version_id);assert.equal(synced.answers.find(a=>a.key==='lights-left-on').status,JSON.stringify(['Porch']));
  assert.equal(synced.answers.filter(a=>a.room_key).length,3);
  const startCall=sent.find(s=>s.p==='/api/inspections');
  const replay=await employee.call('POST','inspections',startCall.body,{'Idempotency-Key':startCall.key});
  assert.equal(replay.status,201);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  const submitCall=sent.find(s=>s.p==='/api/inspections/submit');
  assert.equal((await employee.call('POST','inspections/submit',submitCall.body,{'Idempotency-Key':submitCall.key})).headers.get('idempotency-replayed'),'true');
  assert.equal((await admin.req('data')).inspections.filter(i=>i.id===id).length,1,'one visit, no duplicates');

  // An offline start queued by an older app version (no checklist in the payload) stays on the built-in checklist.
  const oldId=randomUUID();await employee.req('inspections',{id:oldId,propertyId:home.id,date:'2026-10-03'},201,{'Idempotency-Key':randomUUID()});
  assert.equal((await visit(oldId)).template_id,null);

  // ---- change the checklist of a scheduled visit before anything is recorded; never after.
  const scheduled=await create({templateId:'built-in',date:'2026-10-20'});
  const changed=await employee.req('inspections/checklist',{id:scheduled.id,version:scheduled.version,templateId:storm},201);
  assert.equal(changed.checklist.name,'Storm prep');const sv=await visit(scheduled.id);assert.equal(sv.visit_type,'pre_storm');assert.equal(sv.answers[0].label,'Shutters installed');
  await employee.req('inspections/save',{id:scheduled.id,version:sv.version,answers:sv.answers.map(a=>({...a,status:'pass'})),summary:'',notes:'',internalNotes:''},201);
  await employee.req('inspections/checklist',{id:scheduled.id,version:sv.version+1,templateId:weekly},409);

  // ---- recurring schedule can name a checklist; the automation creates visits with it.
  await admin.req('operations/inspection-plan',{propertyId:home.id,assignedTo:emp.user.id,nextDue:'2026-09-01',intervalDays:30,active:true,templateId:storm},200);
  assert.equal((await admin.req('operations')).plans[0].template_name,'Storm prep');
  await admin.req('operations/run',{},200);
  const auto=(await admin.req('data')).inspections.find(i=>i.inspection_date==='2026-09-01');
  assert.ok(auto,'automation created the visit');assert.equal(auto.template_id,storm);assert.equal(auto.checklist.name,'Storm prep');

  // ---- the legacy visit is untouched by all of the above.
  const legacyAfter=await visit(legacyId);assert.deepEqual(legacyAfter.answers,legacy.answers);assert.equal(legacyAfter.checklist,null);
 }catch(error){error.message+='\n--- server log ---\n'+srv.log;throw error;}
 finally{await srv.stop();}
}
test('field visits use published checklist templates (SQLite)',()=>scenario('sqlite',{}));
test('field visits use published checklist templates on Postgres (PGlite)',()=>scenario('pg',{pg:true}));

test('completion rules: built-in visits keep the original messages; template visits follow the template',()=>{
 const legacy={answers:JSON.stringify([{key:'a',status:'unchecked'},{key:'b',status:'na',note:''},{key:'c',status:'pass'}]),summary:''};
 assert.deepEqual(submissionProblems(legacy),['1 checklist item still need a result.','Add a note to 1 item marked Not applicable.','Add an inspection summary.']);
 assert.deepEqual(submissionProblems(legacy,{photoCount:0}),submissionProblems(legacy),'photo rules never apply to built-in visits');
 const t=(extra)=>({key:'k'+Math.random(),label:'Door',response_type:'pass_fail_na',required:true,photo_rule:'none',status:'unchecked',note:'',...extra});
 const rows=[t({required:false}),t({status:'fail',photo_rule:'required_on_fail'}),t({response_type:'text',required:true})];
 assert.deepEqual(CK.completionProblems(rows,{summary:'ok',photoCount:0}),['1 checklist item still need a result.','Add a photo for the failed item that requires one: Door.']);
 assert.deepEqual(CK.completionProblems(rows,{summary:'ok',photoCount:1}),['1 checklist item still need a result.']);
});

test('answer values and display per type',()=>{
 const item=(response_type,options=[])=>({response_type,options,required:true});
 assert.equal(CK.valueProblem(item('pass_fail_na'),'pass'),'');assert.equal(CK.valueProblem(item('pass_fail_na'),'monitor'),'');assert.ok(CK.valueProblem(item('pass_fail_na'),'attention'));
 assert.equal(CK.valueProblem(item('rating'),'5'),'');assert.ok(CK.valueProblem(item('rating'),'0'));assert.ok(CK.valueProblem(item('rating'),'2.5'));
 assert.equal(CK.valueProblem(item('number'),'-3.5'),'');assert.ok(CK.valueProblem(item('number'),'abc'));
 assert.equal(CK.valueProblem(item('multi_select',['A','B']),'["A","B"]'),'');assert.ok(CK.valueProblem(item('multi_select',['A']),'["A","A"]'));
 assert.equal(CK.valueProblem(item('select',['A']),'unchecked'),'','not answered is always valid in a draft');
 assert.equal(CK.displayValue({...item('rating'),status:'4'}),'4 of 5');assert.equal(CK.displayValue({...item('multi_select'),status:'["Porch","Garage"]'}),'Porch, Garage');
 assert.equal(CK.displayValue({...item('pass_fail_na'),status:'na'}),'Not applicable');assert.equal(CK.displayValue({...item('text'),required:false,status:'unchecked'}),'Not answered');
 assert.equal(CK.tone({...item('pass_fail_na'),status:'fail'}),'fail');assert.equal(CK.tone({key:'x',status:'attention'}),'fail');assert.equal(CK.tone({...item('yes_no'),status:'no'}),'monitor');
});

test('legacy reports render byte-for-byte the same PDF as before template support',async()=>{
 const report={id:'r1',company:'Harbor',property:'Ocean House',client:'Family',inspector:'Leo',date:'2026-10-02',completedAt:'2026-10-02T14:00:00Z',overall:'Monitor',answers:builtIn.map((a,n)=>({...a,status:['pass','monitor','attention','na'][n%4],note:n%3?'':'Seen'})),summary:'Fine',notes:'None'};
 const a=inspectionPdf(report);
 // Hash of the same report pinned after audit batch 4c (summary moved to the top, readable inspection date); before
 // that it matched pdf.mjs before template support (stability-baseline 4dd965d, 08f7846d…). Template support itself
 // still must not change legacy output: only deliberate layout changes may move this hash.
 const {createHash}=await import('node:crypto');
 assert.equal(createHash('sha256').update(a).digest('hex'),'92b3dd2fbfefa83e192cd70eac832ee74cac99c634ef115fa2a27e5215ec99e2');
 const text=a.toString('latin1');
 assert.ok(text.includes('(Fri, Oct 2, 2026)'),'readable inspection date');assert.ok(text.indexOf('(Summary)')<text.indexOf('(Walkthrough checklist)'),'summary before the checklist');
 assert.ok(text.includes('(MONITOR)')&&text.includes('(ATTENTION)')&&!text.includes('(Checklist)')&&!text.includes('(RECORDED)'));
});
