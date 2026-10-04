/* Flight-aware arrival preparation (browser). Flights on an arrival (staff and client portal), the timed arrival plan
   ("4 h before landing"), "Residence ready" for the family, flight status on arrival cards and the Flight tracking
   section of Company settings. Data comes from /api/data (data.flights); times show in the residence's time zone.
   Every value is escaped; no inline styles or scripts. */
const flData=()=>data?.flights||{flights:[],tasks:[],settings:{}};
const flStaff=()=>['admin','employee'].includes(data?.user?.role);
function flTz(arrival){const p=(data.properties||[]).find(x=>x.id===arrival?.property_id);return p?.effective_timezone||p?.timezone||data.companyTimezone||'America/New_York';}
function flZone(tz){return window.EAVisit?.validTimezone?.(tz)?tz:'America/New_York';}
function flTime(iso,tz,withDay=false){if(!iso)return '';const d=new Date(iso),z=flZone(tz);const t=d.toLocaleTimeString('en-US',{timeZone:z,hour:'numeric',minute:'2-digit',timeZoneName:'short'}).replace(/[\u202f\u00a0]/g,' ');return withDay?d.toLocaleDateString('en-US',{timeZone:z,weekday:'short',month:'short',day:'numeric'})+' · '+t:t;}
/** ISO → 'YYYY-MM-DDTHH:MM' on the residence's clock (for datetime-local inputs). */
function flLocal(iso,tz){if(!iso)return '';const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:flZone(tz),hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(iso)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${String(Number(p.hour)%24).padStart(2,'0')}:${p.minute}`;}
function flSpan(min){const m=Math.abs(Math.round(min)),h=Math.floor(m/60),r=m%60;return h&&r?`${h} h ${r} min`:h?`${h} h`:`${r} min`;}
function flDay(day){const d=new Date(day+'T12:00:00Z');return d.toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'});}
const flFlightsFor=id=>flData().flights.filter(f=>f.arrival_id===id);
const flTasksFor=id=>flData().tasks.filter(t=>t.arrival_id===id);
const flToneClass=t=>({pass:'fl-pass',monitor:'amber',fail:'red'}[t]||'');
const flOpen=a=>!['completed','cancelled'].includes(a.status);
function flReadiness(a){const rooms=a.room_status||[],items=a.items||[],tasks=flTasksFor(a.id).filter(t=>t.required);const total=rooms.length+items.length+tasks.length;const done=rooms.filter(r=>r.ready).length+items.filter(i=>['purchased','stocked'].includes(i.status)).length+tasks.filter(t=>t.done_at).length;return {total,done,ready:['ready','completed'].includes(a.status)};}

/* ---------- arrival detail: readiness, flights, arrival plan ---------- */
function flReadyBanner(a){const r=flReadiness(a);
 if(r.ready)return `<div class="fl-ready" role="status"><span class="fl-ready-mark" aria-hidden="true">✓</span><div><strong>Residence ready</strong><small>${data.user.role==='client'?'Everything on your arrival checklist is done. We look forward to welcoming you.':'The readiness checklist is complete.'}</small></div></div>`;
 if(data.user.role!=='client'||!r.total)return '';
 return `<div class="fl-preparing" role="status"><strong>Preparing your residence</strong><small>${r.done} of ${r.total} checklist items done. You will see “Residence ready” here when everything is in place.</small></div>`;}
function flFlightRow(f,a){
 const tz=flTz(a),staff=flStaff(),S=flData(),dep=f.direction==='departure',auto=f.tracked&&S.live;
 const route=[f.origin,f.diverted_to||f.destination].filter(Boolean).join(' → ');
 const times=[];
 if(f.scheduled_at)times.push(`${dep?'Departs':'Lands'} ${esc(flTime(f.scheduled_at,tz,true))} scheduled`);
 if(f.eta&&f.eta!==f.scheduled_at&&!f.actual_at)times.push(`now ${esc(flTime(f.eta,tz))}`);
 const source=auto?'Updates automatically from the flight service':`Updated by hand${f.updated_at?' · '+esc(flTime(f.updated_at,tz,true)):''}`;
 let close='';if(dep&&f.closedown)close=f.closedown_inspection_id?`<p class="fl-note">Close-down visit created. ${staff?btn('Open visit','fl-open-visit',f.closedown_inspection_id):''}</p>`:`<p class="fl-note">The close-down visit starts ${S.settings?.closedownDelayMinutes?esc(flSpan(S.settings.closedownDelayMinutes))+' after':'when'} this flight departs.</p>`;
 const acts=[],more=[];
 if(flOpen(a)&&!data.offline){if(!auto)acts.push(btn(dep?'Update departure':'Update ETA','fl-eta',f.id));if(staff&&S.live)more.push(btn('Check status now','fl-refresh',f.id));if(staff||(data.user.role==='client'&&f.mine))more.push(btn('Remove flight','fl-remove',f.id));}
 return `<div class="fl-flight"><div class="fl-flight-head"><div class="fl-flight-id"><span class="fl-dir">${dep?'Departure':'Arrival'}</span><strong>${esc(f.ident)}</strong><small>${esc(flDay(f.flight_date))}${route?' · '+esc(route):''}</small></div><span class="badge ${flToneClass(f.tone)}">${esc(f.status_label)}</span></div>${times.length?`<p class="fl-times">${times.join(' · ')}</p>`:''}<p class="fl-note">${source}${staff&&f.provider_error?` · <span class="fl-error">${esc(f.provider_error)}</span>`:''}</p>${close}${acts.length||more.length?`<div class="actions fl-actions">${acts.join('')}${moreMenu(more.join(''))}</div>`:''}</div>`;
}
function flTaskRow(t,a){
 const tz=flTz(a),staff=flStaff(),done=!!t.done_at;
 const due=t.due_at?`Due ${esc(flTime(t.due_at,tz,true))}`:'Due time set once a flight or arrival time is known';
 const moved=t.moved_minutes&&!done?` · moved ${flSpan(t.moved_minutes)} ${t.moved_minutes>0?'later':'earlier'} with the flight`:'';
 const who=t.assignee_name?` · ${esc(t.assignee_name)}`:'';
 const end=done?`<span class="badge fl-pass">Done${t.done_by_name?' · '+esc(t.done_by_name):''}</span>`:'<span class="badge">To do</span>';
 const acts=staff&&!data.offline?(done?moreMenu(btn('Mark not done','fl-task-undo',t.id)+(flOpen(a)?btn('Remove task','fl-task-remove',t.id):'')):btn('Mark done','fl-task-done',t.id)+(flOpen(a)?moreMenu(btn('Remove task','fl-task-remove',t.id)):'')):'';
 return `<div class="fl-task ${done?'fl-task-done':''}"><div class="fl-task-text"><strong>${esc(t.title)}</strong><small>${esc(t.offset_label)} · ${due}${moved}${who}</small></div><div class="fl-task-end">${end}${acts?`<div class="actions">${acts}</div>`:''}</div></div>`;
}
function flBlock(a){
 const flights=flFlightsFor(a.id),tasks=flTasksFor(a.id),staff=flStaff(),client=data.user.role==='client',S=flData(),open=flOpen(a)&&!data.offline;
 const intro=S.live?'Flights update automatically. The arrival plan moves with the landing time.':`Update the ETA here if the flight changes${client?'; your team is alerted':''}. The arrival plan moves with it.`;
 const flightsPanel=`<section class="panel fl-panel" aria-label="Flights"><div class="fl-head"><div><h2>Flights</h2><small>${flights.length?esc(intro):client?'Add your flight and we will time the house around your landing.':'Add the family’s flight to time the preparation around the landing.'}</small></div>${open&&(staff||client)?`<div class="actions">${btn('Add flight','fl-add',a.id,!flights.length)}</div>`:''}</div>${flights.map(f=>flFlightRow(f,a)).join('')}</section>`;
 const missing=SUGGESTED_FL.filter(s=>!tasks.some(t=>t.title===s));
 const planActs=staff&&open?`<div class="actions">${btn('Add task','fl-task-add',a.id)}${missing.length?btn(tasks.length?'Add suggested tasks':'Use suggested plan','fl-task-suggested',a.id,!tasks.length):''}</div>`:'';
 const planEmpty=`<p class="fl-empty">${staff?'Time each step to the landing: for example air conditioning or heat 4 hours before, flowers and groceries 2 hours before, and the driver at landing.':'Your team has not added timed steps for this arrival.'}</p>`;
 const plan=(staff||tasks.length)?`<section class="panel fl-panel" aria-label="Arrival plan"><div class="fl-head"><div><h2>Arrival plan</h2><small>${staff?'Due times follow the first flight’s landing (or the arrival time). Steps due before landing must be done before the residence is marked ready.':'Timed to your landing.'}</small></div>${planActs}</div>${tasks.map(t=>flTaskRow(t,a)).join('')||planEmpty}</section>`:'';
 return `<div class="fl-block">${flReadyBanner(a)}${flightsPanel}${plan}</div>`;
}
const SUGGESTED_FL=['Turn on air conditioning or heat','Fresh flowers and groceries in place','Driver waiting at the airport'];
const flBaseArrivalDetail=arrivalDetail;
arrivalDetail=function(a){
 const html=flBaseArrivalDetail(a);if(data.user.role==='vendor')return html;
 const at=html.indexOf('<div class="two">');const block=flBlock(a);
 return at<0?html+block:html.slice(0,at)+block+html.slice(at);
};
function flSummary(a){const f=flFlightsFor(a.id).filter(x=>x.direction!=='departure')[0]||flFlightsFor(a.id)[0];const r=flReadiness(a);
 return `${f?`<span class="badge ${flToneClass(f.tone)}">${esc(f.ident)} · ${esc(f.status_label)}</span>`:''}${r.ready?'<span class="badge fl-pass">Residence ready ✓</span>':''}`;}
const flBaseArrivalCards=arrivalCards;
arrivalCards=function(rows){if(!rows.length||data.user.role==='vendor')return flBaseArrivalCards(rows);
 return rows.map(a=>{const h=flBaseArrivalCards([a]),s=flSummary(a);if(!s)return h;const end=h.lastIndexOf('</button>');return h.slice(0,end)+`<div class="actions fl-card-line">${s}</div>`+h.slice(end);}).join('');};
const flBaseArrivalRows=arrivalRows;
arrivalRows=function(rows){if(!rows.length||data.user.role==='vendor')return flBaseArrivalRows(rows);
 return rows.map(a=>{const h=flBaseArrivalRows([a]),s=flSummary(a);if(!s)return h;const at=h.indexOf('<p class="pre">');return at<0?h:h.slice(0,at)+`<div class="actions fl-card-line">${s}${btn('Open arrival','arrival-open',a.id)}</div>`+h.slice(at);}).join('');};

/* ---------- Company settings ---------- */
function flSettingsPanel(){
 const S=flData(),s=S.settings||{},c=S.connection||{};
 const status=c.configured?`<span class="badge fl-pass">Connected</span> ${esc(S.providerLabel||'Flight service')}${c.alerts?' · live alerts':' · checked every 10 to 60 minutes'}`:'<span class="badge">Manual updates</span> No flight service connected';
 const how=c.configured?'Flights added to an arrival are tracked automatically: delays, early arrivals, diversions and cancellations alert your team, and the arrival plan moves with the landing time.':'Manual mode works today: staff or the family update a flight’s ETA and status on the arrival, your team is alerted, and the arrival plan moves with it. To track flights automatically, ask EstateAegis support to turn on the FlightAware connection.';
 const facts=factList([['Connection',status],['Alert when the time moves by',esc(String(s.alertMinutes??20))+' minutes or more'],['Close-down visit after departure',esc(String(s.closedownDelayMinutes??60))+' minutes after takeoff, when chosen on the flight']]);
 return resPanel('Flight tracking',facts+`<p class="set-note">${esc(how)}</p>`,`<div class="actions">${btn('Edit','fl-settings')}</div>`);
}
const flBaseSettingsView=settingsView;
settingsView=function(...args){const html=flBaseSettingsView(...args);if(!data.flights||data.user.role!=='admin')return html;
 const marker='<section class="panel res-panel ';const more=html.lastIndexOf(marker);return more<0?html+flSettingsPanel():html.slice(0,more)+flSettingsPanel()+html.slice(more);};

/* ---------- actions ---------- */
function flFlight(id){const f=flData().flights.find(x=>x.id===id);if(!f)throw Error('Flight not found. Refresh and try again.');return f;}
function flArrival(id){const a=data.arrivals.find(x=>x.id===id);if(!a)throw Error('Arrival not found. Refresh and try again.');return a;}
const flBaseAction=action;
action=async function(name,key,button){
 if(!String(name).startsWith('fl-'))return flBaseAction(name,key,button);
 switch(name){
  case 'fl-add':{const a=flArrival(key),tz=flTz(a),S=flData(),day=String(a.arrival_at||'').slice(0,10);
   return dialog('Add flight',`${select('direction','Flight','<option value="arrival">Arriving at the residence</option><option value="departure">Leaving after the stay</option>')}${input('airline','Airline code (for example DL, UA, B6)')}${input('flightNumber','Flight number','text','',true)}${input('date','Flight date (as on the ticket)','date',day)}${input('scheduledAt',`Scheduled landing or takeoff (${flTime(new Date().toISOString(),tz).split(' ').pop()}, residence time)`,'datetime-local',S.live?'':String(a.arrival_at||'').slice(0,16),false)}<label class="check-row full"><input type="checkbox" name="closedown"> <span>For a departure flight: start the close-down visit after it departs</span></label><p class="full fl-help">${S.live?'The flight is looked up and tracked automatically; the time is only needed if the flight service cannot find it yet.':'Times are on the residence’s clock. You can update the ETA later if the flight changes.'}</p>`,'Add flight',async v=>{const r=await api('flights/add',{arrivalId:key,direction:v.direction,airline:v.airline,flightNumber:v.flightNumber,date:v.date,scheduledAt:v.scheduledAt||'',closedown:v.closedown==='on'});toast(r.tracked?'Flight added and tracked.':'Flight added.');});}
  case 'fl-eta':{const f=flFlight(key),a=flArrival(f.arrival_id),tz=flTz(a),dep=f.direction==='departure';
   const opts=(dep?[['scheduled','On schedule'],['departed','Departed'],['cancelled','Cancelled']]:[['scheduled','On schedule'],['en_route','In the air'],['landed','Landed'],['diverted','Diverted'],['cancelled','Cancelled']]).map(([v,l])=>`<option value="${v}" ${f.status===v||(v==='landed'&&f.status==='arrived')?'selected':''}>${l}</option>`).join('');
   return dialog(dep?`Update departure · ${f.ident}`:`Update ETA · ${f.ident}`,`${select('status','Status',opts)}${input('eta',dep?'Departure time (residence time)':'Landing time (residence time)','datetime-local',flLocal(f.actual_at||f.eta,tz),false)}${dep?'':input('divertedTo','If diverted: airport (optional)','text',f.diverted_to||'',false)}<p class="full fl-help">Your team is alerted when the time moves by ${esc(String(flData().settings?.alertMinutes??20))} minutes or more, and the arrival plan moves with it.</p>`,'Save',async v=>{await api('flights/eta',{id:key,version:f.version,status:v.status,eta:v.eta||'',divertedTo:v.divertedTo||''});toast('Flight updated.');});}
  case 'fl-remove':{const f=flFlight(key);if(!confirm(`Remove flight ${f.ident}?`))return;await api('flights/remove',{id:key});await load();toast('Flight removed.');return;}
  case 'fl-refresh':{const r=await api('flights/refresh',{id:key});await load();toast(r.error?r.error:'Flight status updated.');return;}
  case 'fl-task-add':{const staff=(data.users||[]).filter(u=>['admin','employee'].includes(u.role)&&u.active!==0&&u.active!==false);
   return dialog('Add a timed task',`${input('title','Task (for example, Turn on the pool heater)')}${input('hours','How many hours','number','2')}${select('when','When','<option value="-landing">Before landing</option><option value="+landing">After landing</option><option value="-departure">Before departure</option><option value="+departure">After departure</option>')}${staff.length?select('assigneeId','Assign to (optional)','<option value="">No one yet</option>'+staff.map(u=>`<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')):''}<p class="full fl-help">Use 0 hours for “at landing”. Quarter hours work too (0.25 = 15 minutes).</p>`,'Add task',async v=>{const h=Number(v.hours);if(!Number.isFinite(h)||h<0)throw Error('Enter the number of hours (0 or more).');const sign=String(v.when).startsWith('-')?-1:1;await api('flights/tasks/add',{arrivalId:key,title:v.title,offsetMinutes:Math.round(h*60)*sign,anchor:String(v.when).slice(1),assigneeId:v.assigneeId||''});toast('Task added to the arrival plan.');});}
  case 'fl-task-suggested':{const r=await api('flights/tasks/suggested',{arrivalId:key});await load();toast(r.added?`${r.added} timed task${r.added===1?'':'s'} added.`:'The suggested tasks are already in the plan.');return;}
  case 'fl-task-done':await api('flights/tasks/done',{id:key,done:true});await load();toast('Marked done.');return;
  case 'fl-task-undo':await api('flights/tasks/done',{id:key,done:false});await load();return;
  case 'fl-task-remove':{if(!confirm('Remove this task from the arrival plan?'))return;await api('flights/tasks/remove',{id:key});await load();toast('Task removed.');return;}
  case 'fl-open-visit':return flBaseAction('inspection',key,button);
  case 'fl-settings':{const s=flData().settings||{};return dialog('Flight tracking',`${input('alertMinutes','Alert the team when the time moves by (minutes)','number',String(s.alertMinutes??20))}${input('closedownDelayMinutes','Start the close-down visit this long after takeoff (minutes)','number',String(s.closedownDelayMinutes??60))}<p class="full fl-help">Delays, early arrivals, diversions and cancellations go to the primary administrator, the residence manager and anyone assigned a timed task, in the bell and by email.</p>`,'Save',async v=>{await api('flights/settings',{alertMinutes:Number(v.alertMinutes),closedownDelayMinutes:Number(v.closedownDelayMinutes)});toast('Flight tracking settings saved.');});}
 }
 return flBaseAction(name,key,button);
};
