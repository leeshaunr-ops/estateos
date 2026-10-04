// Severe-weather alerts: grouping and threshold rules, providers (headers, rounding, retries, Open-Meteo customer
// endpoint), emails, background jobs against a local NWS stand-in on SQLite and Postgres (PGlite), and the HTTP API
// (permissions, company isolation, client notices, storm hand-off, settings validation, visit snapshot, cron secret).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import '../public/weather-core.js';
import {openDatabase} from '../database.mjs';
import {createWeather} from '../weather.mjs';
import {createVisitVerification} from '../visit-verification.mjs';
import {createNwsClient,createOpenMeteoClient,forecastProviderName,normalizeAlert,DEFAULT_NWS_USER_AGENT} from '../weather-providers.mjs';
import {inspectionPdf} from '../pdf.mjs';
import {startMock,fixture} from './weather-mock.mjs';
const W=globalThis.EAWeather;
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const builtIn=JSON.parse(readFileSync(path.join(root,'inspection-template.json'),'utf8'));
const dirs=[],mocks=[];after(async()=>{for(const m of mocks)await m.close();for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-weather-'));dirs.push(d);return d;};
const mock=async()=>{const m=await startMock();mocks.push(m);return m;};
const words=pdf=>[...pdf.matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const HOMES={naples:[26.142,-81.7948],scottsdale:[33.4942,-111.9261],barharbor:[44.3876,-68.2039],parkcity:[40.6461,-111.498],beaufort:[32.4316,-80.6698],hiltonhead:[32.2163,-80.7526],lakegeneva:[42.5917,-88.4334]};
const alertsFrom=name=>fixture(name).features.map(normalizeAlert);

// ---------- pure rules ----------
test('weather-core: levels, categories, polygon and zone matching',()=>{
 assert.equal(W.levelOf('Tornado Warning'),'warning');assert.equal(W.levelOf('Hard Freeze Watch'),'watch');assert.equal(W.levelOf('Wind Advisory'),'advisory');
 assert.equal(W.categoryOf('Hurricane Warning'),'tropical');assert.equal(W.categoryOf('Winter Storm Warning'),'winter');assert.equal(W.categoryOf('Red Flag Warning'),'fire');
 assert.equal(W.categoryOf('Tornado Warning'),'severe');assert.equal(W.categoryOf('Made Up Warning'),null);
 const [sc]=alertsFrom('alerts-SC.json');
 assert.equal(W.pointInGeometry(...HOMES.beaufort,sc.geometry),true,'Beaufort is inside the tornado polygon');
 assert.equal(W.pointInGeometry(...HOMES.hiltonhead,sc.geometry),false,'Hilton Head is outside it');
 const zone={nws_forecast_zone:'SCZ050',nws_county_zone:'SCC013',nws_fire_zone:'SCZ050'};
 assert.equal(W.matchResidence(sc,{latitude:HOMES.hiltonhead[0],longitude:HOMES.hiltonhead[1],...zone}),null,'a polygon wins over the zone list');
 assert.equal(W.matchResidence(sc,{latitude:HOMES.beaufort[0],longitude:HOMES.beaufort[1],...zone}),'polygon');
 const [fl]=alertsFrom('alerts-FL.json');
 assert.ok(W.matchResidence(fl,{latitude:HOMES.naples[0],longitude:HOMES.naples[1],nws_forecast_zone:'FLZ069'}),'zone match without a polygon');
 assert.equal(W.matchResidence(fl,{latitude:HOMES.naples[0],longitude:HOMES.naples[1],nws_forecast_zone:'FLZ070'}),null);
 assert.equal(W.validCoord(91,0),false);assert.equal(W.validCoord(26.1,-81.7),true);
});

test('weather-core: one group per weather event, updates, cancels and watch-to-warning upgrades',()=>{
 const tag=(list,pid)=>list.map(a=>({...a,residences:[{property_id:pid,matched_by:'zone'}]}));
 const me=tag(alertsFrom('alerts-ME.json'),'bar'),ut=tag(alertsFrom('alerts-UT.json'),'park');
 const first=W.reconcileNws({alerts:[...me,...ut],timezone:'America/New_York'});
 assert.equal(first.groups.length,1,'two offices, one Winter Storm Warning group');
 assert.deepEqual(first.groups[0].residences.sort(),['bar','park']);
 assert.deepEqual(first.events.map(e=>e.type),['new']);
 const saved=first.groups.map(g=>({...g,id:'g1',status:'active',residences:g.residences,notified_count:2}));
 const upd=tag(alertsFrom('alerts-ME-update.json'),'bar');
 const second=W.reconcileNws({groups:saved,alerts:upd,cancelled:['urn:oid:2.49.0.1.840.0.ut-ws-1'],timezone:'America/New_York'});
 assert.equal(second.groups.length,1);assert.deepEqual(second.groups[0].nws_alert_ids,['urn:oid:2.49.0.1.840.0.me-ws-2'],'the update replaces the alert it references');
 assert.deepEqual(second.groups[0].residences,['bar']);assert.equal(second.events.length,0,'updates and shrinking do not notify');
 const gone=W.reconcileNws({groups:[{...second.groups[0],status:'active'}],alerts:[],cancelled:['urn:oid:2.49.0.1.840.0.me-ws-2']});
 assert.equal(gone.groups[0].status,'cancelled');
 const watch=W.reconcileNws({alerts:tag(alertsFrom('alerts-WI-watch.json'),'lake')});
 assert.equal(watch.groups[0].level,'watch');
 const w0={...watch.groups[0],id:'w1',status:'active'};
 const up=W.reconcileNws({groups:[w0],alerts:tag(alertsFrom('alerts-WI-warning.json'),'lake')});
 const warn=up.groups.find(g=>g.level==='warning'),old=up.groups.find(g=>g.id==='w1');
 assert.equal(old.status,'ended');assert.equal(warn.supersedes_alert_id,'w1');assert.deepEqual(up.events.map(e=>e.type),['upgraded']);
 const later=W.reconcileNws({groups:[{...old,superseded:true},{...warn,id:'w2',status:'active'}],alerts:tag(alertsFrom('alerts-WI-warning.json'),'lake')});
 assert.equal(later.groups.filter(g=>g.isNew).length,0,'the still-active watch is absorbed, not re-created');
 assert.equal(later.events.length,0);
});

test('weather-core: forecast thresholds, runs, suppression and plain-language lines',()=>{
 const days=W.nwsGridDaily(fixture('gridpoint-MKX.json').properties,'UTC');
 const day1=W.addDays(W.localDay(new Date().toISOString(),'UTC'),1);
 assert.equal(days.find(d=>d.date===day1).min_f,19.9,'-6.7 °C becomes 19.9 °F');
 const th=W.thresholdsFor({freeze_threshold_f:28},{freeze_threshold_f:'30',bogus:5});
 assert.equal(th.freeze_threshold_f,30,'a residence override wins');assert.equal(th.heat_threshold_f,105);
 const hits=W.thresholdHits([{date:'2026-12-01',min_f:20},{date:'2026-12-02',min_f:24},{date:'2026-12-03',min_f:35},{date:'2026-12-09',min_f:10}],W.thresholdsFor({}),{today:'2026-12-01'});
 const runs=W.mergeRuns(hits);
 assert.deepEqual(runs,[{kind:'hard_freeze',start:'2026-12-01',end:'2026-12-02',min:20,max:24,days:2}],'consecutive days merge; days past the lookahead are ignored');
 assert.equal(W.forecastRange({kind:'hard_freeze',start:'2026-12-01',end:'2026-12-02',min:20,max:24}),'Hard freeze Tue–Wed, lows 20–24 °F');
 const plan=W.planForecast({runs:[{...runs[0],property_id:'a'},{...runs[0],property_id:'b'}],covered:pid=>pid==='b'});
 assert.equal(plan.groups.length,1);assert.deepEqual(plan.groups[0].residences,['a'],'a residence already under an NWS alert is not repeated');
 assert.equal(plan.groups[0].level,'forecast');
 assert.equal(W.planForecast({groups:[{...plan.groups[0],id:'f1',status:'active'}],runs:[]}).groups[0].status,'ended');
 assert.equal(W.snapshotLine({temp_f:33.98,conditions:'Light Snow',wind_mph:12,gust_mph:25,active_alerts:['Winter Storm Warning']}),'34 °F, light snow, wind 12 mph (gusts 25) · Winter Storm Warning in effect');
 assert.equal(W.attribution(['nws','open_meteo']),'Weather data: National Weather Service, Open-Meteo.com (CC BY 4.0)');
 assert.equal(W.attribution(['manual']),'');
 const msg=W.clientMessage({event_name:'Hurricane Warning',ends_at:'2026-10-07T22:00:00Z',company:'Harborline Home Watch',timezone:'America/New_York'});
 assert.match(msg,/^Heads up: the National Weather Service has issued a Hurricane Warning for your area through Wednesday/);
 assert.ok(msg.includes('Harborline Home Watch is keeping an eye on your home'));
});

test('emails: subject lines, residence list, links, attribution and disclaimer; throttle and preferences',()=>{
 const m=W.renderAlertEmail({kind:'new',company:'Harbor <Co>',event_name:'Winter Storm Warning',headline:'Heavy snow expected',onset_at:'2026-12-01T12:00:00Z',ends_at:'2026-12-02T23:00:00Z',timezone:'America/New_York',total:2,residences:[{name:'Bar Harbor Cottage',city:'Bar Harbor'},{name:'Park City Lodge',city:'Park City'}],viewLink:'https://estateaegis.com/app#weather/x',stormLink:'https://estateaegis.com/app#weather/x',attribution:W.attribution(['nws'])});
 assert.match(m.subject,/^Winter Storm Warning: 2 residences affected \(until .+\)$/);
 for(const part of ['Bar Harbor Cottage (Bar Harbor)','Park City Lodge','View affected residences: https://estateaegis.com/app#weather/x','Start storm event','Weather data: National Weather Service',W.DISCLAIMER])assert.ok(m.text.includes(part),part);
 assert.ok(m.html.includes('Harbor &lt;Co&gt;')&&!m.html.includes('<Co>'),'escaped');
 assert.match(W.renderAlertEmail({kind:'upgraded',company:'C',event_name:'Hard Freeze Warning',total:1,residences:[{name:'Lake House'}],viewLink:'x',attribution:''}).subject,/^Upgraded to Hard Freeze Warning: 1 residence affected$/);
 const d=W.renderDigestEmail({company:'C',items:[{title:'Hard freeze Tue, low 20 °F',total:1,residences:[{name:'Lake House',city:'Lake Geneva'}],when:''}],viewLink:'https://estateaegis.com/app#weather',attribution:'Weather data: National Weather Service'});
 assert.equal(d.subject,'Weather digest: 1 alert for your residences');assert.ok(d.text.includes('Hard freeze Tue, low 20 °F · 1 residence'));
 const t=Date.parse('2026-12-01T12:00:00Z');
 assert.equal(W.throttled('expanded','2026-12-01T09:00:00Z',t),true);assert.equal(W.throttled('expanded','2026-12-01T05:00:00Z',t),false);assert.equal(W.throttled('upgraded','2026-12-01T11:59:00Z',t),false);
 assert.equal(W.wantsEmail('warnings_only',{level:'warning',kind:'new'}),true);assert.equal(W.wantsEmail('warnings_only',{level:'watch',kind:'digest'}),false);assert.equal(W.wantsEmail('none',{level:'warning',kind:'new'}),false);
});

// ---------- providers ----------
test('providers: NWS headers, 4-decimal points, 404 outside coverage, retry on 429; Open-Meteo customer endpoint',async()=>{
 const m=await mock();
 const nws=createNwsClient({env:{NWS_BASE_URL:m.base,NWS_USER_AGENT:'(test.example, ops@example.test)',WEATHER_RETRY_DELAY_MS:'5'}});
 const p=await nws.points(26.142049,-81.794812);
 assert.deepEqual({state:p.state,zone:p.forecastZone,county:p.countyZone,grid:[p.gridId,p.gridX,p.gridY]},{state:'FL',zone:'FLZ069',county:'FLC021',grid:['MFL',61,88]});
 const req=m.state.requests.at(-1);assert.equal(req.path,'/points/26.142,-81.7948');
 assert.equal(req.headers['user-agent'],'(test.example, ops@example.test)');assert.equal(req.headers.accept,'application/geo+json');
 await nws.points(26.142049,-81.794812);assert.equal(m.count('/points/'),1,'points responses are cached per Cache-Control');
 assert.deepEqual(await nws.points(43.6532,-79.3832),{supported:false});
 m.setAlerts({AZ:['alerts-AZ.json']});m.state.failOnce.AZ=429;m.reset();
 const az=await nws.activeByState('AZ');
 assert.equal(m.count('/alerts/active'),2,'retried once after 429');assert.equal(az.length,2);assert.ok(m.state.requests.every(r=>r.query.includes('status=actual')));
 m.state.fail.AZ=503;await assert.rejects(nws.activeByState('AZ'),/503/);delete m.state.fail.AZ;
 assert.equal(createNwsClient({env:{}}).userAgent,DEFAULT_NWS_USER_AGENT);
 m.reset();
 const om=createOpenMeteoClient({env:{OPEN_METEO_API_KEY:'test-key-123',OPEN_METEO_CUSTOMER_BASE_URL:m.base,WEATHER_RETRY_DELAY_MS:'5'}});
 const got=await om.daily([{lat:43.653219,lon:-79.383184},{lat:44.3876,lon:-68.2039}]);
 const q=new URLSearchParams(m.state.requests[0].query);
 assert.equal(q.get('apikey'),'test-key-123');assert.equal(q.get('latitude'),'43.65,44.39');assert.equal(q.get('longitude'),'-79.38,-68.2');
 assert.equal(got.length,2);assert.equal(got[0].days[1].min_f,18);
 assert.deepEqual(forecastProviderName({}),{name:'nws_grid',warning:''});
 assert.equal(forecastProviderName({WEATHER_FORECAST_PROVIDER:'open_meteo',RENDER:'true'}).name,'nws_grid','free Open-Meteo is never used on Render');
 assert.equal(forecastProviderName({WEATHER_FORECAST_PROVIDER:'open_meteo',RENDER:'true',OPEN_METEO_API_KEY:'k'}).name,'open_meteo');
 assert.equal(forecastProviderName({WEATHER_FORECAST_PROVIDER:'open_meteo'}).name,'open_meteo');
});

// ---------- background jobs (in-process, real database) ----------
async function jobWorld(dbEnv){
 const m=await mock();
 const db=await openDatabase(root,dbEnv);
 const t=new Date().toISOString(),ins=(sql,...a)=>db.run(sql,...a);
 const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
 const roles=(user,...allowed)=>{if(!allowed.includes(user.role))fail(403,'Not allowed.');};
 for(const [org,name] of [['orgA','Coastal Care'],['orgB','Rival Co']]){await ins('INSERT INTO organizations VALUES(?,?,?)',org,name,t);await ins('INSERT INTO workspace_settings(organization_id) VALUES(?)',org);}
 const user=(id,org,role,email,client=null)=>ins('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',id,org,id,email,'x',role,client,null,1,t);
 await user('a1','orgA','admin','owner@a.test');await user('mgr','orgA','employee','mgr@a.test');await user('other','orgA','employee','other@a.test');await user('b1','orgB','admin','owner@b.test');
 await ins('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)','famA','orgA','Family A',t);await ins('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)','famB','orgB','Family B',t);
 await user('famUser','orgA','client','fam@a.test','famA');
 const home=(id,org,name,city,ll,tz,manager=null)=>ins('INSERT INTO properties(id,organization_id,client_id,name,address,city,timezone,created_at,account_manager_id,latitude,longitude) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,org,org==='orgA'?'famA':'famB',name,`1 Main St, ${city}, XX 00000`,city,tz,t,manager,ll?ll[0]:null,ll?ll[1]:null);
 await home('naples','orgA','Naples Villa','Naples',HOMES.naples,'America/New_York','mgr');
 await home('scottsdale','orgA','Desert House','Scottsdale',HOMES.scottsdale,'America/Phoenix');
 await home('barharbor','orgA','Bar Harbor Cottage','Bar Harbor',HOMES.barharbor,'America/New_York');
 await home('parkcity','orgA','Park City Lodge','Park City',HOMES.parkcity,'America/Denver');
 await home('beaufort','orgA','Beaufort House','Beaufort',HOMES.beaufort,'America/New_York');
 await home('hiltonhead','orgA','Hilton Head Villa','Hilton Head',HOMES.hiltonhead,'America/New_York');
 await home('lakegeneva','orgA','Lake House','Lake Geneva',HOMES.lakegeneva,'America/Chicago','mgr');
 await home('nocoords','orgA','No Pin Yet','Somewhere',null,'America/New_York');
 await home('toronto','orgA','Toronto Condo','Toronto',[43.6532,-79.3832],'America/Toronto');
 await home('naplesB','orgB','Rival Naples','Naples',HOMES.naples,'America/New_York');
 for(const org of ['orgA','orgB'])await ins('INSERT INTO weather_settings(organization_id,enabled,updated_at) VALUES(?,1,?)',org,t);
 const deps={...db,id:randomUUID,now:()=>new Date().toISOString(),fail,json(){},body(){},roles,property:async()=>null,audit:async()=>{},entity:()=>null,captureTime:()=>null};
 const visitVerification=createVisitVerification({...deps,env:{}});
 const make=(env={})=>createWeather({...deps,platformOwner:()=>false,visitVerification,storm:{setReportExtras(){}},portalLink:()=>'https://estateaegis.com/login'},{env:{NWS_BASE_URL:m.base,NWS_USER_AGENT:'(test.example, ops@example.test)',WEATHER_RETRY_DELAY_MS:'5',NODE_ENV:'test',...env},log:{log(){},warn(){},error(){}}});
 return {m,db,weather:make(),make};
}
const groups=async(db,org,where="status IN ('active','dismissed')")=>{
 const rows=await db.all(`SELECT * FROM weather_alerts WHERE organization_id=? AND ${where} ORDER BY event_name`,org);
 for(const r of rows)r.homes=(await db.all('SELECT property_id FROM weather_alert_residences WHERE weather_alert_id=? AND active=1 ORDER BY property_id',r.id)).map(x=>x.property_id);
 return rows;
};
const outbox=db=>db.all("SELECT id,email,subject,body FROM email_outbox WHERE id LIKE 'weather%' ORDER BY email,subject");

async function jobScenario(label,dbEnv){
 const {m,db,weather,make}=await jobWorld(dbEnv);
 try{
  // Points, then a forecast run before any NWS alert: Lake Geneva's hard freeze becomes a forecast group.
  const pts=await weather.runJob('points');assert.equal(pts.status,'ok',label);
  assert.equal(m.count('/points/'),8,'one points lookup per residence with coordinates; the same point in two companies is fetched once');
  assert.deepEqual(await weather.coverage('orgA'),{total:9,monitored:7,withCoordinates:8,missingCoordinates:1,outsideNws:1,awaitingZones:0,monitoringOff:0,geocoderAvailable:false});
  m.reset();assert.equal((await weather.runJob('points')).seen,0,'points are not looked up again');assert.equal(m.count('/points/'),0);
  const fc=await weather.runJob('forecast');assert.equal(fc.status,'ok',JSON.stringify(fc));
  assert.equal(m.count('/gridpoints/MKX/44,30'),1,'one gridpoint request per grid cell');
  let f=await groups(db,'orgA',"source='forecast' AND status='active'");
  assert.equal(f.length,1,label+' forecast groups: '+JSON.stringify(f.map(x=>x.headline)));
  assert.deepEqual(f[0].homes,['lakegeneva']);assert.equal(f[0].level,'forecast');assert.match(f[0].headline,/^Hard freeze .+, lows? 19\.9|^Hard freeze .+, lows? (20|23)/);
  const fv=await db.get('SELECT forecast_value FROM weather_alert_residences WHERE weather_alert_id=?',f[0].id);assert.equal(Number(fv.forecast_value),19.9);
  m.reset();await weather.runJob('forecast');assert.equal(m.count('/gridpoints/'),0,'forecasts are cached for 3 hours');
  // Digest (forced): the forecast reaches the admin and the residence manager once.
  await weather.runJob('digest',{force:true});
  let mail=await outbox(db);
  assert.deepEqual(mail.map(x=>[x.email,x.subject]),[['mgr@a.test','Weather digest: 1 alert for your residences'],['owner@a.test','Weather digest: 1 alert for your residences']]);
  assert.ok(mail[0].body.includes('Lake House (Lake Geneva)')&&mail[0].body.includes('Hard freeze'));
  await weather.runJob('digest',{force:true});assert.equal((await outbox(db)).length,2,'a digest never repeats an alert');

  // Alerts: one request per state across both companies, separate groups per company, one email per recipient.
  m.setAlerts({FL:['alerts-FL.json'],AZ:['alerts-AZ.json'],ME:['alerts-ME.json'],UT:['alerts-UT.json'],SC:['alerts-SC.json'],WI:['alerts-WI-watch.json']});m.reset();
  const r1=await weather.runJob('alerts');assert.equal(r1.status,'ok',JSON.stringify(r1));
  assert.deepEqual(m.state.requests.filter(r=>r.path==='/alerts/active').map(r=>new URLSearchParams(r.query).get('area')),['AZ','FL','ME','SC','UT','WI'],'one request per state');
  assert.ok(m.state.requests.every(r=>r.headers['user-agent']==='(test.example, ops@example.test)'));
  let a=await groups(db,'orgA',"source='nws' AND status='active'");
  assert.deepEqual(a.map(g=>[g.event_name,g.homes.join(',')]),[['Hard Freeze Watch','lakegeneva'],['Hurricane Warning','naples'],['Red Flag Warning','scottsdale'],['Tornado Warning','beaufort'],['Winter Storm Warning','barharbor,parkcity']],'Test alerts are ignored and Hilton Head (outside the polygon) is not matched');
  const b=await groups(db,'orgB',"source='nws' AND status='active'");
  assert.deepEqual(b.map(g=>[g.event_name,g.homes.join(',')]),[['Hurricane Warning','naplesB']]);
  assert.notEqual(b[0].id,a.find(g=>g.event_name==='Hurricane Warning').id,'each company gets its own group');
  mail=(await outbox(db)).filter(x=>!x.subject.startsWith('Weather digest'));
  assert.deepEqual(mail.map(x=>x.email),['mgr@a.test','owner@a.test','owner@a.test','owner@a.test','owner@a.test','owner@b.test'],'warnings email at once; the watch waits for the digest; managers only hear about their own residences');
  assert.ok(mail.some(x=>/^Winter Storm Warning: 2 residences affected \(until .+\)$/.test(x.subject)));
  assert.ok(!mail.some(x=>x.email==='other@a.test'));
  assert.ok(mail.find(x=>x.email==='mgr@a.test').subject.startsWith('Hurricane Warning: 1 residence affected'));
  const n1=Number((await db.get('SELECT COUNT(*) n FROM weather_alert_notifications')).n);
  // Second run with the same alerts: nothing new.
  m.setAlerts({FL:['alerts-FL.json'],AZ:['alerts-AZ.json'],ME:['alerts-ME.json'],UT:['alerts-UT.json'],SC:['alerts-SC.json'],WI:['alerts-WI-watch.json']});
  await weather.runJob('alerts');
  assert.equal((await outbox(db)).length,8,'second run is silent');assert.equal(Number((await db.get('SELECT COUNT(*) n FROM weather_alert_notifications')).n),n1);
  assert.equal((await groups(db,'orgA',"source='nws' AND status='active'")).length,5);
  // The forecast group for Lake Geneva steps aside now that an NWS watch covers it.
  await db.run('DELETE FROM forecast_cache');await weather.runJob('forecast');
  assert.equal((await groups(db,'orgA',"source='forecast' AND status='active'")).length,0,'a residence under an NWS alert of the same kind is not repeated as a forecast');

  // Update (Maine), cancel (Utah) and watch -> warning (Wisconsin).
  m.setAlerts({FL:['alerts-FL.json'],AZ:['alerts-AZ.json'],ME:['alerts-ME-update.json'],UT:['alerts-UT-cancel.json'],SC:['alerts-SC.json'],WI:['alerts-WI-warning.json']});
  await weather.runJob('alerts');
  a=await groups(db,'orgA',"source='nws' AND status='active'");
  const ws=a.find(g=>g.event_name==='Winter Storm Warning');
  assert.deepEqual(ws.homes,['barharbor'],'the cancelled Utah alert drops Park City; the Maine update stays in the same group');
  assert.deepEqual(JSON.parse(ws.nws_alert_ids),['urn:oid:2.49.0.1.840.0.me-ws-2']);
  const watch=(await groups(db,'orgA',"event_name='Hard Freeze Watch'"))[0],warn=a.find(g=>g.event_name==='Hard Freeze Warning');
  assert.equal(watch.status,'ended');assert.equal(warn.supersedes_alert_id,watch.id);assert.deepEqual(warn.homes,['lakegeneva']);
  mail=await outbox(db);
  assert.deepEqual(mail.filter(x=>x.subject.startsWith('Upgraded to Hard Freeze Warning')).map(x=>x.email),['mgr@a.test','owner@a.test']);
  assert.equal(mail.length,10,'no email for the update or the cancel');
  await weather.runJob('alerts');
  assert.equal((await groups(db,'orgA',"event_name='Hard Freeze Watch'")).length,1,'the watch is never re-created while it is still active at NWS');
  assert.equal((await outbox(db)).length,10);

  // A failing state keeps its alerts (no ending, no re-notify); other states carry on. A 429 is retried.
  m.state.fail.FL=503;m.state.failOnce.AZ=429;
  const r5=await weather.runJob('alerts');assert.equal(r5.status,'partial');
  assert.ok((await groups(db,'orgA',"event_name='Hurricane Warning' AND status='active'")).length===1&&(await groups(db,'orgB',"event_name='Hurricane Warning' AND status='active'")).length===1,'Florida groups survive a failed request');
  assert.equal((await groups(db,'orgA',"event_name='Red Flag Warning' AND status='active'")).length,1,'Arizona recovered after one retry');
  const run=await db.get("SELECT status,errors FROM weather_job_runs WHERE job='alerts' ORDER BY started_at DESC LIMIT 1");assert.equal(run.status,'partial');assert.match(run.errors,/alerts FL/);
  delete m.state.fail.FL;
  m.setAlerts({AZ:['alerts-AZ.json'],ME:['alerts-ME-update.json'],SC:['alerts-SC.json'],WI:['alerts-WI-warning.json']});
  await weather.runJob('alerts');
  assert.equal((await groups(db,'orgA',"event_name='Hurricane Warning'"))[0].status,'ended','ends once NWS stops listing it');
  assert.equal((await outbox(db)).length,10);

  // Locks: a second worker skips while the first holds the lock.
  await db.run("UPDATE job_locks SET owner='someone-else',locked_until=? WHERE job='weather:alerts'",new Date(Date.now()+60000).toISOString());
  assert.deepEqual(await weather.runJob('alerts'),{job:'alerts',skipped:'locked'});
  await db.run("UPDATE job_locks SET locked_until='' WHERE job='weather:alerts'");

  // Visit snapshot from the nearest NWS station, with the active alert named.
  const t=new Date().toISOString();
  await db.run("INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at) VALUES('v1','lakegeneva','mgr',?,'draft','[]','',?)",t.slice(0,10),t);
  const snap=await weather.captureSnapshot('v1');
  assert.equal(snap.line,'34 °F, light snow, wind 12 mph (gusts 25) · Hard Freeze Warning in effect');
  assert.equal(await weather.captureSnapshot('v1'),null,'kept once captured');
  // Report hook: frozen into the report only when "weather on reports" is on.
  const vv={publishFields:async()=>({fields:{timezone:'America/Chicago'},number:null})};weather.extendReports(vv);
  const row=await db.get("SELECT * FROM inspections WHERE id='v1'");
  assert.equal((await vv.publishFields({organization_id:'orgA'},row,{})).fields.weather,undefined);
  await db.run("UPDATE weather_settings SET on_reports=1 WHERE organization_id='orgA'");
  assert.deepEqual((await vv.publishFields({organization_id:'orgA'},row,{})).fields.weather,{line:snap.line,sources:['nws'],attribution:'Weather data: National Weather Service'});

  // Pilot companies: turned on once; an admin who later turns it off is respected.
  await db.run("UPDATE weather_settings SET enabled=0 WHERE organization_id='orgB'");
  const pilot=make({FEATURE_PILOT_COMPANIES:'orgB,unknown-company'});
  assert.deepEqual(await pilot.applyPilots(),['orgB']);assert.equal((await pilot.settingsFor('orgB')).enabled,true);
  await db.run("UPDATE weather_settings SET enabled=0 WHERE organization_id='orgB'");
  assert.deepEqual(await pilot.applyPilots(),[]);assert.equal((await pilot.settingsFor('orgB')).enabled,false);
  // Jobs need WEATHER_JOBS_ENABLED=true.
  const before=Number((await db.get('SELECT COUNT(*) n FROM weather_job_runs')).n);await weather.tick();
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM weather_job_runs')).n),before);
 }finally{await db.close();}
}
test('jobs on SQLite: grouping, emails, updates, upgrades, failures, forecasts, digest, snapshot, pilots',async()=>{await jobScenario('sqlite',{ESTATEOS_DATA_DIR:tmp()});});
test('jobs on Postgres (PGlite): the same scenario',async()=>{const d=tmp();await jobScenario('postgres',{ESTATEOS_DATA_DIR:d,NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')});});

// ---------- HTTP API ----------
function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(new Error(`server exited ${code}: ${log}`)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;},
 raw:endpoint=>fetch(srv.base+'/api/'+endpoint,{headers:{Cookie:cookie}})};return c;}
const passAll=()=>builtIn.map(a=>({...a,status:'pass',note:''}));

async function apiScenario(label,env){
 const m=await mock();m.setAlerts({FL:['alerts-FL.json'],WI:['alerts-WI-watch.json']});
 const dir=tmp(),secret='test-cron-secret-0123456789';
 const srv=server({ESTATEOS_DATA_DIR:dir,NWS_BASE_URL:m.base,NWS_USER_AGENT:'(test.example, ops@example.test)',WEATHER_RETRY_DELAY_MS:'5',CRON_SECRET:secret,WEATHER_JOBS_ENABLED:'false',...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),employee=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Weather Co '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Family'},201);
  const naples=await admin.req('properties',{clientId:fam.id,name:'Naples Villa',streetAddress:'1 Gulf Shore Blvd',city:'Naples',state:'FL',postalCode:'34102',country:'United States'},201);
  const lake=await admin.req('properties',{clientId:fam.id,name:'Lake House',streetAddress:'2 Shore Rd',city:'Lake Geneva',state:'WI',postalCode:'53147',country:'United States'},201);
  await admin.req('properties/location',{id:naples.id,latitude:HOMES.naples[0],longitude:HOMES.naples[1]});
  await admin.req('properties/location',{id:lake.id,latitude:HOMES.lakegeneva[0],longitude:HOMES.lakegeneva[1]});
  const accept=async(c,role,email,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email,password:pw},201);};
  const emp=await accept(employee,'employee','tech@example.test');await accept(family,'client','fam@example.test',{clientId:fam.id});
  const vend=await admin.req('vendors',{name:'Pool Co'},201);await accept(vendor,'vendor','vendor@example.test',{vendorId:vend.id});
  await admin.req('access',{userId:emp.user.id,propertyId:naples.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);

  // Off by default: no Weather data for anyone beyond the admin's set-up entry.
  let d=await admin.req('data');assert.equal(d.weather.enabled,false);assert.deepEqual(d.weather.alerts,[]);
  assert.ok(d.properties.every(p=>!('nws_state' in p)),'NWS lookup columns never reach the browser');
  assert.equal('weather' in await vendor.req('data'),false);
  await employee.req('settings/weather',undefined,403);await family.req('settings/weather',undefined,403);await vendor.req('weather/alerts',undefined,403);await family.req('weather/alerts',undefined,403);
  // Settings validation.
  for(const bad of [{freeze_threshold_f:50},{freeze_threshold_f:'cold'},{digest_time:'25:00'},{categories:['meteor']},{client_notice:'loud'},{levels:['statement']},{freeze_threshold_f:28,freeze_notice_f:20},{notify_user_ids:['someone-else']},{enabled:'maybe'}])await admin.req('settings/weather',bad,422);
  const s=await admin.req('settings/weather',{enabled:true,levels:['watch']});
  assert.equal(s.settings.enabled,true);assert.deepEqual(s.settings.levels,['warning','watch']);
  assert.ok(s.privacy.includes('approximate residence coordinates')&&s.privacy.includes('No names or contact details are shared'));
  assert.equal(s.coverage.total,2);assert.equal(s.coverage.awaitingZones,2);
  // Cron endpoint: secret required (header), job validated.
  const cron=(b,headers={})=>fetch(srv.base+'/api/internal/cron/weather',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(b)});
  assert.equal((await cron({job:'alerts'})).status,401);
  assert.equal((await cron({job:'alerts'},{'X-Cron-Secret':'wrong-secret-wrong-secret'})).status,401);
  assert.equal((await cron({job:'meteor'},{'X-Cron-Secret':secret})).status,422);
  const cr=await cron({job:'alerts'},{'X-Cron-Secret':secret});assert.equal(cr.status,200);
  assert.equal((await cr.json()).results[0].status,'ok');

  d=await admin.req('data');
  const hurricane=d.weather.alerts.find(a=>a.event_name==='Hurricane Warning'),watch=d.weather.alerts.find(a=>a.event_name==='Hard Freeze Watch');
  assert.ok(hurricane&&watch,JSON.stringify(d.weather.alerts));assert.deepEqual(hurricane.property_ids,[naples.id]);assert.equal(hurricane.level,'warning');
  // Employees see alerts for their residences only; other alerts are 404.
  const ed=await employee.req('data');assert.deepEqual(ed.weather.alerts.map(a=>a.event_name),['Hurricane Warning']);assert.equal(ed.weather.canManage,false);
  await employee.req('weather/alerts/'+watch.id,undefined,404);
  const det=await employee.req('weather/alerts/'+hurricane.id);assert.deepEqual(det.alert.residences.map(r=>r.name),['Naples Villa']);assert.ok(det.alert.description);
  // Another company: 404 for everything.
  await outsider.req('weather/alerts/'+hurricane.id,undefined,404);await outsider.req('weather/alerts/'+hurricane.id+'/acknowledge',{},404);await outsider.req('weather/alerts/'+hurricane.id+'/start-storm-event',{create:true},404);
  assert.deepEqual((await outsider.req('data')).weather.alerts,[]);
  // Client notices: off by default; after staff review only once acknowledged; automatic shows warnings and watches.
  assert.deepEqual((await family.req('data')).weatherNotices,[]);
  await admin.req('settings/weather',{client_notice:'after_staff_review'});
  assert.deepEqual((await family.req('data')).weatherNotices,[]);
  await employee.req('weather/alerts/'+hurricane.id+'/dismiss',{},403);
  const ack=await employee.req('weather/alerts/'+hurricane.id+'/acknowledge',{});assert.equal(ack.alert.acknowledged_by_name,'tech@example.test');
  let notes=(await family.req('data')).weatherNotices;
  assert.deepEqual(notes.map(n=>[n.event_name,n.property_name]),[['Hurricane Warning','Naples Villa']]);
  assert.match(notes[0].company_message,/^Heads up: the National Weather Service has issued a Hurricane Warning for your area through /);
  await admin.req('settings/weather',{client_notice:'automatic'});
  assert.equal((await family.req('data')).weatherNotices.length,2);
  assert.equal('weather' in await family.req('data'),false,'clients never get the staff alert list');
  // Dismiss (admin) keeps the alert listed as dismissed.
  const dis=await admin.req('weather/alerts/'+watch.id+'/dismiss',{reason:'Caretaker on site'});assert.equal(dis.alert.dismissed,true);assert.equal(dis.alert.dismiss_reason,'Caretaker on site');
  // Storm hand-off: prefill, then a double tap creates one storm event with the affected residences.
  await employee.req('weather/alerts/'+hurricane.id+'/start-storm-event',{},403);
  const pre=await admin.req('weather/alerts/'+hurricane.id+'/start-storm-event',{});
  assert.equal(pre.prefill.type,'hurricane');assert.deepEqual(pre.prefill.residenceIds,[naples.id]);assert.equal(pre.prefill.name,'Hurricane Warning');
  await admin.req('weather/alerts/'+hurricane.id+'/start-storm-event',{create:true,residenceIds:[lake.id]},422);
  const [x1,x2]=await Promise.all([admin.req('weather/alerts/'+hurricane.id+'/start-storm-event',{create:true}),admin.req('weather/alerts/'+hurricane.id+'/start-storm-event',{create:true})]);
  assert.equal(x1.event.id,x2.event.id);assert.equal([x1.created,x2.created].filter(Boolean).length,1);
  const storms=(await admin.req('storm')).events;assert.equal(storms.length,1);assert.deepEqual(storms[0].residences.map(r=>r.property_id||r.id),[naples.id]);
  assert.equal((await admin.req('weather/alerts/'+hurricane.id+'/start-storm-event',{})).linked,true);
  // Coverage, health, residence view, monitoring and email preference.
  assert.equal((await admin.req('weather/coverage')).coverage.monitored,2);
  const h=await admin.req('weather/health');assert.equal(h.lastRuns.alerts.status,'ok');assert.equal(h.platform.cronSecretSet,true);assert.equal(h.platform.customUserAgent,true);
  await employee.req('weather/health',undefined,403);
  assert.equal((await employee.req('weather/residences/'+naples.id)).alerts.length,1);
  await employee.req('weather/residences/'+lake.id,undefined,404);
  await employee.req('weather/residences/'+lake.id+'/monitoring',{enabled:false},403);
  await admin.req('weather/residences/'+lake.id+'/monitoring',{overrides:{freeze_threshold_f:99}},422);
  const mon=await admin.req('weather/residences/'+lake.id+'/monitoring',{enabled:false,overrides:{freeze_threshold_f:30}});assert.equal(mon.monitoring,false);assert.equal(mon.thresholds.freeze_threshold_f,30);
  assert.equal((await admin.req('weather/coverage')).coverage.monitoringOff,1);
  await employee.req('weather/preferences',{emailPref:'loud'},422);assert.equal((await employee.req('weather/preferences',{emailPref:'warnings_only'})).emailPref,'warnings_only');
  assert.equal((await employee.req('data')).weather.emailPref,'warnings_only');

  // Weather at the visit: captured when the visit starts, editable by staff, frozen into the report when enabled.
  const find=async(c,id)=>(await c.req('data')).inspections.find(i=>i.id===id);
  const today=new Date().toISOString().slice(0,10);
  const v1=(await employee.req('inspections',{propertyId:naples.id,date:today},201)).id;
  let i1;for(let k=0;k<50&&!(i1=await find(employee,v1))?.weather;k++)await sleep(100);
  assert.equal(i1.weather.line,'34 °F, light snow, wind 12 mph (gusts 25) · Hurricane Warning in effect');
  assert.equal('weather' in (await find(family,v1)||{}),false);
  await employee.req('inspections/'+v1+'/weather',{snapshot:{temp_f:500}},422);
  await outsider.req('inspections/'+v1+'/weather',{snapshot:{temp_f:80}},404);
  const ed1=await employee.req('inspections/'+v1+'/weather',{snapshot:{temp_f:81.4,conditions:'Sunny',wind_mph:10}});
  assert.equal(ed1.weather.line,'81 °F, sunny, wind 10 mph · Hurricane Warning in effect');assert.equal(ed1.weather.source,'manual');
  assert.equal((await find(admin,v1)).weather_snapshot_overridden,1);
  await admin.req('settings/weather',{on_reports:true});
  const publish=async id=>{const i=await find(employee,id);await employee.req('inspections/save',{id,version:i.version,answers:passAll(),summary:'All clear.',notes:'',internalNotes:''},201);await admin.req('inspections/publish',{id,version:(await find(admin,id)).version,idempotencyKey:randomUUID()},201);};
  await publish(v1);
  const pdf=async(c,id)=>words(Buffer.from(await (await c.raw('inspections/'+id+'/pdf')).arrayBuffer()).toString('latin1'));
  const p1=await pdf(family,v1);
  assert.ok(p1.includes('Weather at visit')&&p1.includes('81 \xb0F, sunny, wind 10 mph'),p1.slice(0,600));
  assert.ok(!p1.includes('Weather data: National Weather Service'),'a manual entry names no data source');
  await employee.req('inspections/'+v1+'/weather',{clear:true},409);
  await admin.req('settings/weather',{on_reports:false});
  const v2=(await employee.req('inspections',{propertyId:naples.id,date:today},201)).id;
  for(let k=0;k<50&&!(await find(employee,v2))?.weather;k++)await sleep(100);
  await publish(v2);
  assert.ok(!(await pdf(family,v2)).includes('Weather at visit'),'off: no weather on the report');
 }finally{await srv.stop();}
}
test('API on SQLite: permissions, company isolation, client notices, storm hand-off, settings, snapshot, PDF, cron',async()=>{await apiScenario('sqlite',{});});
test('API on Postgres (PGlite): the same scenario',async()=>{await apiScenario('postgres',{pg:true});});

test('PDF: weather line and attribution only when the report carries weather',()=>{
 const base={id:'r1',company:'Harbor',property:'Ocean House',client:'Family',inspector:'Leo',date:'2026-10-02',completedAt:'2026-10-02T14:30:00Z',overall:'Passed',answers:builtIn.map(a=>({...a,status:'pass'})),summary:'Fine',notes:'None'};
 const withWx=words(inspectionPdf({...base,weather:{line:'34 °F, light snow, wind 12 mph (gusts 25) · Winter Storm Warning in effect',sources:['nws'],attribution:'Weather data: National Weather Service'}}).toString('latin1'));
 assert.ok(withWx.includes('Weather at visit')&&withWx.includes('34 \xb0F, light snow, wind 12 mph (gusts 25)'));
 assert.ok(withWx.includes('Weather data: National Weather Service. Weather information is provided for reference only.'));
 const plain=words(inspectionPdf(base).toString('latin1'));assert.ok(!plain.includes('Weather'));
});
