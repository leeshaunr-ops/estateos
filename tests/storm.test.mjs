// Hurricane and storm workflow: storm rules (storm-core.js), bulk storm visit scheduling, the status board data,
// automatic statuses from storm visits (including offline completion with Idempotency-Key replays), client notices,
// the client portal, permissions and company isolation, the CSV export and the insurance-claim-ready storm report PDF.
// Server scenarios run on SQLite and on Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import '../public/storm-core.js';
import '../public/view-route.js';
import {renderStormEmail} from '../storm.mjs';
import {stormReportPdf,stormSummaryPdf,disclaimer} from '../storm-pdf.mjs';
const S=globalThis.EAStorm;
const R=globalThis.EARoute;

test('refresh keeps the storm screen: Storms list and a storm board round-trip through the URL', () => {
 const data={user:{id:'u1',role:'admin'},storm:{events:[{id:'ev1'}]}};
 assert.equal(R.toHash({...R.blank(),page:'storm'}),'#/storm');
 assert.equal(R.toHash({...R.blank(),page:'storm',stormEventId:'ev1'}),'#/storm/ev1');
 assert.equal(R.parse('#/storm/ev1').stormEventId,'ev1');
 assert.equal(R.resolve(R.parse('#/storm/ev1'),data).state.stormEventId,'ev1');
 const gone=R.resolve(R.parse('#/storm/missing'),data);assert.equal(gone.state.page,'storm');assert.equal(gone.state.stormEventId,null,'an unknown storm falls back to the Storms list');
 assert.equal(R.resolve(R.parse('#/storm/ev1'),{...data,user:{id:'c',role:'client'}}).fellBack,true,'clients have no Storms page');
 const html=readFileSync(path.join(root,'public/live.html'),'utf8');
 assert.ok(html.indexOf('/storm.js')<html.indexOf('/view-route.js'),'storm.js loads before view-route.js');
});
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const fixture=readFileSync(path.join(root,'tests/fixture.jpg'));
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const words=pdf=>[...pdf.matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');

test('storm rules: outcomes, severity, selection, round robin, counts, photo pairs, CSV, client wording',()=>{
 assert.equal(S.suggestSeverity(0,0),'none');assert.equal(S.suggestSeverity(0,2),'minor');assert.equal(S.suggestSeverity(1,0),'moderate');assert.equal(S.suggestSeverity(2,5),'moderate');assert.equal(S.suggestSeverity(3,0),'major');
 const pf=(status,extra={})=>({key:randomUUID(),label:'Item',response_type:'pass_fail_na',status,...extra});
 assert.deepEqual(S.prepOutcome([pf('pass'),pf('na')]),{status:'secured',issues:false,failed:0});
 assert.equal(S.prepOutcome([pf('pass'),pf('fail')]).issues,true);
 assert.equal(S.prepOutcome([{key:'k',label:'Built-in',status:'attention'}]).issues,true,'built-in Attention counts as failed');
 assert.equal(S.prepOutcome([pf('pass'),{key:'y',label:'Shutters up?',response_type:'yes_no',status:'no'}]).issues,false,'Yes/No answers never decide damage');
 assert.deepEqual(S.postOutcome([pf('pass'),pf('na')]),{status:'no_damage',severity:'none',failed:0,monitored:0});
 assert.equal(S.postOutcome([pf('monitor')]).severity,'minor');assert.equal(S.postOutcome([pf('fail'),pf('monitor')]).severity,'moderate');assert.equal(S.postOutcome([pf('fail'),pf('fail'),pf('fail')]).severity,'major');
 assert.equal(S.findings([pf('pass'),pf('fail'),pf('monitor'),{key:'t',response_type:'text',status:'roof'}]).length,2);
 assert.equal(S.recorded([pf('unchecked')]),false);assert.equal(S.recorded([pf('unchecked',{note:'gate open'})]),true);assert.equal(S.recorded([pf('pass')]),true);assert.equal(S.recorded([],{summary:'x'}),true);
 assert.equal(S.prepLabel('secured',1),'Secured with issues');assert.equal(S.prepLabel('secured',0),'Secured');assert.equal(S.postLabel('damage_found'),'Damage found');
 assert.equal(S.tone('prep','secured',1),'issue');assert.equal(S.tone('prep','secured',0),'done');assert.equal(S.tone('post','no_damage'),'done');assert.equal(S.tone('post','damage_found'),'issue');assert.equal(S.tone('prep','scheduled'),'open');
 const props=[{id:'a',name:'Ocean House',city:'Stuart',postal_code:'34994',account_manager_id:'u1',client_name:'Lee'},{id:'b',name:'Palm Villa',city:'stuart ',postal_code:'34996-1234',account_manager_id:null,client_name:'Park'},{id:'c',name:'Bay Cottage',city:'Naples',postal_code:'34102',account_manager_id:'u2',client_name:'Park'},{id:'d',name:'Old Barn',city:'Stuart',postal_code:'34994',archived_at:'2026-01-01'}];
 assert.deepEqual(S.selectResidences(props,{city:'STUART'}).map(p=>p.id),['a','b'],'city match ignores case/space; archived never selected');
 assert.deepEqual(S.selectResidences(props,{zip:'34996'}).map(p=>p.id),['b'],'ZIP+4 matches the 5-digit ZIP');
 assert.deepEqual(S.selectResidences(props,{managerId:'none'}).map(p=>p.id),['b']);assert.deepEqual(S.selectResidences(props,{managerId:'u2'}).map(p=>p.id),['c']);
 assert.deepEqual(S.selectResidences(props,{search:'park',city:'Naples'}).map(p=>p.id),['c'],'filters narrow together');
 assert.equal(S.selectResidences(props,{}).length,3);
 const rr=S.roundRobin(props.slice(0,3),['u1','u2','u1']);
 assert.deepEqual([...rr.entries()],[['c','u1'],['a','u2'],['b','u1']],'dealt in name order, duplicates ignored');
 assert.equal(S.roundRobin(props,[]).size,0);
 const c=S.counts([{prep_status:'secured',prep_issues:1,post_status:'damage_found'},{prep_status:'secured',prep_issues:0,post_status:'no_damage'},{prep_status:'scheduled',post_status:'not_started'},{prep_status:'in_progress',post_status:'inaccessible'},{prep_status:'client_declined',post_status:'in_progress'}]);
 assert.deepEqual(c,{total:5,secured:2,securedWithIssues:1,prepOpen:1,prepInProgress:1,prepOther:1,postChecked:2,noDamage:1,damageFound:1,postOpen:1,postInProgress:1,inaccessible:1});
 const ph=(id,name,at,key)=>({id,name,captured_at:at,answer_key:key});
 const pairs=S.pairPhotos([ph('b1','North elevation.jpg','2026-10-07T10:00:00Z'),ph('b2','IMG_0042.jpg','2026-10-07T10:01:00Z'),ph('b3','x.jpg','2026-10-07T10:02:00Z','roof')],[ph('a1','IMG_0042.jpg','2026-10-10T10:00:00Z'),ph('a2','north-elevation.JPG','2026-10-10T10:01:00Z'),ph('a3','y.jpg','2026-10-10T10:02:00Z','roof'),ph('a4','z.jpg','2026-10-10T10:03:00Z')]);
 assert.deepEqual(pairs.map(p=>[p.before?.id||null,p.after?.id||null,p.match]),[['b3','a3','item'],['b1','a2','name'],['b2','a1','order'],[null,'a4','order']],'item, then non-generic name, then capture order');
 assert.equal(S.csvCell('=SUM(A1)'),`"'=SUM(A1)"`);assert.equal(S.csvCell('+1'),`"'+1"`);assert.equal(S.csvCell('say "hi"'),'"say ""hi"""');assert.equal(S.csvRow(['a',2]),'"a","2"');
 const at=v=>'AT('+v+')',day=v=>'DAY('+v+')';
 assert.deepEqual(S.clientText({prep_status:'secured',prep_issues:0,post_status:'not_started'},{preAt:'t1'},at,day),{prep:'Your home was secured on AT(t1)',post:''});
 assert.match(S.clientText({prep_status:'secured',prep_issues:1,post_status:'not_started'},{},at,day).prep,/A few items need attention/);
 assert.equal(S.clientText({prep_status:'scheduled',post_status:'not_started'},{preDate:'2026-10-07'},at,day).prep,'Storm preparation is scheduled for DAY(2026-10-07)');
 assert.equal(S.clientText({prep_status:'secured',post_status:'damage_found',damage_severity:'moderate'},{postAt:'t2'},at,day).post,'Post-storm check: damage found (moderate). See the storm report for details (checked AT(t2))');
 assert.equal(S.clientText({prep_status:'secured',post_status:'no_damage'},{},at,day).post,'Post-storm check: no damage found');
});

test('client storm email: branded, escaped, plain text alternative',()=>{
 const e=renderStormEmail({template:'secured',company:'Coastal <Care>',event_name:'Hurricane Milton',property_name:'Ocean <House>',address:'1 Ocean Dr',lines:['Your home was secured on Oct 7, 2026, 3:40 PM EDT.'],link:'https://estateaegis.com/login'});
 assert.equal(e.subject,'Ocean <House> is secured for Hurricane Milton');
 assert.ok(e.html.includes('Ocean &lt;House&gt;')&&!e.html.includes('<House>')&&e.html.includes('#7e202b'),'escaped and wine-branded');
 assert.ok(e.text.includes('Your home was secured on Oct 7, 2026, 3:40 PM EDT.')&&e.text.includes('https://estateaegis.com/login'));
 assert.match(renderStormEmail({template:'post_check_complete',company:'C',event_name:'E',property_name:'P',lines:[],link:'l'}).html,/View the storm report/);
});

test('storm report PDF: sections, disclaimer, time zone, no internal notes, no undrawable glyphs',()=>{
 const photos=new Map([['b',{id:'b',name:'North elevation.jpg',bytes:fixture,capturedAt:'2026-10-07T19:40:00Z',timezone:'America/Chicago'}],['a',{id:'a',name:'North elevation.jpg',bytes:fixture,capturedAt:'2026-10-10T15:00:00Z',timezone:'America/Chicago'}]]);
 const answers=[{key:'k1',section:'Exterior',label:'Roof covering intact',response_type:'pass_fail_na',status:'fail',note:'Shingles missing on the north slope'},{key:'k2',section:'Exterior',label:'Windows intact',response_type:'pass_fail_na',status:'pass',note:''},{key:'k3',section:'Documentation',label:'Insurance-ready damage notes',response_type:'text',status:'About 10 shingles gone.'}];
 const report={company:'Coastal Care',timezone:'America/Chicago',preparedAt:'2026-10-11T15:00:00Z',reference:'Storm report reference r1',event:{name:'Hurricane Milton',typeLabel:'Hurricane',expectedImpactAt:'2026-10-09T02:00:00Z',prepDeadlineAt:'2026-10-08T22:00:00Z'},residence:{name:'Ocean House',address:'1 Ocean Dr'},family:'Lee family',prepLabel:'Secured',prepTone:'done',postLabel:'Damage found',postTone:'issue',severity:'Moderate',
  pre:{id:'p1',date:'2026-10-07',dateLabel:'Oct 7, 2026',completedAt:'2026-10-07T19:45:00Z',inspector:'Leo Tech',reportNumber:'OH-20261007-1',checklistName:'Hurricane prep (version 1)',summary:'Shutters closed.',notes:'All secured.',answers:answers.slice(1,2),photoIds:['b'],verification:{label:'Verified',tone:'pass',rows:[['Arrived','Oct 7, 2026, 2:10 PM CDT']],notes:[]}},
  post:{id:'p2',date:'2026-10-10',dateLabel:'Oct 10, 2026',completedAt:'2026-10-10T15:30:00Z',inspector:'Mia Field',checklistName:'Post-storm (version 1)',summary:'Roof damage.',notes:'Roofer booked.',answers,photoIds:['a']},
  pairs:[{beforeId:'b',afterId:'a',match:'name'}],workOrders:[{title:'Roof covering intact',status:'Open',vendor:'Acme Roofing'}]};
 const raw=stormReportPdf(report,photos).toString('latin1'),pdf=words(raw);
 for(const part of ['Storm Report \x97 Hurricane Milton','Ocean House','Lee family','PRE-STORM PREP','Secured','Damage found','Moderate','Timeline','Pre-storm visit completed by Leo Tech','Expected hurricane impact','Oct 7, 2026, 2:45 PM CDT','Pre-storm condition','VISIT VERIFICATION','OH-20261007-1','Post-storm findings','Roof covering intact','Shingles missing on the north slope','About 10 shingles gone.','Before and after','Same photo name','BEFORE (PRE-STORM)','AFTER (POST-STORM)','Taken Oct 10, 2026, 10:00 AM CDT','Repair work orders','Acme Roofing','Notes to the client','Roofer booked.','Page 1 of','it is not an insurance','Storm report reference r1'])assert.ok(pdf.includes(part),'PDF has '+part);
 assert.ok(pdf.includes(disclaimer('Coastal Care').slice(0,60)),'disclaimer on the page');
 assert.equal((raw.match(/\/Subtype \/Image/g)||[]).length,2,'each photo is embedded once even when reused in before/after');
 assert.ok(!pdf.includes('?'),'no characters the fonts cannot draw');
 const empty=words(stormReportPdf({...report,pre:null,post:null,pairs:[],workOrders:[]},new Map()).toString('latin1'));
 assert.ok(empty.includes('No published pre-storm visit')&&empty.includes('No published post-storm visit')&&!empty.includes('Before and after'));
 const summary=words(stormSummaryPdf({company:'Coastal Care',preparedAt:'2026-10-11T15:00:00Z',event:{name:'Hurricane Milton',typeLabel:'Hurricane',statusLabel:'Recovery'},counts:{total:1,secured:1,noDamage:0,damageFound:1},rows:[{name:'Ocean House',family:'Lee',assigned:'Mia Field',prep:'Secured',post:'Damage found',severity:'Moderate',preDate:'Oct 7, 2026',postDate:'Oct 10, 2026'}]}).toString('latin1'));
 for(const part of ['Storm summary \x97 Hurricane Milton','RESIDENCES','DAMAGE FOUND','Ocean House','Mia Field','Damage found','Pre Oct 7, 2026'])assert.ok(summary.includes(part),'summary has '+part);
});

function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;},
 raw:endpoint=>fetch(srv.base+'/api/'+endpoint,{headers:{Cookie:cookie}})};return c;}
// Answer every item on a template visit: Pass by default, with chosen statuses by label fragment.
function answer(rows,choices={}){return rows.map(a=>{const pick=Object.entries(choices).find(([k])=>a.label.includes(k));const v=pick?pick[1]:null;
 if(a.response_type==='pass_fail_na')return {...a,status:v?.status||'pass',note:v?.note||''};
 if(a.response_type==='yes_no')return {...a,status:'yes',note:''};
 if(a.response_type==='number')return {...a,status:'80',note:''};
 if(a.response_type==='rating')return {...a,status:'4',note:''};
 if(a.response_type==='select')return {...a,status:a.options?.[0]||'unchecked',note:''};
 if(a.response_type==='multi_select')return {...a,status:a.options?.[0]||'unchecked',note:''};
 return {...a,status:v?.text||(a.required?'Recorded':'unchecked'),note:''};});}

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-storm-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),leo=client(srv),mia=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Coastal Care '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const lee=await admin.req('clients',{name:'Lee family'},201),park=await admin.req('clients',{name:'Park family',email:'park@example.test'},201);
  const addHome=(clientId,name,city,postalCode)=>admin.req('properties',{clientId,name,streetAddress:'1 '+name+' Rd',city,state:'FL',postalCode,country:'United States'},201);
  const ocean=await addHome(lee.id,'Ocean House','Stuart','34994'),palm=await addHome(park.id,'Palm Villa','Stuart','34996'),bay=await addHome(park.id,'Bay Cottage','Naples','34102');
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const leoU=(await accept(leo,'employee','leo@example.test','Leo Tech')).user,miaU=(await accept(mia,'employee','mia@example.test','Mia Field')).user;
  await accept(family,'client','lee@example.test','Ana Lee',{clientId:lee.id});
  const vend=await admin.req('vendors',{name:'Acme Roofing'},201);await accept(vendor,'vendor','vendor@example.test','Vic Vendor',{vendorId:vend.id});
  await admin.req('access',{userId:leoU.id,propertyId:ocean.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);
  const find=async(c,id)=>(await c.req('data')).inspections.find(i=>i.id===id);
  const board=async(c=admin)=>(await c.req('storm-events/'+ev.id)).event;
  const rowOf=(e,propertyId)=>e.residences.find(r=>r.property_id===propertyId);

  // ---- only admins manage storms; vendors see nothing; validation.
  await leo.req('storm-events',{name:'Nope'},403);await family.req('storm-events',{name:'Nope'},403);await vendor.req('storm',undefined,403);
  await admin.req('storm-events',{name:'Bad',type:'meteor'},422);await admin.req('storm-events',{name:'Bad',expectedImpactAt:'not a date'},422);await admin.req('storm-events',{name:''},422);
  let ev=(await admin.req('storm-events',{name:'Hurricane Milton',type:'hurricane',expectedImpactAt:'2026-10-09T02:00:00.000Z',prepDeadlineAt:'2026-10-08T22:00:00.000Z',notes:'Shutters first.'},201)).event;
  assert.equal(ev.status,'preparing');assert.equal(ev.type_label,'Hurricane');assert.equal(ev.counts.total,0);

  // ---- bulk residence selection: by filter (city), then by id; repeats are ignored; other companies' ids rejected.
  let added=await admin.req('storm-events/'+ev.id+'/residences',{filter:{city:'stuart'}});
  assert.equal(added.added,2);assert.deepEqual(added.event.residences.map(r=>r.property_name),['Ocean House','Palm Villa']);
  added=await admin.req('storm-events/'+ev.id+'/residences',{propertyIds:[bay.id,ocean.id]});assert.equal(added.added,1);assert.equal(added.alreadyIncluded,1);
  await admin.req('storm-events/'+ev.id+'/residences',{propertyIds:[randomUUID()]},422);
  await leo.req('storm-events/'+ev.id+'/residences',{propertyIds:[bay.id]},403);
  ev=await board();assert.equal(ev.counts.total,3);assert.ok(ev.residences.every(r=>r.prep_status==='not_started'&&r.post_status==='not_started'));

  // ---- bulk pre-storm visits, round robin. No Hurricane prep template yet: the starter one is published automatically.
  await leo.req('storm-events/'+ev.id+'/visits',{phase:'pre',date:'2026-10-07',assignment:'round_robin',userIds:[leoU.id,miaU.id]},403);
  await admin.req('storm-events/'+ev.id+'/visits',{phase:'pre',date:'2026-10-07',assignment:'round_robin',userIds:[randomUUID()]},422);
  const sched=await admin.req('storm-events/'+ev.id+'/visits',{phase:'pre',date:'2026-10-07',assignment:'round_robin',userIds:[leoU.id,miaU.id]},201);
  assert.equal(sched.created,3);assert.equal(sched.skipped.length,0);
  assert.equal(sched.template.name,'Hurricane prep');assert.equal(sched.template.created,true);assert.equal(sched.template.visit_type,'pre_storm');
  assert.deepEqual(sched.assignments.map(a=>[a.residence,a.assignee]),[['Bay Cottage','Leo Tech'],['Ocean House','Mia Field'],['Palm Villa','Leo Tech']],'dealt in name order');
  const again=await admin.req('storm-events/'+ev.id+'/visits',{phase:'pre',date:'2026-10-07',assignment:'round_robin',userIds:[leoU.id,miaU.id]},201);
  assert.equal(again.created,0);assert.equal(again.skipped.length,3,'repeat scheduling never creates a second visit');assert.match(again.skipped[0].reason,/Already has a pre-storm visit/);
  ev=await board();
  assert.ok(ev.residences.every(r=>r.prep_status==='scheduled'&&r.pre?.status==='draft'&&r.pre.date==='2026-10-07'));
  const oceanPre=rowOf(ev,ocean.id).pre_inspection_id,bayPre=rowOf(ev,bay.id).pre_inspection_id,palmPre=rowOf(ev,palm.id).pre_inspection_id;
  const visit=await find(admin,oceanPre);
  assert.equal(visit.visit_type,'pre_storm');assert.equal(visit.storm_event_id,ev.id);assert.equal(visit.inspector_id,miaU.id);assert.equal(visit.checklist.name,'Hurricane prep');
  const templates=(await admin.req('checklist-templates')).templates.filter(t=>t.visit_type==='pre_storm');assert.equal(templates.length,1,'one starter template, reused');
  assert.ok((await mia.req('notifications')).notifications.some(n=>n.kind==='storm_assigned'),'assignee gets an in-app storm notice');

  // ---- employees: only their storm residences. Mia (assigned by round robin, not the Residence Manager) can open Ocean House.
  const miaStorm=await mia.req('storm');assert.equal(miaStorm.canManage,false);assert.deepEqual(miaStorm.events[0].residences.map(r=>r.property_name),['Ocean House']);
  const leoStorm=await leo.req('storm');assert.deepEqual(leoStorm.events[0].residences.map(r=>r.property_name),['Bay Cottage','Ocean House','Palm Villa'],'assigned + managed');
  assert.ok((await mia.req('data')).properties.some(p=>p.id===ocean.id),'storm assignment opens the residence');
  await mia.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rowOf(ev,ocean.id).id],assignedUserId:leoU.id},403);
  await mia.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rowOf(ev,palm.id).id],prepStatus:'in_progress'},404);
  await mia.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rowOf(ev,ocean.id).id],prepStatus:'teleported'},422);
  await mia.req('storm-events/'+ev.id+'/summary.pdf',undefined,403);await mia.req('storm-events/'+ev.id+'/notify',{template:'secured',residenceIds:[rowOf(ev,ocean.id).id]},403);
  const miaCsv=await (await mia.raw('storm-events/'+ev.id+'/export.csv')).text();assert.equal(miaCsv.trim().split('\r\n').length,2,'employee CSV: header + their residence');

  // ---- offline completion: download the visit, save + submit with Idempotency-Key, replay both. Status updates on its own.
  const pack=await mia.req('offline/visits?propertyIds='+ocean.id);
  const packed=pack.inspections.find(v=>v.id===oceanPre);assert.ok(packed,'storm visit is in the offline pack');assert.equal(packed.storm_event_id,ev.id);assert.equal(packed.visit_type,'pre_storm');
  const preAnswers=answer(packed.answers,{'Shutters or panels installed':{status:'fail',note:'Shutter track bent on the east window'}});
  assert.ok(preAnswers.some(a=>a.status==='fail'),'a pre-storm item failed');
  const saveKey=randomUUID(),saveBody={id:oceanPre,version:packed.version,answers:preAnswers,summary:'Secured. One shutter track bent.',notes:'Shutters closed on all windows but one.',internalNotes:'INTERNAL-PRE-SECRET'};
  const saved=await mia.req('inspections/save',saveBody,201,{'Idempotency-Key':saveKey});
  const replay=await mia.call('POST','inspections/save',saveBody,{'Idempotency-Key':saveKey});assert.equal(replay.status,201);assert.equal(replay.headers.get('idempotency-replayed'),'true');assert.deepEqual(replay.body,saved);
  assert.equal(rowOf(await board(),ocean.id).prep_status,'in_progress','results recorded: In progress');
  await mia.req('files',{propertyId:ocean.id,inspectionId:oceanPre,name:'North elevation.jpg',capturedAt:new Date(Date.now()-3*3600000).toISOString(),base64:fixture.toString('base64')},201,{'Idempotency-Key':randomUUID()});
  await mia.req('files',{propertyId:ocean.id,inspectionId:oceanPre,name:'IMG_0001.jpg',capturedAt:new Date(Date.now()-3*3600000+60000).toISOString(),base64:fixture.toString('base64')},201,{'Idempotency-Key':randomUUID()});
  const submitKey=randomUUID(),submitBody={id:oceanPre,version:saved.version};
  await mia.req('inspections/submit',submitBody,201,{'Idempotency-Key':submitKey});
  const resubmit=await mia.call('POST','inspections/submit',submitBody,{'Idempotency-Key':submitKey});assert.equal(resubmit.status,201);assert.equal(resubmit.headers.get('idempotency-replayed'),'true');
  ev=await board();let ro=rowOf(ev,ocean.id);
  assert.equal(ro.prep_status,'secured');assert.equal(ro.prep_issues,1);assert.equal(ro.prep_label,'Secured with issues');assert.equal(ro.prep_tone,'issue');
  assert.equal(ev.counts.secured,1);assert.equal(ev.counts.securedWithIssues,1);
  await admin.req('inspections/publish',{id:oceanPre,version:(await find(admin,oceanPre)).version,idempotencyKey:randomUUID()},201);

  // ---- a draft storm visit deleted: the residence can be scheduled again.
  await leo.req('inspections/delete',{id:bayPre,version:(await find(leo,bayPre)).version},201);
  let rb=rowOf(await board(),bay.id);assert.equal(rb.pre_inspection_id,null);assert.equal(rb.prep_status,'not_started');
  // ---- manual statuses; internal notes; CSV formula guard.
  await admin.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rowOf(ev,palm.id).id],prepStatus:'client_declined'});
  await admin.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rb.id],internalNotes:'=HYPERLINK("http://x")'});
  await admin.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rb.id,rowOf(ev,palm.id).id],internalNotes:'x'},422);
  await admin.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rowOf(ev,ocean.id).id],internalNotes:'BOARD-SECRET gate code 1234'});
  const csv=await (await admin.raw('storm-events/'+ev.id+'/export.csv')).text();
  assert.ok(csv.replace(/^\ufeff/,'').startsWith('"Residence","Address","Family"'));assert.equal(csv.trim().split('\r\n').length,4);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`),'formulas neutralised');assert.ok(csv.includes('"Secured with issues"')&&csv.includes('"Client declined"'));
  const pre2=await admin.req('storm-events/'+ev.id+'/visits',{phase:'pre',date:'2026-10-07',assignment:'residence_manager'},201);
  assert.equal(pre2.created,1,'only Bay Cottage: Ocean and Palm already have visits');assert.equal(pre2.assignments[0].assignee,'Owner','no Residence Manager: assigned to the admin');assert.match(pre2.assignments[0].note,/No Residence Manager/);
  assert.equal(pre2.template.created,false);assert.deepEqual(pre2.skipped.map(s=>s.residence).sort(),['Ocean House','Palm Villa']);

  // ---- client notices: preview, send, de-duplicated; skips with reasons.
  ev=await board();ro=rowOf(ev,ocean.id);rb=rowOf(ev,bay.id);const rp=rowOf(ev,palm.id);
  const preview=await admin.req('storm-events/'+ev.id+'/notify',{template:'secured',residenceIds:[ro.id,rp.id],preview:true});
  assert.deepEqual(preview.recipients.map(r=>[r.residence,r.emails]),[['Ocean House',['lee@example.test']]]);assert.deepEqual(preview.skipped.map(s=>s.reason),['Not secured yet']);
  assert.match(preview.sample.subject,/Ocean House is secured for Hurricane Milton/);assert.match(preview.sample.text,/Your home was secured on [A-Z][a-z]{2} \d+, 20\d\d, \d+:\d\d [AP]M E[SD]T/);
  const sent=await admin.req('storm-events/'+ev.id+'/notify',{template:'secured',residenceIds:[ro.id,rp.id]});
  assert.equal(sent.notified,1);assert.equal(sent.emails,1);assert.equal(sent.inApp,1);
  const resent=await admin.req('storm-events/'+ev.id+'/notify',{template:'secured',residenceIds:[ro.id]});assert.equal(resent.notified,0);assert.equal(resent.skipped[0].reason,'Already sent');
  const planned=await admin.req('storm-events/'+ev.id+'/notify',{template:'prep_planned',residenceIds:[rb.id]});assert.equal(planned.emails,1,'no portal account: the family email on file');assert.equal(planned.inApp,0);
  const email=(await admin.req('operations')).email||[];
  assert.ok(JSON.stringify(email).includes('Ocean House is secured for Hurricane Milton')||email.length===0,'email queued in the outbox');
  assert.ok((await family.req('notifications')).notifications.some(n=>n.kind==='storm_secured'),'client gets an in-app Secured notice');
  ev=await board();assert.ok(rowOf(ev,ocean.id).client_prep_notified_at,'notified time recorded');

  // ---- recovery: offers post-storm visits for secured homes; post visit assigned to one person.
  await leo.req('storm-events/'+ev.id+'/recovery',{},403);
  const rec=await admin.req('storm-events/'+ev.id+'/recovery',{});assert.equal(rec.event.status,'recovery');assert.deepEqual(rec.securedWithoutPostVisit,[ro.id]);
  const post=await admin.req('storm-events/'+ev.id+'/visits',{phase:'post',date:'2026-10-10',assignment:'user',userId:miaU.id,residenceIds:rec.securedWithoutPostVisit},201);
  assert.equal(post.created,1);assert.equal(post.template.name,'Post-storm');assert.equal(post.template.created,true);
  const oceanPost=post.assignments[0].inspectionId;
  ev=await board();assert.equal(rowOf(ev,ocean.id).post_status,'scheduled');
  // Mia completes the post-storm visit: two failures + one monitor = damage found, moderate.
  const postRow=await find(mia,oceanPost);assert.equal(postRow.visit_type,'post_storm');
  const postAnswers=answer(postRow.answers,{'Roof intact':{status:'fail',note:'Shingles missing on the north slope'},'Windows and doors intact':{status:'fail',note:'Cracked pane in the primary bedroom'},'Pool and screen enclosure':{status:'monitor',note:'Debris in the pool'},'Insurance-ready damage notes':{text:'About ten shingles gone; one cracked window.'}});
  assert.equal(postAnswers.filter(a=>a.status==='fail').length,2,'two failed items: '+postRow.answers.map(a=>a.label).join(' | '));
  const ps=await mia.req('inspections/save',{id:oceanPost,version:postRow.version,answers:postAnswers,summary:'Roof and window damage.',notes:'Roofer booked for Monday.',internalNotes:'INTERNAL-POST-SECRET'},201);
  await mia.req('files',{propertyId:ocean.id,inspectionId:oceanPost,name:'North elevation.jpg',capturedAt:new Date(Date.now()-600000).toISOString(),base64:fixture.toString('base64')},201);
  await mia.req('inspections/submit',{id:oceanPost,version:ps.version},201);
  assert.equal(rowOf(await board(),ocean.id).post_status,'in_progress','submitted, waiting for review');
  await admin.req('inspections/publish',{id:oceanPost,version:(await find(admin,oceanPost)).version,idempotencyKey:randomUUID()},201);
  ev=await board();ro=rowOf(ev,ocean.id);
  assert.equal(ro.post_status,'damage_found');assert.equal(ro.damage_severity,'moderate');assert.equal(ro.post_tone,'issue');assert.equal(ev.counts.damageFound,1);assert.equal(ro.report_available,true);
  // Follow-up repair work from a finding is linked to the storm.
  const finding=(await find(admin,oceanPost)).answers.find(a=>a.status==='fail');
  await admin.req('operations/followup',{inspectionId:oceanPost,answerKey:finding.key});
  ev=await board();assert.equal(ev.workOrders.length,1);assert.equal(ev.workOrders[0].title,finding.label);

  // ---- client portal: plain language for their own residence only; the storm report once a visit is published.
  const portal=(await family.req('storm')).portal;assert.equal(portal.length,1,'only the Lee family residence');
  assert.equal(portal[0].propertyName,'Ocean House');assert.match(portal[0].prep,/^Your home was secured on [A-Z][a-z]{2} \d+, 20\d\d, \d+:\d\d [AP]M E[SD]T\. A few items need attention/);
  assert.match(portal[0].post,/^Post-storm check: damage found \(moderate\)/);assert.ok(portal[0].reportUrl);
  assert.ok(!JSON.stringify(portal).includes('SECRET'),'no internal notes in the portal');
  await family.req('storm-events/'+ev.id,undefined,403);await family.req('storm-events/'+ev.id+'/export.csv',undefined,403);
  const pdfRes=await family.raw(portal[0].reportUrl.slice(5));assert.equal(pdfRes.status,200);assert.equal(pdfRes.headers.get('content-type'),'application/pdf');
  assert.match(pdfRes.headers.get('content-disposition'),/Storm-Report-Hurricane-Milton-Ocean-House\.pdf/);
  const report=words(Buffer.from(await pdfRes.arrayBuffer()).toString('latin1'));
  for(const part of ['Storm Report \x97 Hurricane Milton','Ocean House','Lee family','Secured with issues','Damage found','Moderate','Pre-storm visit completed by Mia Field','Shutter track bent on the east window','Shingles missing on the north slope','About ten shingles gone; one cracked window.','Debris in the pool','Before and after','Same photo name','Taken ','EDT','Repair work orders',finding.label,'Roofer booked for Monday.','Notes to the client','not an insurance adjuster','Page 1 of'])assert.ok(report.includes(part),'storm report has '+part);
  assert.ok(!report.includes('SECRET'),'internal notes never reach the storm report');
  assert.equal((await family.raw('storm-events/'+ev.id+'/residences/'+rb.id+'/report.pdf')).status,404,'another family\'s residence');
  assert.equal((await outsider.raw('storm-events/'+ev.id+'/residences/'+ro.id+'/report.pdf')).status,404,'another company');
  assert.equal((await admin.raw('storm-events/'+ev.id+'/residences/'+rb.id+'/report.pdf')).status,200,'staff can preview a report before visits are published');
  const summary=await admin.raw('storm-events/'+ev.id+'/summary.pdf');assert.equal(summary.status,200);
  const st=words(Buffer.from(await summary.arrayBuffer()).toString('latin1'));for(const part of ['Storm summary \x97 Hurricane Milton','Ocean House','Bay Cottage','Damage found','Client declined'])assert.ok(st.includes(part),'summary has '+part);

  // ---- company isolation.
  await outsider.req('storm-events/'+ev.id,undefined,404);assert.deepEqual((await outsider.req('storm')).events,[]);
  await outsider.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[ro.id],prepStatus:'secured'},404);

  // ---- remove: completed visits keep a residence on the storm; draft visits are unlinked.
  await admin.req('storm-events/'+ev.id+'/residences/remove',{residenceIds:[ro.id]},409);
  const bayDraft=rowOf(ev,bay.id).pre_inspection_id;
  await admin.req('storm-events/'+ev.id+'/residences/remove',{residenceIds:[rowOf(ev,bay.id).id]});
  assert.equal((await find(admin,bayDraft)).storm_event_id,null,'the draft stays as an ordinary visit');
  assert.equal((await board()).counts.total,2);

  // ---- closing: read-only for employees; storm-only access ends.
  ev=await board();
  await admin.req('storm-events/'+ev.id,{version:ev.version,status:'closed'});
  await admin.req('storm-events/'+ev.id,{version:ev.version,status:'closed'},409);
  ev=await board();assert.equal(ev.status,'closed');assert.ok(ev.closed_at);
  assert.ok(!(await mia.req('data')).properties.some(p=>p.id===ocean.id),'closed storm: assignment no longer opens the residence');
  await leo.req('storm-events/'+ev.id+'/residences/update',{residenceIds:[rowOf(ev,palm.id).id],prepStatus:'secured'},409);
  await admin.req('storm-events/'+ev.id+'/visits',{phase:'post',date:'2026-10-10',assignment:'residence_manager'},409);
  assert.equal((await family.req('storm')).portal[0].reportUrl!=='',true,'closed storms keep the report for the family');
 }catch(error){error.message+='\n'+srv.log.slice(-3000);throw error;}
 finally{await srv.stop();}
}
test('storm workflow on SQLite',()=>scenario('SQLite',{}));
test('storm workflow on Postgres (PGlite)',()=>scenario('PG',{pg:true}));
