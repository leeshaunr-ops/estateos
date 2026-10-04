// Severe-weather alerts for every residence (per-company flag weather_settings.enabled, default off).
// Background jobs pull National Weather Service alerts (one request per state with monitored residences) and daily
// forecasts, match them to residences (polygon first, else NWS zones), group them into one company alert per weather
// event, email staff (immediately for warnings, otherwise a daily digest), and show a banner, badges, a Weather page,
// optional gentle client notices, a "weather at visit" line on inspections and reports, and a one-tap storm event.
// Pure rules live in public/weather-core.js (shared with the browser and tests); HTTP calls live in weather-providers.mjs.
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import './public/weather-core.js';
import './public/storm-core.js';
import {createNwsClient,createOpenMeteoClient,forecastProviderName,DEFAULT_NWS_USER_AGENT} from './weather-providers.mjs';
const W=globalThis.EAWeather,S=globalThis.EAStorm;
const parse=(s,f)=>{if(s==null||s==='')return f;if(typeof s!=='string')return s;try{return JSON.parse(s);}catch{return f;}};
const digest=s=>createHash('sha256').update(s).digest('hex').slice(0,40);
const num=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
const LEVEL_OPTIONS=['warning','watch','advisory'];
const CLIENT_NOTICE=['off','after_staff_review','automatic'];
const EMAIL_PREFS=['all','warnings_only','none'];
const JOBS={alerts:10,forecast:180,points:60,digest:15};
const cityOf=addr=>{const parts=String(addr||'').split(',').map(s=>s.trim()).filter(Boolean);return parts.length>=3?parts[parts.length-2]:parts.length===2?parts[1].replace(/\s+[A-Z]{2}\s*\d{5}.*$/,''):'';};

export function createWeather({get,all,run,transaction,id,now,fail,json,body,roles,property,audit,platformOwner,visitVerification,storm,portalLink},{env=process.env,fetcher=globalThis.fetch,log=console}={}){
 const counter={requests:0};
 const nws=createNwsClient({env,fetcher,counter});
 const meteo=createOpenMeteoClient({env,fetcher,counter});
 const provider=forecastProviderName(env);
 if(provider.warning&&env.NODE_ENV!=='test')log.warn('Weather:',provider.warning);
 const owner=randomUUID();
 const jobsEnabled=()=>String(env.WEATHER_JOBS_ENABLED||'').toLowerCase()==='true';
 const budgetMs=()=>Number(env.WEATHER_JOB_BUDGET_MS||240000);
 const interval=job=>Number(env[`WEATHER_${job.toUpperCase()}_INTERVAL_MIN`]||JOBS[job]);

 // ---------- settings ----------
 async function settingsFor(org){
  const r=await get('SELECT * FROM weather_settings WHERE organization_id=?',org)||{};
  const cats=parse(r.categories,null);
  const levels=parse(r.levels,['warning','watch']);
  return {enabled:Number(r.enabled||0)===1,categories:Array.isArray(cats)?cats.filter(c=>W.CATEGORY_KEYS.includes(c)):[...W.CATEGORY_KEYS],
   levels:[...new Set(['warning',...(Array.isArray(levels)?levels:[]).filter(l=>LEVEL_OPTIONS.includes(l))])],
   freeze_threshold_f:num(r.freeze_threshold_f)??W.DEFAULTS.freeze_threshold_f,freeze_notice_f:num(r.freeze_notice_f),heat_threshold_f:num(r.heat_threshold_f)??W.DEFAULTS.heat_threshold_f,
   heavy_rain_in:num(r.heavy_rain_in)??W.DEFAULTS.heavy_rain_in,high_wind_gust_mph:num(r.high_wind_gust_mph)??W.DEFAULTS.high_wind_gust_mph,forecast_lookahead_days:num(r.forecast_lookahead_days)??W.DEFAULTS.forecast_lookahead_days,
   notify_admins:r.notify_admins==null?true:Number(r.notify_admins)===1,notify_residence_managers:r.notify_residence_managers==null?true:Number(r.notify_residence_managers)===1,notify_user_ids:parse(r.notify_user_ids,[]),
   digest_time:/^\d\d:\d\d$/.test(r.digest_time||'')?r.digest_time:'06:30',watch_immediate:Number(r.watch_immediate||0)===1,client_notice:CLIENT_NOTICE.includes(r.client_notice)?r.client_notice:'off',
   on_reports:Number(r.on_reports||0)===1,storm_prep_lead_hours:num(r.storm_prep_lead_hours)??24,last_digest_day:r.last_digest_day||null,updated_at:r.updated_at||null};
 }
 async function companyTz(org){return (await visitVerification.settings(org)).timezone||'America/New_York';}
 const bool=(v,label)=>{if(typeof v==='boolean')return v;if(v===1||v===0)return !!v;if(v==='true'||v==='false')return v==='true';fail(422,`${label} must be on or off.`);};
 function inRange(v,key,label,unit,nullable=false){
  if(nullable&&(v===null||v===''))return null;
  const n=Number(v),[lo,hi]=W.LIMITS[key];
  if(v===undefined||v===null||v===''||!Number.isFinite(n)||n<lo||n>hi)fail(422,`${label} must be between ${lo} and ${hi} ${unit}.`);
  return key==='heavy_rain_in'?Math.round(n*10)/10:Math.round(n);
 }
 async function saveSettings(user,b){
  roles(user,'admin');
  if(!b||typeof b!=='object')fail(422,'Send the weather settings.');
  const cur=await settingsFor(user.organization_id),has=k=>b[k]!==undefined;
  const next={...cur};
  if(has('enabled'))next.enabled=bool(b.enabled,'Weather alerts');
  if(has('categories')){if(!Array.isArray(b.categories)||b.categories.some(c=>!W.CATEGORY_KEYS.includes(c)))fail(422,'Choose valid weather categories.');next.categories=[...new Set(b.categories)];}
  if(has('levels')){if(!Array.isArray(b.levels)||b.levels.some(l=>!LEVEL_OPTIONS.includes(l)))fail(422,'Choose valid alert levels.');next.levels=[...new Set(['warning',...b.levels])];}
  if(has('freeze_threshold_f'))next.freeze_threshold_f=inRange(b.freeze_threshold_f,'freeze_threshold_f','Hard freeze','°F');
  if(has('freeze_notice_f'))next.freeze_notice_f=inRange(b.freeze_notice_f,'freeze_notice_f','Freeze notice','°F',true);
  if(has('heat_threshold_f'))next.heat_threshold_f=inRange(b.heat_threshold_f,'heat_threshold_f','Extreme heat','°F');
  if(has('heavy_rain_in'))next.heavy_rain_in=inRange(b.heavy_rain_in,'heavy_rain_in','Heavy rain','inches');
  if(has('high_wind_gust_mph'))next.high_wind_gust_mph=inRange(b.high_wind_gust_mph,'high_wind_gust_mph','High wind gusts','mph');
  if(has('forecast_lookahead_days'))next.forecast_lookahead_days=inRange(b.forecast_lookahead_days,'forecast_lookahead_days','Forecast lookahead','days');
  if(next.freeze_notice_f!=null&&next.freeze_notice_f<=next.freeze_threshold_f)fail(422,'The freeze notice temperature must be above the hard freeze temperature.');
  if(has('notify_admins'))next.notify_admins=bool(b.notify_admins,'Notify administrators');
  if(has('notify_residence_managers'))next.notify_residence_managers=bool(b.notify_residence_managers,'Notify residence managers');
  if(has('notify_user_ids')){
   if(!Array.isArray(b.notify_user_ids)||b.notify_user_ids.length>100)fail(422,'Choose team members to notify.');
   const want=[...new Set(b.notify_user_ids.map(String))];
   const ok=want.length?await all(`SELECT id FROM users WHERE organization_id=? AND active=1 AND role IN ('admin','employee') AND id IN (${want.map(()=>'?').join(',')})`,user.organization_id,...want):[];
   if(ok.length!==want.length)fail(422,'Choose active team members from your company.');
   next.notify_user_ids=want;
  }
  if(has('digest_time')){if(!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(b.digest_time)))fail(422,'Digest time must be a time like 06:30.');next.digest_time=b.digest_time;}
  if(has('watch_immediate'))next.watch_immediate=bool(b.watch_immediate,'Email watches immediately');
  if(has('client_notice')){if(!CLIENT_NOTICE.includes(b.client_notice))fail(422,'Choose how clients are told.');next.client_notice=b.client_notice;}
  if(has('on_reports'))next.on_reports=bool(b.on_reports,'Weather on inspection reports');
  if(has('storm_prep_lead_hours')){const n=Number(b.storm_prep_lead_hours);if(!Number.isInteger(n)||n<1||n>168)fail(422,'Storm preparation lead time must be between 1 and 168 hours.');next.storm_prep_lead_hours=n;}
  const at=now();
  await run(`INSERT INTO weather_settings(organization_id,enabled,categories,levels,freeze_threshold_f,freeze_notice_f,heat_threshold_f,heavy_rain_in,high_wind_gust_mph,forecast_lookahead_days,notify_admins,notify_residence_managers,notify_user_ids,digest_time,watch_immediate,client_notice,on_reports,storm_prep_lead_hours,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,categories=excluded.categories,levels=excluded.levels,freeze_threshold_f=excluded.freeze_threshold_f,freeze_notice_f=excluded.freeze_notice_f,heat_threshold_f=excluded.heat_threshold_f,heavy_rain_in=excluded.heavy_rain_in,high_wind_gust_mph=excluded.high_wind_gust_mph,forecast_lookahead_days=excluded.forecast_lookahead_days,notify_admins=excluded.notify_admins,notify_residence_managers=excluded.notify_residence_managers,notify_user_ids=excluded.notify_user_ids,digest_time=excluded.digest_time,watch_immediate=excluded.watch_immediate,client_notice=excluded.client_notice,on_reports=excluded.on_reports,storm_prep_lead_hours=excluded.storm_prep_lead_hours,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
   user.organization_id,next.enabled?1:0,JSON.stringify(next.categories),JSON.stringify(next.levels),next.freeze_threshold_f,next.freeze_notice_f,next.heat_threshold_f,next.heavy_rain_in,next.high_wind_gust_mph,next.forecast_lookahead_days,next.notify_admins?1:0,next.notify_residence_managers?1:0,JSON.stringify(next.notify_user_ids),next.digest_time,next.watch_immediate?1:0,next.client_notice,next.on_reports?1:0,next.storm_prep_lead_hours,user.id,at);
  if(next.enabled!==cur.enabled)await audit(user,next.enabled?'weather.enabled':'weather.disabled',user.organization_id);
  await audit(user,'weather.settings_updated',user.organization_id);
  return settingsOut(user);
 }
 async function settingsOut(user){
  const s=await settingsFor(user.organization_id);delete s.last_digest_day;
  return {settings:s,categories:Object.entries(W.CATEGORIES).map(([key,c])=>({key,label:c.label})),limits:W.LIMITS,defaults:W.DEFAULTS,team:await all("SELECT id,name,role FROM users WHERE organization_id=? AND active=1 AND role IN ('admin','employee') ORDER BY name",user.organization_id),
   coverage:await coverage(user.organization_id),provider:provider.name,jobsEnabled:jobsEnabled(),disclaimer:W.DISCLAIMER,attribution:W.attribution(['nws',...(provider.name==='open_meteo'?['open_meteo']:[])]),
   clientPreview:W.clientMessage({event_name:'Winter Storm Warning',ends_at:new Date(Date.now()+36*3600000).toISOString(),company:(await get('SELECT name FROM organizations WHERE id=?',user.organization_id))?.name,timezone:await companyTz(user.organization_id)}),
   privacy:'We send approximate residence coordinates to the US National Weather Service and to Open-Meteo to check weather alerts and forecasts. No names or contact details are shared.'};
 }
 async function coverage(org){
  const rows=await all('SELECT latitude,longitude,nws_supported,nws_forecast_zone,weather_monitoring_enabled FROM properties WHERE organization_id=? AND archived_at IS NULL',org);
  const c={total:rows.length,monitored:0,withCoordinates:0,missingCoordinates:0,outsideNws:0,awaitingZones:0,monitoringOff:0,geocoderAvailable:!!env.GEOAPIFY_API_KEY};
  for(const r of rows){
   if(Number(r.weather_monitoring_enabled??1)!==1){c.monitoringOff++;continue;}
   if(!W.validCoord(num(r.latitude),num(r.longitude))){c.missingCoordinates++;continue;}
   c.withCoordinates++;
   if(r.nws_supported!==null&&r.nws_supported!==undefined&&Number(r.nws_supported)===0)c.outsideNws++;
   else if(!r.nws_forecast_zone)c.awaitingZones++;
   else c.monitored++;
  }
  return c;
 }

 // ---------- access ----------
 async function accessible(user){
  if(user.role==='admin')return new Set((await all('SELECT id FROM properties WHERE organization_id=? AND archived_at IS NULL',user.organization_id)).map(r=>r.id));
  if(user.role!=='employee')return new Set();
  const own=await all('SELECT id FROM properties WHERE organization_id=? AND archived_at IS NULL AND account_manager_id=?',user.organization_id,user.id);
  const storms=await all("SELECT r.property_id id FROM storm_event_residences r JOIN storm_events e ON e.id=r.storm_event_id JOIN properties p ON p.id=r.property_id WHERE r.assigned_user_id=? AND r.organization_id=? AND e.status<>'closed' AND p.archived_at IS NULL",user.id,user.organization_id);
  return new Set([...own,...storms].map(r=>r.id));
 }
 async function alertFor(user,alertId){
  roles(user,'admin','employee');
  const a=await get('SELECT * FROM weather_alerts WHERE id=? AND organization_id=?',String(alertId),user.organization_id);if(!a)fail(404,'Weather alert not found.');
  const res=await all('SELECT * FROM weather_alert_residences WHERE weather_alert_id=? AND organization_id=? AND active=1',a.id,user.organization_id);
  const ok=await accessible(user),mine=res.filter(r=>ok.has(r.property_id));
  if(!mine.length&&user.role!=='admin')fail(404,'Weather alert not found.');
  return {a,res:mine};
 }

 // ---------- output shaping ----------
 async function shapeAlerts(user,rows,tz){
  if(!rows.length)return [];
  const ok=await accessible(user);
  const ids=rows.map(r=>r.id),res=await all(`SELECT weather_alert_id,property_id,forecast_value,forecast_unit FROM weather_alert_residences WHERE organization_id=? AND active=1 AND weather_alert_id IN (${ids.map(()=>'?').join(',')})`,user.organization_id,...ids);
  const by=new Map();for(const r of res){if(!ok.has(r.property_id))continue;if(!by.has(r.weather_alert_id))by.set(r.weather_alert_id,[]);by.get(r.weather_alert_id).push(r);}
  const names=new Map((await all('SELECT id,name FROM users WHERE organization_id=?',user.organization_id)).map(u=>[u.id,u.name]));
  const stormIds=[...new Set(rows.map(r=>r.storm_event_id).filter(Boolean))];
  const storms=new Map(stormIds.length?(await all(`SELECT id,name,status FROM storm_events WHERE organization_id=? AND id IN (${stormIds.map(()=>'?').join(',')})`,user.organization_id,...stormIds)).map(s=>[s.id,s]):[]);
  const out=[];
  for(const r of rows){
   const list=by.get(r.id)||[];if(!list.length&&user.role!=='admin')continue;
   const fs=parse(r.forecast_summary,null),st=storms.get(r.storm_event_id);
   out.push({id:r.id,source:r.source,category:r.category,category_label:W.CATEGORIES[r.category]?.label||r.category,level:r.level,event_name:r.event_name,headline:r.headline,onset_at:r.onset_at,ends_at:r.ends_at,status:r.status,
    forecast_summary:fs,title:r.source==='forecast'&&fs?W.forecastRange(fs):r.event_name,timeframe:W.timeframe({...r,forecast_summary:fs},tz),
    count:list.length,residence_count:list.length,property_ids:list.map(x=>x.property_id),values:Object.fromEntries(list.filter(x=>x.forecast_value!=null).map(x=>[x.property_id,{value:Number(x.forecast_value),unit:x.forecast_unit,day:fs?.start||null,kind:fs?.kind||null}])),
    acknowledged_at:r.acknowledged_at||null,acknowledged_by_name:r.acknowledged_by?names.get(r.acknowledged_by)||'':'',dismissed:r.status==='dismissed',dismissed_by_name:r.dismissed_by?names.get(r.dismissed_by)||'':'',dismiss_reason:r.dismiss_reason||'',
    storm_event_id:st?r.storm_event_id:null,storm_event_name:st?.name||'',storm_event_open:!!st&&st.status!=='closed',first_seen_at:r.first_seen_at,ended_at:r.ended_at||null,severity_rank:Number(r.severity_rank||0)});
  }
  return out.sort((a,b)=>b.severity_rank-a.severity_rank||String(a.onset_at||'').localeCompare(String(b.onset_at||'')));
 }
 async function listAlerts(user,status='active'){
  const tz=await companyTz(user.organization_id);
  const rows=status==='recent'
   ?await all("SELECT * FROM weather_alerts WHERE organization_id=? AND status IN ('ended','cancelled') AND (ended_at IS NULL OR ended_at>=?) ORDER BY ended_at DESC LIMIT 60",user.organization_id,new Date(Date.now()-14*86400000).toISOString())
   :await all("SELECT * FROM weather_alerts WHERE organization_id=? AND status IN ('active','dismissed') ORDER BY severity_rank DESC,onset_at",user.organization_id);
  return shapeAlerts(user,rows,tz);
 }
 async function alertDetail(user,alertId){
  const {a,res}=await alertFor(user,alertId),tz=await companyTz(user.organization_id);
  const [shaped]=await shapeAlerts(user,[a],tz);
  const members=parse(a.nws_alert_ids,[]),nwsRows=members.length?await all(`SELECT id,headline,description,instruction,sender_name,area_desc,sent_at FROM nws_alerts WHERE id IN (${members.map(()=>'?').join(',')}) ORDER BY sent_at DESC`,...members):[];
  const pids=res.map(r=>r.property_id),marks=pids.map(()=>'?').join(',');
  const props=pids.length?await all(`SELECT p.id,p.name,p.address,p.city,p.account_manager_id,u.name manager_name FROM properties p LEFT JOIN users u ON u.id=p.account_manager_id WHERE p.organization_id=? AND p.id IN (${marks})`,user.organization_id,...pids):[];
  const today=new Date().toISOString().slice(0,10);
  const visits=pids.length?await all(`SELECT property_id,MIN(inspection_date) next_date FROM inspections WHERE status='draft' AND inspection_date>=? AND property_id IN (${marks}) GROUP BY property_id`,today,...pids):[];
  const nextVisit=new Map(visits.map(v=>[v.property_id,v.next_date]));
  const stormRes=a.storm_event_id?new Map((await all('SELECT property_id,prep_status,prep_issues FROM storm_event_residences WHERE storm_event_id=? AND organization_id=?',a.storm_event_id,user.organization_id)).map(r=>[r.property_id,r])):new Map();
  const byId=new Map(props.map(p=>[p.id,p]));
  const fs=shaped?.forecast_summary;
  const residences=res.map(r=>{const p=byId.get(r.property_id)||{};const sr=stormRes.get(r.property_id);
   return {property_id:r.property_id,name:p.name||'Residence',city:p.city||cityOf(p.address),address:p.address||'',manager_id:p.account_manager_id||null,manager:p.manager_name||'',next_visit:nextVisit.get(r.property_id)||null,
    on_storm:!!sr,storm_status:sr?S.prepLabel(sr.prep_status,sr.prep_issues):null,matched_by:r.matched_by,forecast:r.forecast_value!=null&&fs?W.forecastBadge(fs.kind,fs.start,Number(r.forecast_value)):''};}).sort((x,y)=>x.name.localeCompare(y.name));
  const best=nwsRows[0]||{};
  return {alert:{...shaped,description:best.description||'',instruction:best.instruction||'',sender_name:best.sender_name||'',area_desc:best.area_desc||'',residences,timezone:tz,
   attribution:W.attribution([a.source==='forecast'&&provider.name==='open_meteo'?'open_meteo':'nws']),disclaimer:W.DISCLAIMER},canManage:user.role==='admin'};
 }

 // ---------- storm hand-off ----------
 function stormPrefill(a,res,s){
  const type=W.stormTypeFor(a.category,a.event_name);
  const lead=Number(s.storm_prep_lead_hours||24)*3600000;
  const onset=a.onset_at||null;
  const prep=onset&&Date.parse(onset)-lead>Date.now()?new Date(Date.parse(onset)-lead).toISOString():null;
  const fs=parse(a.forecast_summary,null);
  return {name:String(fs?W.forecastRange(fs):a.event_name).slice(0,150),type,type_label:S.TYPES[type]||'Storm',expected_impact_at:onset,prep_deadline_at:prep,residenceIds:res.map(r=>r.property_id)};
 }
 async function startStorm(user,alertId,b){
  roles(user,'admin');
  const {a,res}=await alertFor(user,alertId),s=await settingsFor(user.organization_id);
  if(a.storm_event_id){const ev=await get('SELECT id,name,status FROM storm_events WHERE id=? AND organization_id=?',a.storm_event_id,user.organization_id);if(ev)return {linked:true,event:ev};}
  if(!b.create)return {prefill:stormPrefill(a,res,s)};
  const allowed=new Set(res.map(r=>r.property_id));
  const residenceIds=Array.isArray(b.residenceIds)?[...new Set(b.residenceIds.map(String))]:[...allowed];
  if(residenceIds.some(x=>!allowed.has(x)))fail(422,'Choose residences affected by this alert.');
  let event,created=false;
  await transaction(async()=>{
   // Re-check inside the transaction (it holds the advisory lock on Postgres) so a double tap creates one storm.
   const fresh=await get('SELECT storm_event_id FROM weather_alerts WHERE id=? AND organization_id=?',a.id,user.organization_id);
   if(fresh?.storm_event_id){event=await get('SELECT id,name,status FROM storm_events WHERE id=?',fresh.storm_event_id);if(event)return;}
   const pre=stormPrefill(a,res,s);
   const key=await storm.createEvent(user,{name:b.name||pre.name,type:b.type||pre.type,expectedImpactAt:b.expectedImpactAt===undefined?pre.expected_impact_at:b.expectedImpactAt,prepDeadlineAt:b.prepDeadlineAt===undefined?pre.prep_deadline_at:b.prepDeadlineAt,postCheckTargetAt:b.postCheckTargetAt,notes:b.notes??`Started from weather alert: ${a.event_name}.`});
   if(residenceIds.length)await storm.addResidences(user,key,residenceIds);
   await run('UPDATE weather_alerts SET storm_event_id=?,updated_at=? WHERE id=? AND organization_id=?',key,now(),a.id,user.organization_id);
   await audit(user,'weather.storm_started',a.id);
   event=await get('SELECT id,name,status FROM storm_events WHERE id=?',key);created=true;
  });
  return {created,linked:!created,event};
 }
 async function addToStorm(user,alertId,b){
  roles(user,'admin');
  const {a,res}=await alertFor(user,alertId);
  const allowed=new Set(res.map(r=>r.property_id));
  const residenceIds=Array.isArray(b.residenceIds)?[...new Set(b.residenceIds.map(String))]:[...allowed];
  if(residenceIds.some(x=>!allowed.has(x)))fail(422,'Choose residences affected by this alert.');
  if(!b.stormEventId)fail(422,'Choose a storm event.');
  let out;
  await transaction(async()=>{
   out=await storm.addResidences(user,String(b.stormEventId),residenceIds);
   if(!a.storm_event_id)await run('UPDATE weather_alerts SET storm_event_id=?,updated_at=? WHERE id=? AND organization_id=?',out.event.id,now(),a.id,user.organization_id);
   await audit(user,'weather.added_to_storm',a.id);
  });
  return {added:out.added,alreadyIncluded:out.alreadyIncluded,event:{id:out.event.id,name:out.event.name,status:out.event.status}};
 }

 // ---------- inspection weather snapshot ----------
 async function conditionsFor(p,at){
  const lat=num(p.latitude),lon=num(p.longitude);if(!W.validCoord(lat,lon))return null;
  if(provider.name==='open_meteo'||(Number(p.nws_supported)===0&&env.OPEN_METEO_API_KEY))return meteo.conditions(lat,lon,at);
  if(Number(p.nws_supported)!==1||!p.nws_grid_id)return null;
  let station=p.nws_station_id;
  if(!station){station=await nws.station(p.nws_grid_id,p.nws_grid_x,p.nws_grid_y);if(station)await run('UPDATE properties SET nws_station_id=? WHERE id=?',station,p.id);}
  return station?nws.observation(station,at):null;
 }
 async function activeAlertNames(propertyId){
  const rows=await all("SELECT a.event_name FROM weather_alerts a JOIN weather_alert_residences r ON r.weather_alert_id=a.id WHERE r.property_id=? AND r.active=1 AND a.source='nws' AND a.status IN ('active','dismissed') ORDER BY a.severity_rank DESC",propertyId);
  return [...new Set(rows.map(r=>r.event_name))];
 }
 /** Captures conditions at the residence for a draft visit. Never throws: a visit must not fail because of weather. */
 async function captureSnapshot(inspectionId,{force=false}={}){
  try{
   const i=await get('SELECT id,property_id,status,weather_snapshot,weather_snapshot_overridden FROM inspections WHERE id=?',inspectionId);
   if(!i||i.status!=='draft'||Number(i.weather_snapshot_overridden)===1||(i.weather_snapshot&&!force))return null;
   const p=await get('SELECT * FROM properties WHERE id=?',i.property_id);if(!p)return null;
   if(!(await settingsFor(p.organization_id)).enabled)return null;
   const visit=await get('SELECT check_in_device_at,check_in_server_at FROM inspection_visits WHERE inspection_id=?',inspectionId);
   const at=visit?.check_in_device_at||visit?.check_in_server_at||now();
   const cur=await conditionsFor(p,at).catch(e=>{log.error('Weather snapshot:',e.message);return null;});
   const alerts=await activeAlertNames(p.id);
   if(!cur&&!alerts.length)return null;
   const snap={...(cur||{source:'nws'}),active_alerts:alerts,captured_at:now()};
   snap.line=W.snapshotLine(snap);
   await run("UPDATE inspections SET weather_snapshot=? WHERE id=? AND status='draft' AND weather_snapshot_overridden=0",JSON.stringify(snap),inspectionId);
   return snap;
  }catch(e){log.error('Weather snapshot:',e.message);return null;}
 }
 const pending=new Set();
 function captureLater(inspectionId,opts={}){
  const t=setTimeout(()=>{pending.delete(t);captureSnapshot(inspectionId,opts).catch(()=>{});},Number(env.WEATHER_SNAPSHOT_DELAY_MS??0));t.unref?.();pending.add(t);
 }
 /** Wraps visitVerification.handle: after a successful check-in, refresh the visit's weather in the background. */
 function hookCheckIn(vv){
  const base=vv.handle,CHECK_IN=/^\/api\/inspections\/([^/]+)\/check-in$/;
  vv.handle=async(req,res,url,user)=>{const done=await base(req,res,url,user);const m=done&&res.statusCode===200&&CHECK_IN.exec(url.pathname);if(m)captureLater(decodeURIComponent(m[1]),{force:true});return done;};
  return vv;
 }
 async function editSnapshot(user,inspectionId,b){
  roles(user,'admin','employee');
  const i=await get('SELECT * FROM inspections WHERE id=?',String(inspectionId));if(!i)fail(404,'Inspection not found.');
  await property(user,i.property_id,'operate');
  if(i.status!=='draft')fail(409,'Weather can only be changed while the visit is a draft.');
  if(b.clear){await run("UPDATE inspections SET weather_snapshot=NULL,weather_snapshot_overridden=1 WHERE id=? AND status='draft'",i.id);await audit(user,'weather.snapshot_removed',i.id);return {weather:null};}
  if(b.refresh){await run("UPDATE inspections SET weather_snapshot_overridden=0 WHERE id=? AND status='draft'",i.id);return {weather:await captureSnapshot(i.id,{force:true})};}
  const s=b.snapshot;if(!s||typeof s!=='object')fail(422,'Enter the weather at the visit.');
  const out={source:'manual',captured_at:now(),edited_by:user.id};
  const n=(k,label,lo,hi)=>{if(s[k]===undefined||s[k]===null||s[k]==='')return;const v=Number(s[k]);if(!Number.isFinite(v)||v<lo||v>hi)fail(422,`${label} must be between ${lo} and ${hi}.`);out[k]=Math.round(v*10)/10;};
  n('temp_f','Temperature',-80,140);n('wind_mph','Wind',0,250);n('gust_mph','Gusts',0,300);
  if(s.conditions!==undefined){const c=String(s.conditions||'').trim();if(c.length>80)fail(422,'Conditions must be 80 characters or fewer.');if(c)out.conditions=c;}
  const prev=parse(i.weather_snapshot,{})||{};
  out.active_alerts=Array.isArray(s.active_alerts)?s.active_alerts.map(x=>String(x).slice(0,80)).slice(0,5):(prev.active_alerts||[]);
  out.line=W.snapshotLine(out);if(!out.line)fail(422,'Enter at least the temperature or the conditions.');
  await run("UPDATE inspections SET weather_snapshot=?,weather_snapshot_overridden=1 WHERE id=? AND status='draft'",JSON.stringify(out),i.id);
  await audit(user,'weather.snapshot_edited',i.id);
  return {weather:out};
 }

 // ---------- report hooks ----------
 /** Wraps visitVerification.publishFields so publish freezes report.weather when "weather on reports" is on. */
 function extendReports(vv){
  const base=vv.publishFields;
  vv.publishFields=async(user,row,pRow)=>{
   const out=await base(user,row,pRow);
   try{
    const snap=parse(row.weather_snapshot,null);
    if(snap?.line&&(await settingsFor(user.organization_id)).on_reports)out.fields={...out.fields,weather:{line:snap.line,sources:[snap.source].filter(x=>x&&x!=='manual'),attribution:W.attribution([snap.source])}};
   }catch{}
   return out;
  };
  return vv;
 }
 async function stormExtras(user,ev){
  const a=await get("SELECT event_name,first_seen_at,ends_at FROM weather_alerts WHERE storm_event_id=? AND organization_id=? AND source='nws' ORDER BY severity_rank DESC LIMIT 1",ev.id,user.organization_id);
  if(!a)return null;
  return {alert:{event:a.event_name,issuedAt:a.first_seen_at,endsAt:a.ends_at},note:W.attribution(['nws'])};
 }
 storm?.setReportExtras?.(stormExtras);

 // ---------- /api/data ----------
 const PKEYS=['nws_supported','nws_state','nws_forecast_zone','nws_county_zone','nws_fire_zone','nws_grid_id','nws_grid_x','nws_grid_y','nws_station_id','nws_points_checked_at','nws_points_lat','nws_points_lon'];
 async function decorate(user,data){
  if(!data||!user)return data;
  const staff=user.role==='admin'||user.role==='employee';
  for(const p of data.properties||[]){for(const k of PKEYS)delete p[k];if(!staff){delete p.weather_monitoring_enabled;delete p.weather_threshold_overrides;}}
  for(const p of data.archivedProperties||[])for(const k of PKEYS)delete p[k];
  for(const i of data.inspections||[]){const snap=parse(i.weather_snapshot,null);delete i.weather_snapshot;if(staff){i.weather=snap;i.weather_snapshot_overridden=Number(i.weather_snapshot_overridden||0);}else delete i.weather_snapshot_overridden;}
  if(user.role==='vendor')return data;
  const s=await settingsFor(user.organization_id);
  if(staff){
   const pref=(await get('SELECT email_pref FROM weather_user_prefs WHERE user_id=?',user.id))?.email_pref||'all';
   data.weather={enabled:s.enabled,canManage:user.role==='admin',emailPref:pref,timezone:await companyTz(user.organization_id),alerts:s.enabled?await listAlerts(user,'active'):[],disclaimer:W.DISCLAIMER,onReports:s.on_reports};
  }else if(user.role==='client'){
   data.weatherNotices=s.enabled&&s.client_notice!=='off'?await clientNotices(user,data,s):[];
  }
  return data;
 }
 async function clientNotices(user,data,s){
  const homes=new Map((data.properties||[]).map(p=>[p.id,p]));if(!homes.size)return [];
  const ids=[...homes.keys()];
  const rows=await all(`SELECT a.id,a.event_name,a.onset_at,a.ends_at,a.acknowledged_at,r.property_id FROM weather_alerts a JOIN weather_alert_residences r ON r.weather_alert_id=a.id WHERE a.organization_id=? AND a.source='nws' AND a.status='active' AND a.level IN ('warning','watch') AND r.active=1 AND r.property_id IN (${ids.map(()=>'?').join(',')}) ORDER BY a.severity_rank DESC`,user.organization_id,...ids);
  const company=(await get('SELECT name FROM organizations WHERE id=?',user.organization_id))?.name||'';
  return rows.filter(r=>s.client_notice==='automatic'||r.acknowledged_at).map(r=>{const p=homes.get(r.property_id);const tz=p.effective_timezone||p.timezone||'America/New_York';return {id:`${r.id}:${r.property_id}`,property_id:r.property_id,property_name:p.name,event_name:r.event_name,onset_at:r.onset_at,ends_at:r.ends_at,company_message:W.clientMessage({event_name:r.event_name,ends_at:r.ends_at,company,timezone:tz})};});
 }

 // ---------- jobs ----------
 async function lock(job,ms=300000){
  const key='weather:'+job,until=new Date(Date.now()+ms).toISOString(),at=now();
  await run("INSERT INTO job_locks(job,owner,locked_until) VALUES(?,NULL,'') ON CONFLICT(job) DO NOTHING",key);
  const r=await run('UPDATE job_locks SET owner=?,locked_until=? WHERE job=? AND (locked_until<? OR owner=?)',owner,until,key,at,owner);
  return (r.changes||0)===1;
 }
 async function unlock(job){await run("UPDATE job_locks SET locked_until='' WHERE job=? AND owner=?",'weather:'+job,owner);}
 async function runJob(job,{force=false}={}){
  if(!JOBS[job])fail(422,'Unknown weather job.');
  if(!(await lock(job)))return {job,skipped:'locked'};
  const runId=id(),started=Date.now(),before=counter.requests,errors=[];
  await run('INSERT INTO weather_job_runs(id,job,started_at,status) VALUES(?,?,?,?)',runId,job,new Date(started).toISOString(),'running');
  const deadline=started+budgetMs();
  try{
   const fn={alerts:alertsJob,forecast:forecastJob,points:pointsJob,digest:digestJob}[job];
   const r=await fn({deadline,errors,force});const seen=r?.seen||0,status=errors.length?'partial':'ok';
   await run('UPDATE weather_job_runs SET finished_at=?,status=?,requests=?,alerts_seen=?,errors=? WHERE id=?',now(),status,counter.requests-before,seen,JSON.stringify(errors.slice(0,20)),runId);
   if(errors.length)log.error(`Weather ${job} job finished with ${errors.length} problem(s):`,errors.slice(0,3).join(' | '));
   return {job,status,requests:counter.requests-before,seen,errors:errors.length};
  }catch(e){
   errors.push(e.message);log.error(`Weather ${job} job:`,e.message);
   await run('UPDATE weather_job_runs SET finished_at=?,status=?,requests=?,errors=? WHERE id=?',now(),'failed',counter.requests-before,JSON.stringify(errors.slice(0,20)),runId);
   return {job,status:'failed',errors:errors.length};
  }finally{await unlock(job);}
 }
 async function due(job){
  const last=await get("SELECT MAX(started_at) at FROM weather_job_runs WHERE job=? AND status<>'running'",job);
  return !last?.at||Date.now()-Date.parse(last.at)>=interval(job)*60000-15000;
 }
 let ticking=false;
 /** Called every minute by server.mjs. Runs whichever jobs are due (needs WEATHER_JOBS_ENABLED=true). */
 async function tick(){
  if(!jobsEnabled()||ticking)return;
  ticking=true;
  try{
   if(!(await get('SELECT 1 FROM weather_settings WHERE enabled=1 LIMIT 1')))return;
   for(const job of ['points','alerts','forecast','digest'])if(await due(job))await runJob(job);
  }catch(e){log.error('Weather jobs:',e.message);}finally{ticking=false;}
 }
 async function monitored(){
  const rows=await all('SELECT p.* FROM properties p JOIN weather_settings w ON w.organization_id=p.organization_id WHERE w.enabled=1 AND p.archived_at IS NULL AND p.weather_monitoring_enabled=1 AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL');
  return rows.filter(p=>W.validCoord(num(p.latitude),num(p.longitude)));
 }
 async function pointsJob({deadline,errors}){
  const rows=(await monitored()).filter(p=>{
   if(p.nws_supported===null||p.nws_supported===undefined)return true;
   const moved=W.round(num(p.latitude),4)!==num(p.nws_points_lat)||W.round(num(p.longitude),4)!==num(p.nws_points_lon);
   return moved||!p.nws_points_checked_at||Date.now()-Date.parse(p.nws_points_checked_at)>30*86400000;
  }).slice(0,Number(env.WEATHER_POINTS_BATCH||100));
  let done=0;
  for(const p of rows){
   if(Date.now()>deadline)break;
   const lat=W.round(num(p.latitude),4),lon=W.round(num(p.longitude),4);
   try{
    const r=await nws.points(lat,lon),at=now();
    if(!r.supported)await run('UPDATE properties SET nws_supported=0,nws_points_checked_at=?,nws_points_lat=?,nws_points_lon=? WHERE id=?',at,lat,lon,p.id);
    else await run('UPDATE properties SET nws_supported=1,nws_state=?,nws_forecast_zone=?,nws_county_zone=?,nws_fire_zone=?,nws_grid_id=?,nws_grid_x=?,nws_grid_y=?,nws_station_id=NULL,nws_points_checked_at=?,nws_points_lat=?,nws_points_lon=? WHERE id=?',r.state,r.forecastZone,r.countyZone,r.fireZone,r.gridId,r.gridX,r.gridY,at,lat,lon,p.id);
    done++;
   }catch(e){errors.push(`points: ${e.message}`);if(e.status===429)break;}
  }
  return {seen:done};
 }
 async function storeAlerts(list,at){
  for(const a of list){
   await run(`INSERT INTO nws_alerts(id,event,category,level,status,severity,urgency,certainty,headline,description,instruction,sender_name,area_desc,sent_at,effective_at,onset_at,expires_at,ends_at,message_type,refs,vtec,ugc,geometry,fetched_at,last_active_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET headline=excluded.headline,description=excluded.description,instruction=excluded.instruction,expires_at=excluded.expires_at,ends_at=excluded.ends_at,ugc=excluded.ugc,geometry=excluded.geometry,last_active_at=excluded.last_active_at`,
    a.id,a.event,a.category,a.level,a.status,a.severity,a.urgency,a.certainty,a.headline,a.description,a.instruction,a.sender_name,a.area_desc,a.sent_at,a.effective_at,a.onset_at,a.expires_at,a.ends_at,a.message_type,JSON.stringify(a.refs),JSON.stringify(a.vtec),JSON.stringify(a.ugc),a.geometry?JSON.stringify(a.geometry):null,at,at);
   for(const ref of a.refs)await run('UPDATE nws_alerts SET superseded_by=?,cancelled=? WHERE id=? AND superseded_by IS NULL',a.id,a.message_type==='Cancel'?1:0,ref);
  }
 }
 const cachedAlert=r=>({id:r.id,event:r.event,category:r.category,level:r.level,status:r.status,message_type:r.message_type,headline:r.headline||'',sent_at:r.sent_at,onset_at:r.onset_at,ends_at:r.ends_at,expires_at:r.expires_at,refs:parse(r.refs,[]),ugc:parse(r.ugc,[]),geometry:parse(r.geometry,null)});
 async function alertsJob({deadline,errors}){
  await pointsJob({deadline:Math.min(deadline,Date.now()+60000),errors});
  const homes=await monitored(),at=now(),nowMs=Date.now();
  const states=[...new Set(homes.filter(p=>Number(p.nws_supported)===1&&p.nws_state).map(p=>p.nws_state))].sort();
  const fresh=[],failed=new Set(),cancelled=new Set();
  for(const st of states){
   if(Date.now()>deadline){failed.add(st);errors.push(`alerts ${st}: out of time`);continue;}
   try{fresh.push(...await nws.activeByState(st));}catch(e){failed.add(st);errors.push(`alerts ${st}: ${e.message}`);}
  }
  // Residences in NWS coverage without zones yet (points not resolved): one point query each, a few per run.
  const byPoint=new Map();
  for(const p of homes.filter(x=>Number(x.nws_supported)!==0&&!x.nws_forecast_zone).slice(0,20)){if(Date.now()>deadline)break;try{byPoint.set(p.id,await nws.activeByPoint(num(p.latitude),num(p.longitude)));}catch(e){errors.push(`alerts point: ${e.message}`);}}
  const unique=new Map();for(const a of [...fresh,...[...byPoint.values()].flat()])if(a.id)unique.set(a.id,a);
  for(const a of unique.values())if(a.message_type==='Cancel')for(const r of a.refs)cancelled.add(r);
  await storeAlerts([...unique.values()],at);
  const live=a=>a.status==='Actual'&&a.message_type!=='Cancel'&&!cancelled.has(a.id)&&!!a.category&&a.level!=='statement'&&(!(a.ends_at||a.expires_at)||Date.parse(a.ends_at||a.expires_at)>nowMs);
  const activeFresh=[...unique.values()].filter(live);
  // A state whose request failed keeps its last known alerts, so its groups neither end nor re-notify.
  let stale=[];
  if(failed.size){const since=new Date(nowMs-6*3600000).toISOString();stale=(await all('SELECT * FROM nws_alerts WHERE last_active_at>=? AND superseded_by IS NULL AND cancelled=0',since)).map(cachedAlert).filter(live);}
  const orgs=[...new Set(homes.map(p=>p.organization_id))];
  for(const org of orgs){
   if(Date.now()>deadline){errors.push('alerts: out of time before all companies');break;}
   try{await reconcileOrg(org,homes.filter(p=>p.organization_id===org),{activeFresh,stale,failed,byPoint,cancelled:[...cancelled],live});}catch(e){errors.push(`alerts company: ${e.message}`);log.error('Weather reconcile:',e.message);}
  }
  await run('DELETE FROM nws_alerts WHERE fetched_at<?',new Date(nowMs-30*86400000).toISOString());
  return {seen:unique.size};
 }
 async function reconcileOrg(org,homes,{activeFresh,stale,failed,byPoint,cancelled,live}){
  const s=await settingsFor(org),tz=await companyTz(org);
  const wanted=a=>s.categories.includes(a.category)&&(a.level==='warning'||s.levels.includes(a.level));
  const matched=new Map();
  for(const p of homes){
   const viaPoint=byPoint.has(p.id);
   const pool=viaPoint?byPoint.get(p.id).filter(live):Number(p.nws_supported)===1&&p.nws_state?(failed.has(p.nws_state)?stale:activeFresh):[];
   for(const a of pool){
    if(!wanted(a))continue;
    const how=viaPoint?'point':W.matchResidence(a,{latitude:num(p.latitude),longitude:num(p.longitude),nws_forecast_zone:p.nws_forecast_zone,nws_county_zone:p.nws_county_zone,nws_fire_zone:p.nws_fire_zone});
    if(!how)continue;
    if(!matched.has(a.id))matched.set(a.id,{...a,residences:[]});matched.get(a.id).residences.push({property_id:p.id,matched_by:how});
   }
  }
  const rows=await all("SELECT * FROM weather_alerts WHERE organization_id=? AND source='nws' AND (status IN ('active','dismissed') OR (status='ended' AND ended_at>=?))",org,new Date(Date.now()-7*86400000).toISOString());
  const supersededIds=new Set(rows.filter(r=>r.supersedes_alert_id).map(r=>r.supersedes_alert_id));
  const groups=[];
  for(const r of rows){
   if(r.status==='ended'&&!supersededIds.has(r.id))continue;
   const res=(await all('SELECT property_id FROM weather_alert_residences WHERE weather_alert_id=? AND active=1',r.id)).map(x=>x.property_id);
   groups.push({...r,nws_alert_ids:parse(r.nws_alert_ids,[]),cancelled_ids:parse(r.cancelled_ids,[]),residences:res,superseded:r.status==='ended',notified_count:Number(r.notified_count||0)});
  }
  const {groups:next,events}=W.reconcileNws({groups,alerts:[...matched.values()],cancelled,timezone:tz,now:now()});
  const at=now();
  await transaction(async()=>{
   for(const g of next){
    if(!g.changed&&!g.isNew)continue;
    if(g.isNew){
     g.id=id();
     await run('INSERT INTO weather_alerts(id,organization_id,source,category,level,event_name,group_key,severity_rank,headline,onset_at,ends_at,status,first_seen_at,last_seen_at,supersedes_alert_id,nws_alert_ids,cancelled_ids,notified_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      g.id,org,'nws',g.category,g.level,g.event_name,g.group_key,W.severityRank(g.level,g.category),g.headline||'',g.onset_at,g.ends_at,'active',at,at,g.supersedesRef?.id||g.supersedes_alert_id||null,JSON.stringify(g.nws_alert_ids),JSON.stringify(g.cancelled_ids||[]),0,at,at);
     // A watch first seen in the same run as the warning that replaces it is stored as ended (history only).
     if(g.status==='ended'){await run("UPDATE weather_alerts SET status='ended',ended_at=? WHERE id=?",at,g.id);await syncResidences(org,g.id,g.residenceMatches||new Map(g.members?[...g.members.values()].flatMap(m=>m.residences.map(r=>[r.property_id,r.matched_by])):[]),at);continue;}
    }else if(g.keepEnded){
     await run('UPDATE weather_alerts SET nws_alert_ids=?,updated_at=? WHERE id=?',JSON.stringify(g.nws_alert_ids),at,g.id);continue;
    }else{
     const status=['ended','cancelled'].includes(g.status)?g.status:(g.status==='dismissed'?'dismissed':'active');
     await run('UPDATE weather_alerts SET status=?,headline=?,onset_at=?,ends_at=?,nws_alert_ids=?,cancelled_ids=?,ended_at=?,last_seen_at=?,updated_at=? WHERE id=?',status,g.headline||'',g.onset_at,g.ends_at,JSON.stringify(g.nws_alert_ids),JSON.stringify(g.cancelled_ids||[]),['ended','cancelled'].includes(status)?(g.ended_at||at):null,at,at,g.id);
     if(['ended','cancelled'].includes(status))continue;
    }
    await syncResidences(org,g.id,g.residenceMatches||new Map(),at);
   }
  });
  for(const ev of events){
   const g=ev.group;if(!g.id)continue;
   if(g.status==='ended'||g.status==='cancelled'||(g.status==='dismissed'&&ev.type==='expanded'))continue;
   const immediate=ev.type==='upgraded'||ev.type==='expanded'||(ev.type==='new'&&(g.level==='warning'||(g.level==='watch'&&s.watch_immediate)));
   if(immediate)await notifyImmediate(org,g.id,ev.type,s,tz);
  }
 }
 async function syncResidences(org,alertId,matches,at,values=null){
  const current=new Map((await all('SELECT property_id,active FROM weather_alert_residences WHERE weather_alert_id=?',alertId)).map(r=>[r.property_id,Number(r.active)]));
  for(const [pid,how] of matches){
   const v=values?.get(pid);
   if(!current.has(pid))await run('INSERT INTO weather_alert_residences(id,organization_id,weather_alert_id,property_id,matched_by,forecast_value,forecast_unit,first_seen_at,last_seen_at,active) VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(weather_alert_id,property_id) DO NOTHING',id(),org,alertId,pid,how,v?.value??null,v?.unit??null,at,at);
   else await run('UPDATE weather_alert_residences SET active=1,matched_by=?,forecast_value=?,forecast_unit=?,last_seen_at=? WHERE weather_alert_id=? AND property_id=?',how,v?.value??null,v?.unit??null,at,alertId,pid);
  }
  for(const [pid,active] of current)if(active&&!matches.has(pid))await run('UPDATE weather_alert_residences SET active=0,last_seen_at=? WHERE weather_alert_id=? AND property_id=?',at,alertId,pid);
 }

 // ---------- forecast job ----------
 async function dailyFor(homes,errors,deadline){
  const out=new Map(),fresh=Date.now()-3*3600000;
  const useMeteo=p=>provider.name==='open_meteo'||(Number(p.nws_supported)===0&&!!env.OPEN_METEO_API_KEY);
  const cells=new Map();
  for(const p of homes.filter(x=>!useMeteo(x)&&Number(x.nws_supported)===1&&x.nws_grid_id)){const key=`nws_grid:${p.nws_grid_id}/${p.nws_grid_x},${p.nws_grid_y}:${p.effective_timezone}`;if(!cells.has(key))cells.set(key,{p,homes:[]});cells.get(key).homes.push(p);}
  // NWS raw grid: one request per grid cell, cached for 3 hours.
  for(const [key,c] of cells){
   let days=null;const hit=await get('SELECT daily,fetched_at FROM forecast_cache WHERE cache_key=?',key);
   if(hit&&Date.parse(hit.fetched_at)>fresh)days=parse(hit.daily,null);
   else if(Date.now()<deadline){
    try{const props=await nws.gridpoint(c.p.nws_grid_id,c.p.nws_grid_x,c.p.nws_grid_y);if(props){days=W.nwsGridDaily(props,c.p.effective_timezone);await run('INSERT INTO forecast_cache(cache_key,provider,fetched_at,daily) VALUES(?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET fetched_at=excluded.fetched_at,daily=excluded.daily',key,'nws_grid',now(),JSON.stringify(days));}}
    catch(e){errors.push(`forecast grid: ${e.message}`);if(hit)days=parse(hit.daily,null);}
   }
   if(days)for(const p of c.homes)out.set(p.id,{days,source:'nws'});
  }
  // Open-Meteo: batches of up to 50 rounded points, cached for 3 hours.
  const need=[];
  for(const p of homes.filter(useMeteo)){const lat=W.round(num(p.latitude),2),lon=W.round(num(p.longitude),2),key=`open_meteo:${lat},${lon}`;const hit=await get('SELECT daily,fetched_at FROM forecast_cache WHERE cache_key=?',key);if(hit&&Date.parse(hit.fetched_at)>fresh)out.set(p.id,{days:parse(hit.daily,[]),source:'open_meteo'});else need.push({p,lat,lon,key});}
  if(need.length&&Date.now()<deadline){
   const uniq=[...new Map(need.map(n=>[n.key,n])).values()];
   try{
    const got=await meteo.daily(uniq.map(n=>({lat:n.lat,lon:n.lon}))),byKey=new Map();
    for(const [i,n] of uniq.entries()){const g=got[i];if(!g)continue;byKey.set(n.key,g.days);await run('INSERT INTO forecast_cache(cache_key,lat_r,lon_r,provider,fetched_at,daily) VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET fetched_at=excluded.fetched_at,daily=excluded.daily',n.key,n.lat,n.lon,'open_meteo',now(),JSON.stringify(g.days));}
    for(const n of need)if(byKey.has(n.key))out.set(n.p.id,{days:byKey.get(n.key),source:'open_meteo'});
   }catch(e){errors.push(`forecast open-meteo: ${e.message}`);}
  }
  return out;
 }
 async function forecastJob({deadline,errors}){
  const homes=await monitored(),orgs=[...new Set(homes.map(p=>p.organization_id))];
  const settings=new Map(),vvs=new Map();
  for(const org of orgs){settings.set(org,await settingsFor(org));vvs.set(org,await visitVerification.settings(org));}
  for(const p of homes)p.effective_timezone=visitVerification.timezoneFor(p,vvs.get(p.organization_id))||'America/New_York';
  const forecastCats=['winter','heat','flood','wind'];
  const relevant=homes.filter(p=>settings.get(p.organization_id).categories.some(c=>forecastCats.includes(c)));
  const daily=await dailyFor(relevant,errors,deadline);
  for(const org of orgs){
   if(Date.now()>deadline){errors.push('forecast: out of time before all companies');break;}
   try{await forecastOrg(org,relevant.filter(p=>p.organization_id===org),daily,settings.get(org));}catch(e){errors.push(`forecast company: ${e.message}`);log.error('Weather forecast:',e.message);}
  }
  return {seen:daily.size};
 }
 async function forecastOrg(org,homes,daily,s){
  const runs=[];
  for(const p of homes){
   const d=daily.get(p.id);if(!d)continue;
   const th=W.thresholdsFor(s,p.weather_threshold_overrides),today=W.localDay(now(),p.effective_timezone);
   for(const r of W.mergeRuns(W.thresholdHits(d.days,th,{today,categories:s.categories})))runs.push({...r,property_id:p.id});
  }
  // A residence already covered by an NWS alert of the same category with overlapping dates is not added.
  const nwsRows=await all("SELECT a.category,a.onset_at,a.ends_at,r.property_id FROM weather_alerts a JOIN weather_alert_residences r ON r.weather_alert_id=a.id WHERE a.organization_id=? AND a.source='nws' AND a.status IN ('active','dismissed') AND r.active=1",org);
  const covered=(pid,cat,start,end)=>nwsRows.some(n=>n.property_id===pid&&n.category===cat&&W.overlaps(n.onset_at,n.ends_at,start+'T00:00:00.000Z',W.addDays(end,1)+'T12:00:00.000Z'));
  const rows=await all("SELECT * FROM weather_alerts WHERE organization_id=? AND source='forecast' AND status IN ('active','dismissed')",org);
  const groups=[];for(const r of rows)groups.push({...r,residences:(await all('SELECT property_id FROM weather_alert_residences WHERE weather_alert_id=? AND active=1',r.id)).map(x=>x.property_id)});
  const {groups:next}=W.planForecast({groups,runs,covered,now:now()});
  const at=now();
  await transaction(async()=>{
   for(const g of next){
    if(!g.changed&&!g.isNew)continue;
    if(g.isNew){g.id=id();await run('INSERT INTO weather_alerts(id,organization_id,source,category,level,event_name,group_key,severity_rank,headline,onset_at,ends_at,forecast_summary,status,first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',g.id,org,'forecast',g.category,g.level,g.event_name,g.group_key,W.severityRank(g.level,g.category),g.headline||'',g.onset_at||null,null,JSON.stringify(g.forecast_summary),'active',at,at,at,at);}
    else{const status=g.status==='ended'?'ended':g.status;await run('UPDATE weather_alerts SET status=?,headline=?,onset_at=?,forecast_summary=?,ended_at=?,last_seen_at=?,updated_at=? WHERE id=?',status,g.headline||'',g.onset_at||null,JSON.stringify(g.forecast_summary),status==='ended'?(g.ended_at||at):null,at,at,g.id);if(status==='ended')continue;}
    await syncResidences(org,g.id,new Map(g.residences.map(pid=>[pid,'forecast'])),at,g.values);
   }
  });
 }

 // ---------- notifications ----------
 async function recipients(org,s,propertyIds){
  const staff=await all("SELECT id,name,email,role FROM users WHERE organization_id=? AND active=1 AND role IN ('admin','employee')",org);
  const managers=propertyIds.length?new Set((await all(`SELECT DISTINCT account_manager_id id FROM properties WHERE id IN (${propertyIds.map(()=>'?').join(',')}) AND account_manager_id IS NOT NULL`,...propertyIds)).map(r=>r.id)):new Set();
  const chosen=new Set(s.notify_user_ids||[]);
  return staff.filter(u=>u.email&&((s.notify_admins&&u.role==='admin')||(s.notify_residence_managers&&managers.has(u.id))||chosen.has(u.id)));
 }
 async function residencesFor(u,org,propertyIds){
  const ok=await accessible({...u,organization_id:org});
  const list=propertyIds.filter(x=>ok.has(x));
  if(!list.length)return [];
  return (await all(`SELECT id,name,address,city FROM properties WHERE id IN (${list.map(()=>'?').join(',')}) ORDER BY name`,...list)).map(p=>({name:p.name,city:p.city||cityOf(p.address)}));
 }
 async function companyName(org){return (await get('SELECT name FROM organizations WHERE id=?',org))?.name||'EstateAegis';}
 const origin=()=>{try{return new URL(portalLink(env)).origin;}catch{return 'https://estateaegis.com';}};
 const emailPref=async userId=>(await get('SELECT email_pref FROM weather_user_prefs WHERE user_id=?',userId))?.email_pref||'all';
 async function notifyImmediate(org,alertId,kind,s,tz){
  const a=await get('SELECT * FROM weather_alerts WHERE id=?',alertId);if(!a)return 0;
  const pids=(await all('SELECT property_id FROM weather_alert_residences WHERE weather_alert_id=? AND active=1',alertId)).map(r=>r.property_id);
  const demo=await get('SELECT organization_id FROM demo_workspaces WHERE organization_id=?',org);
  const company=await companyName(org);let sent=0;
  for(const u of await recipients(org,s,pids)){
   if(!W.wantsEmail(await emailPref(u.id),{level:a.level,kind}))continue;
   const res=await residencesFor(u,org,pids);if(!res.length)continue;
   const last=await get("SELECT MAX(sent_at) at FROM weather_alert_notifications WHERE weather_alert_id=? AND user_id=? AND channel='email'",alertId,u.id);
   if(W.throttled(kind,last?.at))continue;
   const emailId='weather:'+digest(`${org}:${alertId}:${u.id}:${kind}`);
   const ins=await run('INSERT INTO weather_alert_notifications(id,organization_id,weather_alert_id,user_id,channel,kind,sent_at,email_log_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(weather_alert_id,user_id,channel,kind) DO NOTHING',id(),org,alertId,u.id,'email',kind,now(),demo?null:emailId);
   if((ins.changes||0)!==1||demo)continue;
   const m=W.renderAlertEmail({kind,company,event_name:a.event_name,headline:a.headline,onset_at:a.onset_at,ends_at:a.ends_at,timezone:tz,total:res.length,residences:res,viewLink:`${origin()}/app#weather/${a.id}`,stormLink:u.role==='admin'?`${origin()}/app#weather/${a.id}`:'',attribution:W.attribution(['nws'])});
   await run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,html,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',emailId,org,u.id,u.email,m.subject,m.text,m.html,now(),now());
   sent++;
  }
  await run('UPDATE weather_alerts SET notified_count=? WHERE id=?',pids.length,alertId);
  return sent;
 }
 function localClock(tz,at=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(p=>[p.type,p.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
 }
 async function digestJob({force}){
  const orgs=await all('SELECT organization_id FROM weather_settings WHERE enabled=1');let sent=0;
  for(const {organization_id:org} of orgs){
   const s=await settingsFor(org),tz=await companyTz(org),clock=localClock(tz);
   if(!force&&(clock.time<s.digest_time||s.last_digest_day===clock.day))continue;
   if(!force){const claim=await run('UPDATE weather_settings SET last_digest_day=? WHERE organization_id=? AND (last_digest_day IS NULL OR last_digest_day<>?)',clock.day,org,clock.day);if((claim.changes||0)!==1)continue;}
   const rows=(await all("SELECT * FROM weather_alerts WHERE organization_id=? AND status='active'",org)).filter(a=>!(a.source==='nws'&&a.level==='warning')&&!(a.source==='nws'&&a.level==='watch'&&s.watch_immediate));
   if(!rows.length)continue;
   const demo=await get('SELECT organization_id FROM demo_workspaces WHERE organization_id=?',org),company=await companyName(org);
   const pidsBy=new Map();for(const a of rows)pidsBy.set(a.id,(await all('SELECT property_id FROM weather_alert_residences WHERE weather_alert_id=? AND active=1',a.id)).map(r=>r.property_id));
   for(const u of await recipients(org,s,[...new Set([...pidsBy.values()].flat())])){
    if(!W.wantsEmail(await emailPref(u.id),{level:'watch',kind:'digest'}))continue;
    const items=[];
    for(const a of rows){
     const res=await residencesFor(u,org,pidsBy.get(a.id)||[]);if(!res.length)continue;
     const ins=await run('INSERT INTO weather_alert_notifications(id,organization_id,weather_alert_id,user_id,channel,kind,sent_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(weather_alert_id,user_id,channel,kind) DO NOTHING',id(),org,a.id,u.id,'email','digest',now());
     if((ins.changes||0)!==1)continue;
     const fs=parse(a.forecast_summary,null);
     items.push({title:a.source==='forecast'&&fs?W.forecastRange(fs):a.event_name,total:res.length,residences:res,when:a.source==='forecast'?'':W.timeframe(a,tz)});
    }
    if(!items.length||demo)continue;
    const m=W.renderDigestEmail({company,items,viewLink:`${origin()}/app#weather`,attribution:W.attribution(['nws',...(rows.some(a=>a.source==='forecast')&&provider.name==='open_meteo'?['open_meteo']:[])])});
    await run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,html,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING','weather-digest:'+digest(`${org}:${u.id}:${clock.day}`),org,u.id,u.email,m.subject,m.text,m.html,now(),now());
    sent++;
   }
  }
  return {seen:sent};
 }

 // ---------- pilot ----------
 /** FEATURE_PILOT_COMPANIES (staging): platform_owner, demo_company or company ids. Turns the flag on once per company. */
 async function applyPilots(){
  const tokens=String(env.FEATURE_PILOT_COMPANIES||'').split(',').map(t=>t.trim()).filter(Boolean);if(!tokens.length)return [];
  const orgs=new Set();
  for(const t of tokens){
   if(t==='platform_owner'){if(env.ESTATEOS_PLATFORM_OWNER_ID){const u=await get('SELECT organization_id FROM users WHERE id=?',env.ESTATEOS_PLATFORM_OWNER_ID);if(u)orgs.add(u.organization_id);}}
   else if(t==='demo_company'){const o=await get("SELECT id FROM organizations WHERE name='EstateOS Demo Company'");if(o)orgs.add(o.id);}
   else{const o=await get('SELECT id FROM organizations WHERE id=?',t);if(o)orgs.add(o.id);}
  }
  const applied=[];
  for(const org of orgs){
   const ins=await run("INSERT INTO feature_pilots(organization_id,feature,applied_at) VALUES(?,'weather_alerts',?) ON CONFLICT(organization_id,feature) DO NOTHING",org,now());
   if((ins.changes||0)!==1)continue;
   await run('INSERT INTO weather_settings(organization_id,enabled,updated_at) VALUES(?,1,?) ON CONFLICT(organization_id) DO UPDATE SET enabled=1,updated_at=excluded.updated_at',org,now());
   applied.push(org);
  }
  if(applied.length)log.log(`Weather alerts pilot turned on for ${applied.length} compan${applied.length===1?'y':'ies'}.`);
  return applied;
 }

 // ---------- cron ----------
 function secretOk(given){
  const want=String(env.CRON_SECRET||'');if(want.length<16||!given)return false;
  return timingSafeEqual(createHash('sha256').update(String(given)).digest(),createHash('sha256').update(want).digest());
 }
 /** POST /api/internal/cron/weather {job} with X-Cron-Secret. Routed before the session and Origin checks. */
 async function cron(req,res,url){
  if(url.pathname!=='/api/internal/cron/weather')return false;
  if(req.method!=='POST')fail(405,'Use POST.');
  if(!secretOk(req.headers['x-cron-secret']))fail(401,'Not authorized.');
  let raw='';for await(const c of req){raw+=c;if(raw.length>4096)fail(413,'Request too large.');}
  let b={};try{b=raw?JSON.parse(raw):{};}catch{fail(400,'Send JSON like {"job":"alerts"}.');}
  const job=b.job?String(b.job):'all';
  if(job!=='all'&&!JOBS[job])fail(422,'Unknown weather job.');
  const results=[];
  for(const j of job==='all'?['points','alerts','forecast','digest']:[job])results.push(await runJob(j,{force:job==='digest'}));
  json(res,200,{results});return true;
 }

 // ---------- health ----------
 async function health(user){
  roles(user,'admin');
  const s=await settingsFor(user.organization_id),org=user.organization_id;
  const active=(await get("SELECT COUNT(*) n FROM weather_alerts WHERE organization_id=? AND status IN ('active','dismissed')",org))?.n||0;
  const out={enabled:s.enabled,jobsEnabled:jobsEnabled(),provider:provider.name,coverage:await coverage(org),activeAlerts:Number(active),lastRuns:{}};
  for(const job of Object.keys(JOBS)){const r=await get('SELECT started_at,finished_at,status FROM weather_job_runs WHERE job=? ORDER BY started_at DESC LIMIT 1',job);out.lastRuns[job]=r||null;}
  if(platformOwner(user))out.platform={customUserAgent:!!env.NWS_USER_AGENT,cronSecretSet:String(env.CRON_SECRET||'').length>=16,companies:Number((await get('SELECT COUNT(*) n FROM weather_settings WHERE enabled=1'))?.n||0),runs:(await all('SELECT job,started_at,finished_at,status,requests,alerts_seen,errors FROM weather_job_runs ORDER BY started_at DESC LIMIT 40')).map(r=>({...r,errors:parse(r.errors,[])}))};
  return out;
 }

 // ---------- residence ----------
 async function residenceWeather(user,propertyId){
  roles(user,'admin','employee');
  const p=await property(user,String(propertyId),'read');
  const s=await settingsFor(user.organization_id),vv=await visitVerification.settings(user.organization_id),tz=visitVerification.timezoneFor(p,vv)||'America/New_York';
  const rows=await all("SELECT a.* FROM weather_alerts a JOIN weather_alert_residences r ON r.weather_alert_id=a.id WHERE r.property_id=? AND r.active=1 AND a.organization_id=? AND a.status IN ('active','dismissed')",p.id,user.organization_id);
  const alerts=await shapeAlerts(user,rows,tz);
  let days=[];
  for(const k of [`nws_grid:${p.nws_grid_id}/${p.nws_grid_x},${p.nws_grid_y}:${tz}`,`open_meteo:${W.round(num(p.latitude),2)},${W.round(num(p.longitude),2)}`]){const hit=await get('SELECT daily FROM forecast_cache WHERE cache_key=?',k);if(hit){days=parse(hit.daily,[]);break;}}
  const today=W.localDay(now(),tz);
  return {enabled:s.enabled,timezone:tz,monitoring:Number(p.weather_monitoring_enabled??1)===1,overrides:parse(p.weather_threshold_overrides,{})||{},thresholds:W.thresholdsFor(s,p.weather_threshold_overrides),
   hasCoordinates:W.validCoord(num(p.latitude),num(p.longitude)),nwsSupported:p.nws_supported==null?null:Number(p.nws_supported)===1,alerts,days:days.filter(d=>d.date>=today).slice(0,3)};
 }
 async function saveMonitoring(user,propertyId,b){
  roles(user,'admin');
  const p=await property(user,String(propertyId),'read');
  const set=[],args=[];let off=false;
  if(b.enabled!==undefined){const on=bool(b.enabled,'Weather monitoring');off=!on;set.push('weather_monitoring_enabled=?');args.push(on?1:0);}
  if(b.overrides!==undefined){
   if(b.overrides!==null&&(typeof b.overrides!=='object'||Array.isArray(b.overrides)))fail(422,'Send threshold overrides as an object.');
   const labels={freeze_threshold_f:['Hard freeze','°F'],freeze_notice_f:['Freeze notice','°F'],heat_threshold_f:['Extreme heat','°F'],heavy_rain_in:['Heavy rain','inches'],high_wind_gust_mph:['High wind gusts','mph']},o={};
   for(const [k,v] of Object.entries(b.overrides||{})){if(!labels[k])fail(422,'Unknown threshold.');if(v===null||v==='')continue;o[k]=inRange(v,k,...labels[k]);}
   set.push('weather_threshold_overrides=?');args.push(Object.keys(o).length?JSON.stringify(o):null);
  }
  if(!set.length)fail(422,'Choose what to change.');
  await run(`UPDATE properties SET ${set.join(',')} WHERE id=? AND organization_id=?`,...args,p.id,user.organization_id);
  if(off)await run('UPDATE weather_alert_residences SET active=0 WHERE property_id=? AND organization_id=?',p.id,user.organization_id);
  await audit(user,'weather.residence_updated',p.id);
  return residenceWeather(user,p.id);
 }

 // ---------- routes ----------
 const ALERT=/^\/api\/weather\/alerts\/([^/]+)(?:\/(acknowledge|dismiss|start-storm-event|add-to-storm))?$/;
 const RES=/^\/api\/weather\/residences\/([^/]+)(\/monitoring)?$/;
 const INSP=/^\/api\/inspections\/([^/]+)\/weather$/;
 async function handle(req,res,url,user){
  const p=url.pathname,method=req.method;
  if(!p.startsWith('/api/weather/')&&p!=='/api/weather'&&p!=='/api/settings/weather'&&!INSP.test(p))return false;
  if(!user)fail(401,'Please sign in.');
  if(p==='/api/settings/weather'){
   roles(user,'admin');
   if(method==='GET')return json(res,200,await settingsOut(user)),true;
   if(method==='POST'||method==='PUT')return json(res,200,await saveSettings(user,await body(req))),true;
   return false;
  }
  const im=p.match(INSP);
  if(im){if(method!=='POST'&&method!=='PUT')return false;return json(res,200,await editSnapshot(user,decodeURIComponent(im[1]),await body(req))),true;}
  if(p==='/api/weather/preferences'&&method==='POST'){
   roles(user,'admin','employee');const b=await body(req);if(!EMAIL_PREFS.includes(b.emailPref))fail(422,'Choose All, Warnings only or None.');
   await run('INSERT INTO weather_user_prefs(user_id,organization_id,email_pref,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_pref=excluded.email_pref,updated_at=excluded.updated_at',user.id,user.organization_id,b.emailPref,now());
   return json(res,200,{emailPref:b.emailPref}),true;
  }
  if(p==='/api/weather/alerts'&&method==='GET'){roles(user,'admin','employee');const status=url.searchParams.get('status')==='recent'?'recent':'active';return json(res,200,{alerts:await listAlerts(user,status),canManage:user.role==='admin',timezone:await companyTz(user.organization_id)}),true;}
  if(p==='/api/weather/coverage'&&method==='GET'){roles(user,'admin');return json(res,200,{coverage:await coverage(user.organization_id)}),true;}
  if(p==='/api/weather/coverage/geocode-missing'&&method==='POST'){
   roles(user,'admin');
   if(!env.GEOAPIFY_API_KEY)fail(409,'Address lookup is not set up on this server, so set these residences\u2019 locations on each residence page.');
   const done=await visitVerification.geocodePending(25);await audit(user,'weather.geocode_requested',user.organization_id);
   return json(res,200,{geocoded:done,coverage:await coverage(user.organization_id)}),true;
  }
  if(p==='/api/weather/health'&&method==='GET')return json(res,200,await health(user)),true;
  const am=p.match(ALERT);
  if(am){
   const alertId=decodeURIComponent(am[1]),sub=am[2]||'';
   if(!sub&&method==='GET')return json(res,200,await alertDetail(user,alertId)),true;
   if(method!=='POST'||!sub)return false;
   const b=await body(req);
   if(sub==='acknowledge'){const {a}=await alertFor(user,alertId);if(!a.acknowledged_at){await run('UPDATE weather_alerts SET acknowledged_by=?,acknowledged_at=?,updated_at=? WHERE id=? AND acknowledged_at IS NULL',user.id,now(),now(),a.id);await audit(user,'weather.acknowledged',a.id);}return json(res,200,await alertDetail(user,a.id)),true;}
   if(sub==='dismiss'){roles(user,'admin');const {a}=await alertFor(user,alertId);if(!['active','dismissed'].includes(a.status))fail(409,'This alert has already ended.');const reason=String(b.reason??'').trim().slice(0,500);await run("UPDATE weather_alerts SET status='dismissed',dismissed_by=?,dismissed_at=?,dismiss_reason=?,updated_at=? WHERE id=?",user.id,now(),reason,now(),a.id);await audit(user,'weather.dismissed',a.id);return json(res,200,await alertDetail(user,a.id)),true;}
   if(sub==='start-storm-event')return json(res,200,await startStorm(user,alertId,b)),true;
   if(sub==='add-to-storm')return json(res,200,await addToStorm(user,alertId,b)),true;
  }
  const rm=p.match(RES);
  if(rm){const pid=decodeURIComponent(rm[1]);if(!rm[2]&&method==='GET')return json(res,200,await residenceWeather(user,pid)),true;if(rm[2]&&method==='POST')return json(res,200,await saveMonitoring(user,pid,await body(req))),true;}
  return false;
 }

 return {handle,cron,decorate,tick,runJob,applyPilots,captureSnapshot,captureLater,extendReports,hookCheckIn,settingsFor,coverage,provider};
}
