// Field inspector logins (Oct 2026).
//  - For an inspector: the "Today" page (today's route, overdue, coming up, waiting for office review), door/alarm
//    codes on the day of a visit, and directions. They can open their assigned visits and nothing else; the server
//    enforces this with an allow-list (inspector.mjs), this file only shapes the screens.
//  - For an admin: the field inspector panel on Team & access (allowance, assigned visits), the invite hint and
//    "Assign a visit" / "Assign to a field inspector" dialogs.
// Uses live.js globals (data, esc, btn, head, empty, badge, dialog, select, input, option, api, toast, render, $).
(function(){
 'use strict';
 const ME=()=>data&&data.user&&data.user.role==='inspector';
 const DAY=86400000;
 const dayIn=(tz,at=Date.now())=>{try{return new Intl.DateTimeFormat('en-CA',{timeZone:tz||undefined,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}catch{return new Date(at).toISOString().slice(0,10);}};
 const homeOf=i=>(data.properties||[]).find(p=>p.id===i.property_id)||{};
 const tzOf=p=>p.effective_timezone||p.timezone||data.companyTimezone||'America/New_York';
 const addressOf=p=>p.address||[p.street_address,p.city,p.state,p.postal_code].filter(Boolean).join(', ');
 const mapsDir=list=>{const stops=list.map(addressOf).filter(Boolean);if(!stops.length)return '';const dest=stops[stops.length-1],way=stops.slice(0,-1);return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination='+encodeURIComponent(dest)+(way.length?'&waypoints='+encodeURIComponent(way.join('|')):'');};
 const prettyDay=k=>{try{return new Date(k+'T12:00:00Z').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});}catch{return k;}};
 const queued=i=>typeof offlineDraft==='function'&&!!offlineDraft(i.id)?.completeQueued;
 const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;

 /** Groups an inspector's visits by the residence's local day. */
 function groups(){
  const out={today:[],overdue:[],soon:[],later:[],review:[]};
  for(const i of data.inspections||[]){
   if(i.status==='submitted'||queued(i)){out.review.push(i);continue;}
   if(i.status!=='draft')continue;
   const p=homeOf(i),today=dayIn(tzOf(p)),limit=dayIn(tzOf(p),Date.now()+14*DAY);
   if(i.inspection_date===today)out.today.push(i);else if(i.inspection_date<today)out.overdue.push(i);else if(i.inspection_date<=limit)out.soon.push(i);else out.later.push(i);
  }
  const byDay=(a,b)=>(a.inspection_date||'').localeCompare(b.inspection_date||'')||String(homeOf(a).name||'').localeCompare(String(homeOf(b).name||''));
  for(const k in out)out[k].sort(byDay);
  return out;
 }
 function card(i,{codes=false,when=true}={}){
  const p=homeOf(i),addr=addressOf(p),dir=addr?mapsDir([p]):'';
  const status=i.status==='submitted'||queued(i)?'<span class="badge amber">Waiting for office review</span>':'';
  const rooms=(()=>{try{const r=typeof p.room_profile==='string'?JSON.parse(p.room_profile||'{}'):(p.room_profile||{});return (r.rooms||[]).length;}catch{return 0;}})();
  return `<li class="fi-visit"><div class="fi-visit-text"><strong class="fi-visit-home">${esc(p.name||'Residence')}</strong>${addr?`<span class="fi-visit-address">${esc(addr)}</span>`:''}<span class="fi-visit-meta">${when?esc(prettyDay(i.inspection_date))+' · ':''}${esc((i.checklist&&i.checklist.name)||'Routine visit')}${rooms?' · '+esc(plural(rooms,'room')):''}</span>${status}</div>
<div class="fi-visit-actions">${btn(i.status==='draft'&&!queued(i)?'Open visit':'View visit','inspection',i.id,codes)}${codes?btn('Door & alarm codes','inspector-codes',i.property_id):''}${dir?`<a class="fi-link" href="${esc(dir)}" target="_blank" rel="noopener">Directions</a>`:''}</div></li>`;
 }
 const list=(rows,opts)=>`<ul class="fi-visits">${rows.map(i=>card(i,opts)).join('')}</ul>`;
 function todayPage(){
  const g=groups(),first=(data.user.name||'').split(' ')[0];
  const route=g.today.length?mapsDir(g.today.map(homeOf)):'';
  const todayLabel=prettyDay(dayIn(data.companyTimezone||undefined));
  const section=(title,rows,opts,extra='')=>`<section class="panel fi-section"><div class="fi-section-head"><h2>${esc(title)}</h2>${extra}</div>${rows.length?list(rows,opts):''}</section>`;
  return head(`Good ${new Date().getHours()<12?'morning':new Date().getHours()<17?'afternoon':'evening'}${first?', '+first:''}`,`${data.company||'Your company'} · Field inspector · ${todayLabel}`)
   +`<section class="panel fi-section fi-today"><div class="fi-section-head"><h2>Today’s route</h2>${route?`<a class="fi-route" href="${esc(route)}" target="_blank" rel="noopener">Open today’s route in Maps</a>`:''}</div>${g.today.length?`<p class="fi-note">${esc(plural(g.today.length,'visit'))} assigned to you today. Door and alarm codes open only today, for these homes.</p>`+list(g.today,{codes:true,when:false}):`<p class="fi-note">No visits assigned to you today.</p>`}</section>`
   +(g.overdue.length?section('Overdue',g.overdue,{},`<span class="badge red">${esc(plural(g.overdue.length,'visit'))}</span>`):'')
   +section('Coming up · next 14 days',g.soon,{})+(g.soon.length?'':'<p class="fi-empty muted">Nothing else scheduled for the next two weeks.</p>')
   +(g.later.length?`<p class="fi-note">${esc(plural(g.later.length,'more visit'))} scheduled after that.</p>`:'')
   +(g.review.length?section('Waiting for office review',g.review,{}):'')
   +`<p class="fi-help muted">You can open only the visits your office assigns to you. Save as you go; it works offline and syncs when you’re back online. Mark a visit complete and your office reviews it before the report goes to the family.</p>`;
 }
 /** live.js view() hook for inspectors: returns markup, or null to let the normal page render (visit, profile, notifications). */
 function page(name){
  if(!ME())return null;
  if(name==='dashboard')return todayPage();
  return null;
 }

 // ---- Admin side ----
 function allowance(){
  const b=data.billing||{},q=b.quote,users=(data.users||[]).filter(u=>u.role==='inspector');
  const used=Number(b.usage?.inspectors??users.filter(u=>u.active!==false&&u.active!==0).length);
  if(q)return {used,limit:Number(q.inspectors),free:Number(q.freeInspectors),extra:Number(q.extraInspectors||0),addon:b.inspectorAddon||null,planned:true};
  const freePer=Number(b.inspectorAddon?.freePerSeat||2),seats=Number(data.subscription?.seats||0);
  return {used,limit:null,free:null,extra:0,addon:b.inspectorAddon||null,freePer,seats,planned:false};
 }
 function inviteHint(){
  const a=allowance();
  return `<p class="field full fi-invite-hint">Field inspector logins open only the visits you assign them (checklist, photos, GPS check-in and that day’s door codes). They never use an admin/staff seat${a.planned?`: ${esc(a.used)} of ${esc(a.limit)} in use.`:'.'}</p>`;
 }
 function teamPanel(){
  if(!data||data.user.role!=='admin')return '';
  const a=allowance(),people=(data.users||[]).filter(u=>u.role==='inspector');
  const upcoming=id=>(data.inspections||[]).filter(i=>i.inspector_id===id&&i.status==='draft');
  const full=a.planned&&a.used>=a.limit;
  const allowanceText=a.planned?`${a.used} of ${a.limit} field inspector logins in use (${a.free} free with your plan${a.extra?` plus ${a.extra} extra`:''}).`:`${a.used} field inspector login${a.used===1?'':'s'}. Every plan includes 2 free per admin/staff user (8 on Essentials, 20 on Growth, 40 on Professional).`;
  const addon=a.addon&&a.addon.available?'Extra field inspectors are $5 each per month.':'Extra field inspectors beyond the free allowance ($5 each per month) aren’t available to add yet.';
  return `<section class="panel fi-team"><div class="fi-section-head"><h2>Field inspectors</h2>${full?'':btn('Invite a field inspector','inspector-invite')}</div>
<p class="fi-note">Field inspectors log in to run the visits you assign them: checklist, photos, GPS check-in and door codes on the day of the visit. They can’t see clients, other residences, work orders, invoices or messages, and they never use an admin/staff seat.</p>
<p class="fi-allowance${full?' fi-full':''}"><strong>${esc(allowanceText)}</strong> ${esc(full?addon+' Suspend an inspector who no longer needs access to free a login.':addon)}</p>
${people.length?`<ul class="fi-people">${people.map(u=>{const v=upcoming(u.id);return `<li class="fi-person"><div><strong>${esc(u.name)}</strong><span class="muted">${esc(u.email)}${u.active?'':' · Suspended'} · ${esc(v.length?plural(v.length,'open visit'):'No open visits')}${v[0]?` · next ${esc(prettyDay(v[0].inspection_date))}`:''}</span></div><div class="actions">${u.active?btn('Assign a visit','inspector-assign',u.id):''}</div></li>`;}).join('')}</ul>`:'<p class="muted">No field inspectors yet. Invite one with their email; they set their own password.</p>'}</section>`;
 }
 function assignButton(i){
  if(!data||data.user.role!=='admin'||i.status!=='draft')return '';
  if(!(data.users||[]).some(u=>u.role==='inspector'&&u.active))return '';
  return btn(i.inspector_id&&(data.users||[]).some(u=>u.id===i.inspector_id&&u.role==='inspector')?'Reassign field inspector':'Assign to a field inspector','inspector-reassign',i.id);
 }
 const activeInspectors=()=>(data.users||[]).filter(u=>u.role==='inspector'&&u.active);
 const todayKey=()=>dayIn(data.companyTimezone||undefined);
 async function codes(propertyId){
  const p=(data.properties||[]).find(x=>x.id===propertyId)||{};
  const record=await api('access-codes/read',{propertyId});const d=record.details||{};
  const fields=[['gate','Gate'],['door','Door'],['alarm','Alarm'],['lockbox','Lockbox'],['instructions','Entry instructions']].filter(([k])=>String(d[k]||'').trim());
  $('modalBody').innerHTML=`<h2>Door & alarm codes</h2><p class="muted">${esc(p.name||'Residence')} · today only. Viewing is recorded for your office.</p>${fields.length?`<dl class="fi-codes">${fields.map(([k,t])=>`<div><dt>${esc(t)}</dt><dd class="pre">${esc(d[k])}</dd></div>`).join('')}</dl>`:'<p>Your office hasn’t saved codes for this residence. Call the office before you go.</p>'}<div class="dialog-footer">${btn('Close','close','',true)}</div>`;
  $('modal').showModal();
 }
 /** live.js action() hook. Returns true when handled. */
 async function action(name,key){
  if(name==='inspector-codes'){await codes(key);return true;}
  if(name==='inspector-invite'){await action0('new-invite');const role=document.getElementById('f-role');if(role){role.value='inspector';role.dispatchEvent(new Event('change',{bubbles:true}));}return true;}
  if(name==='inspector-assign'){
   const who=(data.users||[]).find(u=>u.id===key);
   dialog(`Assign a visit${who?' to '+who.name:''}`,select('propertyId','Residence','<option value="">Select residence</option>'+option(data.properties))+input('date','Visit date','date',todayKey())+select('templateId','Checklist','<option value="">Newest routine checklist</option>'+option((data.checklists||[]).map(c=>({id:c.template_id,name:c.name})).filter(c=>c.id))),'Assign visit',async b=>{if(!b.propertyId)throw Error('Select a residence.');await api('inspectors/assign',{propertyId:b.propertyId,inspectorId:key,date:b.date,templateId:b.templateId||undefined});toast(`Visit assigned${who?' to '+who.name:''}. They’ve been notified.`);});
   return true;
  }
  if(name==='inspector-reassign'){
   const i=(data.inspections||[]).find(x=>x.id===key);
   dialog('Assign to a field inspector',`<p class="field full muted">${esc(homeOf(i||{}).name||'')} · ${esc(prettyDay(i?.inspection_date||''))}. The inspector sees this visit, its checklist and that day’s door codes.</p>`+select('inspectorId','Field inspector',option(activeInspectors(),'id','name',i?.inspector_id)),'Assign',async b=>{await api('inspectors/reassign',{inspectionId:key,inspectorId:b.inspectorId});toast('Visit assigned. The inspector has been notified.');});
   return true;
  }
  return false;
 }
 // The original invite dialog lives in live.js action(); calling it through the global keeps one invite flow.
 const action0=name=>window.action(name,'');
 window.EAInspector={page,teamPanel,assignButton,inviteHint,action,groups,dayIn,mapsDir};
})();
