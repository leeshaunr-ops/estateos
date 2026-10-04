/* Smart-lock access windows (browser). Temporary door codes on visits and work orders, shown to the assignee only during
   the access window (every reveal is audit-logged on the server), lock entries next to GPS check-in in the Visit
   verification box, the residence's locks (Records tab), and the Smart locks section of Company settings.
   Data comes from /api/data (data.smartLocks). Every value is escaped; no inline styles or scripts. */
const SL_LIVE=['needs_code','scheduled'];
const slRevealed=new Map();
const slData=()=>data?.smartLocks||{locks:[],codes:[],entries:[]};
const slAdmin=()=>data?.user?.role==='admin';
function slTz(propertyId){const p=(data.properties||[]).find(x=>x.id===propertyId);return p?.effective_timezone||p?.timezone||data.companyTimezone||'America/New_York';}
function slWhen(iso,tz){try{return window.EAVisit.formatTime(iso,tz);}catch{return new Date(iso).toLocaleString();}}
function slParts(iso,tz){const d=new Date(iso),z=window.EAVisit?.validTimezone?.(tz)?tz:'America/New_York';const day=d.toLocaleDateString('en-US',{timeZone:z,weekday:'short',month:'short',day:'numeric'});const time=d.toLocaleTimeString('en-US',{timeZone:z,hour:'numeric',minute:'2-digit'}).replace(/[\u202f\u00a0]/g,' ');const zone=(d.toLocaleTimeString('en-US',{timeZone:z,timeZoneName:'short'}).split(' ').pop())||'';return {day,time,zone};}
/** "Mon, Oct 5 · 7:30 AM – 6:30 PM EDT" (or both days when the window crosses midnight). */
function slRange(start,end,tz){const a=slParts(start,tz),b=slParts(end,tz);return a.day===b.day?`${a.day} · ${a.time} – ${b.time} ${b.zone}`:`${a.day} ${a.time} – ${b.day} ${b.time} ${b.zone}`;}
function slPhase(c,nowMs=Date.now()){if(!SL_LIVE.includes(c.status))return 'ended';if(nowMs<Date.parse(c.starts_at))return 'upcoming';if(nowMs>Date.parse(c.ends_at))return 'ended';return 'active';}
function slPill(c){const ph=slPhase(c);
 if(c.status==='revoked')return '<span class="badge">Revoked</span>';
 if(c.status==='expired'||ph==='ended')return '<span class="badge">Expired</span>';
 if(c.status==='needs_code')return `<span class="badge amber">${slAdmin()?'Code needed':'Being set up'}</span>`;
 if(ph==='active')return '<span class="badge ck-pass">Active now</span>';
 return '<span class="badge">Scheduled</span>';}
const slProviderName=k=>k==='manual'?'Manual code':k==='seam'?'Seam':k==='fake'?'Test lock service':'Lock service';
function slCodesFor(type,id){return slData().codes.filter(c=>c.source_type===type&&c.source_id===id).sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at)));}
function slEntriesFor(type,id){return slData().entries.filter(e=>e.source_type===type&&e.source_id===id);}
function slEntryText(e,tz){return `${e.lock_name} ${e.kind==='access_denied'?'refused a code':'unlocked'} ${slWhen(e.occurred_at,tz)}${e.kind==='unlocked'?` (${e.method_label})`:''}${e.by_code?' · '+e.by_code:''}`;}

/* ---------- door code card (visits and jobs) ---------- */
function slCodeRow(c){
 const tz=slTz(c.property_id),ph=slPhase(c),shown=slRevealed.get(c.id),admin=slAdmin(),live=SL_LIVE.includes(c.status);
 let body='';
 if(shown&&live)body=`<div class="sl-code" role="status" aria-live="polite"><span class="sl-code-label">Door code</span><strong class="sl-code-digits">${esc(shown.code.split('').join(' '))}</strong><small>Works until ${esc(slWhen(c.ends_at,tz))}. Viewing is recorded.</small></div>`;
 else if(live&&c.mine&&c.status==='needs_code')body=`<p class="sl-note">Your office is setting up this code. It shows here once it is ready.</p>`;
 else if(live&&c.mine&&ph==='upcoming')body=`<p class="sl-note">Your door code shows here from ${esc(slWhen(c.starts_at,tz))} until ${esc(slWhen(c.ends_at,tz))}.</p>`;
 else if(c.mine&&!live)body=`<p class="sl-note">${c.status==='revoked'?'This code was cancelled. Contact your office if you still need access.':'This code has expired.'}</p>`;
 const acts=[],more=[];
 if(live&&c.can_reveal&&!shown)acts.push(btn('Show door code','sl-reveal',c.id,c.mine&&ph==='active'));
 if(shown)acts.push(btn('Hide code','sl-hide',c.id));
 if(admin&&live&&!data.offline){if(c.provider==='manual'||!c.has_code){more.push(btn(c.has_code?'Change code':'Enter code','sl-enter',c.id));more.push(btn(c.has_code?'Generate a new code':'Generate code','sl-generate',c.id));}more.push(btn('Revoke code','sl-revoke',c.id));}
 if(admin&&c.removal_work_id)more.push(btn('Open removal task','sl-open-work',c.removal_work_id));
 const facts=[`For ${esc(c.assignee_name)}`,esc(slProviderName(c.provider))];
 if(admin&&c.has_code&&c.code_hint)facts.push('ends in '+esc(c.code_hint));
 if(admin&&c.provider_error)facts.push(`<span class="sl-error">${esc(c.provider_error)}</span>`);
 return `<div class="sl-code-row"><div class="sl-code-head"><div><strong>${esc(c.lock_name)}</strong><small>${esc(slRange(c.starts_at,c.ends_at,tz))}</small><small>${facts.join(' · ')}</small></div>${slPill(c)}</div>${body}${acts.length||more.length?`<div class="actions sl-actions">${acts.join('')}${moreMenu(more.join(''))}</div>`:''}</div>`;
}
function slDoorPanel(type,id,propertyId){
 const S=slData(),staff=isStaff(),admin=slAdmin();
 const codes=slCodesFor(type,id).filter(c=>admin||c.mine);
 const locks=(S.locks||[]).filter(l=>l.property_id===propertyId);
 if(!codes.length&&!(admin&&locks.length))return '';
 const showing=codes.filter(c=>SL_LIVE.includes(c.status)||c.mine||admin).slice(-6);
 const s=S.settings||{};
 const empty=!showing.length?`<p class="sl-note">${locks.length} lock${locks.length===1?'':'s'} at this residence. A temporary code is created when this ${type==='inspection'?'visit':'job'} has an assignee and a date within the next two weeks${s.autoCreate===false?' (automatic codes are off, so create it here)':''}.</p>`:'';
 const create=admin&&!data.offline&&locks.length&&!showing.some(c=>SL_LIVE.includes(c.status))?`<div class="actions sl-actions">${btn('Create door code','sl-create',type+':'+id)}</div>`:'';
 return `<section class="panel sl-door" aria-label="Door access"><div class="sl-door-head"><h2>Door access</h2><small>${staff?'Temporary codes for this '+(type==='inspection'?'visit':'job')+' only. Every view is recorded.':'Your temporary code for this job. Every view is recorded.'}</small></div>${showing.map(slCodeRow).join('')}${empty}${create}</section>`;
}

/* ---------- lock entries in the Visit verification box ---------- */
const slBaseVisitSection=visitSection;
visitSection=function(i,status){
 const html=slBaseVisitSection(i,status),entries=slEntriesFor('inspection',i.id),tz=slTz(i.property_id);
 const rows=entries.map(e=>`<dt>Lock entry</dt><dd>${esc(slEntryText(e,tz))}</dd>`).join('');
 let out=html;
 if(rows){
  const at=html.indexOf('</dl>');
  if(at>=0)out=html.slice(0,at)+rows+html.slice(at);
  else out=html+`<section class="panel visit-card visit-proof" aria-label="Visit verification"><div class="visit-head"><h2>Visit verification</h2><span class="badge ck-pass">Lock entry recorded</span></div><dl class="visit-rows">${rows}</dl></section>`;
 }
 return out+(isStaff()?slDoorPanel('inspection',i.id,i.property_id):'');
};

/* ---------- work orders (staff app and vendor portal) ---------- */
const slBaseWorkDetail=workDetail;
workDetail=function(w){
 const html=slBaseWorkDetail(w);if(data.user.role==='client')return html;
 const entries=slEntriesFor('work_order',w.id),tz=slTz(w.property_id);
 const entryBlock=entries.length?`<div class="sl-entries"><h3 class="work-sub">Lock entries</h3><dl class="visit-rows">${entries.map(e=>`<dt>Lock entry</dt><dd>${esc(slEntryText(e,tz))}</dd>`).join('')}</dl></div>`:'';
 const panel=slDoorPanel('work_order',w.id,w.property_id);
 if(!panel&&!entryBlock)return html;
 const block=`<div class="sl-work">${panel.replace('<section class="panel sl-door"','<section class="sl-door sl-door-inline"')}${entryBlock}</div>`;
 const at=html.indexOf('<div class="work-activity">');
 if(at>=0)return html.slice(0,at)+block+html.slice(at);
 const end=html.lastIndexOf('</section>');return end>=0?html.slice(0,end)+block+html.slice(end):html+block;
};

/* ---------- residence: locks (Records tab) ---------- */
function slLockStatus(l){
 if(l.provider==='manual')return '<span class="badge">Manual codes</span>';
 if(!l.online)return '<span class="badge red">Offline</span>';
 if(typeof l.battery_level==='number'&&l.battery_level<=0.2)return `<span class="badge amber">Battery ${Math.round(l.battery_level*100)}%</span>`;
 return `<span class="badge ck-pass">Online${typeof l.battery_level==='number'?' · battery '+Math.round(l.battery_level*100)+'%':''}</span>`;
}
function slResidencePanel(p){
 const S=slData(),admin=slAdmin(),locks=(S.locks||[]).filter(l=>l.property_id===p.id),tz=slTz(p.id);
 const codes=(S.codes||[]).filter(c=>c.property_id===p.id&&SL_LIVE.includes(c.status));
 const label=c=>{if(c.source_type==='inspection'){const i=data.inspections.find(x=>x.id===c.source_id);return i?`Visit · ${fmtDay(i.inspection_date)}`:'Visit';}const w=data.work.find(x=>x.id===c.source_id);return w?`Work order · ${w.title}`:'Work order';};
 const lockRows=locks.map(l=>resRow(esc(l.name),esc(slProviderName(l.provider))+(l.last_event_at?' · last activity '+esc(slWhen(l.last_event_at,tz)):''),slLockStatus(l)+(admin&&!data.offline?moreMenu(btn('Rename','sl-lock-edit',l.id)+btn('Remove lock','sl-lock-remove',l.id)):''))).join('');
 const codeRows=codes.map(c=>resRow(esc(label(c)),`${esc(c.lock_name)} · ${esc(slRange(c.starts_at,c.ends_at,tz))} · for ${esc(c.assignee_name)}`,slPill(c)+(admin&&!data.offline&&c.status==='needs_code'?btn('Enter code','sl-enter',c.id):''))).join('');
 if(!locks.length&&!admin)return '';
 return `<section class="res-record sl-res" id="res-locks"><div class="res-panel-head"><h2>Smart locks</h2><div class="actions">${admin&&!data.offline?btn('Add lock','sl-lock-add',p.id,!locks.length):''}</div></div><div class="panel res-panel">${lockRows||`<p class="res-empty">No locks yet. Add the keypad or smart lock at this residence and every visit and job gets its own temporary door code, valid only for its time window.</p>`}</div>${codes.length?`<h3 class="sl-sub">Upcoming door codes</h3><div class="panel res-panel">${codeRows}</div>`:''}</section>`;
}
const slBaseResidenceView=residenceView;
residenceView=function(...args){
 const html=slBaseResidenceView(...args);if(!isStaff()||resTab(tab)!=='records')return html;
 const p=data.properties.find(x=>x.id===propertyId);if(!p)return html;
 const panel=slResidencePanel(p);if(!panel)return html;
 const at=html.indexOf('<section class="res-record" id="res-assets">');return at<0?html+panel:html.slice(0,at)+panel+html.slice(at);
};

/* ---------- Company settings ---------- */
function slSettingsPanel(){
 const S=slData(),s=S.settings||{},c=S.connection||{},t=v=>{const [h,m]=String(v||'08:00').split(':').map(Number);const d=new Date(Date.UTC(2026,0,1,h,m));return d.toLocaleTimeString('en-US',{timeZone:'UTC',hour:'numeric',minute:'2-digit'});};
 const status=c.configured?(c.accounts?`<span class="badge ck-pass">Connected</span> ${esc(slProviderName(c.provider))} · ${c.accounts} lock account${c.accounts===1?'':'s'}`:`<span class="badge amber">Ready to connect</span> ${esc(slProviderName(c.provider))}`):'<span class="badge">Manual codes</span> No lock service connected';
 const how=c.configured?(c.accounts?'Add each lock under the residence (Records › Smart locks › Add lock) and choose it from your connected account. Codes are then created and removed on the lock for you.':'Connect the lock brand account you use (August, Yale, Schlage, Kwikset and many others) to start creating codes on the lock automatically.'):'Manual mode works today: your team enters or generates each temporary code and programs it on the lock, the app shows it only during the window and reminds you to remove it. To create and remove codes on the lock automatically and record lock entries, ask EstateAegis support to turn on the Seam lock connection, then connect your lock account here.';
 const facts=factList([['Connection',status],['Lock entries and battery alerts',c.events?'On':'<span class="set-empty">Off</span>'],['Visits without set hours',esc(t(s.defaultStart)+' – '+t(s.defaultEnd))+' at the residence'],['Extra time before and after',esc(String(s.bufferMinutes??30))+' minutes'],['Code length',esc(String(s.codeLength||6))+' digits'],['Create codes automatically',s.autoCreate===false?'Off':'On']]);
 const acts=btn('Edit','sl-settings')+(c.configured?btn(c.accounts?'Connect another lock account':'Connect lock account','sl-connect')+(c.accounts?'':btn('Check connection','sl-connect-check')):'');
 return resPanel('Smart locks',facts+`<p class="set-note">${esc(how)}</p>`,`<div class="actions">${acts}</div>`);
}
const slBaseSettingsView=settingsView;
settingsView=function(...args){
 const html=slBaseSettingsView(...args);if(!data.smartLocks||!slAdmin())return html;
 const marker='<section class="panel res-panel ';const more=html.lastIndexOf(marker);
 return more<0?html+slSettingsPanel():html.slice(0,more)+slSettingsPanel()+html.slice(more);
};

/* ---------- actions ---------- */
function slCode(id){const c=slData().codes.find(x=>x.id===id);if(!c)throw Error('Door code not found. Refresh and try again.');return c;}
const slBaseAction=action;
action=async function(name,key,button){
 if(!String(name).startsWith('sl-'))return slBaseAction(name,key,button);
 switch(name){
  case 'sl-reveal':{const r=await api('smart-locks/codes/reveal',{id:key});slRevealed.set(key,{code:r.code,at:Date.now()});setTimeout(()=>{if(slRevealed.get(key)?.code===r.code){slRevealed.delete(key);if(!$('modal')?.open)render();}},120000);render();return;}
  case 'sl-hide':slRevealed.delete(key);render();return;
  case 'sl-enter':{const c=slCode(key);return dialog(c.has_code?'Change door code':'Enter door code',`<p class="full muted">${esc(c.lock_name)} · ${esc(slRange(c.starts_at,c.ends_at,slTz(c.property_id)))} · for ${esc(c.assignee_name)}</p><div class="field"><label for="f-code">Door code (4 to 12 digits)</label><input id="f-code" name="code" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,12}" required></div><p class="full muted">Program the same code on the lock with its app or keypad, set to work only during this window if the lock allows it.</p>`,'Save code',async v=>{await api('smart-locks/codes/set',{id:key,code:v.code,version:c.version});toast('Door code saved. It shows to the assignee only during the window.');});}
  case 'sl-generate':{const c=slCode(key);if(c.has_code&&!confirm('Replace the current code with a new one? Remember to change it on the lock too.'))return;const r=await api('smart-locks/codes/set',{id:key,generate:true,version:c.version});await load();return dialog('Program this code on the lock',`<div class="sl-code full"><span class="sl-code-label">${esc(c.lock_name)}</span><strong class="sl-code-digits">${esc(String(r.code).split('').join(' '))}</strong><small>${esc(slRange(c.starts_at,c.ends_at,slTz(c.property_id)))}</small></div><p class="full muted">Add this code on the lock now. The assignee sees it only during the window, and you get a reminder to remove it afterwards.</p>`,'Done',async()=>{});}
  case 'sl-revoke':{const c=slCode(key);if(!confirm(`Revoke the ${c.lock_name} code for ${c.assignee_name}? ${c.provider==='manual'?'You will get a task to remove it from the lock.':'It is removed from the lock now.'}`))return;await api('smart-locks/codes/revoke',{id:key});slRevealed.delete(key);await load();toast('Door code revoked.');return;}
  case 'sl-create':{const [type,id]=String(key).split(':');const r=await api('smart-locks/codes/create',{sourceType:type,sourceId:id});await load();toast(`${r.created} door code${r.created===1?'':'s'} ready to set up.`);return;}
  case 'sl-open-work':page='work';activeWork=key;render();window.scrollTo(0,0);return;
  case 'sl-lock-add':{
   const S=slData(),c=S.connection||{};let devices=[];
   if(c.configured&&c.accounts){try{devices=(await api('smart-locks/devices',{})).devices.filter(d=>!d.linked);}catch{devices=[];}}
   const choices=`<option value="manual">Manual: we program codes by hand</option>${devices.map(d=>`<option value="device:${esc(d.deviceId)}">${esc(d.name)}${d.model?' · '+esc(d.model):''}</option>`).join('')}`;
   return dialog('Add lock',`${input('name','Lock name (for example, Front door keypad)')}${select('lock','Lock',choices)}<p class="full muted">${devices.length?'Choose a lock from your connected account to have codes created and removed on it automatically, or Manual.':c.configured?'Connect a lock account in Company settings to pick a connected lock. Manual works today.':'Manual: your team enters or generates each temporary code and programs it on the lock.'}</p>`,'Add lock',async v=>{const device=String(v.lock||'').startsWith('device:')?v.lock.slice(7):'';await api('smart-locks/locks',{propertyId:key,name:v.name,provider:device?'seam':'manual',deviceId:device});toast('Lock added.');});
  }
  case 'sl-lock-edit':{const l=slData().locks.find(x=>x.id===key);if(!l)throw Error('Lock not found.');return dialog('Rename lock',input('name','Lock name','text',l.name),'Save',async v=>{await api('smart-locks/locks/update',{id:key,name:v.name});toast('Lock renamed.');});}
  case 'sl-lock-remove':{const l=slData().locks.find(x=>x.id===key);if(!l)throw Error('Lock not found.');if(!confirm(`Remove ${l.name}? Its upcoming door codes are revoked.`))return;await api('smart-locks/locks/remove',{id:key});await load();toast('Lock removed.');return;}
  case 'sl-settings':{const s=slData().settings||{};return dialog('Smart locks',`<p class="full muted">Each visit or job gets a temporary code valid for its time window plus the extra time below. Visits only have a date, so they use the hours below at the residence's time zone. Jobs linked to a staff schedule use the scheduled hours.</p>${input('defaultStart','Visits without set hours: start','time',s.defaultStart||'08:00')}${input('defaultEnd','Visits without set hours: end','time',s.defaultEnd||'18:00')}${input('bufferMinutes','Extra time before and after (minutes)','number',String(s.bufferMinutes??30))}${input('codeLength','Code length (digits)','number',String(s.codeLength||6))}<label class="check-row full"><input type="checkbox" name="autoCreate" ${s.autoCreate===false?'':'checked'}> <span>Create codes automatically when a visit or job is scheduled or assigned</span></label>`,'Save',async v=>{await api('smart-locks/settings',{defaultStart:v.defaultStart,defaultEnd:v.defaultEnd,bufferMinutes:Number(v.bufferMinutes),codeLength:Number(v.codeLength),autoCreate:v.autoCreate==='on'});toast('Smart lock settings saved.');});}
  case 'sl-connect':{const r=await api('smart-locks/connect',{});if(r.url&&/^https?:\/\//.test(r.url))window.open(r.url,'_blank','noopener');toast('Finish connecting in the new tab, then choose Check connection.');await load();return;}
  case 'sl-connect-check':{const r=await api('smart-locks/connect/check',{});await load();toast(r.accounts?'Lock account connected.':'Not connected yet. Finish the steps in the lock account tab, then check again.');return;}
 }
 return slBaseAction(name,key,button);
};
