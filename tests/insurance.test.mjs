// Insurance and vacancy compliance center: the compliance rules (insurance-core.mjs) including time zone and
// boundary cases, alerts once per window (in-app + email through the outbox, never email for demo companies),
// renewal reminders, the visit history certificate PDF, expiring/revocable share links, permissions and company
// isolation. Server scenarios run on SQLite and on Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as R from '../insurance-core.mjs';
import {createInsurance,renderInsuranceEmail,tokenHash,newToken} from '../insurance.mjs';
import {certificatePdf,CERTIFICATE_DISCLAIMER} from '../insurance-pdf.mjs';
import {createFailAlerts} from '../fail-alerts.mjs';
import {openDatabase} from '../database.mjs';
import '../public/overview-core.js';
import '../public/sidebar-core.js';
import '../public/view-route.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-insurance-'));dirs.push(d);return d;};
const words=pdf=>[...pdf.matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');
const profile=(f={})=>({inspect_every_days:7,warn_days:3,rule_started_at:'2026-09-01T12:00:00Z',...f});
const vacant=since=>({state:'vacant',since});

// ---------- compliance math ----------
test('compliance: not set up, owners in residence, OK, due soon, at risk and breached',()=>{
 assert.equal(R.evaluate({profile:null,today:'2026-10-04'}).code,'not_set');
 assert.equal(R.evaluate({profile:{inspect_every_days:null},today:'2026-10-04'}).code,'not_set','a profile without the interval is not tracked');
 const occ=R.evaluate({profile:profile(),occ:{state:'occupied',since:'2026-09-28T15:00:00Z'},lastVisitDay:'2026-08-01',today:'2026-10-04'});
 assert.equal(occ.code,'ok');assert.equal(occ.occupied,true);assert.match(occ.reason,/Owners in residence since Sep 28, 2026/);
 const base={profile:profile(),occ:vacant('2026-09-01T12:00:00Z'),lastVisitDay:'2026-09-30',today:'2026-10-04'};
 const ok=R.evaluate({...base,lastVisitDay:'2026-10-01',scheduledDays:['2026-10-06']});assert.equal(ok.code,'ok');assert.equal(ok.deadline,'2026-10-08');assert.equal(ok.daysLeft,4);
 assert.equal(R.evaluate({...base,profile:profile({warn_days:2}),scheduledDays:['2026-10-06']}).code,'ok','3 days left is outside a 2-day warning window');
 assert.equal(R.evaluate({...base,scheduledDays:['2026-10-06']}).code,'due_soon','3 days left is inside the default 3-day window');
 const risk=R.evaluate({...base,scheduledDays:['2026-10-08']});assert.equal(risk.code,'at_risk','a visit booked after the deadline does not count');assert.match(risk.reason,/none is scheduled/);
 assert.equal(R.evaluate({...base,scheduledDays:[]}).code,'at_risk');
 assert.equal(R.evaluate({...base,scheduledDays:['2026-10-01']}).code,'at_risk','a scheduled day in the past does not count');
 const far=R.evaluate({...base,profile:profile({inspect_every_days:30}),scheduledDays:[]});assert.equal(far.code,'at_risk','at risk even when the deadline is weeks away and nothing is booked');assert.equal(far.daysLeft,26);
});

test('compliance boundaries: a visit on the deadline day is in time; the next day is a breach',()=>{
 const base={profile:profile(),occ:vacant('2026-09-01T12:00:00Z'),lastVisitDay:'2026-09-27',scheduledDays:['2026-10-04']};
 const onDay=R.evaluate({...base,today:'2026-10-04'});assert.equal(onDay.daysLeft,0);assert.equal(onDay.code,'due_soon');assert.match(onDay.reason,/due today/);
 const after=R.evaluate({...base,today:'2026-10-05'});assert.equal(after.code,'breached');assert.equal(after.daysLeft,-1);assert.match(after.reason,/1 day overdue/);
 const done=R.evaluate({...base,lastVisitDay:'2026-10-04',today:'2026-10-04',scheduledDays:['2026-10-09']});assert.equal(done.code,'ok','a visit completed today restarts the clock');assert.equal(done.deadline,'2026-10-11');
 assert.equal(R.evaluate({...base,profile:profile({warn_days:0}),lastVisitDay:'2026-09-28',today:'2026-10-04',scheduledDays:['2026-10-05']}).code,'ok','warn_days 0: no due-soon window');
});

test('compliance clock starts at the latest of last visit, vacancy start and rule start',()=>{
 const t='2026-10-04';
 assert.equal(R.evaluate({profile:profile(),occ:vacant('2026-10-01T16:00:00Z'),lastVisitDay:'2026-09-10',today:t}).clockStart,'2026-10-01','owners left after the last visit');
 assert.equal(R.evaluate({profile:profile({rule_started_at:'2026-10-03T12:00:00Z'}),occ:vacant(null),lastVisitDay:'2026-09-01',today:t}).clockStart,'2026-10-03','a rule added later does not back-date a breach');
 assert.equal(R.evaluate({profile:profile({rule_started_at:null}),occ:vacant(null),lastVisitDay:null,today:t}).clockStart,t,'no history at all: the clock starts today');
 assert.equal(R.evaluate({profile:profile({rule_started_at:'2026-12-01T00:00:00Z'}),occ:vacant(null),lastVisitDay:'2026-09-30',today:t}).clockStart,'2026-09-30','a future rule start is ignored');
});

test('compliance in the residence time zone: the same instant can be a breach in New York and not in Los Angeles',()=>{
 const instant='2026-10-06T05:30:00Z';// 1:30 AM Oct 6 in New York, 10:30 PM Oct 5 in Los Angeles
 assert.equal(R.localDay(instant,'America/New_York'),'2026-10-06');assert.equal(R.localDay(instant,'America/Los_Angeles'),'2026-10-05');
 assert.equal(R.localDay(instant,'Not/AZone'),'2026-10-06','invalid zones fall back to Eastern');
 const p=profile(),occ=vacant('2026-09-01T12:00:00Z');
 assert.equal(R.evaluate({profile:p,occ,lastVisitDay:'2026-09-28',today:R.localDay(instant,'America/New_York'),timezone:'America/New_York'}).code,'breached');
 assert.equal(R.evaluate({profile:p,occ,lastVisitDay:'2026-09-28',today:R.localDay(instant,'America/Los_Angeles'),timezone:'America/Los_Angeles'}).code,'at_risk');
 // Vacancy start is an instant too: owners leaving at 11 PM Pacific count from that Pacific day.
 assert.equal(R.evaluate({profile:p,occ:vacant('2026-10-02T06:00:00Z'),today:'2026-10-04',timezone:'America/Los_Angeles'}).vacantSince,'2026-10-01');
});

test('maximum vacancy: due soon near the limit, breached past it, even with visits on time',()=>{
 const base={profile:profile({max_vacancy_days:60}),lastVisitDay:'2026-10-03',scheduledDays:['2026-10-08'],today:'2026-10-04'};
 assert.equal(R.evaluate({...base,occ:vacant('2026-08-10T12:00:00Z')}).code,'ok');
 const near=R.evaluate({...base,occ:vacant('2026-08-07T12:00:00Z')});assert.equal(near.vacancyLeft,2);assert.equal(near.code,'due_soon');assert.match(near.reason,/vacancy limit/);
 const at=R.evaluate({...base,occ:vacant('2026-08-05T12:00:00Z')});assert.equal(at.vacancyLeft,0);assert.equal(at.code,'due_soon','exactly at the limit is still allowed');
 const over=R.evaluate({...base,occ:vacant('2026-08-04T12:00:00Z')});assert.equal(over.code,'breached');assert.match(over.reason,/Unoccupied for 61 days; the policy allows 60 days/);
 assert.equal(R.evaluate({...base,occ:vacant(null)}).vacancyLeft,null,'unknown vacancy start: the limit cannot be measured');
 assert.equal(R.evaluate({...base,occ:{state:'occupied',since:'2026-08-01T00:00:00Z'}}).code,'ok','no vacancy limit while occupied');
});

test('occupancy: latest past event wins, future events and unknown states are ignored',()=>{
 const now='2026-10-04T12:00:00Z';
 assert.deepEqual(R.occupancy([],now),{state:'vacant',since:null,source:'none'});
 const ev=[{at:'2026-09-01T10:00:00Z',state:'occupied',source:'arrival'},{at:'2026-09-20T10:00:00Z',state:'vacant',source:'departure_visit'},{at:'2026-10-10T10:00:00Z',state:'occupied',source:'arrival'},{at:'2026-09-25',state:'sleeping'}];
 assert.deepEqual(R.occupancy(ev,now),{state:'vacant',since:'2026-09-20T10:00:00Z',source:'departure_visit'});
 assert.equal(R.occupancy([...ev,{at:'2026-09-20T10:00:00Z',state:'occupied',source:'manual'}],now).state,'occupied','same instant: the later entry wins');
});

test('renewal window and checklist; devices are always the four known kinds',()=>{
 assert.deepEqual(R.renewal({renewal_date:'2026-11-03'},'2026-10-04'),{due:true,passed:false,daysLeft:30});
 assert.equal(R.renewal({renewal_date:'2026-11-04'},'2026-10-04').due,false,'31 days out: not yet');
 assert.equal(R.renewal({renewal_date:'2026-10-04'},'2026-10-04').due,true,'renewal day itself');
 assert.deepEqual(R.renewal({renewal_date:'2026-10-03'},'2026-10-04'),{due:false,passed:true,daysLeft:-1});
 assert.equal(R.renewal({renewal_date:''},'2026-10-04').due,false);
 const devices=R.parseDevices('[{"key":"other","name":"Freeze sensor","required":true,"file_id":"f1"},{"key":"bogus"},"x",null]');
 assert.deepEqual(devices.map(d=>d.key),['water_shutoff','monitored_alarm','generator','other']);
 assert.equal(devices[3].label,'Freeze sensor');assert.equal(devices[3].file_id,'f1');
 assert.equal(R.parseDevices('not json').length,4);
 const list=R.renewalChecklist({inspect_every_days:14,max_vacancy_days:90,devices:JSON.stringify([{key:'water_shutoff',required:true}])});
 assert.ok(list.some(i=>i.includes('every 14 days')&&i.includes('90 days')));assert.ok(list.some(i=>i.startsWith('Automatic water shut-off: required (add a photo')));
 assert.ok(list.some(i=>i.includes('certificate')));
});

test('alert and renewal emails: escaped, branded, with the checklist',()=>{
 const base={company:'Harbor <Co>',property_name:'Cedar House',address:'4 Cedar Ln',carrier:'Example Mutual',policy_number:'P-1',status_label:'At risk',reason:'Visit due by Oct 7, 2026, but none is scheduled before then.',deadline_label:'Oct 7, 2026',due_label:'by Oct 7, 2026',renewal_label:'Nov 3, 2026',days_left:30,checklist:['Confirm the carrier.','Send the visit history certificate to the broker.'],link:'https://app.example.test/login'};
 const pre=renderInsuranceEmail({...base,kind:'pre_breach'});assert.equal(pre.subject,'Insurance visit due by Oct 7, 2026 at Cedar House');
 assert.ok(pre.html.includes('Harbor &lt;Co&gt;')&&!pre.html.includes('Harbor <Co>'));assert.ok(pre.text.includes('none is scheduled'));assert.ok(pre.html.includes('#7e202b'));
 assert.equal(renderInsuranceEmail({...base,kind:'breach'}).subject,'Insurance visit overdue at Cedar House');
 const ren=renderInsuranceEmail({...base,kind:'renewal'});assert.equal(ren.subject,'Policy renewal in 30 days: Cedar House');
 for(const part of ['Confirm the carrier.','Send the visit history certificate to the broker.','Nov 3, 2026'])assert.ok(ren.text.includes(part)&&ren.html.includes(part),part);
});

test('certificate PDF: company, residence, policy, visits with times and GPS check, findings and the disclaimer',()=>{
 const cert={company:'Harborline Home Watch',companyLogo:'',timezone:'America/Phoenix',preparedAt:'2026-10-04T16:00:00Z',fromLabel:'Oct 4, 2025',toLabel:'Oct 4, 2026',reference:'VC-ABCD1234',residence:{name:'Saguaro Ridge',address:'88 Desert Bloom Road, Scottsdale, AZ'},policyholder:'Okafor family',policy:{carrier:'Desert Sun Home Insurance',number:'DS-1',renewal:'Feb 21, 2027',rule:'Inspect at least every 14 days while unoccupied'},status:{label:'Breached',code:'breached',reason:'Visit was due by Oct 2, 2026.'},devices:[{label:'Monitored alarm',required:true,discount:false,installed:true,proof:true}],visits:[{dateLabel:'Sep 18, 2026',type:'Routine visit',inspector:'Casey Morgan',arrived:'7:10 AM MST',departed:'7:48 AM MST',verified:true,verification:'GPS verified at the residence',findings:{pass:3,monitor:1,attention:0},summary:'All clear.',reportNumber:'HHW-1'},{dateLabel:'Sep 4, 2026',type:'Departure visit',inspector:'Jordan Ellis',arrived:'',departed:'',verified:false,verification:'Not checked in',findings:{pass:0,monitor:0,attention:0},summary:'',reportNumber:''}],verifiedCount:1,longestGap:14,disclaimer:CERTIFICATE_DISCLAIMER('Harborline Home Watch')};
 const pdf=certificatePdf(cert);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
 const text=words(pdf.toString('latin1'));
 for(const part of ['Harborline Home Watch','VISIT HISTORY CERTIFICATE','Saguaro Ridge','Desert Sun Home Insurance','DS-1','Feb 21, 2027','Inspect at least every 14 days','Sep 18, 2026','7:10 AM MST to 7:48 AM MST','GPS verified at the residence','Not checked in','3 passed, 1 to monitor','1 of 2','14 days','Breached','Monitored alarm','Required by the policy','America/Phoenix','VC-ABCD1234','All clear.'])assert.ok(text.includes(part),'certificate has '+part);
 assert.ok(text.includes("not an insurance adjuster's assessment"),'disclaimer');
 const empty=words(certificatePdf({...cert,visits:[],verifiedCount:0,longestGap:null,devices:[]}).toString('latin1'));
 assert.ok(empty.includes('No published visits in this period.')&&!empty.includes('Protective devices'));
});

test('menus and routes: Insurance compliance is a staff page under Residences; clients and vendors never get it',()=>{
 const S=globalThis.EASidebar,V=globalThis.EARoute;
 const ids=role=>S.navFor({role}).map(n=>n[0]);
 assert.ok(ids('admin').includes('insurance')&&ids('employee').includes('insurance'));
 assert.ok(!ids('client').includes('insurance')&&!ids('vendor').includes('insurance'));
 const res=S.menu(S.navFor({role:'admin'}),'admin').sections.find(s=>s.title==='Residences');
 assert.deepEqual(res.items.slice(0,2).map(i=>i.label),['Residences','Insurance compliance']);
 assert.equal(V.resolve(V.parse('#/insurance'),{user:{role:'admin'}}).state.page,'insurance');
 assert.equal(V.resolve(V.parse('#/insurance'),{user:{role:'client'}}).fellBack,true);
 const html=readFileSync(path.join(root,'public/live.html'),'utf8');
 assert.ok(html.indexOf('/insurance.js')>html.indexOf('/storm.js')&&html.indexOf('/insurance.js')<html.indexOf('/view-route.js'));
 const pkg=readFileSync(path.join(root,'package.json'),'utf8');for(const f of ['public/insurance.js','public/certificate.js','insurance.mjs','insurance-core.mjs','insurance-pdf.mjs'])assert.ok(pkg.includes('node --check '+f),'check script covers '+f);
 for(const f of ['public/insurance.js','public/certificate.js','public/certificate.html'])assert.ok(!/<script>|style="/.test(readFileSync(path.join(root,f),'utf8')),f+': no inline scripts or styles');
});

test('overview "Needs your attention": breached, at risk and due soon residences, and renewals for admins',()=>{
 const O=globalThis.EAOverview;
 const data={user:{id:'a',role:'admin'},properties:[{id:'p1',name:'Cedar House'},{id:'p2',name:'Bay Cottage'},{id:'p3',name:'Pine Lodge'}],inspections:[],work:[],requests:[],users:[],
  insurance:{residences:[{property_id:'p1',name:'Cedar House',status:{code:'breached',label:'Breached',reason:'Visit was due by Oct 2.',deadline:'2026-10-02',daysLeft:-2}},{property_id:'p2',name:'Bay Cottage',status:{code:'ok',label:'OK',reason:''},renewal:{date:'2026-10-20',due:true,daysLeft:16}},{property_id:'p3',name:'Pine Lodge',status:{code:'at_risk',label:'At risk',reason:'None scheduled.',deadline:'2026-10-09',daysLeft:5}}]}};
 const att=O.attention(data,{today:'2026-10-04'});
 const ins=att.items.filter(i=>i.group==='insurance');
 assert.deepEqual(ins.map(i=>i.id),['insurance:p1','insurance:p3','renewal:p2']);
 assert.equal(ins[0].tone,'fail');assert.equal(ins[0].action.name,'insurance-open');
 assert.equal(att.counts.insurance,3);assert.ok(att.primary.some(i=>i.group==='insurance'));
 assert.equal(O.GROUP_TITLES.insurance,'Insurance compliance');
 assert.match(O.summary(att,[],{today:'2026-10-04'}).line,/3 insurance items/);
 const staff=O.attention({...data,user:{id:'e',role:'employee'}},{today:'2026-10-04'});
 assert.ok(!staff.items.some(i=>i.id==='renewal:p2'),'renewal reminders are for admins');
 assert.equal(O.attention({...data,user:{id:'c',role:'client'}},{today:'2026-10-04'}).items.filter(i=>i.group==='insurance').length,0);
});

// ---------- alerts, renewal reminders and share-link expiry (module level, controllable clock) ----------
async function moduleScenario(label,dbEnv){
 const db=await openDatabase(root,dbEnv);
 try{
  const t='2026-09-01T12:00:00.000Z',ins=(sql,...a)=>db.run(sql,...a);
  let clock='2026-10-04T15:00:00.000Z';const now=()=>clock;let n=0;const id=()=>label+'-id-'+(++n);
  for(const org of ['org','demo']){await ins('INSERT INTO organizations VALUES(?,?,?)',org,org==='org'?'Cedar Care':'Demo Co',t);await ins('INSERT INTO workspace_settings(organization_id) VALUES(?)',org);}
  const user=(uid,org,role,email,active=1)=>ins('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',uid,org,uid,email,'x',role,null,null,active,t);
  await user('admin1','org','admin','a1@example.test');await user('gone','org','admin','gone@example.test',0);await user('mgr','org','employee','mgr@example.test');await user('other','org','employee','other@example.test');
  await user('dadmin','demo','admin','d@example.test');
  await ins("INSERT INTO demo_workspaces(organization_id,admin_id,expires_at,reset_at) VALUES('demo','dadmin',?,?)",Date.now()+86400000,t);
  for(const org of ['org','demo'])await ins('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)','fam-'+org,org,'Family',t);
  await ins("INSERT INTO properties(id,organization_id,client_id,name,address,timezone,created_at,account_manager_id) VALUES('west','org','fam-org','West House','1 Pacific Ave','America/Los_Angeles',?,'mgr')",t);
  await ins("INSERT INTO properties(id,organization_id,client_id,name,address,timezone,created_at) VALUES('demohome','demo','fam-demo','Demo Home','2 Demo St','America/New_York',?)",t);
  const policy=(pid,org,f={})=>ins('INSERT INTO insurance_policies(property_id,organization_id,carrier,policy_number,renewal_date,inspect_every_days,max_vacancy_days,warn_days,devices,rule_started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',pid,org,'Example Mutual','P-77',f.renewal||null,7,null,3,'[]','2026-09-01T12:00:00.000Z',t,t);
  await policy('west','org',{renewal:'2026-11-03'});await policy('demohome','demo');
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,visit_type,submitted_at,published_at,report_snapshot) VALUES('v1','west','mgr','2026-09-28','published','[]','Fine',?,'routine',?,?,'{}')",t,'2026-09-28T18:00:00.000Z','2026-09-28T19:00:00.000Z');
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,visit_type) VALUES('d1','demohome','dadmin','2026-09-28','published','[]','Fine',?,'routine')",t);
  const logs=[],failAlerts=createFailAlerts({...db,id,now,fail(){},json(){},body(){}});
  const vv={settings:async()=>({timezone:''}),timezoneFor:p=>p.timezone,visitRow:async()=>null};
  const fail=(s,m)=>{throw Object.assign(Error(m),{status:s});};
  const res=()=>({status:0,headers:{},body:null,writeHead(s,h){this.status=s;Object.assign(this.headers,h||{});},end(b){this.body=b;}});
  const json=(r,s,d)=>{r.status=s;r.data=d;};
  const insurance=createInsurance({...db,id,now,fail,json,body:async()=>({}),roles(){},property:async()=>{},audit:async()=>{},visitVerification:vv,failAlerts,readFile(){},readBytes(){}},{env:{APP_URL:'https://app.example.test'},log:m=>logs.push(m)});

  // Oct 4, 8 AM Pacific: due Oct 5, nothing scheduled -> at risk inside the warning window: one pre-breach alert.
  const status=async pid=>(await insurance.compute('org',[await db.get('SELECT * FROM properties WHERE id=?',pid)])).get(pid).status;
  assert.equal((await status('west')).code,'at_risk');
  const westAlerts=async()=>(await db.all("SELECT kind FROM insurance_alerts WHERE property_id='west' ORDER BY kind")).map(a=>a.kind);
  await insurance.tick();assert.deepEqual(await westAlerts(),['pre_breach','renewal'],'pre-breach + renewal (30 days before Nov 3)');
  assert.deepEqual((await db.all("SELECT user_id FROM notifications WHERE kind='insurance_pre_breach' AND entity_id='west' ORDER BY user_id")).map(x=>x.user_id),['admin1','mgr'],'active admins plus the Residence Manager; not other staff or inactive admins');
  assert.deepEqual((await db.all("SELECT user_id FROM notifications WHERE kind='insurance_renewal' AND entity_id='west' ORDER BY user_id")).map(x=>x.user_id),['admin1','mgr']);
  const mail=await db.all("SELECT email,subject,body FROM email_outbox WHERE organization_id='org' ORDER BY subject,email");
  assert.deepEqual(mail.map(m=>m.email),['a1@example.test','mgr@example.test','a1@example.test','mgr@example.test']);
  assert.ok(mail.some(m=>m.subject==='Insurance visit due tomorrow at West House'));
  assert.ok(mail.some(m=>m.subject==='Policy renewal in 30 days: West House'&&m.body.includes('Send the visit history certificate to the broker.')));
  await insurance.tick();assert.equal((await westAlerts()).length,2,'once per window: a second run sends nothing');assert.equal((await db.all("SELECT id FROM notifications WHERE kind='insurance_pre_breach' AND entity_id='west'")).length,2);
  // Oct 6, 5:30 UTC = Oct 5 10:30 PM Pacific: still the deadline day there, no breach yet.
  clock='2026-10-06T05:30:00.000Z';assert.equal((await status('west')).code,'at_risk');await insurance.tick();assert.equal((await westAlerts()).length,2);
  // Oct 6, 9 AM Pacific: breached -> one breach alert, then nothing more.
  clock='2026-10-06T16:00:00.000Z';assert.equal((await status('west')).code,'breached');
  await insurance.tick();assert.deepEqual(await westAlerts(),['breach','pre_breach','renewal']);assert.deepEqual((await db.all("SELECT n.user_id FROM notifications n WHERE n.kind='insurance_breach' AND n.entity_id='west' ORDER BY n.user_id")).map(x=>x.user_id),['admin1','mgr']);await insurance.tick();assert.equal((await westAlerts()).length,3);
  // A new visit opens a new window; its pre-breach alert is new.
  await ins("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,visit_type) VALUES('v2','west','mgr','2026-10-06','submitted','[]','Fine',?,'routine')",t);
  assert.equal((await status('west')).code,'at_risk');assert.equal((await status('west')).deadline,'2026-10-13');
  clock='2026-10-10T16:00:00.000Z';await insurance.tick();assert.equal((await westAlerts()).length,4);assert.equal((await db.all("SELECT id FROM notifications WHERE kind='insurance_pre_breach' AND entity_id='west'")).length,4);
  // Demo companies: the bell yes, email never.
  assert.ok((await db.all("SELECT n.id FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.organization_id='demo'")).length>=1);
  assert.equal((await db.all("SELECT id FROM email_outbox WHERE organization_id='demo'")).length,0);
  assert.ok(logs.some(l=>/RESEND_API_KEY is not set/.test(l)));

  // Share links: expiry and revocation, checked at the public endpoint.
  const token=newToken();assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  await ins("INSERT INTO insurance_share_links(id,organization_id,property_id,token_hash,expires_at,created_by,created_at) VALUES('l1','org','west',?,?,?,?)",tokenHash(token),'2026-10-11T16:00:00.000Z','admin1',clock);
  const req={method:'GET',headers:{'user-agent':'Broker browser'},socket:{remoteAddress:'203.0.113.9'}};
  const call=async p=>{const out=res();try{await insurance.handlePublic(req,out,new URL('http://x'+p));}catch(e){out.status=e.status;out.error=e.message;}return out;};
  let o=await call('/api/public/certificates/'+token);assert.equal(o.status,200);assert.equal(o.data.certificate.residence.name,'West House');assert.equal(o.data.certificate.policy.number,'P-77');
  assert.ok(!JSON.stringify(o.data).includes('mgr@example.test'),'no staff contact details');
  o=await call('/api/public/certificates/'+token+'/pdf');assert.equal(o.status,200);assert.equal(o.headers['Content-Type'],'application/pdf');assert.ok(words(o.body.toString('latin1')).includes('West House'));
  const link=await db.get("SELECT view_count,last_viewed_at FROM insurance_share_links WHERE id='l1'");assert.equal(Number(link.view_count),2);assert.equal(link.last_viewed_at,clock);
  const views=await db.all("SELECT kind,ip_hash,user_agent FROM insurance_share_views WHERE link_id='l1' ORDER BY kind");assert.deepEqual(views.map(v=>v.kind),['page','pdf']);assert.ok(views[0].ip_hash&&!views[0].ip_hash.includes('203.0.113'),'addresses are stored hashed');
  assert.equal((await db.all("SELECT id FROM audit WHERE action='insurance_share.viewed' AND entity_id='l1'")).length,1,'views are audit-logged');
  clock='2026-10-11T15:59:59.000Z';assert.equal((await call('/api/public/certificates/'+token)).status,200,'still valid one second before expiry');
  clock='2026-10-11T16:00:00.000Z';o=await call('/api/public/certificates/'+token);assert.equal(o.status,410);assert.match(o.error,/expired/);
  assert.equal((await call('/api/public/certificates/'+token+'/pdf')).status,410);
  await ins("UPDATE insurance_share_links SET expires_at='2026-12-01T00:00:00.000Z',revoked_at=? WHERE id='l1'",clock);
  o=await call('/api/public/certificates/'+token);assert.equal(o.status,410);assert.match(o.error,/turned off/);
  assert.equal((await call('/api/public/certificates/'+newToken())).status,404,'unknown token');
  {const out=res();assert.equal(await insurance.handlePublic(req,out,new URL('http://x/api/public/certificates/short')),false,'not a certificate route');}
  assert.equal(Number((await db.get("SELECT view_count FROM insurance_share_links WHERE id='l1'")).view_count),3,'refused requests are not counted as views');
 }finally{await db.close?.();}
}
test('alerts once per window, renewal reminders, demo companies and share-link expiry (SQLite)',()=>moduleScenario('lite',{ESTATEOS_DATA_DIR:tmp()}));
test('alerts once per window, renewal reminders, demo companies and share-link expiry (Postgres/PGlite)',()=>{const d=tmp();return moduleScenario('pg',{ESTATEOS_DATA_DIR:d,NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')});});

// ---------- API: permissions, company isolation, certificate and share links (SQLite and PGlite) ----------
function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const buf=Buffer.from(await res.arrayBuffer());let body={};try{body=JSON.parse(buf.toString());}catch{body={raw:buf};}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body).slice(0,300)}`);return r.body;}};return c;}
const localToday=(tz='America/New_York')=>R.localDay(new Date().toISOString(),tz);

async function apiScenario(label,env){
 const dir=tmp();
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),mgr=client(srv),other=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv),anon=client(srv);
  await admin.req('setup',{company:'Cedar Care '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  const setup=await admin.req('login',{email:'owner@example.test',password:pw});
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});await admin.req('login',{email:'owner@example.test',password:pw});
  const lee=await admin.req('clients',{name:'Lee family'},201),park=await admin.req('clients',{name:'Park family'},201);
  const home=await admin.req('properties',{clientId:lee.id,name:'Cedar House',streetAddress:'4 Cedar Ln',city:'Asheville',state:'NC',postalCode:'28801',country:'United States'},201);
  const home2=await admin.req('properties',{clientId:park.id,name:'Bay Cottage',streetAddress:'9 Bay Rd',city:'Mystic',state:'CT',postalCode:'06355',country:'United States'},201);
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const mgrU=(await accept(mgr,'employee','mgr@example.test','Mia Field')).user;await accept(other,'employee','other@example.test','Otto Other');
  await accept(family,'client','lee@example.test','Ana Lee',{clientId:lee.id});
  const vend=await admin.req('vendors',{name:'Acme Plumbing'},201);await accept(vendor,'vendor','vendor@example.test','Vic Vendor',{vendorId:vend.id});
  await admin.req('access',{userId:mgrU.id,propertyId:home.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);
  const ins=async(c,pid=home.id)=>((await c.req('data')).insurance?.residences||[]).find(r=>r.property_id===pid);

  // ---- nothing changes until a profile exists; admins see "not set up", families see nothing yet.
  assert.equal((await ins(admin)).status.code,'not_set');assert.equal((await ins(family)),undefined);
  assert.equal((await vendor.req('data')).insurance,undefined,'vendors get no insurance data');
  await vendor.req('insurance/'+home.id,{carrier:'X'},403);
  // ---- only admins edit; validation.
  await mgr.req('insurance/'+home.id,{carrier:'X',inspect_every_days:7},403);await family.req('insurance/'+home.id,{carrier:'X'},403);
  await outsider.req('insurance/'+home.id,{carrier:'X'},404);
  await admin.req('insurance/'+home.id,{inspect_every_days:0},422);await admin.req('insurance/'+home.id,{inspect_every_days:2.5},422);
  await admin.req('insurance/'+home.id,{broker_email:'not-an-email'},422);await admin.req('insurance/'+home.id,{max_vacancy_days:30},422);
  await admin.req('insurance/'+home.id,{renewal_date:'2026-02-30'},422);
  const otherFile=await admin.req('files',{propertyId:home2.id,name:'alarm.pdf',base64:Buffer.from('%PDF-1.4 test').toString('base64'),visibility:'internal'},201);
  await admin.req('insurance/'+home.id,{inspect_every_days:7,devices:[{key:'water_shutoff',required:true,file_id:otherFile.id}]},422);
  const proof=await admin.req('files',{propertyId:home.id,name:'shutoff.pdf',base64:Buffer.from('%PDF-1.4 test').toString('base64'),visibility:'internal'},201);
  const renewal=R.addDays(localToday(),20);
  await admin.req('insurance/'+home.id,{carrier:'Example Mutual',policy_number:'EM-204',renewal_date:renewal,broker_name:'Dana Broker',broker_email:'dana@broker.example',broker_phone:'555-0100',inspect_every_days:7,max_vacancy_days:90,warn_days:3,devices:[{key:'water_shutoff',required:true,installed:true,file_id:proof.id},{key:'generator',discount:true}],notes:'OFFICE-ONLY-NOTE',client_share:false});
  let mine=await ins(admin);assert.equal(mine.profile.carrier,'Example Mutual');assert.equal(mine.profile.devices[0].file_id,proof.id);assert.equal(mine.profile.version,1);
  assert.equal(mine.status.code,'at_risk','rule set today, nothing scheduled');assert.equal(mine.status.deadline,R.addDays(localToday(),7));assert.equal(mine.renewal.due,true);
  await admin.req('insurance/'+home.id,{carrier:'Stale',inspect_every_days:7,version:0},409);
  // ---- staff view their residences; families see status without office notes; other staff see nothing.
  const asMgr=await ins(mgr);assert.equal(asMgr.status.code,'at_risk');assert.equal(asMgr.profile.notes,'OFFICE-ONLY-NOTE');assert.equal((await mgr.req('data')).insurance.canEdit,false);
  assert.equal(await ins(other),undefined);
  const asFamily=await ins(family);assert.equal(asFamily.status.code,'at_risk');assert.equal(asFamily.profile.notes,undefined);assert.equal(asFamily.profile.devices[0].file_id,null,'staff-only proof files stay hidden');assert.equal(asFamily.canCertificate,false);assert.equal(asFamily.canShare,false);
  assert.equal(await ins(family,home2.id),undefined,'families never see another family');
  // ---- a scheduled visit before the deadline makes it OK; owners arriving pauses the rule; leaving restarts it.
  const draft=randomUUID();await mgr.req('inspections',{id:draft,propertyId:home.id,date:localToday()},201,{'Idempotency-Key':randomUUID()});
  assert.equal((await ins(admin)).status.code,'ok');assert.equal((await ins(admin)).status.nextScheduled,localToday());
  await mgr.req('insurance/'+home.id+'/occupancy',{state:'occupied'},403);
  await admin.req('insurance/'+home.id+'/occupancy',{state:'occupied',date:R.addDays(localToday(),1)},422);
  await admin.req('insurance/'+home.id+'/occupancy',{state:'occupied',note:'Family here for the holidays'},201);
  mine=await ins(admin);assert.equal(mine.status.occupied,true);assert.equal(mine.occupancy.source,'manual');assert.equal(mine.events[0].note,'Family here for the holidays');
  assert.deepEqual((await ins(family)).events,[],'families do not see office marks');
  await admin.req('insurance/'+home.id+'/occupancy',{state:'vacant'},201);assert.equal((await ins(admin)).status.occupied,false);
  // ---- publish a visit (internal notes must never reach the certificate).
  const row=(await mgr.req('data')).inspections.find(i=>i.id===draft);
  await mgr.req('inspections/save',{id:draft,version:row.version,answers:row.answers.map(a=>({...a,status:'pass'})),summary:'Everything secure and dry.',notes:'',internalNotes:'INTERNAL-SECRET-NOTE'},201);
  await admin.req('inspections/publish',{id:draft,version:(await admin.req('data')).inspections.find(i=>i.id===draft).version,idempotencyKey:randomUUID()},201);
  // ---- certificate: admins and the Residence Manager download; families only when allowed; outsiders never.
  const cert=await admin.call('GET','insurance/'+home.id+'/certificate.pdf');assert.equal(cert.status,200);assert.equal(cert.headers.get('content-type'),'application/pdf');
  assert.match(cert.headers.get('content-disposition'),/Visit-History-Certificate-Cedar-House\.pdf/);
  const text=words(cert.body.raw.toString('latin1'));
  for(const part of ['Cedar Care '+label,'Visit history certificate','Cedar House','Lee family','Example Mutual','EM-204','Inspect at least every 7 days while unoccupied','Everything secure and dry.','Automatic water shut-off','Photo or document on file',"not an insurance adjuster's assessment"])assert.ok(text.includes(part),'certificate has '+part);
  assert.ok(text.includes(R.dayLabel(localToday())),'the published visit is listed with its date');
  assert.ok(!text.includes('INTERNAL-SECRET-NOTE')&&!text.includes('OFFICE-ONLY-NOTE'),'no internal or office notes');
  assert.equal((await mgr.call('GET','insurance/'+home.id+'/certificate.pdf')).status,200);
  assert.equal((await other.call('GET','insurance/'+home.id+'/certificate.pdf')).status,404);
  assert.equal((await family.call('GET','insurance/'+home.id+'/certificate.pdf')).status,403);
  assert.equal((await outsider.call('GET','insurance/'+home.id+'/certificate.pdf')).status,404);
  assert.equal((await anon.call('GET','insurance/'+home.id+'/certificate.pdf')).status,401);
  assert.equal((await admin.call('GET','insurance/'+home2.id+'/certificate.pdf')).status,404,'no profile, no certificate');
  // ---- share links: admins create; lifetime bounds; public page shows only the certificate.
  await mgr.req('insurance/'+home.id+'/share-links',{},403);await family.req('insurance/'+home.id+'/share-links',{},403);await outsider.req('insurance/'+home.id+'/share-links',{},404);
  await admin.req('insurance/'+home.id+'/share-links',{days:0},422);await admin.req('insurance/'+home.id+'/share-links',{days:91},422);
  const link=await admin.req('insurance/'+home.id+'/share-links',{label:'For Dana'},201);
  assert.match(link.path,/^\/certificate\/[A-Za-z0-9_-]{43}$/);const token=link.path.split('/')[2];
  const days=(Date.parse(link.expires_at)-Date.now())/86400000;assert.ok(days>13.9&&days<=14,'default lifetime is 14 days');
  const page=await fetch(srv.base+link.path);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);const html=await page.text();assert.ok(html.includes('/certificate.js')&&!html.includes('/live.js'),'the share page loads only the certificate script');
  assert.equal((await fetch(srv.base+'/certificate/short')).status,404);
  const pub=await anon.call('GET','public/certificates/'+token);assert.equal(pub.status,200);
  const pubText=JSON.stringify(pub.body);assert.ok(pubText.includes('Cedar House')&&pubText.includes('EM-204'));
  for(const secret of ['INTERNAL-SECRET-NOTE','OFFICE-ONLY-NOTE','dana@broker.example','mgr@example.test',draft])assert.ok(!pubText.includes(secret),'public page leaks nothing: '+secret);
  assert.equal(pub.headers.get('referrer-policy'),'no-referrer');assert.match(pub.headers.get('x-robots-tag'),/noindex/);
  assert.equal((await anon.call('GET','public/certificates/'+token+'/pdf')).status,200);
  assert.equal((await anon.call('GET','data')).status,401,'the token opens nothing else');
  const listed=(await ins(admin)).links.find(l=>l.id===link.id);assert.equal(listed.view_count,2);assert.equal(listed.state,'active');assert.equal(listed.created_by_name,'Owner');
  assert.equal((await ins(mgr)).links.length,1,'staff can see the links');
  // ---- revocation: staff cannot; outsiders cannot; admins can; the link stops working at once.
  await mgr.req('insurance/share-links/'+link.id+'/revoke',{},403);await outsider.req('insurance/share-links/'+link.id+'/revoke',{},404);
  await admin.req('insurance/share-links/'+link.id+'/revoke',{});
  assert.equal((await anon.call('GET','public/certificates/'+token)).status,410);assert.equal((await ins(admin)).links.find(l=>l.id===link.id).state,'revoked');
  // ---- families: once the admin allows it, they download and share, and can turn off only their own links.
  await admin.req('insurance/'+home.id,{...(await ins(admin)).profile,devices:(await ins(admin)).profile.devices,client_share:true});
  const fam=await ins(family);assert.equal(fam.canCertificate,true);assert.equal(fam.canShare,true);assert.deepEqual(fam.links,[],'families see only links they created');
  assert.equal((await family.call('GET','insurance/'+home.id+'/certificate.pdf')).status,200);
  const famLink=await family.req('insurance/'+home.id+'/share-links',{label:'For my broker',days:30},201);
  const adminLink=await admin.req('insurance/'+home.id+'/share-links',{days:7},201);
  await family.req('insurance/share-links/'+adminLink.id+'/revoke',{},403);
  await family.req('insurance/share-links/'+famLink.id+'/revoke',{});assert.equal((await anon.call('GET','public/certificates/'+famLink.path.split('/')[2])).status,410);
  assert.equal((await anon.call('GET','public/certificates/'+adminLink.path.split('/')[2])).status,200);
  // ---- audit trail.
  const actions=(await admin.req('data')).audit.map(a=>a.action);
  for(const a of ['insurance.updated','insurance.certificate_downloaded','insurance_share.created','insurance_share.revoked','occupancy.owners_arrived','occupancy.owners_left'])assert.ok(actions.includes(a),'audit has '+a);
  // ---- company isolation: the rival company sees nothing of this residence.
  assert.deepEqual((await outsider.req('data')).insurance.residences,[]);
 }finally{await srv.stop();}
}
test('insurance API on SQLite: permissions, isolation, certificate, share links',()=>apiScenario('SQLite',{}));
test('insurance API on Postgres (PGlite): permissions, isolation, certificate, share links',()=>apiScenario('PG',{pg:true}));
