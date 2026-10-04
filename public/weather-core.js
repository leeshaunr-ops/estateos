/* Severe-weather alert rules (no DOM, no network): NWS event categories and levels (including renamed products),
   point-in-polygon and zone matching, grouping and de-duplication of alerts into one record per event per company,
   forecast thresholds, unit conversions, plain-language lines, time labels with zone abbreviations and staff emails.
   Loaded in the browser as window.EAWeather and in Node (server and tests) via import (sets globalThis.EAWeather). */
(function(root,factory){const api=factory();if(typeof module==='object'&&module&&module.exports)module.exports=api;root.EAWeather=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 // ---- categories (one config; edit here to adjust) ----
 const CATEGORIES={
  tropical:{label:'Hurricanes & tropical storms',noun:'tropical weather'},
  winter:{label:'Winter storms & hard freezes',noun:'winter weather'},
  flood:{label:'Floods',noun:'flooding'},
  severe:{label:'Severe thunderstorms & tornadoes',noun:'severe storms'},
  wind:{label:'High wind',noun:'high wind'},
  heat:{label:'Extreme heat',noun:'extreme heat'},
  fire:{label:'Wildfire & smoke',noun:'fire weather'}
 };
 const CATEGORY_KEYS=Object.keys(CATEGORIES);
 // NWS event names (lower case) -> category. Old and new product names are both listed: NWS renamed "Excessive Heat"
 // to "Extreme Heat" and "Wind Chill" to "Extreme Cold".
 const EVENTS={
  tropical:['hurricane warning','hurricane watch','tropical storm warning','tropical storm watch','storm surge warning','storm surge watch','extreme wind warning','typhoon warning','typhoon watch','hurricane force wind warning'],
  winter:['winter storm warning','winter storm watch','blizzard warning','blizzard watch','ice storm warning','lake effect snow warning','hard freeze warning','hard freeze watch','freeze warning','freeze watch','extreme cold warning','extreme cold watch','wind chill warning','wind chill watch','winter weather advisory','frost advisory','cold weather advisory','wind chill advisory'],
  flood:['flash flood warning','flash flood watch','flood warning','flood watch','coastal flood warning','coastal flood watch','lakeshore flood warning','lakeshore flood watch','flood advisory','coastal flood advisory'],
  severe:['tornado warning','tornado watch','severe thunderstorm warning','severe thunderstorm watch'],
  wind:['high wind warning','high wind watch','wind advisory'],
  heat:['extreme heat warning','extreme heat watch','excessive heat warning','excessive heat watch','heat advisory'],
  fire:['red flag warning','fire weather watch','fire warning','evacuation immediate','air quality alert','dense smoke advisory']
 };
 const EVENT_CATEGORY=new Map();for(const [c,list] of Object.entries(EVENTS))for(const e of list)EVENT_CATEGORY.set(e,c);
 const LEVELS={warning:'Warning',watch:'Watch',advisory:'Advisory',forecast:'Forecast',statement:'Statement'};
 const norm=s=>String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
 function categoryOf(event){return EVENT_CATEGORY.get(norm(event))||null;}
 function levelOf(event){const e=norm(event);if(e==='evacuation immediate'||e==='fire warning')return 'warning';if(e==='air quality alert')return 'advisory';if(/ warning$/.test(e))return 'warning';if(/ watch$/.test(e))return 'watch';if(/ advisory$/.test(e))return 'advisory';if(/ statement$/.test(e))return 'statement';return 'advisory';}
 /** The hazard an event names, without its level ("Winter Storm Warning" -> "winter storm"). */
 const hazardOf=event=>norm(event).replace(/ (warning|watch|advisory|statement)$/,'');
 /** Storm workflow type to pre-fill when an alert is handed off. */
 function stormTypeFor(category,event){const e=norm(event);
  if(category==='tropical')return /tropical storm/.test(e)?'tropical_storm':'hurricane';
  if(category==='winter')return /freeze|frost|extreme cold|wind chill|cold weather/.test(e)?'freeze':'winter_storm';
  return {flood:'flood',severe:'severe_storm',heat:'extreme_heat',fire:'wildfire',wind:'other'}[category]||'other';}
 const LEVEL_RANK={warning:400,watch:300,forecast:200,advisory:100,statement:0};
 const CATEGORY_RANK={tropical:60,severe:55,fire:50,flood:45,winter:40,heat:35,wind:30};
 function severityRank(level,category,event){const e=norm(event);return (LEVEL_RANK[level]||0)+(CATEGORY_RANK[category]||0)+(/tornado warning|extreme wind warning|evacuation immediate|hurricane warning/.test(e)?30:0);}

 // ---- geometry ----
 const round=(v,d)=>{const f=10**d;return Math.round(Number(v)*f)/f;};
 const validCoord=(lat,lon)=>Number.isFinite(Number(lat))&&Number.isFinite(Number(lon))&&Math.abs(lat)<=90&&Math.abs(lon)<=180&&lat!==null&&lon!==null;
 function onSegment(px,py,ax,ay,bx,by){const cross=(px-ax)*(by-ay)-(py-ay)*(bx-ax);if(Math.abs(cross)>1e-9)return false;return px>=Math.min(ax,bx)-1e-12&&px<=Math.max(ax,bx)+1e-12&&py>=Math.min(ay,by)-1e-12&&py<=Math.max(ay,by)+1e-12;}
 /** -1 outside, 0 on the edge, 1 inside. Ring of [lon,lat] pairs (GeoJSON order). */
 function inRing(lon,lat,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if(onSegment(lon,lat,xi,yi,xj,yj))return 0;if(((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/(yj-yi)+xi))inside=!inside;}return inside?1:-1;}
 function inPolygon(lon,lat,rings){if(!Array.isArray(rings)||!rings.length)return false;const outer=inRing(lon,lat,rings[0]);if(outer<0)return false;if(outer===0)return true;for(const hole of rings.slice(1)){const h=inRing(lon,lat,hole);if(h>0)return false;}return true;}
 /** True when the residence point is inside (or on the edge of) a GeoJSON Polygon or MultiPolygon. */
 function pointInGeometry(lat,lon,geometry){if(!geometry||!validCoord(lat,lon))return false;if(geometry.type==='Polygon')return inPolygon(Number(lon),Number(lat),geometry.coordinates);if(geometry.type==='MultiPolygon')return (geometry.coordinates||[]).some(p=>inPolygon(Number(lon),Number(lat),p));if(geometry.type==='GeometryCollection')return (geometry.geometries||[]).some(g=>pointInGeometry(lat,lon,g));return false;}
 const zonesOf=p=>[p.nws_forecast_zone,p.nws_county_zone,p.nws_fire_zone].filter(Boolean).map(z=>String(z).toUpperCase());
 /** How an alert matches a residence: 'polygon', 'zone', or null. Storm-based warnings carry a polygon; others use UGC zones. */
 function matchResidence(alert,p){if(alert.geometry)return pointInGeometry(p.latitude,p.longitude,alert.geometry)?'polygon':null;const ugc=new Set((alert.ugc||[]).map(z=>String(z).toUpperCase()));return zonesOf(p).some(z=>ugc.has(z))?'zone':null;}

 // ---- time ----
 const clean=s=>String(s).replace(/[\u202f\u00a0]/g,' ');
 function fmt(iso,tz,opts){if(!iso)return '';const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';try{return clean(d.toLocaleString('en-US',{timeZone:tz||'America/New_York',...opts}));}catch{return clean(d.toLocaleString('en-US',{timeZone:'America/New_York',...opts}));}}
 /** "Tue 6:00 PM EST" */
 const shortWhen=(iso,tz)=>fmt(iso,tz,{weekday:'short',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).replace(',','');
 /** "Tue, Dec 22, 6:00 PM EST" */
 const longWhen=(iso,tz)=>fmt(iso,tz,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 function localDay(iso,tz){if(!iso)return '';const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';try{return d.toLocaleDateString('en-CA',{timeZone:tz||'America/New_York'});}catch{return d.toISOString().slice(0,10);}}
 const dayName=(day,style='short')=>/^\d{4}-\d{2}-\d{2}$/.test(String(day||''))?new Date(day+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:style}):'';
 const addDays=(day,n)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 function partOfDay(iso,tz){const h=Number(fmt(iso,tz,{hour:'numeric',hourCycle:'h23'}));if(!Number.isFinite(h))return '';return h<5?'night':h<12?'morning':h<17?'afternoon':h<21?'evening':'night';}
 /** "until Tue 6:00 PM EST" / "from Mon 5:00 AM EST" / "" */
 function timeframe(a,tz){if(a.source==='forecast'&&a.forecast_summary)return forecastRange(a.forecast_summary);if(a.ends_at)return 'until '+shortWhen(a.ends_at,tz);if(a.onset_at&&Date.parse(a.onset_at)>Date.now())return 'from '+shortWhen(a.onset_at,tz);return '';}

 // ---- grouping of NWS alerts into one record per event per company ----
 const t=v=>{const n=Date.parse(v||'');return Number.isFinite(n)?n:null;};
 function overlaps(aStart,aEnd,bStart,bEnd){const as=t(aStart)??-Infinity,ae=t(aEnd)??Infinity,bs=t(bStart)??-Infinity,be=t(bEnd)??Infinity;return as<=be&&bs<=ae;}
 const minIso=(a,b)=>!a?b:!b?a:(t(a)<=t(b)?a:b),maxIso=(a,b)=>!a?b:!b?a:(t(a)>=t(b)?a:b);
 /**
  * Reconcile a company's live NWS groups with the currently active, matched alerts.
  * groups: [{id,event_name,level,category,status:'active'|'dismissed',onset_at,ends_at,nws_alert_ids,cancelled_ids,residences:[ids],notified_count,group_key}]
  * alerts: [{id,event,level,category,onset_at,ends_at,refs,residences:[{property_id,matched_by}],headline,severity}] (active, Actual, not cancelled)
  * cancelled: ids referenced by Cancel messages.  Returns {groups, events:[{type,group}]} where new groups have id null.
  */
 function reconcileNws({groups=[],alerts=[],cancelled=[],timezone='America/New_York',now=new Date().toISOString()}){
  const live=groups.filter(g=>['active','dismissed'].includes(g.status)).map(g=>({...g,nws_alert_ids:[...(g.nws_alert_ids||[])],cancelled_ids:[...(g.cancelled_ids||[])],previousResidences:[...(g.residences||[])],residences:[],members:new Map(),changed:false,isNew:false}));
  // Watch groups ended by an upgrade keep absorbing their own (still active) watch alerts, so they never come back.
  const absorbers=groups.filter(g=>g.status==='ended'&&g.superseded).map(g=>({...g,nws_alert_ids:[...(g.nws_alert_ids||[])],absorbed:false}));
  const cancelledSet=new Set(cancelled),events=[];
  const sorted=[...alerts].sort((a,b)=>(LEVEL_RANK[a.level]||0)-(LEVEL_RANK[b.level]||0)||(t(a.onset_at)??0)-(t(b.onset_at)??0)||String(a.id).localeCompare(String(b.id)));
  const isLive=g=>['active','dismissed'].includes(g.status);
  for(const alert of sorted){
   const refs=new Set(alert.refs||[]);
   let target=live.find(g=>isLive(g)&&(g.nws_alert_ids.includes(alert.id)||g.nws_alert_ids.some(id=>refs.has(id))));
   if(!target)target=live.find(g=>isLive(g)&&norm(g.event_name)===norm(alert.event)&&overlaps(g.onset_at,g.ends_at,alert.onset_at,alert.ends_at));
   if(!target){const old=absorbers.find(g=>g.nws_alert_ids.includes(alert.id)||g.nws_alert_ids.some(id=>refs.has(id))||(norm(g.event_name)===norm(alert.event)&&overlaps(g.onset_at,g.ends_at,alert.onset_at,alert.ends_at)));
    if(old){old.nws_alert_ids=[...new Set([...old.nws_alert_ids.filter(id=>!refs.has(id)),alert.id])];old.absorbed=true;continue;}}
   if(!target){
    const day=localDay(alert.onset_at||alert.sent_at||now,timezone);
    target={id:null,group_key:`nws:${norm(alert.event)}:${day}`,event_name:alert.event,level:alert.level,category:alert.category,status:'active',onset_at:alert.onset_at||null,ends_at:alert.ends_at||null,nws_alert_ids:[],cancelled_ids:[],previousResidences:[],residences:[],members:new Map(),notified_count:0,supersedes_alert_id:null,isNew:true,changed:true};
    if(alert.level==='warning'){
     const ids=new Set(alert.residences.map(r=>r.property_id));
     const watch=live.find(g=>isLive(g)&&g.level==='watch'&&hazardOf(g.event_name)===hazardOf(alert.event))||live.find(g=>isLive(g)&&g.level==='watch'&&g.category===alert.category&&g.previousResidences.concat(g.residences).some(id=>ids.has(id)));
     if(watch){target.supersedes_alert_id=watch.id;target.supersedesRef=watch;watch.status='ended';watch.endReason='upgraded';watch.changed=true;}
    }
    live.push(target);events.push({type:target.supersedesRef?'upgraded':'new',group:target});
   }
   target.nws_alert_ids=target.nws_alert_ids.filter(id=>!refs.has(id));
   if(!target.nws_alert_ids.includes(alert.id)){target.nws_alert_ids.push(alert.id);target.changed=true;}
   target.members.set(alert.id,alert);
  }
  const activeIds=new Set(alerts.map(a=>a.id));
  for(const g of live){
   if(g.keepEnded)continue;
   if(g.status==='ended'&&g.endReason==='upgraded'){g.ended_at=now;continue;}
   const before=g.nws_alert_ids.length;
   const gone=g.nws_alert_ids.filter(id=>!activeIds.has(id));
   for(const id of gone)if(cancelledSet.has(id)&&!g.cancelled_ids.includes(id))g.cancelled_ids.push(id);
   g.nws_alert_ids=g.nws_alert_ids.filter(id=>activeIds.has(id));
   if(g.nws_alert_ids.length!==before)g.changed=true;
   if(!g.nws_alert_ids.length){g.status=g.cancelled_ids.length&&gone.every(id=>cancelledSet.has(id))?'cancelled':'ended';g.ended_at=now;g.changed=true;continue;}
   const members=g.nws_alert_ids.map(id=>g.members.get(id)||alerts.find(a=>a.id===id)).filter(Boolean);
   const res=new Map();for(const m of members)for(const r of m.residences)if(!res.has(r.property_id))res.set(r.property_id,r.matched_by);
   g.residenceMatches=res;g.residences=[...res.keys()];
   let onset=null,ends=null,best=null;for(const m of members){onset=minIso(onset,m.onset_at);ends=maxIso(ends,m.ends_at);if(!best||(t(m.sent_at)??0)>=(t(best.sent_at)??0))best=m;}
   if(onset!==g.onset_at||ends!==g.ends_at)g.changed=true;
   g.onset_at=onset;g.ends_at=ends;g.headline=best?.headline||g.headline||'';
   const prevSet=new Set(g.previousResidences);if(g.residences.length!==prevSet.size||g.residences.some(id=>!prevSet.has(id)))g.changed=true;
   if(!g.isNew&&g.level==='warning'){const base=Number(g.notified_count)||0;if(base&&g.residences.length>=base+Math.max(3,Math.ceil(base*.25)))events.push({type:'expanded',group:g});}
  }
  for(const a of absorbers){const next=a.nws_alert_ids.filter(id=>activeIds.has(id));if(next.length!==(a.nws_alert_ids||[]).length||a.absorbed){a.changed=JSON.stringify(next)!==JSON.stringify((groups.find(g=>g.id===a.id)||{}).nws_alert_ids||[]);a.nws_alert_ids=next;if(a.changed)live.push({...a,status:'ended',keepEnded:true,residences:[...(a.residences||[])],previousResidences:[...(a.residences||[])],members:new Map()});}}
  return {groups:live,events};
 }

 // ---- forecast thresholds ----
 const THRESHOLD_KINDS={
  hard_freeze:{category:'winter',label:'Hard freeze',event:'Hard freeze forecast',unit:'°F',field:'min_f',word:'low'},
  freeze_notice:{category:'winter',label:'Freeze',event:'Freeze forecast',unit:'°F',field:'min_f',word:'low'},
  extreme_heat:{category:'heat',label:'Extreme heat',event:'Extreme heat forecast',unit:'°F',field:'feels_max_f',word:'feels like'},
  heavy_rain:{category:'flood',label:'Heavy rain',event:'Heavy rain forecast',unit:'in',field:'precip_in',word:'rain'},
  high_wind:{category:'wind',label:'High wind',event:'High wind forecast',unit:'mph',field:'gust_mph',word:'gusts'}
 };
 const DEFAULTS={freeze_threshold_f:28,freeze_notice_f:null,heat_threshold_f:105,heavy_rain_in:2.0,high_wind_gust_mph:50,forecast_lookahead_days:3};
 const LIMITS={freeze_threshold_f:[-20,40],freeze_notice_f:[-20,40],heat_threshold_f:[80,130],heavy_rain_in:[.5,10],high_wind_gust_mph:[20,120],forecast_lookahead_days:[1,7]};
 /** Company thresholds with a residence's overrides applied (only known keys, only valid numbers). */
 function thresholdsFor(company={},overrides=null){const out={};for(const k of Object.keys(DEFAULTS)){const v=company[k];out[k]=v===null||v===undefined||v===''?DEFAULTS[k]:Number(v);}
  let o=overrides;if(typeof o==='string'){try{o=JSON.parse(o);}catch{o=null;}}
  if(o&&typeof o==='object')for(const k of ['freeze_threshold_f','freeze_notice_f','heat_threshold_f','heavy_rain_in','high_wind_gust_mph'])if(o[k]!==undefined&&o[k]!==null&&o[k]!==''&&Number.isFinite(Number(o[k])))out[k]=Number(o[k]);
  return out;}
 /** Qualifying days within the lookahead, starting at `today` (residence-local YYYY-MM-DD). */
 function thresholdHits(days,thresholds,{today,categories=CATEGORY_KEYS}={}){
  const end=addDays(today,Math.max(1,Math.min(7,thresholds.forecast_lookahead_days||3))-1),on=new Set(categories),hits=[];
  for(const d of days||[]){if(!d||d.date<today||d.date>end)continue;
   if(on.has('winter')&&d.min_f!=null){if(d.min_f<=thresholds.freeze_threshold_f)hits.push({date:d.date,kind:'hard_freeze',value:d.min_f});else if(thresholds.freeze_notice_f!=null&&d.min_f<=thresholds.freeze_notice_f)hits.push({date:d.date,kind:'freeze_notice',value:d.min_f});}
   if(on.has('heat')&&d.feels_max_f!=null&&d.feels_max_f>=thresholds.heat_threshold_f)hits.push({date:d.date,kind:'extreme_heat',value:d.feels_max_f});
   if(on.has('flood')&&d.precip_in!=null&&d.precip_in>=thresholds.heavy_rain_in)hits.push({date:d.date,kind:'heavy_rain',value:d.precip_in});
   if(on.has('wind')&&d.gust_mph!=null&&d.gust_mph>=thresholds.high_wind_gust_mph)hits.push({date:d.date,kind:'high_wind',value:d.gust_mph});
  }
  return hits;}
 /** Consecutive qualifying days of one kind merge into one run: {kind,start,end,min,max,days}. */
 function mergeRuns(hits){const byKind=new Map();for(const h of [...hits].sort((a,b)=>a.kind.localeCompare(b.kind)||a.date.localeCompare(b.date))){const list=byKind.get(h.kind)||[];const last=list[list.length-1];if(last&&addDays(last.end,1)===h.date){last.end=h.date;last.min=Math.min(last.min,h.value);last.max=Math.max(last.max,h.value);last.days++;}else list.push({kind:h.kind,start:h.date,end:h.date,min:h.value,max:h.value,days:1});byKind.set(h.kind,list);}return [...byKind.values()].flat();}
 const num=(v,unit)=>unit==='in'?Number(v).toFixed(1):String(Math.round(Number(v)));
 function valueRange(kind,min,max){const k=THRESHOLD_KINDS[kind];const word={hard_freeze:'lows',freeze_notice:'lows',extreme_heat:'feels like',heavy_rain:'rain up to',high_wind:'gusts up to'}[kind];
  if(kind==='heavy_rain'||kind==='high_wind')return `${word} ${num(max,k.unit)} ${k.unit}`;
  if(kind==='extreme_heat')return min===max?`${word} ${num(max,k.unit)} ${k.unit}`:`${word} ${num(min,k.unit)}–${num(max,k.unit)} ${k.unit}`;
  return min===max?`${word==='lows'?'low':word} ${num(min,k.unit)} ${k.unit}`:`${word} ${num(min,k.unit)}–${num(max,k.unit)} ${k.unit}`;}
 /** "Hard freeze Tue–Thu, lows 19–24 °F" */
 function forecastRange(s){if(!s)return '';const k=THRESHOLD_KINDS[s.kind];if(!k)return '';const days=s.start===s.end?dayName(s.start):`${dayName(s.start)}–${dayName(s.end)}`;return `${k.label} ${days}, ${valueRange(s.kind,s.min,s.max)}`;}
 /** Residence badge for a forecast hit: "Hard freeze Tue (low 24 °F)". */
 function forecastBadge(kind,day,value){const k=THRESHOLD_KINDS[kind];if(!k)return '';const v=`${num(value,k.unit)} ${k.unit}`;return `${k.label} ${dayName(day)} (${k.word} ${v})`;}
 /**
  * Plan forecast groups for a company. runs: [{property_id,kind,start,end,min,max}] (one per residence and run);
  * covered(property_id,category,start,end) -> true when an NWS group of the same category already covers it.
  * groups: live forecast groups [{id,group_key,forecast_summary,status,residences}]. Returns {groups, events}.
  */
 function planForecast({groups=[],runs=[],covered=()=>false,now=new Date().toISOString()}){
  const live=groups.filter(g=>['active','dismissed'].includes(g.status)).map(g=>({...g,forecast_summary:typeof g.forecast_summary==='string'?JSON.parse(g.forecast_summary||'null'):g.forecast_summary,previousResidences:[...(g.residences||[])],residences:[],values:new Map(),touched:false,isNew:false,changed:false}));
  const events=[];
  for(const r of [...runs].sort((a,b)=>a.start.localeCompare(b.start)||String(a.property_id).localeCompare(String(b.property_id)))){
   const k=THRESHOLD_KINDS[r.kind];if(!k)continue;
   if(covered(r.property_id,k.category,r.start,r.end))continue;
   let g=live.find(x=>x.forecast_summary?.kind===r.kind&&x.forecast_summary.start<=r.end&&r.start<=x.forecast_summary.end);
   if(!g){g={id:null,group_key:`forecast:${r.kind}:${r.start}`,source:'forecast',category:k.category,level:r.kind==='freeze_notice'?'advisory':'forecast',event_name:k.event,status:'active',forecast_summary:{kind:r.kind,start:r.start,end:r.end,min:r.min,max:r.max,unit:k.unit},previousResidences:[],residences:[],values:new Map(),isNew:true,changed:true,touched:false};live.push(g);events.push({type:'new',group:g});}
   if(!g.touched){g.touched=true;g.next={kind:r.kind,start:r.start,end:r.end,min:r.min,max:r.max,unit:k.unit};}
   else{g.next.start=g.next.start<r.start?g.next.start:r.start;g.next.end=g.next.end>r.end?g.next.end:r.end;g.next.min=Math.min(g.next.min,r.min);g.next.max=Math.max(g.next.max,r.max);}
   if(!g.residences.includes(r.property_id))g.residences.push(r.property_id);
   const val=k.field==='min_f'?r.min:r.max;g.values.set(r.property_id,{value:val,unit:k.unit,day:k.field==='min_f'?r.start:r.start});
  }
  for(const g of live){
   if(!g.touched){g.status='ended';g.ended_at=now;g.changed=true;continue;}
   if(JSON.stringify(g.next)!==JSON.stringify(g.forecast_summary))g.changed=true;
   g.forecast_summary=g.next;g.onset_at=g.next.start+'T00:00:00.000Z';g.ends_at=null;g.headline=forecastRange(g.next);
   const prev=new Set(g.previousResidences);if(g.residences.length!==prev.size||g.residences.some(id=>!prev.has(id)))g.changed=true;
  }
  return {groups:live,events};
 }

 // ---- units ----
 const cToF=c=>c*9/5+32,mmToIn=mm=>mm/25.4,kmhToMph=k=>k/1.609344,msToMph=m=>m*2.2369363;
 function toF(value,uom){if(value==null)return null;return /degF/.test(uom||'')?Number(value):cToF(Number(value));}
 function toMph(value,uom){if(value==null)return null;const u=String(uom||'');if(/km_h/.test(u))return kmhToMph(Number(value));if(/m_s/.test(u))return msToMph(Number(value));if(/kt|knot/.test(u))return Number(value)*1.150779;return Number(value);}
 function toIn(value,uom){if(value==null)return null;const u=String(uom||'');if(/mm/.test(u))return mmToIn(Number(value));if(/cm/.test(u))return Number(value)/2.54;if(/\bm$|:m$/.test(u))return Number(value)*39.3701;return Number(value);}
 function isoDuration(s){const m=String(s||'').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);if(!m)return 3600000;return ((+m[1]||0)*24*3600+(+m[2]||0)*3600+(+m[3]||0)*60)*1000||3600000;}
 /** NWS raw gridpoint data -> residence-local daily values in °F, inches and mph. */
 function nwsGridDaily(props,tz){
  const days=new Map(),day=d=>{if(!days.has(d))days.set(d,{date:d,min_f:null,max_f:null,feels_max_f:null,precip_in:null,gust_mph:null});return days.get(d);};
  const each=(layer,fn)=>{for(const v of layer?.values||[]){if(v.value==null)continue;const [start,dur]=String(v.validTime).split('/');const s=Date.parse(start);if(!Number.isFinite(s))continue;fn(v.value,s,isoDuration(dur),layer.uom);}};
  each(props.minTemperature,(v,s,len,uom)=>{const d=day(localDay(new Date(s+len/2).toISOString(),tz)),f=toF(v,uom);d.min_f=d.min_f==null?f:Math.min(d.min_f,f);});
  each(props.maxTemperature,(v,s,len,uom)=>{const d=day(localDay(new Date(s+len/2).toISOString(),tz)),f=toF(v,uom);d.max_f=d.max_f==null?f:Math.max(d.max_f,f);});
  each(props.apparentTemperature,(v,s,len,uom)=>{const f=toF(v,uom);for(let x=s;x<s+len;x+=3600000){const d=day(localDay(new Date(x).toISOString(),tz));d.feels_max_f=d.feels_max_f==null?f:Math.max(d.feels_max_f,f);}});
  each(props.quantitativePrecipitation,(v,s,len,uom)=>{const d=day(localDay(new Date(s).toISOString(),tz));d.precip_in=(d.precip_in||0)+toIn(v,uom);});
  each(props.windGust,(v,s,len,uom)=>{const m=toMph(v,uom);for(let x=s;x<s+len;x+=3600000){const d=day(localDay(new Date(x).toISOString(),tz));d.gust_mph=d.gust_mph==null?m:Math.max(d.gust_mph,m);}});
  return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,min_f:r1(d.min_f),max_f:r1(d.max_f),feels_max_f:r1(d.feels_max_f),precip_in:d.precip_in==null?null:Math.round(d.precip_in*100)/100,gust_mph:r1(d.gust_mph)}));
 }
 const r1=v=>v==null?null:Math.round(v*10)/10;
 /** Open-Meteo daily block (fahrenheit/mph/inch units, timezone=auto, so dates are already residence-local). */
 function openMeteoDaily(daily){const d=daily||{};return (d.time||[]).map((date,i)=>({date,min_f:d.temperature_2m_min?.[i]??null,max_f:d.temperature_2m_max?.[i]??null,feels_max_f:d.apparent_temperature_max?.[i]??null,precip_in:d.precipitation_sum?.[i]??null,gust_mph:d.wind_gusts_10m_max?.[i]??null}));}
 const WMO={0:'clear',1:'mostly clear',2:'partly cloudy',3:'overcast',45:'fog',48:'freezing fog',51:'light drizzle',53:'drizzle',55:'heavy drizzle',56:'light freezing drizzle',57:'freezing drizzle',61:'light rain',63:'rain',65:'heavy rain',66:'light freezing rain',67:'freezing rain',71:'light snow',73:'snow',75:'heavy snow',77:'snow grains',80:'light rain showers',81:'rain showers',82:'heavy rain showers',85:'light snow showers',86:'snow showers',95:'thunderstorm',96:'thunderstorm with hail',99:'thunderstorm with heavy hail'};
 const wmoText=code=>WMO[Number(code)]||'';

 // ---- plain-language lines ----
 /** "34 °F, light snow, wind 12 mph (gusts 25) · Winter Storm Warning in effect" */
 function snapshotLine(s){if(!s)return '';const parts=[];if(s.temp_f!=null)parts.push(`${Math.round(s.temp_f)} °F`);if(s.conditions)parts.push(String(s.conditions).toLowerCase());if(s.wind_mph!=null)parts.push(`wind ${Math.round(s.wind_mph)} mph${s.gust_mph!=null&&Math.round(s.gust_mph)>Math.round(s.wind_mph)?` (gusts ${Math.round(s.gust_mph)})`:''}`);
  let line=parts.join(', ');if(line)line=line[0].toUpperCase()+line.slice(1);const alerts=(s.active_alerts||[]).filter(Boolean);if(alerts.length)line+=(line?' · ':'')+alerts.slice(0,2).join(', ')+(alerts.length>2?` and ${alerts.length-2} more`:'')+' in effect';return line;}
 const SOURCE_NAMES={nws:'National Weather Service',nws_grid:'National Weather Service',open_meteo:'Open-Meteo.com (CC BY 4.0)',manual:''};
 /** "Weather data: National Weather Service, Open-Meteo.com (CC BY 4.0)" naming only the sources used. */
 function attribution(sources){const names=[...new Set((sources||[]).map(s=>SOURCE_NAMES[s]??s).filter(Boolean))];return names.length?'Weather data: '+names.join(', '):'';}
 const DISCLAIMER='Weather alerts in EstateAegis are for planning visits. They can be delayed and are not a substitute for official warnings. Always follow the National Weather Service and local emergency officials.';
 /** Gentle client notice text (NWS alerts only). */
 function clientMessage({event_name,ends_at,company,timezone}){const until=ends_at?` through ${fmt(ends_at,timezone,{weekday:'long'})} ${partOfDay(ends_at,timezone)}`:'';return `Heads up: the National Weather Service has issued a ${event_name} for your area${until}. ${company||'Your residence care team'} is keeping an eye on your home and will contact you if we plan a visit.`;}
 function bannerLine(a,tz){const n=a.count??a.residence_count??0;const tf=timeframe(a,tz);return `${a.source==='forecast'&&a.forecast_summary?forecastRange(a.forecast_summary):a.event_name} · ${n} residence${n===1?'':'s'}${tf&&a.source!=='forecast'?' · '+tf:''}`;}

 // ---- staff emails ----
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function shell(company,eyebrow,heading,bodyHtml,footer){return `<div style="margin:0;padding:24px 12px;background:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#1f2933"><div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e7eb;border-radius:12px;overflow:hidden"><div style="border-top:4px solid #7e202b;padding:24px 28px 6px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5f6b76">${esc(company)} · ${esc(eyebrow)}</div><h1 style="font-size:22px;line-height:1.3;margin:8px 0 6px;color:#7e202b">${esc(heading)}</h1></div>${bodyHtml}<div style="padding:16px 28px;background:#faf9f6;border-top:1px solid #e2e7eb;font-size:12px;color:#5f6b76">${footer}</div></div></div>`;}
 const button=(href,label,primary=true)=>`<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;background:${primary?'#7e202b':'#ffffff'};color:${primary?'#ffffff':'#7e202b'};border:1px solid #7e202b;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px">${esc(label)}</a>`;
 /** Immediate alert email (new / upgraded / expanded). Pure, so tests can check it. */
 function renderAlertEmail(d){
  const n=d.total,until=d.ends_at?shortWhen(d.ends_at,d.timezone):'';
  const subject=`${d.kind==='upgraded'?'Upgraded to ':''}${d.event_name}: ${n} residence${n===1?'':'s'} affected${until?` (until ${until})`:''}`;
  const when=[d.onset_at?'Starts '+longWhen(d.onset_at,d.timezone):'',d.ends_at?'Ends '+longWhen(d.ends_at,d.timezone):''].filter(Boolean).join(' · ');
  const list=d.residences.slice(0,25),more=n-list.length;
  const intro=d.kind==='expanded'?`More of your residences are now covered by this alert.`:d.kind==='upgraded'?`The earlier watch has been upgraded to a warning.`:`The National Weather Service has issued a ${d.event_name}.`;
  const text=[`${d.event_name}: ${n} residence${n===1?'':'s'} affected`,'',intro,when,'',d.headline||'','','Affected residences:',...list.map(r=>`- ${r.name}${r.city?' ('+r.city+')':''}`),...(more>0?[`- and ${more} more`]:[]),'',`View affected residences: ${d.viewLink}`,...(d.stormLink?[`Start storm event: ${d.stormLink}`]:[]),'',d.attribution,'',DISCLAIMER].filter((l,i,a)=>!(l===''&&a[i-1]==='')).join('\n');
  const body=`<div style="padding:8px 28px 4px"><p style="margin:0 0 10px;font-size:15px;line-height:1.5">${esc(intro)}</p>${when?`<p style="margin:0 0 10px;font-size:14px;color:#5f6b76">${esc(when)}</p>`:''}${d.headline?`<p style="margin:0 0 14px;font-size:14px;line-height:1.5">${esc(d.headline)}</p>`:''}<p style="margin:0 0 6px;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#5f6b76">Affected residences</p><ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.6">${list.map(r=>`<li>${esc(r.name)}${r.city?` <span style="color:#5f6b76">(${esc(r.city)})</span>`:''}</li>`).join('')}${more>0?`<li>and ${more} more</li>`:''}</ul></div><div style="padding:6px 28px 20px">${button(d.viewLink,'View affected residences')}${d.stormLink?button(d.stormLink,'Start storm event',false):''}</div>`;
  const html=shell(d.company,'Weather alert',`${d.event_name} · ${n} residence${n===1?'':'s'}`,body,`${esc(d.attribution)}<br><br>${esc(DISCLAIMER)}`);
  return {subject,text,html};
 }
 /** Daily digest of watches, advisories and forecast thresholds. */
 function renderDigestEmail(d){
  const subject=`Weather digest: ${d.items.length} alert${d.items.length===1?'':'s'} for your residences`;
  const line=i=>`${i.title} · ${i.total} residence${i.total===1?'':'s'}${i.when?' · '+i.when:''}`;
  const text=['Weather digest','',...d.items.flatMap(i=>[line(i),...i.residences.slice(0,10).map(r=>`  - ${r.name}${r.city?' ('+r.city+')':''}`),'']),`Open Weather: ${d.viewLink}`,'',d.attribution,'',DISCLAIMER].join('\n');
  const body=`<div style="padding:8px 28px 4px">${d.items.map(i=>`<div style="margin:0 0 14px"><p style="margin:0 0 4px;font-size:15px;font-weight:bold">${esc(i.title)}</p><p style="margin:0 0 4px;font-size:13px;color:#5f6b76">${esc(`${i.total} residence${i.total===1?'':'s'}${i.when?' · '+i.when:''}`)}</p><p style="margin:0;font-size:14px">${i.residences.slice(0,10).map(r=>esc(r.name)).join(', ')}${i.total>10?` and ${i.total-10} more`:''}</p></div>`).join('')}</div><div style="padding:6px 28px 20px">${button(d.viewLink,'Open Weather')}</div>`;
  return {subject,text,html:shell(d.company,'Weather digest','Weather for your residences',body,`${esc(d.attribution)}<br><br>${esc(DISCLAIMER)}`)};
 }
 /** Throttle: one email per alert group per user every 6 hours, except upgrades. */
 function throttled(kind,lastSentAt,now=Date.now()){if(kind==='upgraded'||!lastSentAt)return false;const last=Date.parse(lastSentAt);return Number.isFinite(last)&&now-last<6*3600000;}
 /** Respect each user's email preference. */
 function wantsEmail(pref,{level,kind}){if(pref==='none')return false;if(pref==='warnings_only')return kind!=='digest'&&level==='warning';return true;}

 return {CATEGORIES,CATEGORY_KEYS,EVENTS,LEVELS,LEVEL_RANK,THRESHOLD_KINDS,DEFAULTS,LIMITS,DISCLAIMER,WMO,categoryOf,levelOf,hazardOf,stormTypeFor,severityRank,round,validCoord,pointInGeometry,zonesOf,matchResidence,shortWhen,longWhen,localDay,dayName,addDays,partOfDay,timeframe,overlaps,reconcileNws,thresholdsFor,thresholdHits,mergeRuns,forecastRange,forecastBadge,planForecast,cToF,toF,toMph,toIn,nwsGridDaily,openMeteoDaily,wmoText,snapshotLine,attribution,clientMessage,bannerLine,renderAlertEmail,renderDigestEmail,throttled,wantsEmail};
});
