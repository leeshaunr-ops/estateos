/* Severe-weather alerts (browser): the Weather page (Active, Recent, Settings), alert detail with affected residences,
   the Overview banner, residence and inspection badges, "Weather at visit" on inspections, residence monitoring,
   the profile email preference, the client notice and the hand-off to the storm wizard. Needs live.js globals and
   storm.js (loaded first). Pure rules come from weather-core.js (window.EAWeather). Every value is escaped with esc(). */
const WX=window.EAWeather;
let weatherState={tab:'active',alertId:null,detail:null,recent:null,settings:null,selected:new Set(),filters:{manager:'',city:''},loadingFor:null};
let wxRoutePreset=null;
const WX_ICON={warning:'⚠',watch:'◔',advisory:'ℹ',forecast:'☁',statement:'ℹ'};
const wxStaff=()=>!!data&&['admin','employee'].includes(data.user.role);
const wxAdmin=()=>data?.user?.role==='admin';
const wxOn=()=>!!data?.weather?.enabled;
const wxAlerts=()=>(data?.weather?.alerts||[]);
const wxLive=()=>wxAlerts().filter(a=>!a.dismissed);
const wxTz=()=>data?.weather?.timezone||'America/New_York';
const wxProperty=id=>(data.properties||[]).find(p=>p.id===id);
function wxPill(a){return `<span class="wx-pill wx-${esc(a.level)}"><span aria-hidden="true">${esc(WX_ICON[a.level]||'ℹ')}</span> ${esc(a.source==='forecast'?'Forecast':(WX.LEVELS[a.level]||a.level))}</span>`;}
function wxResidenceBadge(a,propertyId){
 const v=a.values?.[propertyId];
 const text=a.source==='forecast'&&v?WX.forecastBadge(v.kind,v.day,v.value):a.event_name;
 return `<button type="button" class="wx-badge wx-${esc(a.level)}" data-action="weather-open" data-id="${esc(a.id)}"><span aria-hidden="true">${esc(WX_ICON[a.level]||'⚠')}</span> ${esc(text)}</button>`;
}
function wxWhen(iso,tz){return iso?WX.longWhen(iso,tz||wxTz()):'';}
async function wxReload(){lastLoadAt=0;await load();}
async function wxLoadDetail(id){
 weatherState.loadingFor=id;
 try{const r=await api('weather/alerts/'+encodeURIComponent(id));if(weatherState.alertId!==id)return;weatherState.detail=r.alert;weatherState.selected=new Set();}
 catch(error){if(weatherState.alertId!==id)return;weatherState.alertId=null;weatherState.detail=null;toast(error.status===404?'That weather alert is no longer available.':error.message);}
 finally{weatherState.loadingFor=null;}
 if(page==='weather')render();
}
async function wxLoadRecent(){try{weatherState.recent=(await api('weather/alerts?status=recent')).alerts;}catch(error){weatherState.recent=[];toast(error.message);}if(page==='weather')render();}
async function wxLoadSettings(){try{weatherState.settings=await api('settings/weather');}catch(error){toast(error.message);}if(page==='weather')render();}

/* ---------- Weather page ---------- */
function wxTabs(){
 const tabs=[['active',`Active (${wxAlerts().length})`],['recent','Recent'],...(wxAdmin()?[['settings','Settings']]:[])];
 return `<div class="wx-tabs" role="group" aria-label="Weather views">${tabs.map(([k,t])=>`<button type="button" data-action="weather-tab" data-id="${k}" aria-pressed="${weatherState.tab===k}" class="${weatherState.tab===k?'primary':''}">${esc(t)}</button>`).join('')}</div>`;
}
function wxCard(a){
 const ack=a.acknowledged_at?`Acknowledged by ${a.acknowledged_by_name||'a team member'}`:'Not yet acknowledged';
 const lines=[a.category_label,a.source==='forecast'?'':a.timeframe,a.status==='dismissed'?`Dismissed${a.dismissed_by_name?' by '+a.dismissed_by_name:''}`:a.status==='active'?ack:a.status==='cancelled'?'Cancelled by the National Weather Service':a.status==='ended'?'Ended':''].filter(Boolean);
 return `<article class="panel wx-card wx-card-${esc(a.level)}"><div class="wx-card-top">${wxPill(a)}${a.storm_event_id?`<span class="wx-tag">Storm: ${esc(a.storm_event_name)}</span>`:''}</div><h2>${esc(a.title||a.event_name)}</h2><p class="wx-count"><strong>${a.count} residence${a.count===1?'':'s'}</strong></p><p class="muted">${esc(lines.join(' · '))}</p><div class="actions">${btn('View residences','weather-open',a.id,true)}${a.status==='active'&&!a.acknowledged_at?btn('Acknowledge','weather-ack',a.id):''}</div></article>`;
}
function wxActiveView(){
 if(!wxOn())return wxAdmin()?`<div class="panel wx-intro"><h2>Weather alerts are off</h2><p>Turn them on to see National Weather Service warnings and forecast hard freezes, extreme heat, heavy rain and high wind for every residence, with one-tap storm preparation.</p><div class="actions">${btn('Set up weather alerts','weather-tab','settings',true)}</div></div>`:empty('Weather alerts are off','Your administrator can turn them on in Weather settings.');
 const list=wxAlerts();
 if(!list.length)return empty('No weather alerts right now','We check the National Weather Service every 10 minutes and forecasts every 3 hours for your residences.');
 return `<div class="wx-cards">${list.map(wxCard).join('')}</div>`;
}
function wxRecentView(){
 if(weatherState.recent===null){wxLoadRecent();return `<div class="panel"><p class="muted">Loading recent alerts…</p></div>`;}
 if(!weatherState.recent.length)return empty('No alerts in the last 14 days');
 return `<div class="wx-cards">${weatherState.recent.map(wxCard).join('')}</div>`;
}
function wxFiltered(d){const f=weatherState.filters;return d.residences.filter(r=>(!f.manager||(f.manager==='none'?!r.manager_id:r.manager_id===f.manager))&&(!f.city||r.city===f.city));}
function wxResidenceRows(d){
 const rows=wxFiltered(d);
 if(!rows.length)return empty('No residences match these filters.');
 return rows.map(r=>`<div class="wx-res"><label class="wx-res-pick"><input type="checkbox" data-wx-pick value="${esc(r.property_id)}" ${weatherState.selected.has(r.property_id)?'checked':''}><span class="sr-only">Select ${esc(r.name)}</span></label><div class="wx-res-text"><button type="button" class="ov-head-link" data-action="property" data-id="${esc(r.property_id)}">${esc(r.name)}</button><small>${esc([r.city,r.manager?'Residence Manager: '+r.manager:'No Residence Manager',r.next_visit?'Next visit '+fmtDay(r.next_visit):'No visit scheduled'].filter(Boolean).join(' · '))}</small>${r.forecast?`<small class="wx-res-forecast">${esc(r.forecast)}</small>`:''}</div><div class="wx-res-end">${r.on_storm?`<span class="wx-tag">On storm · ${esc(r.storm_status||'')}</span>`:''}</div></div>`).join('');
}
function wxDetailView(){
 const d=weatherState.detail;
 if(!d||d.id!==weatherState.alertId){if(weatherState.loadingFor!==weatherState.alertId)wxLoadDetail(weatherState.alertId);return head('Weather alert','Loading…',btn('Back to weather','weather-back'))+`<div class="panel"><p class="muted">Loading the alert…</p></div>`;}
 const admin=wxAdmin(),open=typeof stormOpenEvents==='function'?stormOpenEvents():[];
 const cities=[...new Set(d.residences.map(r=>r.city).filter(Boolean))].sort(),managers=[...new Map(d.residences.filter(r=>r.manager_id).map(r=>[r.manager_id,r.manager])).entries()];
 const live=['active','dismissed'].includes(d.status);
 const actions=[
  admin&&live&&!d.storm_event_id?btn('Start storm event','weather-storm-start',d.id,true):'',
  d.storm_event_id?btn('Open storm event','weather-storm-open',d.storm_event_id,!admin):'',
  admin&&live&&open.length?btn('Add to storm event','weather-storm-add',d.id):'',
  btn('Plan route','weather-route',d.id),
  live&&!d.acknowledged_at?btn('Acknowledge','weather-ack',d.id):'',
  admin&&d.status==='active'?btn('Dismiss','weather-dismiss',d.id):''
 ].filter(Boolean).join('');
 const facts=factList([
  ['Level',wxPill(d)],['Category',esc(d.category_label)],
  ...(d.source==='nws'?[['Issued by',esc(d.sender_name||'National Weather Service')],['Starts',esc(wxWhen(d.onset_at,d.timezone)||'Now')],['Ends',esc(wxWhen(d.ends_at,d.timezone)||'Not given')]]:[['Forecast',esc(WX.forecastRange(d.forecast_summary))]]),
  ['Status',esc(d.status==='dismissed'?`Dismissed${d.dismissed_by_name?' by '+d.dismissed_by_name:''}${d.dismiss_reason?': '+d.dismiss_reason:''}`:d.status==='active'?'In effect':d.status==='cancelled'?'Cancelled by the National Weather Service':'Ended')],
  ['Acknowledged',esc(d.acknowledged_at?`${d.acknowledged_by_name||'A team member'}, ${wxWhen(d.acknowledged_at,d.timezone)}`:'Not yet')]
 ]);
 const nws=d.description||d.instruction?`<details class="wx-nws"><summary>National Weather Service text</summary>${d.headline?`<p><strong>${esc(d.headline)}</strong></p>`:''}${d.description?`<p class="wx-pre">${esc(d.description)}</p>`:''}${d.instruction?`<h3>What to do</h3><p class="wx-pre">${esc(d.instruction)}</p>`:''}${d.area_desc?`<p class="muted">Areas: ${esc(d.area_desc)}</p>`:''}</details>`:'';
 const filters=`<div class="wx-filters"><div class="field"><label for="wx-f-manager">Residence Manager</label><select id="wx-f-manager" data-wx-filter="manager"><option value="">Anyone</option><option value="none" ${weatherState.filters.manager==='none'?'selected':''}>No Residence Manager</option>${managers.map(([id,n])=>`<option value="${esc(id)}" ${weatherState.filters.manager===id?'selected':''}>${esc(n)}</option>`).join('')}</select></div><div class="field"><label for="wx-f-city">City</label><select id="wx-f-city" data-wx-filter="city"><option value="">Any city</option>${cities.map(c=>`<option ${weatherState.filters.city===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div><div class="field wx-select-all">${btn('Select all shown','weather-select-all')}<span id="wxPickCount" class="muted" aria-live="polite">${weatherState.selected.size} selected</span></div></div>`;
 return head(d.title||d.event_name,`${d.residences.length} residence${d.residences.length===1?'':'s'}${d.timeframe?' · '+d.timeframe:''}`,btn('Back to weather','weather-back'))
  +`<div class="panel wx-detail"><div class="actions wx-detail-actions">${actions}</div>${facts}${nws}</div>`
  +`<section class="panel wx-residences" aria-labelledby="wxResTitle"><h2 id="wxResTitle">Affected residences</h2><p class="muted">Select residences to plan a route or add them to a storm event. With none selected, actions use every residence on this alert.</p>${filters}<div id="wxResRows">${wxResidenceRows(d)}</div></section>`
  +`<p class="wx-foot muted">${esc(d.attribution)}. ${esc(d.disclaimer)}</p>`;
}
function wxNum(name,label,value,{min,max,step=1,unit,optional=false}){return `<div class="field"><label for="wx-${name}">${esc(label)}${unit?` (${esc(unit)})`:''}</label><input id="wx-${name}" name="${name}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${value===null||value===undefined?'':esc(value)}" ${optional?'':'required'}></div>`;}
function wxCheck(name,label,on,{value='1',disabled=false,hint=''}={}){return `<label class="check-row wx-check"><input type="checkbox" name="${name}" value="${esc(value)}" ${on?'checked':''} ${disabled?'disabled':''}><span>${esc(label)}${hint?`<br><span class="muted">${esc(hint)}</span>`:''}</span></label>`;}
function wxSettingsView(){
 const r=weatherState.settings;if(!r){wxLoadSettings();return `<div class="panel"><p class="muted">Loading weather settings…</p></div>`;}
 const s=r.settings,c=r.coverage,team=r.team||[];
 const cov=`<section class="panel wx-coverage" aria-labelledby="wxCovTitle"><h2 id="wxCovTitle">Coverage</h2>${factList([['Residences checked',`${c.monitored} of ${c.total}`],['Waiting for weather zones',String(c.awaitingZones)],['Missing a location',String(c.missingCoordinates)],['Outside National Weather Service coverage',String(c.outsideNws)],['Monitoring turned off',String(c.monitoringOff)]])}${c.missingCoordinates?`<p class="muted">Residences without a location cannot get weather alerts. ${c.geocoderAvailable?'Look them up from their addresses, or set the location on each residence page.':'Set the location on each residence page (Edit residence, Location).'}</p>${c.geocoderAvailable?`<div class="actions">${btn('Look up missing locations','weather-geocode')}</div>`:''}`:''}${!r.jobsEnabled?'<p class="wx-warn">Background weather checks are paused on this server, so new alerts will not arrive yet.</p>':''}</section>`;
 const form=`<form id="wxSettings" class="form wx-settings">
  <fieldset><legend>Weather alerts</legend>${wxCheck('enabled','Turn on weather alerts for this company',s.enabled,{hint:'Checks every residence with a location against National Weather Service alerts and the forecast.'})}</fieldset>
  <fieldset><legend>What to watch for</legend>${r.categories.map(k=>wxCheck('categories',k.label,s.categories.includes(k.key),{value:k.key})).join('')}</fieldset>
  <fieldset><legend>Alert levels</legend>${wxCheck('levels','Warnings (always on)',true,{value:'warning',disabled:true})}${wxCheck('levels','Watches',s.levels.includes('watch'),{value:'watch'})}${wxCheck('levels','Advisories',s.levels.includes('advisory'),{value:'advisory'})}</fieldset>
  <fieldset><legend>Forecast thresholds</legend><div class="wx-grid">${wxNum('freeze_threshold_f','Hard freeze at or below',s.freeze_threshold_f,{min:-20,max:40,unit:'°F'})}${wxNum('freeze_notice_f','Freeze notice at or below (optional)',s.freeze_notice_f,{min:-20,max:40,unit:'°F',optional:true})}${wxNum('heat_threshold_f','Extreme heat, feels like at or above',s.heat_threshold_f,{min:80,max:130,unit:'°F'})}${wxNum('heavy_rain_in','Heavy rain in one day',s.heavy_rain_in,{min:0.5,max:10,step:0.1,unit:'inches'})}${wxNum('high_wind_gust_mph','High wind gusts',s.high_wind_gust_mph,{min:20,max:120,unit:'mph'})}${wxNum('forecast_lookahead_days','Look ahead',s.forecast_lookahead_days,{min:1,max:7,unit:'days'})}</div></fieldset>
  <fieldset><legend>Who gets emails</legend>${wxCheck('notify_admins','All administrators',s.notify_admins)}${wxCheck('notify_residence_managers','Residence Managers (only for their residences)',s.notify_residence_managers)}${team.length?`<p class="muted">Also email:</p>${team.map(u=>wxCheck('notify_user_ids',u.name,s.notify_user_ids.includes(u.id),{value:u.id})).join('')}`:''}
   <div class="field"><label for="wx-digest_time">Daily digest time (company time zone)</label><input id="wx-digest_time" name="digest_time" type="time" value="${esc(s.digest_time)}" required></div>${wxCheck('watch_immediate','Email watches right away (otherwise they go in the daily digest)',s.watch_immediate)}<p class="muted">Warnings are emailed right away. Watches, advisories and forecast thresholds go in the daily digest.</p></fieldset>
  <fieldset><legend>Tell clients</legend>${[['off','Off'],['after_staff_review','After a team member acknowledges the alert'],['automatic','Automatically']].map(([k,t])=>`<label class="check-row wx-check"><input type="radio" name="client_notice" value="${k}" ${s.client_notice===k?'checked':''}><span>${esc(t)}</span></label>`).join('')}<p class="muted">Clients see a short notice in their portal for warnings and watches at their own residences. Preview:</p><blockquote class="wx-preview">${esc(r.clientPreview)}</blockquote></fieldset>
  <fieldset><legend>Reports and storms</legend>${wxCheck('on_reports','Show the weather at the visit on inspection reports',s.on_reports)}${wxNum('storm_prep_lead_hours','Storm preparation deadline, hours before the weather arrives',s.storm_prep_lead_hours,{min:1,max:168,unit:'hours'})}</fieldset>
  <div class="dialog-footer"><button class="primary" type="submit">Save weather settings</button></div></form>`;
 return `<div class="wx-settings-wrap"><section class="panel">${form}</section>${cov}<section class="panel wx-about"><h2>About weather data</h2><p>${esc(r.disclaimer)}</p><p class="muted">${esc(r.attribution)}. ${esc(r.privacy)}</p></section></div>`;
}
function weatherView(){
 if(!wxStaff())return empty('Weather is for staff.');
 if(weatherState.alertId)return wxDetailView();
 if(!wxAdmin()&&weatherState.tab==='settings')weatherState.tab='active';
 const tab=weatherState.tab;
 const body=tab==='recent'?wxRecentView():tab==='settings'?wxSettingsView():wxActiveView();
 return head('Weather','National Weather Service alerts and forecast thresholds for your residences.',wxOn()?btn('Refresh','weather-refresh'):'')+wxTabs()+body;
}

/* ---------- banner, badges and screen hooks ---------- */
function wxBanner(){
 if(!wxStaff()||!wxOn())return '';
 const list=wxLive().filter(a=>!(a.storm_event_id&&a.storm_event_open));if(!list.length)return '';
 if(list.length>2){const homes=new Set(list.flatMap(a=>a.property_ids));return `<section class="wx-banner wx-${esc(list[0].level)}" role="status" aria-label="Weather alerts"><span class="wx-icon" aria-hidden="true">${esc(WX_ICON[list[0].level]||'⚠')}</span><div class="wx-banner-text"><h2>${list.length} weather alerts affecting ${homes.size} residence${homes.size===1?'':'s'}</h2><p>${esc(list.slice(0,3).map(a=>a.title||a.event_name).join(' · '))}</p></div><div class="wx-banner-actions">${btn('View','navigate','weather',true)}</div></section>`;}
 return list.map(a=>`<section class="wx-banner wx-${esc(a.level)}" role="status" aria-label="${esc(a.event_name)}"><span class="wx-icon" aria-hidden="true">${esc(WX_ICON[a.level]||'⚠')}</span><div class="wx-banner-text"><h2>${esc(WX.bannerLine(a,wxTz()))}</h2><p>${esc([a.category_label,a.acknowledged_at?`Acknowledged by ${a.acknowledged_by_name||'a team member'}`:'Not yet acknowledged'].join(' · '))}</p></div><div class="wx-banner-actions">${btn('View','weather-open',a.id,true)}${!a.acknowledged_at?btn('Acknowledge','weather-ack',a.id):''}${wxAdmin()?btn('Dismiss','weather-dismiss',a.id):''}</div></section>`).join('');
}
function wxAlertsFor(propertyId){return wxLive().filter(a=>a.property_ids.includes(propertyId));}

const wxBaseStormStrip=ovStormStrip;
ovStormStrip=function(...args){return wxBanner()+wxBaseStormStrip(...args);};

const wxBaseResidenceSummary=residenceSummary;
residenceSummary=function(p,...rest){
 const html=wxBaseResidenceSummary(p,...rest);if(!wxStaff()||!wxOn())return html;
 const list=wxAlertsFor(p.id);if(!list.length)return html;
 const badges=`<div class="wx-badges" aria-label="Weather">${list.slice(0,3).map(a=>wxResidenceBadge(a,p.id)).join('')}</div>`;
 const at=html.indexOf('</h2>');return at<0?html:html.slice(0,at+5)+badges+html.slice(at+5);
};

const wxBaseResidenceView=residenceView;
residenceView=function(...args){
 const html=wxBaseResidenceView(...args);if(!wxStaff()||!wxOn())return html;
 const p=wxProperty(propertyId);if(!p)return html;
 const list=wxAlertsFor(p.id);
 const badges=list.length?`<div class="wx-res-banner" role="status"><span class="wx-icon" aria-hidden="true">⚠</span><div><strong>Weather</strong><div class="wx-badges">${list.map(a=>wxResidenceBadge(a,p.id)).join('')}</div></div></div>`:'';
 const monitoringOff=Number(p.weather_monitoring_enabled??1)!==1;
 let overrides={};try{overrides=typeof p.weather_threshold_overrides==='string'?JSON.parse(p.weather_threshold_overrides||'{}')||{}:(p.weather_threshold_overrides||{});}catch{}
 const admin=wxAdmin()?`<div class="wx-res-monitor"><span>${monitoringOff?'Weather monitoring is off for this residence.':Object.keys(overrides).length?'Weather monitoring on, with custom thresholds.':'Weather monitoring on, using company thresholds.'}</span>${btn('Weather settings','weather-monitoring',p.id)}</div>`:'';
 const extra=badges+admin;if(!extra)return html;
 // Below the residence header and facts, just above the section tabs (older layouts: before the summary hero).
 let at=html.indexOf('<nav class="res-tabs"');if(at<0)at=html.indexOf('<div class="hero summary">');return at<0?extra+html:html.slice(0,at)+extra+html.slice(at);
};

const wxBaseInspectionView=inspectionView;
inspectionView=function(...args){
 const html=wxBaseInspectionView(...args);if(!wxStaff()||!wxOn())return html;
 const i=data.inspections.find(x=>x.id===activeInspection);if(!i)return html;
 const draft=i.status==='draft'&&!data.offline,w=i.weather;
 const alerts=wxAlertsFor(i.property_id).filter(a=>a.source==='nws'&&a.level==='warning');
 const warn=alerts.length&&i.status==='draft'?`<div class="wx-visit-warn" role="status"><span aria-hidden="true">⚠</span> ${esc(alerts.map(a=>a.event_name).join(', '))} during this visit ${btn('View alert','weather-open',alerts[0].id)}</div>`:'';
 const line=`<div class="wx-visit-line" role="note"><span class="wx-icon" aria-hidden="true">☁</span><div><strong>Weather at visit</strong><div>${w?.line?esc(w.line):'<span class="muted">Not recorded yet. It is captured automatically when you check in or start the visit.</span>'}${w?.source==='manual'?' <span class="muted">(entered by the team)</span>':''}</div></div>${draft?`<div class="wx-visit-actions">${btn(w?'Edit':'Add','weather-snapshot-edit',i.id)}${w?btn('Remove','weather-snapshot-remove',i.id):btn('Look up now','weather-snapshot-refresh',i.id)}</div>`:''}</div>`;
 const extra=warn+line;
 const at=html.indexOf('<div class="panel inspection-screen"');return at<0?extra+html:html.slice(0,at)+extra+html.slice(at);
};

const wxBaseRouteView=routeView;
routeView=function(...args){
 const html=wxBaseRouteView(...args);if(!wxStaff()||!wxOn())return html;
 const preset=wxRoutePreset;wxRoutePreset=null;
 if(preset?.length){
  routePlannerSelections.inspections=false;for(const id of preset)routePlannerSelections.manual.set(id,true);
  setTimeout(()=>{const group=document.querySelector('[data-route-group="inspections"]');if(group)group.checked=false;document.querySelectorAll('.route-stop').forEach(stop=>{stop.checked=!!routeSelected(stop.value);});},0);
  return `<div class="wx-banner wx-watch" role="status"><span class="wx-icon" aria-hidden="true">⚠</span><div class="wx-banner-text"><h2>Route for a weather alert</h2><p>${preset.length} residence${preset.length===1?'':'s'} selected below. Add your starting address, then open directions.</p></div></div>`+html;
 }
 const today=new Date().toLocaleDateString('en-CA');
 const stops=new Set((data.inspections||[]).filter(i=>i.status==='draft'&&String(i.inspection_date||'')<=today).map(i=>i.property_id));
 const hits=wxLive().filter(a=>a.source==='nws'&&a.property_ids.some(id=>stops.has(id)));
 if(!hits.length)return html;
 return hits.map(a=>{const names=a.property_ids.filter(id=>stops.has(id)).map(id=>wxProperty(id)?.name).filter(Boolean);return `<div class="wx-banner wx-${esc(a.level)}" role="status"><span class="wx-icon" aria-hidden="true">${esc(WX_ICON[a.level]||'⚠')}</span><div class="wx-banner-text"><h2>${esc(a.event_name)} during today's visits</h2><p>${esc(names.slice(0,6).join(', '))}${names.length>6?` and ${names.length-6} more`:''}</p></div><div class="wx-banner-actions">${btn('View alert','weather-open',a.id)}</div></div>`;}).join('')+html;
};

const wxBaseProfileView=profileView;
profileView=function(...args){
 const html=wxBaseProfileView(...args);if(!wxStaff()||!data.weather)return html;
 const pref=data.weather.emailPref||'all';
 return html+`<section class="panel wx-profile" aria-labelledby="wxPrefTitle"><h2 id="wxPrefTitle">Weather alert emails</h2><div class="field"><label for="wx-pref">Email me about</label><select id="wx-pref">${[['all','All weather alerts and the daily digest'],['warnings_only','Warnings only'],['none','None']].map(([k,t])=>`<option value="${k}" ${pref===k?'selected':''}>${esc(t)}</option>`).join('')}</select></div><div class="actions">${btn('Save','weather-pref-save','',true)}</div></section>`;
};

const wxBaseSettingsView=settingsView;
settingsView=function(...args){
 const html=wxBaseSettingsView(...args);if(!wxAdmin()||!data.weather)return html;
 const panel=resPanel('Weather alerts',factList([['Weather alerts',wxOn()?'On':'Off'],['Weather on inspection reports',data.weather.onReports?'On':'Off']]),btn(wxOn()?'Weather settings':'Set up','weather-settings'));
 const at=html.lastIndexOf('</div></div>');return at<0?html+panel:html.slice(0,at)+panel+html.slice(at);
};

/* Client portal: a gentle notice for warnings and watches at the client's own residences (dismissible per device). */
const WX_DISMISSED='estateos:weather-notices-dismissed';
function wxDismissed(){try{return new Set(JSON.parse(localStorage.getItem(WX_DISMISSED)||'[]'));}catch{return new Set();}}
const wxBaseActionNeeded=actionNeeded;
actionNeeded=function(...args){
 const base=wxBaseActionNeeded(...args);
 if(page!=='dashboard'||data?.user?.role!=='client'||!data.weatherNotices?.length)return base;
 const gone=wxDismissed(),list=data.weatherNotices.filter(n=>!gone.has(n.id)).slice(0,4);if(!list.length)return base;
 return `<section class="wx-notices" aria-label="Weather notices">${list.map(n=>`<article class="panel wx-notice" role="status"><div class="eyebrow"><span aria-hidden="true">⚠</span> Weather notice · ${esc(n.property_name)}</div><p>${esc(n.company_message)}</p><div class="actions">${btn('Dismiss','weather-notice-dismiss',n.id)}</div></article>`).join('')}</section>`+base;
};

const wxBaseView=view;
view=function(...args){if(page==='weather'&&data&&!data.offline&&wxStaff())return weatherView();return wxBaseView(...args);};

/* ---------- dialogs ---------- */
function wxSnapshotDialog(i){
 const w=i.weather||{};
 dialog('Weather at visit',`${wxNum('temp_f','Temperature',w.temp_f!=null?Math.round(w.temp_f):'',{min:-80,max:140,unit:'°F',optional:true})}<div class="field"><label for="wx-conditions">Conditions</label><input id="wx-conditions" name="conditions" maxlength="80" value="${esc(w.conditions||'')}" placeholder="Light snow"></div>${wxNum('wind_mph','Wind',w.wind_mph!=null?Math.round(w.wind_mph):'',{min:0,max:250,unit:'mph',optional:true})}${wxNum('gust_mph','Gusts',w.gust_mph!=null?Math.round(w.gust_mph):'',{min:0,max:300,unit:'mph',optional:true})}<p class="muted full">Your entry replaces the automatic reading on this visit.</p>`,'Save weather',async v=>{await api(`inspections/${encodeURIComponent(i.id)}/weather`,{snapshot:{temp_f:v.temp_f,conditions:v.conditions,wind_mph:v.wind_mph,gust_mph:v.gust_mph}});toast('Weather saved.');});
}
async function wxMonitoringDialog(p){
 const r=await api('weather/residences/'+encodeURIComponent(p.id));
 const o=r.overrides||{},t=r.thresholds||{};
 dialog(`Weather for ${p.name}`,`${wxCheck('enabled','Check this residence for weather alerts',r.monitoring)}<p class="muted full">Leave a threshold blank to use the company setting (shown).</p>${wxNum('freeze_threshold_f',`Hard freeze at or below (company ${t.freeze_threshold_f})`,o.freeze_threshold_f??'',{min:-20,max:40,unit:'°F',optional:true})}${wxNum('heat_threshold_f',`Extreme heat at or above (company ${t.heat_threshold_f})`,o.heat_threshold_f??'',{min:80,max:130,unit:'°F',optional:true})}${wxNum('heavy_rain_in',`Heavy rain in one day (company ${t.heavy_rain_in})`,o.heavy_rain_in??'',{min:0.5,max:10,step:0.1,unit:'inches',optional:true})}${wxNum('high_wind_gust_mph',`High wind gusts (company ${t.high_wind_gust_mph})`,o.high_wind_gust_mph??'',{min:20,max:120,unit:'mph',optional:true})}${r.hasCoordinates?'':'<p class="wx-warn full">This residence has no location yet, so it cannot get weather alerts.</p>'}`,'Save',async v=>{
  await api('weather/residences/'+encodeURIComponent(p.id)+'/monitoring',{enabled:v.enabled==='1',overrides:{freeze_threshold_f:v.freeze_threshold_f,heat_threshold_f:v.heat_threshold_f,heavy_rain_in:v.heavy_rain_in,high_wind_gust_mph:v.high_wind_gust_mph}});toast('Weather settings saved.');});
}
function wxChosen(d){return weatherState.selected.size?[...weatherState.selected].filter(id=>d.residences.some(r=>r.property_id===id)):d.residences.map(r=>r.property_id);}
async function wxStartStorm(id){
 const d=weatherState.detail;const r=await api(`weather/alerts/${encodeURIComponent(id)}/start-storm-event`,{});
 if(r.linked){await wxOpenStorm(r.event.id);return;}
 const pre=r.prefill,ids=wxChosen(d);
 dialog('Start storm event',`${input('name','Storm name','text',pre.name)}${stormTypeSelect(pre.type)}${stormDateTime('expectedImpactAt','Expected impact',pre.expected_impact_at)}${stormDateTime('prepDeadlineAt','Preparation deadline',pre.prep_deadline_at)}<p class="muted full">${ids.length} affected residence${ids.length===1?'':'s'} will be added. Next you can add more residences and schedule pre-storm visits.</p>`,'Create storm event',async v=>{
  const out=await api(`weather/alerts/${encodeURIComponent(id)}/start-storm-event`,{create:true,name:v.name,type:v.type,expectedImpactAt:stormIso(v.expectedImpactAt)||null,prepDeadlineAt:stormIso(v.prepDeadlineAt)||null,residenceIds:ids});
  await stormRefresh();stormState.view='wizard';stormState.wizard={step:2,eventId:out.event.id,selected:new Set(),filter:{}};page='storm';weatherState.detail=null;weatherState.alertId=null;
  toast(out.created?'Storm event created. Add any other residences, then schedule pre-storm visits.':'This alert already has a storm event.');
 });
}
async function wxOpenStorm(eventId){await stormRefresh().catch(()=>{});stormState.view='board';stormState.eventId=eventId;stormState.wizard=null;page='storm';render();window.scrollTo(0,0);}

/* ---------- actions ---------- */
const wxBaseAction=action;
action=async function(name,key,button){
 if(name==='navigate'&&key==='weather'){weatherState.alertId=null;weatherState.detail=null;weatherState.recent=null;}
 if(!String(name).startsWith('weather-'))return wxBaseAction(name,key,button);
 try{
  switch(name){
   case 'weather-open':page='weather';weatherState.alertId=key;weatherState.detail=null;weatherState.filters={manager:'',city:''};render();window.scrollTo(0,0);return;
   case 'weather-back':weatherState.alertId=null;weatherState.detail=null;render();return;
   case 'weather-tab':page='weather';weatherState.alertId=null;weatherState.tab=key;if(key==='recent')weatherState.recent=null;if(key==='settings')weatherState.settings=null;render();return;
   case 'weather-settings':page='weather';weatherState.alertId=null;weatherState.tab='settings';weatherState.settings=null;render();window.scrollTo(0,0);return;
   case 'weather-refresh':await wxReload();weatherState.recent=null;toast('Weather alerts refreshed.');return;
   case 'weather-ack':await api(`weather/alerts/${encodeURIComponent(key)}/acknowledge`,{});if(weatherState.alertId===key)weatherState.detail=null;await wxReload();toast('Alert acknowledged.');return;
   case 'weather-dismiss':dialog('Dismiss this alert?',`<div class="field full"><label for="wx-reason">Reason (optional)</label><input id="wx-reason" name="reason" maxlength="500" placeholder="Residences already prepared"></div><p class="muted full">It stays dismissed for your whole team while the alert is in effect.</p>`,'Dismiss alert',async v=>{await api(`weather/alerts/${encodeURIComponent(key)}/dismiss`,{reason:v.reason||''});if(weatherState.alertId===key)weatherState.detail=null;toast('Alert dismissed.');});return;
   case 'weather-storm-start':await wxStartStorm(key);return;
   case 'weather-storm-open':await wxOpenStorm(key);return;
   case 'weather-storm-add':{const d=weatherState.detail,events=stormOpenEvents(),ids=wxChosen(d);dialog('Add to storm event',`${select('stormEventId','Storm event',events.map(e=>`<option value="${esc(e.id)}">${esc(e.name)}</option>`).join(''))}<p class="muted full">${ids.length} residence${ids.length===1?'':'s'} will be added.</p>`,'Add residences',async v=>{const r=await api(`weather/alerts/${encodeURIComponent(key)}/add-to-storm`,{stormEventId:v.stormEventId,residenceIds:ids});weatherState.detail=null;await stormRefresh().catch(()=>{});toast(`${r.added} added to ${r.event.name}${r.alreadyIncluded?`, ${r.alreadyIncluded} already on it`:''}.`);});return;}
   case 'weather-route':{const d=weatherState.detail;wxRoutePreset=d?wxChosen(d):[];page='routes';render();window.scrollTo(0,0);return;}
   case 'weather-select-all':{const d=weatherState.detail;if(!d)return;for(const r of wxFiltered(d))weatherState.selected.add(r.property_id);render();return;}
   case 'weather-geocode':{const r=await api('weather/coverage/geocode-missing',{});weatherState.settings=null;toast(`${r.geocoded} location${r.geocoded===1?'':'s'} found.`);render();return;}
   case 'weather-snapshot-edit':{const i=data.inspections.find(x=>x.id===key);if(i)wxSnapshotDialog(i);return;}
   case 'weather-snapshot-remove':await api(`inspections/${encodeURIComponent(key)}/weather`,{clear:true});await wxReload();toast('Weather removed from this visit.');return;
   case 'weather-snapshot-refresh':{const r=await api(`inspections/${encodeURIComponent(key)}/weather`,{refresh:true});await wxReload();toast(r.weather?'Weather recorded.':'Weather is not available for this residence right now.');return;}
   case 'weather-monitoring':{const p=wxProperty(key);if(p)await wxMonitoringDialog(p);return;}
   case 'weather-pref-save':{const v=$('wx-pref')?.value;const r=await api('weather/preferences',{emailPref:v});data.weather.emailPref=r.emailPref;toast('Weather email preference saved.');return;}
   case 'weather-notice-dismiss':{const s=wxDismissed();s.add(key);try{localStorage.setItem(WX_DISMISSED,JSON.stringify([...s].slice(-200)));}catch{}render();return;}
  }
 }catch(error){toast(error.message);}
};

/* ---------- form events ---------- */
document.addEventListener('submit',async event=>{
 const form=event.target;if(form.id!=='wxSettings')return;
 event.preventDefault();const button=event.submitter;if(button)button.disabled=true;
 try{
  const f=new FormData(form),one=k=>f.get(k),many=k=>f.getAll(k);
  const payload={enabled:f.has('enabled'),categories:many('categories'),levels:['warning',...many('levels')],freeze_threshold_f:one('freeze_threshold_f'),freeze_notice_f:one('freeze_notice_f')||null,heat_threshold_f:one('heat_threshold_f'),heavy_rain_in:one('heavy_rain_in'),high_wind_gust_mph:one('high_wind_gust_mph'),forecast_lookahead_days:one('forecast_lookahead_days'),
   notify_admins:f.has('notify_admins'),notify_residence_managers:f.has('notify_residence_managers'),notify_user_ids:many('notify_user_ids'),digest_time:one('digest_time'),watch_immediate:f.has('watch_immediate'),client_notice:one('client_notice')||'off',on_reports:f.has('on_reports'),storm_prep_lead_hours:Number(one('storm_prep_lead_hours'))};
  weatherState.settings=await api('settings/weather',payload);
  await wxReload();toast('Weather settings saved.');
 }catch(error){toast(error.message);}finally{if(button&&button.isConnected)button.disabled=false;}
});
document.addEventListener('change',event=>{
 const t=event.target;if(!(t instanceof HTMLElement))return;
 if(t.matches('[data-wx-pick]')){const box=/** @type {HTMLInputElement} */(t);if(box.checked)weatherState.selected.add(box.value);else weatherState.selected.delete(box.value);const c=$('wxPickCount');if(c)c.textContent=`${weatherState.selected.size} selected`;return;}
 if(t.matches('[data-wx-filter]')){const sel=/** @type {HTMLSelectElement} */(t);weatherState.filters[sel.dataset.wxFilter]=sel.value;const rows=$('wxResRows');if(rows&&weatherState.detail)rows.innerHTML=wxResidenceRows(weatherState.detail);}
});
