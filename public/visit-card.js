/* Visit verification (GPS and timestamp proof of visit): inspection-screen card, report summary block (staff and client
   portal), report-list badges and filter, residence "Location & time zone", and company settings.
   Location is read only when the inspector taps Check in / Check out (or saves photos); there is no tracking. Check-in
   and check-out go through the offline outbox, so they work with no signal and sync later (device time + server time).
   A visit can always be completed: with no position it is shown as "Location unavailable". */
const VV=window.EAVisit;
const VV_ZONES=[['America/New_York','Eastern (New York)'],['America/Chicago','Central (Chicago)'],['America/Denver','Mountain (Denver)'],['America/Phoenix','Arizona (Phoenix)'],['America/Los_Angeles','Pacific (Los Angeles)'],['America/Anchorage','Alaska (Anchorage)'],['Pacific/Honolulu','Hawaii (Honolulu)'],['America/Puerto_Rico','Atlantic (Puerto Rico)'],['America/Toronto','Toronto'],['America/Vancouver','Vancouver'],['Europe/London','London'],['Europe/Paris','Paris'],['America/Mexico_City','Mexico City']];
let visitFilterValue='';
const vvSettings=()=>data?.visitVerification||OFF.workspace?.visitVerification||{};
const vvOn=()=>!!vvSettings().enabled;
const vvResidence=i=>data.properties.find(p=>p.id===i.property_id)||{};
const vvTimezone=p=>p?.effective_timezone||VV.effectiveTimezone(p,data.companyTimezone);
const vvGeo=p=>({lat:p?.latitude,lon:p?.longitude,radius:p?.effective_radius_m??p?.geofence_radius_m??vvSettings().radius??VV.DEFAULT_RADIUS});
const vvKey=k=>'ea-visit-'+k+':'+(data?.user?.id||OFF.userId||'');
OFF.visits=OFF.visits||new Map();
/* Device copies of check-ins live in the offline store's meta ("visit:<inspectionId>", listed in "visit-index"). */
async function visitLoadCache(){
 if(!OFF.store?.getMeta)return;
 try{const index=(await OFF.store.getMeta('visit-index'))||[];const next=new Map();for(const id of index){const m=await OFF.store.getMeta('visit:'+id);if(m)next.set(id,m);}OFF.visits=next;}catch{}
}
const visitBaseRefresh=offlineRefreshMirror;
const visitSig=()=>JSON.stringify([...OFF.visits].map(([k,v])=>[k,v.server?.status||'',!!v.server?.check_out,Object.values(v.local||{}).map(l=>!!l.synced)]));
offlineRefreshMirror=async function(){
 await visitBaseRefresh();const before=visitSig();await visitLoadCache();
 // A check-in that just synced: refresh the card (unless the inspector is typing or a dialog is open).
 const typing=document.activeElement&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
 if(visitSig()!==before&&typeof data!=='undefined'&&data&&page==='inspection'&&!typing&&!$('modal').open)setTimeout(render,0);
};
window.EAOffline?.ready?.then(visitLoadCache);
const vvStore={get:k=>{try{return localStorage.getItem(vvKey(k));}catch{return null;}},set:(k,v)=>{try{localStorage.setItem(vvKey(k),v);}catch{}}};

/* ---------- state: server copy (from /api/data or the last sync) + anything still waiting on this device ---------- */
function visitState(i){
 const m=OFF.visits.get(i.id)||{};
 const score=v=>v?(v.override?4:0)+(v.check_out?2:0)+(v.check_in?1:0):-1;
 const server=[i.visit,m.server].filter(Boolean).sort((a,b)=>score(b)-score(a))[0]||null;
 const local=m.local||{},geo=vvGeo(vvResidence(i));
 const side=(which)=>{
  if(server?.[which])return server[which];
  const l=local[which];if(!l)return null;
  const ev=VV.evaluate({lat:l.lat,lon:l.lon,accuracy:l.accuracy},geo);
  return {at:l.at,offline:!!l.offline,synced_at:null,pending:!l.synced,distance_m:ev.distance,accuracy_m:l.accuracy??null,has_location:VV.validCoord(l.lat,l.lon),status:ev.status,note:l.note||'',auto:!!l.auto};
 };
 const check_in=side('check_in'),check_out=side('check_out');
 let status=server?.status&&server.check_in?server.status:'pending';
 if(!server?.check_in&&check_in){const marks=[check_in.status,check_out?.status].filter(Boolean);status=marks.includes('outside_geofence')?'outside_geofence':marks.includes('verified')?'verified':marks.includes('no_residence_location')?'no_residence_location':'location_unavailable';}
 if(server?.override)status='verified';
 const start=Date.parse(check_in?.at||''),end=Date.parse(check_out?.at||'');
 return {...(server||{}),status,check_in,check_out,duration_seconds:server?.duration_seconds??(Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,Math.round((end-start)/1000)):null),pending:!!(check_in?.pending||check_out?.pending)};
}
const visitCheckedIn=i=>!!visitState(i).check_in;
function visitGated(i,status){return vvOn()&&vvSettings().requireCheckIn&&isStaff()&&status==='draft'&&!visitCheckedIn(i);}

/* ---------- wording ---------- */
const VV_PILL={pass:'ck-pass',fail:'ck-fail',monitor:'ck-monitor',open:''};
function visitPill(v){const d=VV.describe(v,'UTC');return `<span class="badge visit-pill ${VV_PILL[d.tone]||''}">${esc(d.label)}</span>`;}
function visitStatusText(v,geo){
 if(!v.check_in)return 'Not checked in yet. Tap Check in when you arrive at the residence.';
 const s=v.check_in;let text;
 if(v.override)text='Verified by an administrator.';
 else if(s.status==='verified')text=`Checked in at the residence (${VV.formatDistance(s.distance_m)} away).`;
 else if(s.status==='outside_geofence')text=`Checked in ${VV.formatDistance(s.distance_m)} from the residence.`;
 else if(s.status==='no_residence_location')text='Checked in. This residence has no location set yet, so the distance could not be checked.';
 else text='Checked in without a location. The report will show “Location unavailable”.';
 if(v.check_out)text+=v.check_out.auto?' Checked out automatically when the report was completed.':' Checked out.';
 if(v.pending)text+=' Saved on this device; it syncs when you’re back online.';
 return text;
}
function visitRows(v,tz){return `<dl class="visit-rows">${VV.describe(v,tz).rows.map(([k,val])=>`<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>`;}
const visitMapLink=s=>s&&s.lat!=null&&s.lon!=null?`<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(s.lat+','+s.lon)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>`:'';
function visitDetails(v,tz){
 const sides=[['Check-in',v.check_in],['Check-out',v.check_out]].filter(([,s])=>s&&('server_at' in s));if(!sides.length)return '';
 const row=([name,s])=>`<tr><th scope="row">${name}</th><td>${esc(s.device_at?VV.formatTime(s.device_at,tz):'Not recorded')}</td><td>${esc(s.server_at?VV.formatTime(s.server_at,tz):'Waiting to sync')}</td><td>${s.lat!=null?esc(s.lat.toFixed(5)+', '+s.lon.toFixed(5))+'<br>'+visitMapLink(s):esc(s.source==='denied'?'Permission denied':s.source==='auto'?'Automatic check-out':s.source==='timeout'?'No GPS fix (timed out)':'No location')}</td><td>${s.accuracy_m!=null?'±'+Math.round(s.accuracy_m)+' m':'—'}</td></tr>`;
 return `<details class="visit-details"><summary>Device and server details</summary><div class="visit-table-wrap"><table class="visit-table"><thead><tr><th></th><th>Device time</th><th>Server received</th><th>Coordinates</th><th>GPS accuracy</th></tr></thead><tbody>${sides.map(row).join('')}</tbody></table></div>${v.check_in_by?`<p class="muted">Checked in by ${esc(v.check_in_by)}.</p>`:''}${v.clock_skew?'<p class="muted">The device clock differed from the server clock by more than 10 minutes.</p>':''}</details>`;
}

/* ---------- inspection screen ---------- */
function visitSection(i,status){
 const staff=isStaff(),v=visitState(i),p=vvResidence(i),tz=vvTimezone(p),geo=vvGeo(p);
 if(!staff){if(!i.visit)return '';return `<section class="panel visit-card visit-proof" aria-label="Visit verification"><div class="visit-head"><h2>Visit verification</h2>${visitPill(i.visit)}</div>${visitRows(i.visit,tz)}${VV.describe(i.visit,tz).notes.map(n=>`<p class="muted">${esc(n)}</p>`).join('')}</section>`;}
 if(!vvOn()&&!i.visit)return '';
 const draft=status==='draft',queued=!!offlineDraft(i.id)?.completeQueued;
 if(draft&&!queued&&vvOn()){
  const denied=vvStore.get('denied')==='1',noGeo=!VV.validCoord(geo.lat,geo.lon);
  const actions=!v.check_in?btn('Check in','visit-check-in',i.id,true):!v.check_out?btn('Check out','visit-check-out',i.id):'';
  return `<section class="panel visit-card" aria-label="Visit verification"><div class="visit-head"><h2>Visit verification</h2>${v.check_in?visitPill(v):'<span class="badge">Not checked in</span>'}</div><p class="visit-status-text">${esc(visitStatusText(v,geo))}</p>${v.check_in?visitRows(v,tz):''}${actions?`<div class="actions visit-actions">${actions}</div>`:''}${denied&&!v.check_in?`<p class="visit-help">Location is turned off for EstateAegis on this phone. You can still check in and complete the visit; it will show as “Location unavailable”. To turn it on: iPhone — Settings › Privacy &amp; Security › Location Services › Safari Websites (or EstateAegis); Android — Chrome › Settings › Site settings › Location.</p>`:''}${noGeo?`<p class="visit-help">This residence has no location set yet, so distance can’t be checked.${data.user.role==='admin'&&!data.offline?' Set it under the residence’s “Location &amp; time zone”.':' An admin can set it under the residence’s “Location & time zone”.'}</p>`:''}<p class="muted visit-privacy">${esc(VV.NOTICE)}</p>${data.user.role==='admin'&&v.check_in?visitDetails(v,tz):''}</section>`;
 }
 const admin=data.user.role==='admin'&&!data.offline;
 return `<section class="panel visit-card visit-proof" aria-label="Visit verification"><div class="visit-head"><h2>Visit verification</h2>${visitPill(v)}</div>${visitRows(v,tz)}${VV.describe(v,tz).notes.map(n=>`<p class="muted">${esc(n)}</p>`).join('')}${visitDetails(v,tz)}${admin&&v.status!=='verified'?`<div class="actions visit-actions">${btn('Mark visit as verified','visit-override',i.id)}</div>`:''}</section>`;
}
function visitGateNotice(){return `<div class="notice visit-gate"><strong>Check in to start.</strong> Your company asks inspectors to check in at the residence before recording the inspection. If location is unavailable you can still check in.</div>`;}

/* ---------- report list: badge + filter ---------- */
function visitBadge(i){
 if(!isStaff())return '';const v=i.visit;
 if(!v){return vvOn()&&i.status!=='draft'?'<span class="badge amber visit-badge">Not checked in</span>':'';}
 const st=v.override?'verified':v.status;if(st==='pending')return i.status==='draft'?'':'<span class="badge amber visit-badge">Not checked in</span>';
 const cls={verified:'ck-pass',outside_geofence:'ck-fail',location_unavailable:'ck-monitor',no_residence_location:'ck-monitor'}[st]||'';
 const text={verified:v.override?'Verified (admin)':'Verified',outside_geofence:'Outside area',location_unavailable:'No location',no_residence_location:'Residence location not set'}[st]||'';
 return `<span class="badge visit-badge ${cls}" title="Visit verification">${esc(text)}</span>`;
}
function visitFilterBar(){
 if(!isStaff()||!vvOn())return '';
 const options=[['','All visits'],['verified','Verified'],['outside_geofence','Outside area'],['location_unavailable','No location'],['pending','Not checked in']];
 return `<div class="visit-filter" role="group" aria-label="Filter by visit verification">${options.map(([v,t])=>`<button class="${visitFilterValue===v?'active':''}" data-action="visit-filter" data-id="${v}">${esc(t)}</button>`).join('')}</div>`;
}
function visitFilter(rows){
 if(!visitFilterValue||!isStaff())return rows;
 return rows.filter(i=>{const st=i.visit?(i.visit.override?'verified':i.visit.status):'pending';return visitFilterValue==='location_unavailable'?['location_unavailable','no_residence_location'].includes(st):st===visitFilterValue;});
}

/* ---------- capture ---------- */
async function visitPermission(){try{return (await navigator.permissions?.query({name:'geolocation'}))?.state||'prompt';}catch{return 'prompt';}}
function visitNotice(){
 if(vvStore.get('notice')==='1')return Promise.resolve(true);
 return new Promise(resolve=>{
  $('modalBody').innerHTML=`<h2>Location for visit proof</h2><p>${esc(VV.NOTICE)}</p><p class="muted">Your phone will ask for permission next. If you say no, you can still check in — the visit will show as “Location unavailable”.</p><div class="dialog-footer"><button type="button" id="vvNoticeCancel">Not now</button><button type="button" class="primary" id="vvNoticeOk">Continue</button></div>`;
  const done=ok=>{$('modal').close();if(ok)vvStore.set('notice','1');resolve(ok);};
  $('vvNoticeOk').onclick=()=>done(true);$('vvNoticeCancel').onclick=()=>done(false);$('modal').showModal();
 });
}
function visitPosition({timeout=15000}={}){
 if(!navigator.geolocation)return Promise.resolve({source:'unsupported'});
 return new Promise(resolve=>{let settled=false;const finish=v=>{if(!settled){settled=true;resolve(v);}};
  setTimeout(()=>finish({source:'timeout'}),timeout+2000);
  try{navigator.geolocation.getCurrentPosition(p=>{vvStore.set('denied','0');finish({lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,source:'gps'});},e=>{if(e&&e.code===1)vvStore.set('denied','1');finish({source:e&&e.code===1?'denied':e&&e.code===3?'timeout':'unavailable'});},{enableHighAccuracy:true,timeout,maximumAge:30000});}catch{finish({source:'unavailable'});}
 });
}
/** One position for a check-in/out: the one-time notice first, then the browser prompt. Never throws. */
async function visitCapture(){
 if(!navigator.geolocation)return {source:'unsupported'};
 if(await visitPermission()==='denied'){vvStore.set('denied','1');return {source:'denied'};}
 if(!(await visitNotice()))return {source:'denied'};
 return visitPosition();
}
/** Photo location: only when location is already allowed (no prompt while taking photos). */
async function visitPhotoPosition(){
 if(!vvOn()||!vvSettings().capturePhotoLocation||!navigator.geolocation)return null;
 const state=await visitPermission();if(state!=='granted'&&!(state==='prompt'&&vvStore.get('notice')==='1'))return null;
 const p=await visitPosition({timeout:8000});return p.source==='gps'?p:null;
}
function visitReason(distance){
 return new Promise(resolve=>{
  $('modalBody').innerHTML=`<h2>You’re outside the residence area</h2><form id="vvReason" class="form"><p class="full vv-full">Your location is about <strong>${esc(VV.formatDistance(distance))}</strong> from the residence. Add a short reason; it appears on the report.</p><div class="field full"><label for="vvReasonText">Reason</label><textarea id="vvReasonText" required minlength="3" maxlength="500" placeholder="For example: GPS drifting inside the house, or checking the boathouse down the road"></textarea></div><div class="dialog-footer"><button type="button" id="vvReasonCancel">Cancel</button><button class="primary" type="submit">Continue</button></div></form>`;
  $('vvReason').onsubmit=e=>{e.preventDefault();const t=$('vvReasonText').value.trim();if(t.length<3)return;$('modal').close();resolve(t);};
  $('vvReasonCancel').onclick=()=>{$('modal').close();resolve(null);};$('modal').showModal();
 });
}
async function visitRecord(i,which,{auto=false,position=null}={}){
 const pos=position||await visitCapture(),geo=vvGeo(vvResidence(i));
 const ev=VV.evaluate({lat:pos.lat,lon:pos.lon,accuracy:pos.accuracy},geo);
 let note='';
 if(!auto&&ev.status==='outside_geofence'){note=await visitReason(ev.distance);if(note===null)return false;}
 const at=new Date().toISOString(),offline=!offlineIsOnline();
 const local={at,lat:pos.lat??null,lon:pos.lon??null,accuracy:pos.accuracy??null,source:pos.source,offline,note,auto,synced:false};
 const k='visit:'+i.id,cur=(await OFF.store.getMeta(k))||{local:{}};cur.local={...(cur.local||{}),[which]:local};await OFF.store.putMeta(k,cur);
 const index=(await OFF.store.getMeta('visit-index'))||[];if(!index.includes(i.id))await OFF.store.putMeta('visit-index',[...index,i.id].slice(-200));
 await offlineCore.enqueue(OFF.store,{type:which==='check_in'?'visit_check_in':'visit_check_out',inspectionId:i.id,payload:{deviceAt:at,latitude:local.lat,longitude:local.lon,accuracy:local.accuracy,source:pos.source,offline,...(note?{note}:{}),...(auto?{auto:true}:{})}});
 await offlineRefreshMirror();offlineRequestBackgroundSync();
 return true;
}
/** Before Mark complete / publish: check out automatically if the inspector checked in but never out. */
async function visitAutoCheckOut(i){
 if(!vvOn()||!i)return;const v=visitState(i);if(!v.check_in||v.check_out)return;
 const position=await visitPermission()==='granted'?await visitPosition({timeout:6000}):{source:'auto'};
 await visitRecord(i,'check_out',{auto:true,position:position.source==='gps'?position:{source:'auto'}});
}

/* ---------- dialogs ---------- */
const vvZoneOptions=(selected,blank)=>`${blank?`<option value="">${esc(blank)}</option>`:''}${[...VV_ZONES,...(selected&&!VV_ZONES.some(z=>z[0]===selected)?[[selected,selected]]:[])].map(([z,t])=>`<option value="${esc(z)}" ${z===selected?'selected':''}>${esc(t)} — ${esc(VV.zoneAbbreviation(z))}</option>`).join('')}`;
function visitLocationDialog(p){
 const src={geoapify:'found from the address',manual:'entered by an admin',device:'taken from a phone at the residence',geoapify_failed:''}[p.geocode_source]||'set';
 const has=VV.validCoord(p.latitude,p.longitude),company=data.companyTimezone||'America/New_York';
 dialog('Location & time zone',`<p class="full muted vv-full">${has?`Location ${esc(src)}${p.geocoded_at?' on '+esc(VV.formatTime(p.geocoded_at,vvTimezone(p))):''}${p.geocoded_address&&p.geocoded_address!==p.address?' (for an earlier address)':''}.`:p.geocode_source==='geoapify_failed'?'The address lookup could not find this address. Enter the coordinates, or use your phone while standing at the residence.':'No location set. Visit verification needs it to check that inspectors are at the residence.'}</p><div class="field"><label for="f-latitude">Latitude</label><input id="f-latitude" name="latitude" inputmode="decimal" value="${has?esc(Number(p.latitude).toFixed(6)):''}" placeholder="27.197200"></div><div class="field"><label for="f-longitude">Longitude</label><input id="f-longitude" name="longitude" inputmode="decimal" value="${has?esc(Number(p.longitude).toFixed(6)):''}" placeholder="-80.252800"></div><input type="hidden" name="source" id="f-source" value="manual"><div class="actions full vv-full">${btn('Use my current location','vv-use-location',p.id)}${vvSettings().geocoding?btn('Look up from address','vv-geocode',p.id):''}</div>${has?`<p class="full vv-full">${visitMapLink({lat:Number(p.latitude),lon:Number(p.longitude)})}</p>`:''}<div class="field"><label for="f-radius">Residence area (metres)</label><input id="f-radius" name="radius" type="number" min="25" max="2000" step="1" value="${esc(p.geofence_radius_m??'')}" placeholder="Company default: ${esc(vvSettings().radius||150)}"></div>${select('timezone','Time zone',vvZoneOptions(p.timezone_source?p.timezone:'',`Company default (${company})`))}<p class="full muted vv-full">Report times for this residence are shown in ${esc(vvTimezone(p))} (${esc(VV.zoneAbbreviation(vvTimezone(p)))}).</p>`,'Save location',async b=>{await api('properties/location',{id:p.id,latitude:b.latitude.trim(),longitude:b.longitude.trim(),source:b.source,radius:b.radius,timezone:b.timezone});toast('Location saved.');});
}
function visitSettingsDialog(){
 const s=vvSettings(),check=(name,label,on,help='')=>`<label class="check-row full vv-full"><input type="checkbox" name="${name}" ${on?'checked':''}> <span>${esc(label)}${help?`<small class="muted"> ${esc(help)}</small>`:''}</span></label>`;
 dialog('Visit verification',`<p class="full muted vv-full">Inspectors check in and out on their phone. Each report then shows when they arrived and left and whether they were at the residence. Location is recorded only at check-in, check-out and photos — never tracked.</p>${check('enabled','Turn on visit verification',s.enabled)}${check('requireCheckIn','Require check-in before recording an inspection',s.requireCheckIn,'(inspectors can still check in without location)')}${check('showOnPdf','Show visit verification on the PDF report and client portal',s.showOnPdf)}${check('capturePhotoLocation','Record photo locations',s.capturePhotoLocation)}<div class="field"><label for="f-radius">Residence area (metres)</label><input id="f-radius" name="radius" type="number" min="25" max="2000" step="1" value="${esc(s.radius||150)}"></div>${select('timezone','Company time zone',vvZoneOptions(s.timezone||'','Not set (Eastern)'))}<p class="full muted vv-full">Residences without their own time zone use the company time zone.${s.geocoding?' Residence locations are looked up from their addresses automatically.':' Address lookup is not configured: set each residence location under the residence’s “Location & time zone”.'}</p>`,'Save settings',async b=>{await api('visit-verification/settings',{enabled:!!b.enabled,requireCheckIn:!!b.requireCheckIn,showOnPdf:!!b.showOnPdf,capturePhotoLocation:!!b.capturePhotoLocation,radius:b.radius,timezone:b.timezone});toast('Visit verification settings saved.');});
}

/* ---------- actions ---------- */
const visitBaseAction=action;
action=async function(name,key,button){
 const inspection=()=>data.inspections.find(x=>x.id===(key||activeInspection));
 if(name==='visit-check-in'||name==='visit-check-out'){
  const i=inspection();if(!i)throw Error('Inspection unavailable.');
  const which=name==='visit-check-in'?'check_in':'check_out',v=visitState(i);
  if(which==='check_in'&&v.check_in||which==='check_out'&&(v.check_out||!v.check_in)){render();return;}
  if(button)button.textContent='Finding your location…';
  const saved=await visitRecord(i,which);render();if(!saved)return;
  const s=visitState(i)[which];
  toast((which==='check_in'?'Checked in':'Checked out')+(s?.has_location?'':' (location unavailable)')+(offlineIsOnline()?'.':' on this device. It syncs when you’re back online.'));
  offlineSync();return;
 }
 if(name==='visit-override'){const i=inspection();return dialog('Mark visit as verified',`<p class="full muted vv-full">Use this when you have other proof the visit happened (for example, a call with the inspector at the residence). Your name and reason are shown on the report and recorded in the audit log.</p>`+textarea('reason','Reason (at least 10 characters)'),'Mark verified',async b=>{if(String(b.reason||'').trim().length<10)throw Error('Give a reason of at least 10 characters.');await api('inspections/'+encodeURIComponent(i.id)+'/visit/override',{reason:b.reason});toast('Visit marked as verified.');});}
 if(name==='visit-filter'){visitFilterValue=key||'';render();return;}
 if(name==='visit-settings')return visitSettingsDialog();
 if(name==='property-location'){const p=data.properties.find(x=>x.id===key);if(!p)throw Error('Residence unavailable.');return visitLocationDialog(p);}
 if(name==='vv-use-location'){
  if(button)button.textContent='Finding your location…';
  const pos=await visitCapture();if(button)button.textContent='Use my current location';
  if(pos.source!=='gps')throw Error(pos.source==='denied'?'Location permission is off for this site. Turn it on in your browser or phone settings.':'Could not get a location. Try again outdoors, or enter the coordinates.');
  $('f-latitude').value=pos.lat.toFixed(6);$('f-longitude').value=pos.lon.toFixed(6);$('f-source').value='device';toast(`Location filled in (GPS accuracy ±${Math.round(pos.accuracy)} m). Save to keep it.`);return;
 }
 if(name==='vv-geocode'){const r=await api('properties/location',{id:key,geocode:true});$('f-latitude').value=Number(r.latitude).toFixed(6);$('f-longitude').value=Number(r.longitude).toFixed(6);$('f-source').value='manual';await load();toast('Location found from the address.');return visitLocationDialog(data.properties.find(x=>x.id===key));}
 if(name==='inspection-publish'){const i=inspection();if(i&&vvOn()&&isStaff()){await visitAutoCheckOut(i);if(navigator.onLine)await offlineSync();}}
 return visitBaseAction(name,key,button);
};
