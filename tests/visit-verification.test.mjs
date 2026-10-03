// GPS and timestamp proof of visit: rules, check-in/out API, offline sync, EXIF privacy, PDF box, client portal,
// report numbers and residence/company time zones. Server scenarios run on SQLite and Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import '../public/visit-verification.js';
import {readExif,stripLocation,exifTime} from '../exif.mjs';
import {reportInitials} from '../visit-verification.mjs';
import {inspectionPdf,jpegSize} from '../pdf.mjs';
const V=globalThis.EAVisit;
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const fixture=readFileSync(path.join(root,'tests/fixture.jpg'));
const builtIn=JSON.parse(readFileSync(path.join(root,'inspection-template.json'),'utf8'));
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const sandbox={crypto:globalThis.crypto,btoa:globalThis.btoa,console};sandbox.globalThis=sandbox;
vm.createContext(sandbox);vm.runInContext(readFileSync(path.join(root,'public/offline-core.js'),'utf8'),sandbox);
const OC=sandbox.EAOfflineCore;
const words=pdf=>[...pdf.matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const HOME={lat:27.1972,lon:-80.2528};
const NEAR={latitude:27.19756,longitude:-80.2528,accuracy:8};      // ~40 m north
const FAR={latitude:27.2082,longitude:-80.2528,accuracy:12};       // ~1.2 km north

// ---- a JPEG carrying EXIF DateTimeOriginal + offset + GPS (27.1975 N, 80.2528 W, ±6 m) and an XMP packet with GPS.
function exifJpeg(){
 const t=Buffer.alloc(218);let o=0;const w16=(v,at)=>t.writeUInt16BE(v,at),w32=(v,at)=>t.writeUInt32BE(v,at);
 t.write('MM',0,'latin1');w16(42,2);w32(8,4);
 const entry=(at,tag,type,count,value)=>{w16(tag,at);w16(type,at+2);w32(count,at+4);if(typeof value==='string')t.write(value,at+8,'latin1');else w32(value,at+8);};
 w16(2,8);entry(10,0x8769,4,1,38);entry(22,0x8825,4,1,96);w32(0,34);
 w16(2,38);entry(40,0x9003,2,20,68);entry(52,0x9011,2,7,88);w32(0,64);
 t.write('2026:10:02 09:05:00\0',68,'latin1');t.write('-04:00\0',88,'latin1');
 w16(5,96);entry(98,1,2,2,'N\0');entry(110,2,5,3,162);entry(122,3,2,2,'W\0');entry(134,4,5,3,186);entry(146,0x1f,5,1,210);w32(0,158);
 const rat=(at,a,b)=>{w32(a,at);w32(b,at+4);};
 rat(162,27,1);rat(170,11,1);rat(178,51,1);rat(186,80,1);rat(194,15,1);rat(202,1008,100);rat(210,6,1);
 const exif=Buffer.concat([Buffer.from('Exif\0\0','latin1'),t]);
 const xmp=Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0','latin1'),Buffer.from('<x:xmpmeta><rdf:Description exif:GPSLatitude="27,11.85N" exif:GPSLongitude="80,15.168W"/></x:xmpmeta>','latin1')]);
 const seg=(data)=>{const h=Buffer.alloc(4);h[0]=0xff;h[1]=0xe1;h.writeUInt16BE(data.length+2,2);return Buffer.concat([h,data]);};
 return Buffer.concat([fixture.subarray(0,2),seg(exif),seg(xmp),fixture.subarray(2)]);
}

test('distance, residence area, clock skew and time zone rules',()=>{
 const km=(a,b)=>V.haversine(...a,...b)/1000;
 assert.ok(Math.abs(km([40.7128,-74.006],[34.0522,-118.2437])-3936)<10,'New York - Los Angeles ~3,936 km');
 assert.ok(Math.abs(km([51.5074,-0.1278],[48.8566,2.3522])-343.5)<2,'London - Paris ~343 km');
 assert.ok(Math.abs(V.haversine(0,0,1,0)-111195)<50,'one degree of latitude ~111.2 km');
 assert.equal(V.haversine(HOME.lat,HOME.lon,HOME.lat,HOME.lon),0);
 const at=(m,accuracy,radius=150)=>V.evaluate({lat:HOME.lat+m/111195,lon:HOME.lon,accuracy},{...HOME,radius});
 assert.equal(at(140,5).status,'verified');assert.equal(at(160,5).status,'outside_geofence');
 assert.equal(at(200,60).status,'verified','accuracy widens the area');assert.equal(at(200,40).status,'outside_geofence');
 assert.equal(at(245,5000).status,'verified','accuracy allowance is capped at 100 m');assert.equal(at(255,5000).status,'outside_geofence');
 assert.equal(V.evaluate({},HOME).status,'location_unavailable');
 assert.equal(V.evaluate({lat:27.2,lon:-80.25},{}).status,'no_residence_location');
 assert.equal(at(160,5,300).status,'verified','per-residence radius');
 const base='2026-10-02T13:00:00.000Z',plus=m=>new Date(Date.parse(base)+m*60000).toISOString();
 assert.equal(V.clockSkew({deviceAt:plus(-11),serverAt:base,offline:false}),true,'online and 11 minutes off');
 assert.equal(V.clockSkew({deviceAt:plus(-9),serverAt:base,offline:false}),false);
 assert.equal(V.clockSkew({deviceAt:plus(-300),serverAt:base,offline:true}),false,'offline capture is legitimately earlier');
 assert.equal(V.clockSkew({deviceAt:plus(-300),serverAt:base,sentAt:plus(-30),offline:true}),true,'device clock 30 min behind at send time');
 assert.equal(V.clockSkew({deviceAt:plus(-300),serverAt:base,sentAt:plus(1),offline:true}),false);
 const summer='2026-07-01T17:30:00Z',winter='2026-01-15T17:30:00Z';
 assert.equal(V.formatTime(summer,'America/New_York'),'Jul 1, 2026, 1:30 PM EDT');
 assert.equal(V.formatTime(summer,'America/Chicago'),'Jul 1, 2026, 12:30 PM CDT');
 assert.equal(V.formatTime(summer,'America/Phoenix'),'Jul 1, 2026, 10:30 AM MST','Arizona has no daylight time');
 assert.equal(V.formatTime(summer,'Pacific/Honolulu'),'Jul 1, 2026, 7:30 AM HST');
 assert.equal(V.formatTime(winter,'America/New_York'),'Jan 15, 2026, 12:30 PM EST');
 assert.equal(V.formatTime(summer,'Not/AZone'),'Jul 1, 2026, 1:30 PM EDT','invalid zones fall back to Eastern');
 assert.equal(V.effectiveTimezone({timezone:'America/Chicago',timezone_source:'manual'},'America/Phoenix'),'America/Chicago');
 assert.equal(V.effectiveTimezone({timezone:'America/New_York',timezone_source:null},'America/Phoenix'),'America/Phoenix','unset residence zone uses the company zone');
 assert.equal(V.effectiveTimezone({timezone:'America/New_York'},null),'America/New_York');
 assert.equal(V.effectiveTimezone({},''),'America/New_York');
 assert.equal(V.formatDistance(42.4),'42 m');assert.equal(V.formatDistance(1234),'1.2 km');assert.equal(V.formatDuration(4380),'1 h 13 min');
 assert.equal(reportInitials('Ocean House'),'OH');assert.equal(reportInitials('The Palm Beach Villa'),'TPB');assert.equal(reportInitials('  '),'RES');
});

test('EXIF: capture time and GPS are read, then GPS and XMP are stripped from the stored bytes',()=>{
 const jpeg=exifJpeg(),exif=readExif(jpeg);
 assert.equal(exif.dateTimeOriginal,'2026:10:02 09:05:00');assert.equal(exif.offset,'-04:00');
 assert.ok(Math.abs(exif.lat-27.1975)<1e-6&&Math.abs(exif.lon+80.2528)<1e-6,JSON.stringify(exif));assert.equal(exif.accuracy,6);
 assert.equal(exifTime(exif),'2026-10-02T13:05:00.000Z');
 assert.equal(exifTime({dateTimeOriginal:'2026:10:02 09:05:00'},'America/Chicago'),'2026-10-02T14:05:00.000Z','no offset tag: read in the residence zone');
 const clean=stripLocation(jpeg),after=readExif(clean);
 assert.equal(after.lat,null);assert.equal(after.lon,null);assert.equal(after.dateTimeOriginal,'2026:10:02 09:05:00','other EXIF is kept');
 assert.ok(!clean.includes(Buffer.from('GPSLatitude')),'XMP GPS removed');
 assert.deepEqual(jpegSize(clean),jpegSize(fixture),'the photo itself is untouched');
 assert.equal(readExif(fixture),null);assert.equal(stripLocation(fixture).equals(fixture),true,'photos without EXIF are stored as-is');
});

test('PDF: verification box, zone abbreviation, photo captions; absent for older reports',()=>{
 const row={check_in_server_at:'2026-10-02T13:14:20Z',check_in_device_at:'2026-10-02T13:14:18Z',check_in_lat:27.19756,check_in_lon:-80.2528,check_in_accuracy_m:8,check_in_distance_m:40,radius_m:150,check_out_server_at:'2026-10-02T14:20:00Z',check_out_device_at:'2026-10-02T14:19:58Z',check_out_auto:0,duration_seconds:3940};
 const base={id:'r1',company:'Harbor',property:'Ocean House',client:'Family',inspector:'Leo',date:'2026-10-02',completedAt:'2026-10-02T14:30:00Z',overall:'Passed',answers:builtIn.map(a=>({...a,status:'pass'})),summary:'Fine',notes:'None'};
 const visit=V.describe(V.publicVisit(row),'America/Chicago');
 const raw=inspectionPdf({...base,timezone:'America/Chicago',reportNumber:'OH-20261002-1',visit},[{name:'Kitchen',bytes:fixture,capturedAt:'2026-10-02T13:20:00Z',timezone:'America/Chicago',atResidence:true}]).toString('latin1'),pdf=words(raw);
 for(const part of ['VISIT VERIFICATION','VERIFIED','Arrived Oct 2, 2026, 8:14 AM CDT','Departed Oct 2, 2026, 9:20 AM CDT','Time on site 1 h 6 min','Verified at the residence (40 m, GPS accuracy \xb18 m)','Taken Oct 2, 2026, 8:20 AM CDT at the residence','Report number OH-20261002-1','Reference r1','Completed Oct 2, 2026, 9:30 AM CDT'])assert.ok(pdf.includes(part),'PDF has '+part+'\n'+pdf.slice(0,900));
 const outside=V.describe(V.publicVisit({...row,check_in_lat:27.2082,check_in_distance_m:1189,check_in_note:'Checked the boathouse first'}),'America/New_York');
 const pdf2=words(inspectionPdf({...base,timezone:'America/New_York',visit:outside}).toString('latin1'));
 assert.ok(pdf2.includes('OUTSIDE RESIDENCE AREA')&&pdf2.includes('Recorded 1.2 km from the residence - reason: Checked the boathouse first'),'outside wording');
 const none=V.describe(V.publicVisit({check_in_server_at:'2026-10-02T13:14:20Z',check_in_source:'denied',radius_m:150,check_in_offline:1,check_in_device_at:'2026-10-02T13:00:00Z'}),'America/New_York');
 const pdf3=words(inspectionPdf({...base,visit:none}).toString('latin1'));
 assert.ok(pdf3.includes('LOCATION UNAVAILABLE')&&pdf3.includes('Oct 2, 2026, 9:00 AM EDT (recorded offline; synced Oct 2, 2026, 9:14 AM EDT)')&&pdf3.includes('Location unavailable'),'offline + unavailable wording');
 const old=words(inspectionPdf(base).toString('latin1'));
 assert.ok(!old.includes('VISIT VERIFICATION')&&old.includes('Report reference r1')&&!old.includes('at the residence'),'older reports have no box');
 assert.ok(!/[\u2713\u26a0?]/.test(pdf+pdf2+pdf3),'no glyphs the PDF fonts cannot draw');
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
const pdfText=async(c,id)=>words(Buffer.from(await (await c.raw('inspections/'+id+'/pdf')).arrayBuffer()).toString('latin1'));
const passAll=()=>builtIn.map(a=>({...a,status:'pass',note:''}));

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-gps-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),employee=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'GPS Co '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const accept=async(c,role,email,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email==='tech@example.test'?'Leo Tech':email,password:pw},201);};
  const emp=await accept(employee,'employee','tech@example.test');await accept(family,'client','fam@example.test',{clientId:fam.id});
  const vend=await admin.req('vendors',{name:'Pool Co'},201);await accept(vendor,'vendor','vendor@example.test',{vendorId:vend.id});
  await admin.req('access',{userId:emp.user.id,propertyId:home.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);
  const find=async(c,id)=>(await c.req('data')).inspections.find(i=>i.id===id);
  const start=async(date='2026-10-02')=>(await employee.req('inspections',{propertyId:home.id,date},201)).id;
  const fill=async(id,c=employee)=>{const i=await find(c,id);return c.req('inspections/save',{id,version:i.version,answers:passAll(),summary:'All clear.',notes:'',internalNotes:''},201);};
  const publish=async id=>admin.req('inspections/publish',{id,version:(await find(admin,id)).version,idempotencyKey:randomUUID()},201);

  // ---- feature off (default): nothing changes; the time zone fix still applies.
  const legacy=await start();
  assert.deepEqual(await employee.req('inspections/'+legacy+'/check-in',{deviceAt:new Date().toISOString(),...NEAR}),{visit:null,disabled:true});
  await fill(legacy);await publish(legacy);
  let row=await find(admin,legacy);
  assert.equal(row.visit,undefined,'no visit data with the feature off');assert.equal(row.report_number,null,'no report number with the feature off');
  let pdf=await pdfText(admin,legacy);
  assert.ok(!pdf.includes('VISIT VERIFICATION')&&pdf.includes('Report reference'),'feature off: PDF has no box');
  assert.match(pdf,/Completed Oct \d+, 2026, \d+:\d\d [AP]M EDT/,'Eastern by default');
  await admin.req('properties/location',{id:home.id,timezone:'America/Chicago'});
  assert.match(await pdfText(admin,legacy),/Completed Oct \d+, 2026, \d+:\d\d [AP]M CDT/,'residence time zone is used (also for reports published before the fix)');
  await admin.req('properties/location',{id:home.id,timezone:'Mars/Olympus'},422);
  await admin.req('properties/location',{id:home.id,timezone:''});
  await admin.req('visit-verification/settings',{enabled:false,requireCheckIn:false,showOnPdf:true,capturePhotoLocation:true,radius:150,timezone:'America/Phoenix'});
  assert.match(await pdfText(admin,legacy),/Completed Oct \d+, 2026, \d+:\d\d [AP]M MST/,'no residence zone: the company time zone');
  const legacyClient=(await family.req('data')).inspections.find(i=>i.id===legacy);assert.equal(legacyClient.visit,undefined);
  await employee.req('visit-verification/settings',{enabled:true},403);
  await admin.req('visit-verification/settings',{enabled:true,radius:5},422);

  // ---- turn it on; set the residence location.
  const s=await admin.req('visit-verification/settings',{enabled:true,requireCheckIn:true,showOnPdf:true,capturePhotoLocation:true,radius:150,timezone:'America/Phoenix'});
  assert.equal(s.enabled,true);assert.equal(s.requireCheckIn,true);
  await employee.req('properties/location',{id:home.id,latitude:HOME.lat,longitude:HOME.lon},403);
  await admin.req('properties/location',{id:home.id,latitude:95,longitude:0},422);
  const loc=await admin.req('properties/location',{id:home.id,latitude:HOME.lat,longitude:HOME.lon,radius:''});
  assert.equal(loc.geocode_source,'manual');assert.equal(loc.effective_timezone,'America/Phoenix');
  const adminData=await admin.req('data');
  assert.equal(adminData.visitVerification.enabled,true);assert.equal(adminData.companyTimezone,'America/Phoenix');
  assert.equal(adminData.properties.find(p=>p.id===home.id).effective_radius_m,150);

  // ---- check-in: idempotent, scoped, require-check-in enforced.
  const v1=await start();
  const i1=await find(employee,v1);
  await employee.req('inspections/save',{id:v1,version:i1.version,answers:passAll(),summary:'',notes:'',internalNotes:''},422);
  const key=randomUUID(),checkIn={deviceAt:new Date().toISOString(),...NEAR,source:'gps',offline:false};
  const first=await employee.req('inspections/'+v1+'/check-in',checkIn,200,{'Idempotency-Key':key});
  assert.equal(first.status,'verified');assert.ok(Math.abs(first.visit.check_in.distance_m-40)<=2,'distance ~40 m: '+first.visit.check_in.distance_m);
  assert.equal(first.visit.check_in.lat,NEAR.latitude,'the inspector sees their own coordinates');
  const replay=await employee.call('POST','inspections/'+v1+'/check-in',checkIn,{'Idempotency-Key':key});
  assert.equal(replay.status,200);assert.equal(replay.headers.get('idempotency-replayed'),'true');assert.deepEqual(replay.body,first);
  const again=await employee.req('inspections/'+v1+'/check-in',{...checkIn,...FAR},200,{'Idempotency-Key':randomUUID()});
  assert.equal(again.repeated,true);assert.equal(again.visit.check_in.server_at,first.visit.check_in.server_at,'the first check-in wins');
  await family.req('inspections/'+v1+'/check-in',checkIn,403);await vendor.req('inspections/'+v1+'/check-in',checkIn,403);
  await outsider.req('inspections/'+v1+'/check-in',checkIn,404);await outsider.req('inspections/'+v1+'/visit/override',{reason:'Long enough reason'},404);
  await employee.req('inspections/'+v1+'/visit/override',{reason:'I was definitely there'},403);await family.req('inspections/'+v1+'/visit/override',{reason:'I was definitely there'},403);
  await admin.req('inspections/'+v1+'/visit/override',{reason:'too short'},422);
  await fill(v1);

  // ---- photos: EXIF GPS stripped from storage; position kept as columns (EXIF, or the device position).
  const exifUp=await employee.req('files',{propertyId:home.id,inspectionId:v1,name:'Kitchen.jpg',base64:exifJpeg().toString('base64')},201);
  const devUp=await employee.req('files',{propertyId:home.id,inspectionId:v1,name:'Porch.jpg',capturedAt:new Date().toISOString(),captureLatitude:NEAR.latitude,captureLongitude:NEAR.longitude,captureAccuracy:5,base64:fixture.toString('base64')},201);
  const stored=Buffer.from(await (await admin.raw('files/'+exifUp.id)).arrayBuffer());
  assert.equal(readExif(stored).lat,null,'stored photo has no GPS');assert.ok(!stored.includes(Buffer.from('GPSLatitude')),'stored photo has no XMP GPS');
  const files=(await admin.req('data')).files;const fx=files.find(f=>f.id===exifUp.id),fd=files.find(f=>f.id===devUp.id);
  assert.equal(fx.capture_source,'exif');assert.ok(Math.abs(fx.capture_lat-27.1975)<1e-6);assert.equal(fx.captured_at,'2026-10-02T13:05:00.000Z','EXIF capture time');
  assert.equal(fd.capture_source,'device');assert.equal(fd.capture_lat,NEAR.latitude);

  // ---- submit without checking out: automatic check-out.
  await employee.req('inspections/submit',{id:v1,version:(await find(employee,v1)).version},201);
  row=await find(admin,v1);
  assert.equal(row.visit.check_out.auto,true,'checked out automatically at submit');assert.equal(row.visit.status,'verified');assert.ok(row.visit.duration_seconds>=0);
  await publish(v1);
  row=await find(admin,v1);
  assert.match(row.report_number,/^OH-20261002-\d+$/);
  pdf=await pdfText(admin,v1);
  for(const part of ['VISIT VERIFICATION','VERIFIED','Departed','Report number '+row.report_number,'at the residence','Reference '+v1])assert.ok(pdf.includes(part),'PDF has '+part);
  assert.match(pdf,/Arrived Oct \d+, 2026, \d+:\d\d [AP]M MST/,'box times in the company zone (residence has none)');
  assert.ok(/Verified at the residence \(\d+ m, GPS accuracy \xb18 m\)/.test(pdf),'distance + accuracy line');
  assert.ok(pdf.includes('checked out automatically when the report was completed'),'automatic check-out shown');

  // ---- client portal: same summary, never coordinates or device/server raw times.
  const fdata=await family.req('data');const portal=fdata.inspections.find(i=>i.id===v1);
  assert.equal(portal.visit.status,'verified');assert.ok(portal.visit.check_in.at);assert.equal(portal.visit.check_in.distance_m,first.visit.check_in.distance_m);
  const raw=JSON.stringify(fdata);
  for(const k of ['"lat"','"lon"','check_in_lat','"device_at"','"server_at"','capture_lat','"latitude"','"longitude"'])assert.ok(!raw.includes(k),'client data has no '+k);
  assert.equal(fdata.properties.find(p=>p.id===home.id).effective_timezone,'America/Phoenix');
  const vdata=JSON.stringify(await vendor.req('data'));assert.ok(!vdata.includes('"visit"')&&!vdata.includes('capture_lat'),'vendors see nothing');

  // ---- show on PDF/portal off: box and portal block hidden; on again: back.
  await admin.req('visit-verification/settings',{enabled:true,requireCheckIn:true,showOnPdf:false,capturePhotoLocation:true,radius:150,timezone:'America/Phoenix'});
  assert.ok(!(await pdfText(admin,v1)).includes('VISIT VERIFICATION'),'setting off: no PDF box');
  assert.equal((await find(family,v1)).visit,undefined,'setting off: no portal block');
  await admin.req('visit-verification/settings',{enabled:true,requireCheckIn:true,showOnPdf:true,capturePhotoLocation:true,radius:150,timezone:'America/Phoenix'});
  assert.ok(!(await pdfText(admin,legacy)).includes('VISIT VERIFICATION'),'reports published before the feature stay without a box');

  // ---- outside the area: reason, then admin override (audited, shown on the report).
  const v2=await start();
  const out=await employee.req('inspections/'+v2+'/check-in',{deviceAt:new Date().toISOString(),...FAR},200);
  assert.equal(out.status,'outside_geofence');assert.ok(out.visit.check_in.distance_m>1100);
  const withReason=await employee.req('inspections/'+v2+'/check-in',{deviceAt:new Date().toISOString(),...FAR,note:'Checked the boathouse first'},200);
  assert.equal(withReason.visit.check_in.note,'Checked the boathouse first','a repeat can add the reason');
  const over=await admin.req('inspections/'+v2+'/visit/override',{reason:'Called the inspector at the gate.'});
  assert.equal(over.status,'verified');assert.equal(over.visit.override.by_name,'Owner');
  assert.ok((await admin.req('data')).audit.some(a=>a.action==='inspection.visit_override'&&a.entity_id===v2),'override audited');
  await fill(v2);await publish(v2);
  pdf=await pdfText(admin,v2);
  assert.ok(pdf.includes('Verified by Owner')&&pdf.includes('Owner - Called the inspector at the gate.')&&pdf.includes('Recorded 1.2 km from the residence - reason: Checked the boathouse first'),'override + reason on the PDF');
  const otherView=(await find(employee,v2)).visit;assert.equal(otherView.check_in.lat,FAR.latitude);

  // ---- denied permission: check-in without a position, visit still completes, "Location unavailable".
  const v3=await start();
  const denied=await employee.req('inspections/'+v3+'/check-in',{deviceAt:new Date().toISOString(),source:'denied',offline:false});
  assert.equal(denied.status,'location_unavailable');
  await fill(v3);await employee.req('inspections/'+v3+'/check-out',{deviceAt:new Date().toISOString(),source:'denied'});
  await employee.req('inspections/submit',{id:v3,version:(await find(employee,v3)).version},201);await publish(v3);
  assert.ok((await pdfText(admin,v3)).includes('LOCATION UNAVAILABLE'));

  // ---- offline: check-in captured with no signal 25 minutes ago, synced now through the outbox engine.
  const store=OC.memoryStore(),offId=randomUUID(),capturedAt=new Date(Date.now()-25*60000).toISOString();
  await store.putDraft({inspectionId:offId,propertyId:home.id,inspectionDate:'2026-10-02',baseVersion:1,base:OC.content({answers:[],summary:'',notes:'',internalNotes:''}),answers:passAll(),summary:'Offline visit.',notes:'',internalNotes:'',rev:1,dirty:true,status:'draft',photos:[],localOnly:true,visitType:'routine'});
  await OC.enqueue(store,{type:'start_inspection',inspectionId:offId,payload:{propertyId:home.id,date:'2026-10-02',templateId:'built-in',visitType:'routine'}});
  await OC.enqueue(store,{type:'visit_check_in',inspectionId:offId,payload:{deviceAt:capturedAt,latitude:NEAR.latitude,longitude:NEAR.longitude,accuracy:9,source:'gps',offline:true}});
  await OC.enqueue(store,{type:'save_draft',inspectionId:offId});
  await OC.enqueue(store,{type:'visit_check_out',inspectionId:offId,payload:{deviceAt:new Date(Date.now()-5*60000).toISOString(),source:'auto',offline:true,auto:true}});
  await OC.enqueue(store,{type:'complete_inspection',inspectionId:offId,payload:{autoPublish:false}});
  const sent=[];const send=async(method,p,body,k)=>{const r=await employee.call(method,p.replace(/^\/api\//,''),body,k?{'Idempotency-Key':k}:{});sent.push([p,r.status]);return {status:r.status,body:r.body};};
  await OC.createSyncEngine({store,send}).run();
  assert.equal((await store.getOutbox()).length,0,'all synced: '+JSON.stringify(sent));
  assert.ok(sent.some(([p])=>/\/check-in\?sentAt=/.test(p)),'device send time travels in the query');
  const offRow=await find(admin,offId);
  assert.equal(offRow.status,'submitted');assert.equal(offRow.visit.check_in.offline,true);assert.equal(offRow.visit.check_in.at,capturedAt,'arrival = device time');
  assert.notEqual(offRow.visit.check_in.server_at,capturedAt,'server receive time kept too');assert.equal(offRow.visit.clock_skew,false);
  assert.equal(offRow.visit.check_out.auto,true);assert.equal(offRow.visit.status,'verified');
  const arrived=V.describe(offRow.visit,'America/Phoenix').rows.find(r=>r[0]==='Arrived')[1];
  assert.match(arrived,/^[A-Z][a-z]{2} \d+, 2026, \d+:\d\d [AP]M MST \(recorded offline; synced .* MST\)$/);
  assert.equal((await store.getMeta('visit:'+offId)).server.check_in.offline,true,'the device keeps the server copy beside the draft after sync');
  await publish(offId);
  assert.ok((await pdfText(admin,offId)).includes('(recorded offline; synced'),'PDF says recorded offline');
  // A device whose clock is 30 minutes slow is flagged.
  const skewStore=OC.memoryStore(),skewId=await start();
  await OC.enqueue(skewStore,{type:'visit_check_in',inspectionId:skewId,payload:{deviceAt:new Date(Date.now()-30*60000).toISOString(),...NEAR,offline:true}});
  await OC.createSyncEngine({store:skewStore,send,now:()=>Date.now()-30*60000}).run();
  assert.equal((await find(admin,skewId)).visit.clock_skew,true,'clock skew flagged');

  // ---- report numbers stay unique when several reports at one residence publish at once.
  await admin.req('visit-verification/settings',{enabled:true,requireCheckIn:false,showOnPdf:true,capturePhotoLocation:true,radius:150,timezone:'America/Phoenix'});
  const many=[];for(let n=0;n<4;n++){const id=await start('2026-10-09');await fill(id);many.push(id);}
  const versions=await Promise.all(many.map(id=>find(admin,id)));
  await Promise.all(versions.map(i=>admin.req('inspections/publish',{id:i.id,version:i.version,idempotencyKey:randomUUID()},201)));
  const numbers=(await admin.req('data')).inspections.filter(i=>many.includes(i.id)).map(i=>i.report_number).sort();
  assert.deepEqual(numbers,['OH-20261009-1','OH-20261009-2','OH-20261009-3','OH-20261009-4']);

  // ---- offline snapshot carries what the card needs with no signal.
  const draft=await start();await employee.req('inspections/'+draft+'/check-in',{deviceAt:new Date().toISOString(),...NEAR});
  const snap=await employee.req('offline/visits?propertyIds='+home.id);
  assert.equal(snap.visitVerification.enabled,true);assert.equal(snap.visitVerification.notice,V.NOTICE);
  const sp=snap.properties[0];assert.equal(sp.latitude,HOME.lat);assert.equal(sp.effective_timezone,'America/Phoenix');assert.equal(sp.effective_radius_m,150);
  assert.equal(snap.inspections.find(i=>i.id===draft).visit.status,'verified');
 }catch(error){error.message+='\n'+srv.log;throw error;}
 finally{await srv.stop();}
}
test('visit verification on SQLite',()=>scenario('sqlite',{}));
test('visit verification on Postgres (PGlite)',()=>scenario('pg',{pg:true}));

test('background geocoding: feature on + API key only; sets coordinates and the time zone',async()=>{
 const calls=[];
 const stub=createServer((req,res)=>{calls.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:[{lat:41.8781,lon:-87.6298,formatted:'1 Lake Shore Dr, Chicago, IL',timezone:{name:'America/Chicago'}}]}));});
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-geo-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,GEOAPIFY_API_KEY:'test-key',GEOAPIFY_BASE_URL:'http://127.0.0.1:'+stub.address().port,ESTATEOS_GEOCODE_INTERVAL_MS:'200',ESTATEOS_GEOCODE_DELAY_MS:'0'});
 await srv.start();
 try{
  const admin=client(srv);
  await admin.req('setup',{company:'Geo Co',name:'Owner',email:'owner@example.test',password:pw},201);
  const fam=await admin.req('clients',{name:'Family'},201);
  const home=await admin.req('properties',{clientId:fam.id,name:'Lake House',streetAddress:'1 Lake Shore Dr',city:'Chicago',state:'IL',postalCode:'60601',country:'United States'},201);
  await sleep(700);
  assert.equal(calls.length,0,'feature off: no geocoding requests');
  await admin.req('visit-verification/settings',{enabled:true,showOnPdf:true,capturePhotoLocation:true,radius:150});
  let p;for(let n=0;n<40;n++){await sleep(150);p=(await admin.req('data')).properties.find(x=>x.id===home.id);if(p.latitude)break;}
  assert.equal(p.latitude,41.8781);assert.equal(p.geocode_source,'geoapify');assert.equal(p.timezone,'America/Chicago');assert.equal(p.timezone_source,'geocode');assert.equal(p.effective_timezone,'America/Chicago');
  assert.ok(calls[0].startsWith('/v1/geocode/search?text=')&&calls[0].includes('apiKey=test-key'));
  const count=calls.length;await sleep(600);assert.equal(calls.length,count,'geocoded once; not repeated');
  // Address change re-geocodes; a manual location is never overwritten.
  await admin.req('properties/location',{id:home.id,latitude:41.9,longitude:-87.7});
  await admin.req('properties/update',{id:home.id,name:'Lake House',streetAddress:'2 Lake Shore Dr',city:'Chicago',state:'IL',postalCode:'60601',country:'United States'},201);
  await sleep(600);p=(await admin.req('data')).properties.find(x=>x.id===home.id);
  assert.equal(p.latitude,41.9,'manual location kept');assert.equal(p.geocode_source,'manual');
  const looked=await admin.req('properties/location',{id:home.id,geocode:true});assert.equal(looked.geocode_source,'geoapify');assert.equal(looked.latitude,41.8781);
 }catch(error){error.message+='\n'+srv.log;throw error;}
 finally{await srv.stop();stub.close();}
});
