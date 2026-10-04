// Repeat-angle photo baselines: photo spots per residence, the baseline, spot photos from visits (also replayed
// offline uploads), the timeline, before/after comparisons in the report and the PDF, pre/post-storm pairing,
// "set as new baseline", permissions and company isolation. Server scenarios run on SQLite and on Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPhotoSpots,spotPairs,takenLabel} from '../photo-spots.mjs';
import {inspectionPdf} from '../pdf.mjs';
import {stormReportPdf} from '../storm-pdf.mjs';
import {openDatabase} from '../database.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const fixture=readFileSync(path.join(root,'tests/fixture.jpg'));
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-spots-'));dirs.push(d);return d;};
const words=pdf=>[...pdf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');
const images=pdf=>(pdf.toString('latin1').match(/\/Subtype \/Image/g)||[]).length;

test('taken labels follow the residence time zone',()=>{
 assert.deepEqual(takenLabel('2026-10-04T03:30:00.000Z','America/Los_Angeles'),{day:'2026-10-03',label:'Oct 3, 2026, 8:30 PM PDT'});
 assert.equal(takenLabel('2026-10-04T03:30:00.000Z','America/New_York').day,'2026-10-03');
 assert.equal(takenLabel('2026-10-04T05:30:00.000Z','America/New_York').day,'2026-10-04');
 assert.equal(takenLabel('2026-10-04T05:30:00.000Z','Not/AZone').day,'2026-10-04','unknown zone falls back to Eastern');
 assert.deepEqual(takenLabel('nonsense'),{day:'',label:''});
});

test('storm pairs: the same spot before and after; last pre-storm photo, first post-storm photo',()=>{
 const shots=[
  {file_id:'p1',spot_id:'a',spot_name:'Roofline',taken:'2026-10-07T10:00:00Z'},{file_id:'p2',spot_id:'a',spot_name:'Roofline',taken:'2026-10-07T10:05:00Z'},
  {file_id:'q1',spot_id:'a',spot_name:'Roofline',taken:'2026-10-10T09:00:00Z'},{file_id:'q2',spot_id:'a',spot_name:'Roofline',taken:'2026-10-10T09:10:00Z'},
  {file_id:'p3',spot_id:'b',spot_name:'Dock',taken:'2026-10-07T11:00:00Z'},
  {file_id:'q3',spot_id:'c',spot_name:'Garage door',taken:'2026-10-10T09:30:00Z'},
  {file_id:'p4',spot_id:'d',spot_name:'Back porch',taken:'2026-10-07T11:00:00Z'},{file_id:'q4',spot_id:'d',spot_name:'Back porch',taken:'2026-10-10T09:40:00Z'},
  {file_id:'x9',spot_id:'d',spot_name:'Back porch',taken:'2026-10-08T09:40:00Z'}];
 assert.deepEqual(spotPairs(shots,['p1','p2','p3','p4'],['q1','q2','q3','q4']),[{beforeId:'p4',afterId:'q4',spot:'Back porch'},{beforeId:'p2',afterId:'q1',spot:'Roofline'}],'only spots photographed on both visits; photos from other visits ignored');
 assert.deepEqual(spotPairs(shots,[],['q1']),[]);
});

test('inspection PDF: a "Photo comparisons" section with the baseline and this visit side by side',()=>{
 const report={id:'r1',company:'Cedar Care',property:'Cedar House',date:'2026-10-02',inspector:'Mia Field',answers:[],summary:'All secure.',notes:''};
 const before=inspectionPdf(report,[]);assert.ok(!words(before).includes('Photo comparisons'),'no section without spot photos');
 const side=(id,at)=>({id,name:id+'.jpg',bytes:fixture,capturedAt:at,timezone:'America/Chicago'});
 const pdf=inspectionPdf({...report,comparisons:[{spot:'Kitchen sink cabinet',location:'Kitchen',before:side('b1','2026-09-01T15:00:00Z'),after:side('a1','2026-10-02T15:00:00Z')},{spot:'Bad photo',location:'',before:{...side('b2'),bytes:Buffer.from('not a jpeg')},after:side('a2')}]},[]);
 const text=words(pdf);
 for(const part of ['Photo comparisons','Kitchen sink cabinet · Kitchen','BASELINE · Sep 1, 2026, 10:00 AM CDT','THIS VISIT · Oct 2, 2026, 10:00 AM CDT'])assert.ok(text.includes(part),'PDF has '+part+' in '+text.slice(0,400));
 assert.ok(!text.includes('Bad photo'),'a pair with a photo that is not a JPEG is left out');
 assert.equal(images(pdf),2,'two images: one baseline and one visit photo');
});

test('storm report PDF labels photo-spot pairs',()=>{
 const photos=new Map([['b',{id:'b',name:'Roof before.jpg',bytes:fixture}],['a',{id:'a',name:'Roof after.jpg',bytes:fixture}]]);
 const visit=(id,ids)=>({id,date:'2026-10-07',dateLabel:'Wed, Oct 7, 2026',completedAt:'2026-10-07T15:00:00Z',inspector:'Mia',checklistName:'Hurricane prep',summary:'',notes:'',answers:[],verification:null,photoIds:ids});
 const pdf=stormReportPdf({company:'Cedar Care',timezone:'America/New_York',preparedAt:'2026-10-11T12:00:00Z',reference:'ref',event:{name:'Tropical Storm Example',typeLabel:'Tropical storm'},residence:{name:'Cedar House',address:''},family:'Lee family',prepLabel:'Secured',prepTone:'ok',postLabel:'No damage',postTone:'ok',severity:'None',pre:visit('pre',['b']),post:visit('post',['a']),pairs:[{beforeId:'b',afterId:'a',match:'spot',spot:'Roofline from the drive'}],workOrders:[]},photos);
 const text=words(pdf);assert.ok(text.includes('Same photo spot: Roofline from the drive'));assert.ok(text.includes('BEFORE (PRE-STORM)')&&text.includes('AFTER (POST-STORM)'));
});

// ---------- module: storm pairing from the database ----------
async function moduleScenario(label,dbEnv){
 const db=await openDatabase(root,dbEnv);
 try{
  const t='2026-09-01T12:00:00.000Z',ins=(sql,...a)=>db.run(sql,...a);
  for(const org of ['org','rival'])await ins('INSERT INTO organizations VALUES(?,?,?)',org,org,t);
  await ins('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','u1','org','U','u@example.test','x','admin',null,null,1,t);
  await ins("INSERT INTO clients(id,organization_id,name,created_at) VALUES('c','org','Fam',?)",t);
  await ins("INSERT INTO properties(id,organization_id,client_id,name,address,timezone,created_at) VALUES('h','org','c','Home','1 St','America/New_York',?)",t);
  const file=(fid,at)=>ins("INSERT INTO files(id,property_id,inspection_id,work_order_id,name,mime,bytes,storage_key,visibility,created_by,created_at,captured_at) VALUES(?,'h',NULL,NULL,?,'image/jpeg',1,?,'internal','u1',?,?)",fid,fid+'.jpg','k-'+fid,at,at);
  await ins("INSERT INTO photo_spots(id,organization_id,property_id,name,created_by,created_at,updated_at) VALUES('s1','org','h','Roofline','u1',?,?)",t,t);
  await ins("INSERT INTO photo_spots(id,organization_id,property_id,name,created_by,created_at,updated_at) VALUES('s2','org','h','Dock','u1',?,?)",t,t);
  for(const [fid,spot,at,org] of [['pre1','s1','2026-10-07T10:00:00Z','org'],['post1','s1','2026-10-10T10:00:00Z','org'],['pre2','s2','2026-10-07T10:00:00Z','org'],['post2','s2','2026-10-10T10:00:00Z','rival']]){await file(fid,at);await ins('INSERT INTO photo_spot_shots(file_id,spot_id,organization_id,property_id,inspection_id,baseline_file_id,kind,created_by,created_at) VALUES(?,?,?,?,NULL,NULL,?,?,?)',fid,spot,org,'h','visit','u1',at);}
  const spots=createPhotoSpots({...db,id:()=>randomUUID(),now:()=>t,fail(s,m){throw Object.assign(Error(m),{status:s});},json(){},body:async()=>({}),roles(){},property:async()=>{},audit:async()=>{},visitVerification:{settings:async()=>({}),timezoneFor:p=>p.timezone},readBytes:async()=>fixture});
  assert.deepEqual(await spots.stormPairs('org',['pre1','pre2'],['post1','post2']),[{beforeId:'pre1',afterId:'post1',spot:'Roofline'}],'only this company\'s shots');
  assert.deepEqual(await spots.stormPairs('org',[],[]),[]);
 }finally{await db.close?.();}
}
test('storm pairing from the database on SQLite',()=>moduleScenario('sqlite',{ESTATEOS_DATA_DIR:tmp()}));
test('storm pairing from the database on Postgres (PGlite)',()=>{const d=tmp();return moduleScenario('pg',{ESTATEOS_DATA_DIR:d,NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')});});

// ---------- API ----------
function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const buf=Buffer.from(await res.arrayBuffer());let body={};try{body=JSON.parse(buf.toString());}catch{body={raw:buf};}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body).slice(0,300)}`);return r.body;}};return c;}
const localToday=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});

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
  const ps=async c=>(await c.req('data')).photoSpots;
  const jpeg=fixture.toString('base64');
  const upload=(c,b,expected=201,headers={'Idempotency-Key':randomUUID()})=>c.req('files',{propertyId:home.id,name:'spot.jpg',base64:jpeg,...b},expected,headers);

  // ---- create: staff who can work at the residence; never families, vendors, other staff or other companies.
  assert.equal((await vendor.req('data')).photoSpots,undefined,'vendors get no photo spots');
  await vendor.req('photo-spots',{propertyId:home.id,name:'X'},403);await family.req('photo-spots',{propertyId:home.id,name:'X'},403);
  assert.notEqual((await other.call('POST','photo-spots',{propertyId:home.id,name:'X'})).status,201,'staff without access cannot add');
  await outsider.req('photo-spots',{propertyId:home.id,name:'X'},404);
  await mgr.req('photo-spots',{propertyId:home.id,name:''},422);await mgr.req('photo-spots',{propertyId:home.id,name:'x'.repeat(81)},422);await mgr.req('photo-spots',{propertyId:home.id,name:'Ok',location:5},422);
  const spot=(await mgr.req('photo-spots',{propertyId:home.id,name:'Kitchen sink cabinet',location:'Kitchen',checklistKey:'kitchen-sink',checklistLabel:'Kitchen · Under-sink leaks',notes:'Door open, from the left.'},201)).id;
  const spot2=(await admin.req('photo-spots',{propertyId:home.id,name:'Water heater',location:'Garage'},201)).id;
  const far=(await admin.req('photo-spots',{propertyId:home2.id,name:'Dock'},201)).id;
  let s=(await ps(mgr)).spots.find(x=>x.id===spot);assert.equal(s.baseline_file_id,null);assert.equal(s.checklist_label,'Kitchen · Under-sink leaks');assert.equal(s.notes,'Door open, from the left.');
  assert.equal((await ps(mgr)).canEdit,true);assert.equal((await ps(mgr)).canArchive,false);assert.ok(!(await ps(mgr)).spots.some(x=>x.id===far),'staff see only their residences');
  const fam=await ps(family);assert.deepEqual(fam.spots.map(x=>x.name).sort(),['Kitchen sink cabinet','Water heater']);assert.equal(fam.spots[0].notes,'','families do not get staff framing notes');assert.equal(fam.canEdit,false);
  assert.deepEqual((await ps(other)).spots,[]);assert.deepEqual((await ps(outsider)).spots,[]);

  // ---- baseline photo outside a visit: becomes the baseline; not listed as a residence document.
  await upload(mgr,{spotId:far},422);await upload(mgr,{spotId:randomUUID()},422);
  await mgr.req('files',{propertyId:home.id,name:'a.pdf',base64:Buffer.from('%PDF-1.4 x').toString('base64'),spotId:spot},422,{'Idempotency-Key':randomUUID()});
  await family.req('files',{propertyId:home.id,name:'x.jpg',base64:jpeg,spotId:spot},403);
  const base1=(await upload(mgr,{spotId:spot,name:'kitchen-baseline.jpg',capturedAt:new Date(Date.now()-86400000).toISOString()})).id;
  s=(await ps(mgr)).spots.find(x=>x.id===spot);assert.equal(s.baseline_file_id,base1);assert.equal(s.photo_count,1);
  assert.ok(!(await admin.req('data')).files.some(f=>f.id===base1),'baseline uploads stay out of Documents');
  assert.equal((await ps(mgr)).shots.find(x=>x.file_id===base1).kind,'baseline');
  // ---- spot images: residence access rules.
  assert.equal((await family.call('GET','photo-spots/image/'+base1)).status,200,'families see the baseline of their home');
  assert.equal((await vendor.call('GET','photo-spots/image/'+base1)).status,403);assert.equal((await outsider.call('GET','photo-spots/image/'+base1)).status,404);
  assert.equal((await anon.call('GET','photo-spots/image/'+base1)).status,401);assert.equal((await other.call('GET','photo-spots/image/'+base1)).status,404);
  const img=await mgr.call('GET','photo-spots/image/'+base1);assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/jpeg');assert.ok(img.body.raw.length>100);

  // ---- a visit: the spot photo keeps the baseline it was taken against; a replayed offline upload is not doubled.
  const draft=randomUUID();await mgr.req('inspections',{id:draft,propertyId:home.id,date:localToday()},201,{'Idempotency-Key':randomUUID()});
  const op=randomUUID();
  const v1=(await mgr.req('files',{propertyId:home.id,inspectionId:draft,spotId:spot,clientOpId:op,name:'Kitchen-sink-cabinet.jpg',base64:jpeg,capturedAt:new Date().toISOString()},201)).id;
  const replay=await mgr.req('files',{propertyId:home.id,inspectionId:draft,spotId:spot,clientOpId:op,name:'Kitchen-sink-cabinet.jpg',base64:jpeg},201);assert.equal(replay.id,v1);assert.equal(replay.existing,true);
  const firstHeater=(await mgr.req('files',{propertyId:home.id,inspectionId:draft,spotId:spot2,name:'heater.jpg',base64:jpeg},201,{'Idempotency-Key':randomUUID()})).id;
  let shots=(await ps(mgr)).shots;
  assert.equal(shots.filter(x=>x.file_id===v1).length,1);assert.equal(shots.find(x=>x.file_id===v1).baseline_file_id,base1);assert.equal(shots.find(x=>x.file_id===v1).inspection_id,draft);
  assert.equal((await ps(mgr)).spots.find(x=>x.id===spot2).baseline_file_id,firstHeater,'the first photo of a spot without a baseline becomes its baseline');
  assert.ok(!(await ps(family)).shots.some(x=>x.file_id===v1),'families do not see photos from unpublished visits');
  assert.equal((await family.call('GET','photo-spots/image/'+v1)).status,404);
  // ---- publish: the family sees the comparison; the PDF has the Photo comparisons section.
  const row=(await mgr.req('data')).inspections.find(i=>i.id===draft);
  await mgr.req('inspections/save',{id:draft,version:row.version,answers:row.answers.map(a=>({...a,status:'pass'})),summary:'Dry under the sink.',notes:'',internalNotes:''},201);
  await admin.req('inspections/publish',{id:draft,version:(await admin.req('data')).inspections.find(i=>i.id===draft).version,idempotencyKey:randomUUID()},201);
  const famShot=(await ps(family)).shots.find(x=>x.file_id===v1);assert.ok(famShot,'published spot photo visible to the family');assert.equal(famShot.baseline_file_id,base1);assert.match(famShot.taken_label,/E[DS]T$/);
  assert.equal((await family.call('GET','photo-spots/image/'+v1)).status,200);
  const pdf=await family.call('GET','inspections/'+draft+'/pdf');assert.equal(pdf.status,200);
  const text=words(pdf.body.raw);assert.ok(text.includes('Photo comparisons')&&text.includes('Kitchen sink cabinet · Kitchen')&&text.includes('BASELINE')&&text.includes('THIS VISIT'),'PDF comparison section');
  assert.ok(!text.includes('Water heater ·')&&!text.includes('Water heater'),'a photo that became the first baseline has nothing to compare against');

  // ---- set as new baseline.
  await family.req('photo-spots/'+spot+'/baseline',{fileId:v1},403);await vendor.req('photo-spots/'+spot+'/baseline',{fileId:v1},403);
  assert.notEqual((await other.call('POST','photo-spots/'+spot+'/baseline',{fileId:v1})).status,200);await outsider.req('photo-spots/'+spot+'/baseline',{fileId:v1},404);
  await mgr.req('photo-spots/'+spot+'/baseline',{fileId:firstHeater},422);await mgr.req('photo-spots/'+spot+'/baseline',{fileId:randomUUID()},404);await mgr.req('photo-spots/'+spot+'/baseline',{},422);
  await mgr.req('photo-spots/'+spot+'/baseline',{fileId:v1});
  s=(await ps(mgr)).spots.find(x=>x.id===spot);assert.equal(s.baseline_file_id,v1);
  assert.equal((await ps(mgr)).shots.find(x=>x.file_id===v1).baseline_file_id,base1,'earlier comparisons keep the baseline they were taken against');
  assert.equal((await mgr.req('photo-spots/'+spot+'/baseline',{fileId:v1})).unchanged,true);
  // A general visit photo can become a baseline too; it joins the timeline.
  const draft2=randomUUID();await mgr.req('inspections',{id:draft2,propertyId:home.id,date:localToday()},201,{'Idempotency-Key':randomUUID()});
  const v2=(await mgr.req('files',{propertyId:home.id,inspectionId:draft2,spotId:spot,name:'k2.jpg',base64:jpeg},201,{'Idempotency-Key':randomUUID()})).id;
  assert.equal((await ps(mgr)).shots.find(x=>x.file_id===v2).baseline_file_id,v1,'new photos line up with the new baseline');
  const loose=(await mgr.req('files',{propertyId:home.id,inspectionId:draft2,name:'general.jpg',base64:jpeg},201,{'Idempotency-Key':randomUUID()})).id;
  await mgr.req('photo-spots/'+spot2+'/baseline',{fileId:loose});assert.equal((await ps(mgr)).shots.find(x=>x.file_id===loose).spot_id,spot2);
  // Deleting a draft removes its photos from the timeline.
  await mgr.req('inspections/delete',{id:draft2,version:(await mgr.req('data')).inspections.find(i=>i.id===draft2).version},201);
  assert.ok(!(await ps(mgr)).shots.some(x=>x.file_id===v2),'deleted draft photos leave the timeline');
  assert.equal((await ps(mgr)).spots.find(x=>x.id===spot2).baseline_file_id,null,'a baseline whose photo was deleted is shown as missing');

  // ---- edit with a version check; archive is admin only.
  s=(await ps(mgr)).spots.find(x=>x.id===spot);
  await mgr.req('photo-spots/'+spot,{name:'Kitchen sink',location:'Kitchen',version:s.version});
  await mgr.req('photo-spots/'+spot,{name:'Stale',version:s.version},409);
  await family.req('photo-spots/'+spot,{name:'X'},403);
  await mgr.req('photo-spots/'+spot+'/archive',{},403);await admin.req('photo-spots/'+spot+'/archive',{});
  assert.ok(!(await ps(admin)).spots.some(x=>x.id===spot),'archived spots leave the list');
  await upload(mgr,{spotId:spot},422);await mgr.req('photo-spots/'+spot,{name:'Back'},409);
  const pdf2=await admin.call('GET','inspections/'+draft+'/pdf');assert.ok(words(pdf2.body.raw).includes('Photo comparisons'),'published reports keep their comparisons after the spot is archived');
  // ---- audit trail; company isolation.
  const actions=(await admin.req('data')).audit.map(a=>a.action);
  for(const a of ['photo_spot.created','photo_spot.updated','photo_spot.baseline_set','photo_spot.archived'])assert.ok(actions.includes(a),'audit has '+a);
  assert.deepEqual((await ps(outsider)).spots,[]);assert.deepEqual((await ps(outsider)).shots,[]);
  assert.equal((await outsider.call('GET','photo-spots/image/'+v1)).status,404);
 }finally{await srv.stop();}
}
test('photo spots API on SQLite: permissions, isolation, baselines, comparisons',()=>apiScenario('SQLite',{}));
test('photo spots API on Postgres (PGlite): permissions, isolation, baselines, comparisons',()=>apiScenario('PG',{pg:true}));
