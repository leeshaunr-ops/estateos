// Flight-aware arrival preparation: residence-time math (time zones, DST), plan anchors and ETA shift math, change
// alerts, AeroAPI request shapes, signed callback URLs, and server scenarios on SQLite and Postgres (PGlite) with the
// test flight service: permissions, company isolation, callbacks (bad token, wrong alert), delays and early arrivals
// moving the plan with alerts, the readiness gate, cancellation, the close-down visit after departure, and manual mode.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localToUtc,flightTimes,anchors,taskDue,shiftPlan,changeEvents,offsetLabel,flightClock,SUGGESTED_TASKS} from '../flights.mjs';
import {normalizeFlight,parseAeroFlight,pickFlight,createFlightAwareProvider,createFakeFlightProvider,flightProvider,ALERT_EVENTS} from '../flight-providers.mjs';
import {signToken,verifyToken} from '../integration-core.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const FAKE_SECRET='estateaegis-fake-flight-secret';

test('residence times: time zones and daylight saving',()=>{
 assert.equal(localToUtc('2026-10-06T15:00','America/Chicago'),'2026-10-06T20:00:00.000Z');
 assert.equal(localToUtc('2026-10-06T15:00','America/Los_Angeles'),'2026-10-06T22:00:00.000Z');
 assert.equal(localToUtc('2026-07-01T15:00','America/Phoenix'),'2026-07-01T22:00:00.000Z','Arizona has no daylight saving');
 assert.equal(localToUtc('2026-12-01T15:00','Pacific/Honolulu'),'2026-12-02T01:00:00.000Z');
 assert.equal(localToUtc('2026-03-07T12:00','America/New_York'),'2026-03-07T17:00:00.000Z','EST before the change');
 assert.equal(localToUtc('2026-03-08T12:00','America/New_York'),'2026-03-08T16:00:00.000Z','EDT after it');
 assert.equal(localToUtc('2026-03-08T02:30','America/New_York'),'2026-03-08T07:30:00.000Z','a time that does not exist moves forward');
 assert.equal(localToUtc('2026-11-01T01:30','America/New_York'),'2026-11-01T05:30:00.000Z','the repeated hour uses the first (EDT) one');
 assert.equal(localToUtc('2026-10-06T15:00','Mars/Olympus'),'2026-10-06T19:00:00.000Z','unknown zone: Eastern');
 assert.equal(localToUtc('tomorrow','America/New_York'),null);
});
test('plan anchors, due times and the ETA shift math',()=>{
 const arrival={arrival_at:'2026-10-06T15:00'};
 assert.deepEqual(anchors(arrival,[],'America/Chicago'),{landing:'2026-10-06T20:00:00.000Z',departure:null},'no flight: the typed arrival time on the residence clock');
 const flights=[
  {direction:'arrival',status:'scheduled',scheduled_in:'2026-10-06T18:00:00.000Z',estimated_in:'2026-10-06T19:15:00.000Z'},
  {direction:'arrival',status:'scheduled',scheduled_in:'2026-10-06T21:00:00.000Z'},
  {direction:'arrival',status:'cancelled',scheduled_in:'2026-10-06T12:00:00.000Z'},
  {direction:'departure',status:'scheduled',scheduled_out:'2026-10-12T14:00:00.000Z'},
  {direction:'departure',status:'departed',scheduled_out:'2026-10-13T14:00:00.000Z',actual_out:'2026-10-13T14:20:00.000Z'}];
 const a=anchors(arrival,flights,'America/Chicago');
 assert.deepEqual(a,{landing:'2026-10-06T19:15:00.000Z',departure:'2026-10-13T14:20:00.000Z'},'first live arrival ETA; last departure; cancelled flights ignored');
 assert.deepEqual(flightTimes({direction:'arrival',scheduled_in:'s',estimated_in:'e',actual_in:'x'}),{scheduled:'s',eta:'x',actual:'x'});
 assert.deepEqual(flightTimes({direction:'departure',scheduled_out:'s',estimated_out:'e'}),{scheduled:'s',eta:'e',actual:null});
 const tasks=[{id:'hvac',anchor:'landing',offset_minutes:-240,due_at:'2026-10-06T14:00:00.000Z'},{id:'driver',anchor:'landing',offset_minutes:0,due_at:'2026-10-06T18:00:00.000Z'},{id:'close',anchor:'departure',offset_minutes:120,due_at:'2026-10-13T16:20:00.000Z'}];
 assert.equal(taskDue(tasks[0],a),'2026-10-06T15:15:00.000Z');
 const shifts=shiftPlan(tasks,a);
 assert.deepEqual(shifts.map(s=>[s.task.id,s.from,s.to]),[['hvac','2026-10-06T14:00:00.000Z','2026-10-06T15:15:00.000Z'],['driver','2026-10-06T18:00:00.000Z','2026-10-06T19:15:00.000Z']],'a 75 minute delay moves every landing task 75 minutes; unchanged tasks are left alone');
 assert.equal(taskDue({anchor:'departure',offset_minutes:0},{landing:'x',departure:null}),null);
 // Elapsed-time offsets across the fall-back night: 4 hours before a 6:00 AM EST landing is 1:00 AM EDT (still 4 real hours).
 const dst=anchors({},[{direction:'arrival',status:'scheduled',scheduled_in:localToUtc('2026-11-01T06:00','America/New_York')}],'America/New_York');
 assert.equal(dst.landing,'2026-11-01T11:00:00.000Z');assert.equal(taskDue({anchor:'landing',offset_minutes:-240},dst),'2026-11-01T07:00:00.000Z');
 const spring=anchors({arrival_at:'2026-03-08T09:00'},[],'America/New_York');assert.equal(spring.landing,'2026-03-08T13:00:00.000Z');
 assert.equal(taskDue({anchor:'landing',offset_minutes:-480},spring),'2026-03-08T05:00:00.000Z','8 real hours before 9:00 AM EDT is midnight EST');
 assert.equal(anchors({arrival_at:'2026-10-06T15:00:00Z'},[],'America/Chicago').landing,'2026-10-06T15:00:00.000Z','an arrival time with a zone is used as is');
 assert.deepEqual(SUGGESTED_TASKS.map(t=>t.offset),[-240,-120,0]);
});
test('alerts compare with what staff were last told',()=>{
 const base={notifiedEta:'2026-10-06T18:00:00Z',notifiedStatus:'scheduled'};
 assert.deepEqual(changeEvents({...base,eta:'2026-10-06T19:15:00Z',status:'scheduled'}),[{kind:'delay',minutes:75}]);
 assert.deepEqual(changeEvents({...base,eta:'2026-10-06T18:19:00Z',status:'scheduled'}),[],'below the threshold: no alert');
 assert.deepEqual(changeEvents({...base,eta:'2026-10-06T18:19:00Z',status:'scheduled',alertMinutes:10}),[{kind:'delay',minutes:19}]);
 assert.deepEqual(changeEvents({...base,eta:'2026-10-06T17:30:00Z',status:'en_route'}),[{kind:'early',minutes:30}]);
 assert.deepEqual(changeEvents({...base,eta:'2026-10-06T21:00:00Z',status:'cancelled'}),[{kind:'cancelled'}],'a cancellation is one alert, not also a delay');
 assert.deepEqual(changeEvents({...base,notifiedStatus:'cancelled',eta:'x',status:'cancelled'}),[],'only once');
 assert.deepEqual(changeEvents({...base,eta:'2026-10-06T19:00:00Z',status:'diverted'}),[{kind:'diverted'}]);
 assert.deepEqual(changeEvents({notifiedEta:null,notifiedStatus:'scheduled',eta:'2026-10-06T19:00:00Z',status:'scheduled'}),[]);
 assert.equal(offsetLabel(-240),'4 h before landing');assert.equal(offsetLabel(-90),'1 h 30 min before landing');assert.equal(offsetLabel(0),'At landing');
 assert.equal(offsetLabel(45,'departure'),'45 min after departure');assert.equal(offsetLabel(-1440,'departure'),'24 h before departure');
 assert.equal(flightClock({ESTATEOS_FLIGHT_TEST_NOW_FILE:'/nope',RENDER:'true'}).toString().includes('Date.now'),true,'the test clock never runs on Render');
});
test('flight numbers and AeroAPI flight data',()=>{
 assert.deepEqual(normalizeFlight(' dl ','0123'),{airline:'DL',number:'123',ident:'DL123'});
 assert.deepEqual(normalizeFlight('B6','1001A'),{airline:'B6',number:'1001A',ident:'B61001A'});
 assert.equal(normalizeFlight('DELTA','12'),null);assert.equal(normalizeFlight('DL','12345'),null);assert.equal(normalizeFlight('DL',''),null);
 const f=parseAeroFlight({fa_flight_id:'DAL1287-1',ident:'DAL1287',ident_iata:'DL1287',origin:{code_iata:'BOS',code:'KBOS',city:'Boston',timezone:'America/New_York'},destination:{code_iata:'CHS',city:'Charleston',timezone:'America/New_York'},scheduled_out:'2026-10-06T14:00:00Z',estimated_out:'2026-10-06T15:10:00Z',actual_out:'2026-10-06T15:12:00Z',actual_off:'2026-10-06T15:25:00Z',scheduled_in:'2026-10-06T18:00:00Z',estimated_in:'2026-10-06T19:15:00Z',status:'En Route / Delayed'});
 assert.equal(f.ident,'DL1287');assert.equal(f.origin.code,'BOS');assert.equal(f.status,'en_route');assert.equal(f.estimatedIn,'2026-10-06T19:15:00.000Z');assert.equal(f.statusText,'En Route / Delayed');
 assert.equal(parseAeroFlight({cancelled:true,actual_off:'2026-10-06T15:25:00Z'}).status,'cancelled');
 assert.equal(parseAeroFlight({diverted:true}).status,'diverted');assert.equal(parseAeroFlight({actual_on:'2026-10-06T19:00:00Z'}).status,'landed');
 assert.equal(parseAeroFlight({actual_in:'2026-10-06T19:05:00Z'}).status,'arrived');assert.equal(parseAeroFlight(null),null);
 // A late-evening West Coast departure is the next day in UTC: it still belongs to the local date the family typed.
 const red={fa_flight_id:'red',origin:{code_iata:'LAX',timezone:'America/Los_Angeles'},destination:{code_iata:'JFK'},scheduled_out:'2026-10-06T05:30:00Z'};
 const day={fa_flight_id:'day',origin:{code_iata:'LAX',timezone:'America/Los_Angeles'},destination:{code_iata:'JFK'},scheduled_out:'2026-10-06T16:00:00Z'};
 assert.equal(pickFlight([day,red],'2026-10-05').faFlightId,'red');assert.equal(pickFlight([day,red],'2026-10-06').faFlightId,'day');
 assert.equal(pickFlight([day],'2026-10-09').faFlightId,'day','nearest when nothing matches the date');assert.equal(pickFlight([],'2026-10-06'),null);
});
test('FlightAware AeroAPI client sends documented requests; signed callback URLs; provider choice',async()=>{
 const sent=[];const reply=(status,obj,headers={})=>({ok:status<400,status,headers:new Headers(headers),json:async()=>obj});
 const fetcher=async(url,opts)=>{const u=new URL(url);sent.push({url:u,method:opts.method,key:opts.headers['x-apikey'],body:opts.body?JSON.parse(opts.body):null});
  if(u.pathname.endsWith('/alerts')&&opts.method==='POST')return reply(201,{},{location:'/aeroapi/alerts/987654'});
  if(u.pathname.includes('/alerts/'))return reply(404,{title:'Not found'});
  if(u.pathname.includes('/schedules/'))return reply(200,{scheduled:[{ident:'DAL1287',ident_iata:'DL1287',origin_iata:'BOS',destination_iata:'CHS',scheduled_out:'2026-10-20T14:00:00Z',scheduled_in:'2026-10-20T18:00:00Z'}]});
  if(u.pathname.includes('/flights/'))return reply(200,{flights:[{fa_flight_id:'DAL1287-1790000000-airline-0001',ident_iata:'DL1287',origin:{code_iata:'BOS',timezone:'America/New_York'},destination:{code_iata:'CHS'},scheduled_out:'2026-10-06T14:00:00Z',scheduled_in:'2026-10-06T18:00:00Z',estimated_in:'2026-10-06T18:10:00Z',status:'Scheduled'}]});
  return reply(500,{title:'unexpected'});};
 const fa=createFlightAwareProvider({apiKey:'fa_test_key',webhookSecret:'s',fetcher,clock:()=>Date.parse('2026-10-05T12:00:00Z')});
 const live=await fa.lookup({airline:'DL',number:'1287',day:'2026-10-06'});
 assert.equal(sent[0].url.origin+sent[0].url.pathname,'https://aeroapi.flightaware.com/aeroapi/flights/DL1287');assert.equal(sent[0].method,'GET');assert.equal(sent[0].key,'fa_test_key');
 assert.deepEqual(Object.fromEntries(sent[0].url.searchParams),{ident_type:'designator',start:'2026-10-05',end:'2026-10-08'});
 assert.equal(live.faFlightId,'DAL1287-1790000000-airline-0001');assert.equal(live.tracked,true);assert.equal(live.estimatedIn,'2026-10-06T18:10:00.000Z');
 const later=await fa.lookup({airline:'DL',number:'1287',day:'2026-10-20'});
 assert.equal(sent[1].url.pathname,'/aeroapi/schedules/2026-10-19/2026-10-22','beyond the two-day live window: airline schedules');
 assert.deepEqual(Object.fromEntries(sent[1].url.searchParams),{airline:'DL',flight_number:'1287',max_pages:'1'});
 assert.equal(later.tracked,false);assert.equal(later.faFlightId,null);assert.equal(later.origin.code,'BOS');assert.equal(later.scheduledIn,'2026-10-20T18:00:00.000Z');
 await fa.status({faFlightId:'DAL1287-1790000000-airline-0001'});assert.equal(sent[2].url.pathname,'/aeroapi/flights/DAL1287-1790000000-airline-0001');assert.equal(sent[2].url.searchParams.get('ident_type'),'fa_flight_id');
 const alert=await fa.createAlert({ident:'DL1287',origin:'BOS',destination:'CHS',day:'2026-10-06',targetUrl:'https://app.example.test/api/webhooks/flightaware/f1/tok'});
 assert.deepEqual(alert,{alertId:'987654'},'the new alert id comes from the Location header');
 assert.equal(sent[3].method,'POST');assert.deepEqual(sent[3].body,{ident:'DL1287',origin:'BOS',destination:'CHS',start:'2026-10-06',end:'2026-10-07',eta:0,events:ALERT_EVENTS,target_url:'https://app.example.test/api/webhooks/flightaware/f1/tok'});
 assert.deepEqual(await fa.deleteAlert({alertId:'987654'}),{ok:true},'an alert that is already gone counts as removed');assert.equal(sent[4].method,'DELETE');assert.equal(sent[4].url.pathname,'/aeroapi/alerts/987654');
 await assert.rejects(createFlightAwareProvider({apiKey:'k',fetcher:async()=>reply(401,{title:'Unauthorized',detail:'Invalid API key'})}).status({faFlightId:'x'}),e=>e.status===502&&/Invalid API key/.test(e.message));
 const t=signToken('secret','flight:f1');assert.equal(verifyToken('secret','flight:f1',t),true);assert.equal(verifyToken('secret','flight:f2',t),false,'a token only opens its own flight');assert.equal(verifyToken('other','flight:f1',t),false);assert.equal(verifyToken('','flight:f1',t),false);
 assert.equal(flightProvider({FLIGHTAWARE_API_KEY:'k'}).kind,'flightaware');assert.equal(flightProvider({FLIGHTAWARE_API_KEY:'k'}).alerts,false,'no callback secret: polling only');
 assert.equal(flightProvider({FLIGHTAWARE_API_KEY:'k',FLIGHTAWARE_WEBHOOK_SECRET:'s'}).alerts,true);
 assert.equal(flightProvider({}).kind,'manual');assert.equal(flightProvider({ESTATEOS_FAKE_FLIGHTS:'1'}).kind,'fake');assert.equal(flightProvider({ESTATEOS_FAKE_FLIGHTS:'1',RENDER:'true'}).kind,'manual','never the test service on Render');
 const fake=createFakeFlightProvider();assert.equal((await fake.lookup({airline:'DL',number:'9999',day:'2026-10-06'})),null);assert.equal((await fake.lookup({airline:'DL',number:'1',day:'2026-10-06'})).scheduledIn,'2026-10-06T18:00:00.000Z');
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
 async denied(endpoint,b){const r=await c.call('POST',endpoint,b);assert.ok([403,404].includes(r.status),`${endpoint} should be refused: ${r.status} ${JSON.stringify(r.body)}`);return r;}};return c;}

async function company(srv,label){
 const admin=client(srv),leo=client(srv),mia=client(srv),family=client(srv),family2=client(srv),vendor=client(srv),outsider=client(srv);
 const setup=await admin.req('setup',{company:'Harborline Home Watch '+label,name:'Jordan Ellis',email:'owner@example.test',password:pw},201);
 await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
 await admin.req('login',{email:'owner@example.test',password:pw});
 const fam=await admin.req('clients',{name:'Sample family'},201),fam2=await admin.req('clients',{name:'Second sample family'},201);
 const home=await admin.req('properties',{clientId:fam.id,name:'Seagrass House',streetAddress:'1 Example Rd',city:'Springfield',state:'IL',postalCode:'62701',country:'United States'},201);
 const other=await admin.req('properties',{clientId:fam2.id,name:'Ridge Cabin',streetAddress:'2 Example Ln',city:'Springfield',state:'IL',postalCode:'62701',country:'United States'},201);
 await admin.req('properties/location',{id:home.id,timezone:'America/Chicago'});await admin.req('properties/location',{id:other.id,timezone:'America/Chicago'});
 const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return (await c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201)).user;};
 const leoU=await accept(leo,'employee','leo@example.test','Leo Field'),miaU=await accept(mia,'employee','mia@example.test','Mia Field');
 await accept(family,'client','fam@example.test','Sam Sample',{clientId:fam.id});await accept(family2,'client','fam2@example.test','Kim Sample',{clientId:fam2.id});
 const v1=await admin.req('vendors',{name:'Test Pool Care'},201);await accept(vendor,'vendor','pool@example.test','Pat Pool',{vendorId:v1.id});
 await admin.req('access',{userId:leoU.id,propertyId:home.id},201);await admin.req('access',{userId:miaU.id,propertyId:other.id},201);
 const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
 await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);
 return {admin,leo,mia,family,family2,vendor,outsider,leoU,miaU,home,other};
}
const F=async c=>(await c.req('data')).flights;
const titles=async c=>(await c.req('data')).notifications.map(n=>n.title);

async function scenario(label,pg){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-flights-'));dirs.push(dir);
 const clockFile=path.join(dir,'now.txt'),setNow=iso=>writeFileSync(clockFile,iso);setNow('2026-10-06T10:00:00Z');
 const fakeFile=path.join(dir,'flights.json'),overrides={},setFlight=(key,v)=>{overrides[key]=v;writeFileSync(fakeFile,JSON.stringify(overrides));};setFlight('none@x',{});
 const env={ESTATEOS_DATA_DIR:dir,ESTATEOS_FAKE_FLIGHTS:'1',ESTATEOS_FAKE_FLIGHTS_FILE:fakeFile,ESTATEOS_FLIGHT_TEST_NOW_FILE:clockFile,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64'),...(pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})};
 delete process.env.DATABASE_URL;
 const srv=server(env);await srv.start();
 const hook=async(flightId,payload={},token=signToken(FAKE_SECRET,'flight:'+flightId))=>(await fetch(`${srv.base}/api/webhooks/flightaware/${flightId}/${token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).status;
 try{
  const {admin,leo,mia,family,family2,vendor,outsider,leoU,home,other}=await company(srv,label);
  for(const ep of ['add','eta','remove','refresh','tasks/add','tasks/done','settings']){const r=await client(srv).call('POST','flights/'+ep,{});assert.equal(r.status,401,`signed out: flights/${ep}`);}
  const arrival=await family.req('arrivals',{propertyId:home.id,arrivalAt:'2026-10-06T15:00',needs:'Two guests.'},201);
  const otherArrival=await family2.req('arrivals',{propertyId:other.id,arrivalAt:'2026-10-07T18:00'},201);

  // Who may add a flight: the family on their own arrival and staff with access; never vendors, other families or other companies.
  await family.req('flights/add',{arrivalId:arrival.id,airline:'Delta',flightNumber:'1287',date:'2026-10-06'},422);
  await family.req('flights/add',{arrivalId:arrival.id,airline:'DL',flightNumber:'1287',date:''},422);
  await vendor.denied('flights/add',{arrivalId:arrival.id,airline:'DL',flightNumber:'1287',date:'2026-10-06'});
  await family2.denied('flights/add',{arrivalId:arrival.id,airline:'DL',flightNumber:'1287',date:'2026-10-06'});
  await mia.denied('flights/add',{arrivalId:arrival.id,airline:'DL',flightNumber:'1287',date:'2026-10-06'});
  await outsider.denied('flights/add',{arrivalId:arrival.id,airline:'DL',flightNumber:'1287',date:'2026-10-06'});
  const added=await family.req('flights/add',{arrivalId:arrival.id,airline:'dl',flightNumber:'1287',date:'2026-10-06'});
  assert.equal(added.tracked,true,'matched on the flight service');
  assert.ok((await titles(admin)).includes('Flight added: Seagrass House'),'the team hears when the family adds a flight');
  let flights=await F(admin);const dl=flights.flights.find(f=>f.id===added.id);
  assert.equal(flights.mode,'fake');assert.equal(dl.ident,'DL1287');assert.equal(dl.origin,'BOS');assert.equal(dl.eta,'2026-10-06T18:00:00.000Z');assert.match(dl.status_label,/^On time · lands 1:00 PM CDT$/);
  assert.ok(flights.connection,'admins see the connection');assert.equal((await F(leo)).connection,undefined,'only admins see the connection');
  for(const c of [vendor,outsider,family2])assert.equal((await F(c)).flights.some(f=>f.id===added.id),false,'other families, vendors and companies never see the flight');
  assert.equal((await F(family)).flights[0].mine,true);

  // Timed plan: staff only; offsets from landing; the plan follows the flight.
  await family.denied('flights/tasks/suggested',{arrivalId:arrival.id});await vendor.denied('flights/tasks/suggested',{arrivalId:arrival.id});
  await mia.denied('flights/tasks/suggested',{arrivalId:arrival.id});await outsider.denied('flights/tasks/suggested',{arrivalId:arrival.id});
  assert.equal((await leo.req('flights/tasks/suggested',{arrivalId:arrival.id})).added,3);
  assert.equal((await leo.req('flights/tasks/suggested',{arrivalId:arrival.id})).added,0,'suggestions are not added twice');
  await leo.req('flights/tasks/add',{arrivalId:arrival.id,title:'Open shutters',anchor:'landing',offsetMinutes:-180,assigneeId:leoU.id});
  await leo.req('flights/tasks/add',{arrivalId:arrival.id,title:'Too far',anchor:'landing',offsetMinutes:-20000},422);
  await leo.req('flights/tasks/add',{arrivalId:arrival.id,title:'Nobody',anchor:'landing',offsetMinutes:-60,assigneeId:'nope'},422);
  const due=async()=>Object.fromEntries((await F(admin)).tasks.map(t=>[t.title,t.due_at]));
  assert.deepEqual(await due(),{'Turn on air conditioning or heat':'2026-10-06T14:00:00.000Z','Open shutters':'2026-10-06T15:00:00.000Z','Fresh flowers and groceries in place':'2026-10-06T16:00:00.000Z','Driver waiting at the airport':'2026-10-06T18:00:00.000Z'});
  assert.equal((await F(family)).tasks.length,4,'the family sees the plan');assert.equal((await F(family)).tasks[0].assignee_user_id,undefined);

  // Flight service callbacks: the URL token must match the flight, the alert must match, then the flight is re-fetched.
  assert.equal(await hook(added.id,{},'x'.repeat(43)),401);
  assert.equal(await hook(added.id,{},signToken(FAKE_SECRET,'flight:'+otherArrival.id)),401,'a token for another id is refused');
  assert.equal(await hook(added.id,{},signToken('wrong-secret','flight:'+added.id)),401);
  assert.equal(await hook(added.id,{alert_id:'not-this-one'}),409);
  setFlight('DL1287@2026-10-06',{estimated_in:'2026-10-06T19:15:00Z',status:'Scheduled / Delayed'});
  assert.equal(await hook(added.id,{alert_id:undefined,long_desc:'DL1287 delayed'}),200);
  assert.deepEqual(await due(),{'Turn on air conditioning or heat':'2026-10-06T15:15:00.000Z','Open shutters':'2026-10-06T16:15:00.000Z','Fresh flowers and groceries in place':'2026-10-06T17:15:00.000Z','Driver waiting at the airport':'2026-10-06T19:15:00.000Z'},'every task moved 75 minutes later');
  flights=await F(admin);assert.match(flights.flights[0].status_label,/^Delayed 75 min · lands 2:15 PM CDT$/);assert.ok(flights.tasks.every(t=>t.moved_minutes===75));
  assert.ok((await titles(admin)).includes('Flight delayed: Seagrass House'));assert.ok((await titles(leo)).includes('Flight delayed: Seagrass House'),'task assignees are alerted too');
  assert.equal((await titles(family)).includes('Flight delayed: Seagrass House'),false,'alerts go to staff');
  const count=async()=>(await titles(admin)).filter(t=>t.startsWith('Flight')).length,before=await count();
  setFlight('DL1287@2026-10-06',{estimated_in:'2026-10-06T19:25:00Z'});assert.equal(await hook(added.id),200);
  assert.equal(await count(),before,'a 10 minute move is below the alert threshold');assert.equal((await due())['Driver waiting at the airport'],'2026-10-06T19:25:00.000Z','but the plan still moves');
  setFlight('DL1287@2026-10-06',{estimated_in:'2026-10-06T18:30:00Z'});assert.equal(await hook(added.id),200);
  assert.ok((await titles(admin)).includes('Flight arriving early: Seagrass House'),'early compared with the last alert (2:15 PM)');
  const tracked=(await F(family)).flights[0];
  await family.req('flights/eta',{id:added.id,eta:'2026-10-06T16:00',version:tracked.version},409);

  // Readiness: steps due before landing must be done; the driver at landing does not block.
  const arrivalRow=async()=>(await admin.req('data')).arrivals.find(a=>a.id===arrival.id);
  const blocked=await admin.call('POST','arrivals/update',{id:arrival.id,status:'ready',confirmNeeds:true,version:(await arrivalRow()).version});
  assert.equal(blocked.status,422);assert.match(blocked.body.error,/Finish the arrival plan first: Turn on air conditioning or heat, Open shutters, Fresh flowers/);
  const tasks=(await F(admin)).tasks;
  await family.denied('flights/tasks/done',{id:tasks[0].id});await outsider.denied('flights/tasks/done',{id:tasks[0].id});
  for(const t of tasks.filter(t=>t.required))await leo.req('flights/tasks/done',{id:t.id});
  assert.equal((await F(family)).tasks.filter(t=>t.done_at).length,3);
  await admin.req('arrivals/update',{id:arrival.id,status:'ready',confirmNeeds:true,version:(await arrivalRow()).version},201);
  assert.equal((await family.req('data')).arrivals.find(a=>a.id===arrival.id).status,'ready','the family portal shows Residence ready');

  // Cancellation: alert once; the plan falls back to the typed arrival time (3:00 PM CDT).
  setFlight('DL1287@2026-10-06',{cancelled:true,status:'Cancelled'});assert.equal(await hook(added.id),200);assert.equal(await hook(added.id),200);
  assert.equal((await titles(admin)).filter(t=>t==='Flight cancelled: Seagrass House').length,1);
  assert.equal((await F(admin)).flights[0].status_label,'Cancelled');assert.equal((await due())['Driver waiting at the airport'],'2026-10-06T20:00:00.000Z');

  // A flight the service cannot find stays manual: the family updates its ETA; staff are alerted and the plan moves.
  const manual=await family.req('flights/add',{arrivalId:arrival.id,airline:'DL',flightNumber:'9999',date:'2026-10-06',scheduledAt:'2026-10-06T16:00'});
  assert.equal(manual.tracked,false);
  let mv=(await F(admin)).flights.find(f=>f.id===manual.id);assert.match(mv.provider_error,/no matching flight/);assert.equal(mv.eta,'2026-10-06T21:00:00.000Z');
  assert.equal((await F(family)).flights.find(f=>f.id===manual.id).provider_error,undefined,'service details are for staff');
  await family.req('flights/eta',{id:manual.id,eta:'2026-10-06T17:00',version:mv.version+5},409);
  await vendor.denied('flights/eta',{id:manual.id,eta:'2026-10-06T17:00'});await family2.denied('flights/eta',{id:manual.id,eta:'2026-10-06T17:00'});
  await family.req('flights/eta',{id:manual.id,eta:'2026-10-06T17:00',status:'scheduled',version:mv.version});
  mv=(await F(admin)).flights.find(f=>f.id===manual.id);assert.equal(mv.eta,'2026-10-06T22:00:00.000Z');assert.equal(mv.source,'manual');
  assert.equal((await due())['Driver waiting at the airport'],'2026-10-06T22:00:00.000Z');
  assert.ok((await titles(admin)).filter(t=>t==='Flight delayed: Seagrass House').length>=2,'a typed 60 minute delay alerts staff');

  // Departure: the close-down visit is created a set time after the departure flight takes off, once.
  setNow('2026-10-08T10:00:00Z');
  const dep=await admin.req('flights/add',{arrivalId:arrival.id,direction:'departure',airline:'DL',flightNumber:'2214',date:'2026-10-08',closedown:true});
  await family.req('flights/remove',{id:dep.id},403);
  setFlight('DL2214@2026-10-08',{actual_out:'2026-10-08T14:05:00Z',actual_off:'2026-10-08T14:20:00Z',status:'En Route / On Time'});
  setNow('2026-10-08T14:30:00Z');assert.equal(await hook(dep.id),200);
  const departures=async()=>(await admin.req('data')).inspections.filter(i=>i.property_id===home.id&&i.visit_type==='departure');
  let dv=(await F(admin)).flights.find(f=>f.id===dep.id);assert.match(dv.status_label,/^Departed 9:20 AM CDT$/);assert.equal(dv.closedown_inspection_id,'');assert.equal((await departures()).length,0,'not before the delay');
  setNow('2026-10-08T15:25:00Z');assert.equal(await hook(dep.id),200);assert.equal(await hook(dep.id),200);
  const visits=await departures();assert.equal(visits.length,1,'one close-down visit');assert.equal(visits[0].inspection_date,'2026-10-08');
  dv=(await F(admin)).flights.find(f=>f.id===dep.id);assert.equal(dv.closedown_inspection_id,visits[0].id);
  assert.ok((await titles(admin)).includes('Close-down visit: Seagrass House'));
  assert.ok((await admin.req('data')).audit.some(a=>a.action==='flights.closedown_visit_created'&&a.entity_id===visits[0].id));

  // Settings and removal.
  await leo.req('flights/settings',{alertMinutes:30,closedownDelayMinutes:90},403);
  await admin.req('flights/settings',{alertMinutes:2,closedownDelayMinutes:90},422);
  assert.deepEqual((await admin.req('flights/settings',{alertMinutes:30,closedownDelayMinutes:90})).settings,{alertMinutes:30,closedownDelayMinutes:90});
  await family.req('flights/remove',{id:manual.id});await outsider.denied('flights/remove',{id:dep.id});
  assert.equal((await F(admin)).flights.some(f=>f.id===manual.id),false);
  assert.equal((await outsider.req('data')).flights.flights.length,0);
  assert.equal(srv.log.includes('Flights:'),false,srv.log);
 }finally{await srv.stop();}
}

test('flight arrivals on SQLite: permissions, isolation, callbacks, plan shifts, readiness, close-down',{timeout:180000},()=>scenario('SQLite',false));
test('flight arrivals on Postgres (PGlite): same scenario',{timeout:240000},()=>scenario('Postgres',true));

test('manual mode: no flight service, typed ETAs move the plan, no callback endpoint',{timeout:120000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-flights-manual-'));dirs.push(dir);
 const clockFile=path.join(dir,'now.txt');writeFileSync(clockFile,'2026-10-06T10:00:00Z');
 const srv=server({ESTATEOS_DATA_DIR:dir,ESTATEOS_FLIGHT_TEST_NOW_FILE:clockFile,ESTATEOS_FAKE_FLIGHTS:'',FLIGHTAWARE_API_KEY:'',ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64')});
 delete process.env.DATABASE_URL;await srv.start();
 try{
  const {admin,family,leo,home}=await company(srv,'Manual');
  const arrival=await family.req('arrivals',{propertyId:home.id,arrivalAt:'2026-10-06T15:00'},201);
  const f=await family.req('flights/add',{arrivalId:arrival.id,airline:'UA',flightNumber:'468',date:'2026-10-06'});
  assert.equal(f.tracked,false);
  let fl=await F(admin);assert.equal(fl.mode,'manual');assert.equal(fl.live,false);assert.equal(fl.connection.configured,false);
  assert.equal(fl.flights[0].eta,'2026-10-06T20:00:00.000Z','without a time, the flight lands at the typed arrival time');
  await leo.req('flights/tasks/add',{arrivalId:arrival.id,title:'Groceries',anchor:'landing',offsetMinutes:-120});
  await leo.req('flights/refresh',{id:f.id},422);
  assert.equal((await fetch(`${srv.base}/api/webhooks/flightaware/${f.id}/${'a'.repeat(43)}`,{method:'POST',body:'{}'})).status,404,'no callback endpoint in manual mode');
  await family.req('flights/eta',{id:f.id,eta:'2026-10-06T16:30',status:'en_route',version:fl.flights[0].version});
  fl=await F(admin);assert.equal(fl.flights[0].eta,'2026-10-06T21:30:00.000Z');assert.equal(fl.tasks[0].due_at,'2026-10-06T19:30:00.000Z');assert.equal(fl.tasks[0].moved_minutes,90);
  assert.match(fl.flights[0].status_label,/^In the air · lands 4:30 PM CDT/);
  assert.ok((await titles(admin)).includes('Flight delayed: Seagrass House'));
  writeFileSync(clockFile,'2026-10-06T21:35:00Z');await leo.req('flights/eta',{id:f.id,status:'landed',version:fl.flights[0].version});
  assert.match((await F(admin)).flights[0].status_label,/^Landed 4:35 PM CDT$/,'marked landed without a time: now');
  // Manual departure with close-down: typed as departed two hours ago.
  writeFileSync(clockFile,'2026-10-08T16:00:00Z');
  const dep=await admin.req('flights/add',{arrivalId:arrival.id,direction:'departure',airline:'UA',flightNumber:'469',date:'2026-10-08',scheduledAt:'2026-10-08T09:00',closedown:true});
  const dv=(await F(admin)).flights.find(x=>x.id===dep.id);assert.equal(dv.eta,'2026-10-08T14:00:00.000Z');
  await admin.req('flights/eta',{id:dep.id,eta:'2026-10-08T09:10',status:'departed',version:dv.version});
  assert.equal((await admin.req('data')).inspections.filter(i=>i.visit_type==='departure').length,1);
 }finally{await srv.stop();}
});
