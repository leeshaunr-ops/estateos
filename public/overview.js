/* EstateAegis Overview for admins and staff: greeting and summary, storm strip, five numbers, "Needs your attention",
   visits (with GPS proof and the route planner button), message previews, owner arrivals, residence status and the
   new-company setup checklist. The rules live in overview-core.js (window.EAOverview); this file only renders. */
let overviewShowAll=false;
function ovTime(iso){try{return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}catch{return '';}}
function ovWhen(iso,today){const day=String(iso||'').slice(0,10);if(!day)return '';const local=new Date(iso);const localDay=window.EAOverview.localDay(local);return localDay===today?ovTime(iso):window.EAOverview.niceDate(localDay,today);}
function ovStormTime(iso){if(!iso)return '';try{return window.EAVisit.formatTime(iso,data.companyTimezone||'America/New_York');}catch{return new Date(iso).toLocaleString();}}
function ovButton(text,act,key,cls=''){return `<button type="button" class="${cls}" data-action="${esc(act)}" data-id="${esc(key||'')}">${esc(text)}</button>`;}
function ovGps(v){
 if(!v.visit||!v.visit.check_in)return data.visitVerification?.enabled?'<span class="ov-gps none">No check-in</span>':`<span class="ov-pill info">${esc(v.status==='published'?'Sent':'Submitted')}</span>`;
 const s=v.visit.override?'verified':v.visit.check_in.status,d=window.EAVisit?.formatDistance?window.EAVisit.formatDistance(v.visit.check_in.distance_m):'';
 if(s==='verified')return `<span class="ov-gps ok"><span aria-hidden="true">✓</span> On site${d&&!v.visit.override?', '+esc(d):''}</span>`;
 if(s==='outside_geofence')return `<span class="ov-gps warn">${esc(d||'Away')} from the residence</span>`;
 if(s==='no_residence_location')return '<span class="ov-gps none">Location recorded</span>';
 return '<span class="ov-gps none">No GPS signal</span>';
}
function ovAttentionPanel(att){
 const view=window.EAOverview.attentionView(att,{showAll:overviewShowAll});
 const count=att.primary.length;
 const rows=view.groups.map(g=>`<h3 class="ov-group">${esc(g.title)}</h3>`+g.items.map(i=>`<div class="ov-row"><span class="ov-pill ${esc(i.tone)}">${esc(i.pill)}</span><div class="ov-row-text"><div class="ov-row-title">${esc(i.title)}</div><div class="ov-row-detail">${i.place?`<b>${esc(i.place)}</b>${i.detail?' · ':''}`:''}${esc(i.detail)}</div></div>${ovButton(i.action.label,i.action.name,i.action.key,'ov-act')}</div>`).join('')).join('');
 const more=view.hidden?ovButton(`${view.hidden} more: ${view.moreText}`,'overview-more','show','ov-more'):overviewShowAll&&att.items.length>window.EAOverview.attentionView(att).groups.reduce((n,g)=>n+g.items.length,0)?ovButton('Show fewer','overview-more','less','ov-more'):'';
 return `<section class="panel ov-panel" id="overviewAttention" aria-labelledby="ovAttentionTitle" tabindex="-1"><div class="ov-head"><h2 id="ovAttentionTitle">Needs your attention${count?`<span class="ov-count" aria-label="${count} items">${count}</span>`:''}</h2></div>${rows||`<p class="ov-empty">You are up to date. Nothing needs your attention right now.</p>`}${more}</section>`;
}
function ovVisitRow(v,today){
 const meta=[v.city,data.user.role==='admin'?v.who:'',v.storm?'pre-storm':v.kind==='plan'?'recurring':v.visitType==='next visit due'?'next visit due':''].filter(Boolean).join(' · ');
 const right=v.kind==='done'?ovGps(v):v.kind==='visit'?`<span class="ov-pill info">${v.started?'In progress':v.date===today?'Not started':'Scheduled'}</span>`:'<span class="ov-pill info">Planned</span>';
 const open=v.kind==='plan'||v.kind==='due'?ovButton(v.property,'property',v.propertyId,'ov-link'):ovButton(v.property,'inspection',v.id,'ov-link');
 return `<div class="ov-visit"><div><div class="ov-row-title">${open}</div><div class="ov-row-detail">${esc(meta||(v.kind==='done'?window.EAOverview.niceDate(v.date,today):''))}${v.kind==='done'&&meta?' · '+esc(window.EAOverview.niceDate(v.date,today)):''}</div></div>${right}</div>`;
}
function ovVisitsPanel(v,today){
 const route=isStaff()?ovButton("Plan today's route",'navigate','routes','ov-route primary'):'';
 const upcoming=v.days.slice(0,4),shownUpcoming=upcoming.reduce((n,d)=>n+Math.min(d.items.length,4),0),hiddenUpcoming=v.upcoming.length-shownUpcoming;
 const doneShown=v.done.slice(0,4);
 return `<section class="panel ov-panel" id="overviewVisits" aria-labelledby="ovVisitsTitle" tabindex="-1"><div class="ov-head"><h2 id="ovVisitsTitle">${data.user.role==='admin'?'Visits':'My visits'}</h2>${route}</div>
  <h3 class="ov-day">Today</h3>${v.today.map(x=>ovVisitRow(x,today)).join('')||'<p class="ov-empty small">No visits scheduled today.</p>'}
  ${upcoming.map(d=>`<h3 class="ov-day">${esc(d.label)}${d.storm?' · storm prep':''}</h3>${d.items.slice(0,4).map(x=>ovVisitRow(x,today)).join('')}`).join('')}
  ${hiddenUpcoming>0?ovButton(`${hiddenUpcoming} more in the next 7 days`,'navigate','calendar','ov-more'):''}
  <h3 class="ov-day">Done, last 7 days</h3>${doneShown.map(x=>ovVisitRow(x,today)).join('')||'<p class="ov-empty small">No visits completed in the last 7 days.</p>'}
  ${v.done.length>doneShown.length?ovButton(`${v.done.length-doneShown.length} more completed visits`,'navigate','inspections','ov-more'):''}</section>`;
}
function ovMessagesPanel(m,today){
 const initials=n=>String(n||'?').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
 return `<section class="panel ov-panel" aria-labelledby="ovMessagesTitle"><div class="ov-head"><h2 id="ovMessagesTitle">Messages${m.unread?`<span class="ov-count" aria-label="${m.unread} unread">${m.unread}</span>`:''}</h2>${ovButton('Inbox','navigate','messages','ov-head-link')}</div>
  ${m.threads.map(t=>`<button type="button" class="ov-msg${t.unread?' unread':''}" data-action="overview-message" data-id="${esc(t.id)}"><span class="ov-avatar" aria-hidden="true">${esc(initials(t.from==='You'?data.user.name:t.from))}</span><span class="ov-msg-text"><span class="ov-row-title">${esc(t.from?t.from+' · ':'')}${esc(t.subject)}</span><span class="ov-row-detail">${esc(t.snippet||'No messages yet')}</span></span><span class="ov-msg-time">${esc(ovWhen(t.at,today))}${t.unread?`<span class="sr-only">, ${t.unread} unread</span>`:''}</span></button>`).join('')||'<p class="ov-empty small">No conversations yet.</p>'}</section>`;
}
function ovArrivalsPanel(list){
 if(!list.length)return '';
 return `<section class="panel ov-panel" aria-labelledby="ovArrivalsTitle"><div class="ov-head"><h2 id="ovArrivalsTitle">Owner arrivals</h2>${ovButton('All arrivals','navigate','arrivals','ov-head-link')}</div>
  ${list.slice(0,3).map(a=>`<div class="ov-row no-pill"><div class="ov-row-text"><div class="ov-row-title">${esc(a.client||a.property)} · ${esc(a.label)}</div><div class="ov-row-detail">${a.client?esc(a.property)+' · ':''}${esc(a.detail)}</div></div>${ovButton(a.ready?'View':'Prepare','arrival-open',a.id,'ov-act')}</div>`).join('')}
  ${list.length>3?ovButton(`${list.length-3} more arrivals in the next 14 days`,'navigate','arrivals','ov-more'):''}</section>`;
}
function ovResidencesPanel(rows){
 if(!rows.length)return '';const shown=rows.slice(0,10);
 return `<section class="panel ov-panel ov-full" aria-labelledby="ovHomesTitle"><div class="ov-head"><h2 id="ovHomesTitle">Residences</h2>${ovButton(`All ${rows.length} residences`,'navigate','properties','ov-head-link')}</div>
  <table class="ov-homes"><thead><tr><th scope="col">Residence</th><th scope="col">Status</th><th scope="col">Last visit</th><th scope="col">Next visit</th></tr></thead><tbody>
  ${shown.map(r=>`<tr><td class="ov-home-name">${ovButton(r.name,'property',r.id,'ov-link')}<small>${esc([r.client,r.city].filter(Boolean).join(' · '))}</small></td><td class="ov-home-status"><span class="ov-status ${esc(r.state)}"><span class="ov-dot" aria-hidden="true"></span>${esc(r.text)}</span></td><td class="ov-home-last"><span class="ov-cell-label">Last visit: </span>${r.last?esc(r.last.label+(r.last.who?' · '+r.last.who:''))+(r.last.gps?' · <span class="ov-gps-mini">✓ GPS</span>':''):'No report yet'}</td><td class="ov-home-next${r.next?.late?' late':''}"><span class="ov-cell-label">Next: </span>${r.next?esc(r.next.label):'Not scheduled'}</td></tr>`).join('')}
  </tbody></table>${rows.length>shown.length?ovButton(`${rows.length-shown.length} more residences`,'navigate','properties','ov-more'):''}</section>`;
}
function ovStormStrip(list){
 return list.map(s=>{const admin=data.user.role==='admin';
  const line=admin?`<b>${s.secured} of ${s.total} residences secured</b>${s.damage?` · ${s.damage} with damage found`:''}`:`<b>${s.mine} storm visit${s.mine===1?'':'s'} waiting for you</b>`;
  const times=[s.prepDeadline?'prep deadline '+esc(ovStormTime(s.prepDeadline)):'',s.impact?'expected impact '+esc(ovStormTime(s.impact)):''].filter(Boolean).join(' · ');
  return `<section class="ov-storm" aria-label="${esc(s.type)}: ${esc(s.name)}"><span class="ov-storm-tag">${esc(s.type)}</span><div class="ov-storm-text"><h2>${esc(s.name)}${s.status?' · '+esc(s.status):''}</h2><p>${line}${times?' · '+times:''}</p>${admin&&s.total?`<progress class="ov-progress" max="${s.total}" value="${s.secured}" aria-label="${s.secured} of ${s.total} residences secured">${s.secured} of ${s.total}</progress>`:''}</div>${ovButton('Open storm board','storm-open',s.id,'primary')}</section>`;}).join('');
}
function ovSetupPanel(setup,{full}){
 const pct=Math.round(setup.done/setup.total*100);
 return `<section class="panel ov-panel${full?'':' ov-full'}" aria-labelledby="ovSetupTitle"><div class="ov-head"><h2 id="ovSetupTitle">${full?`Your first visit, in ${setup.total} steps`:'Finish setting up'}</h2><span class="ov-head-note">${setup.done} of ${setup.total} done</span></div>
  <progress class="ov-progress setup" max="${setup.total}" value="${setup.done}" aria-label="${setup.done} of ${setup.total} setup steps done">${pct}%</progress>
  ${setup.steps.map((s,i)=>`<div class="ov-step${s.done?' done':''}"><span class="ov-num" aria-hidden="true">${s.done?'✓':i+1}</span><div><div class="ov-row-title">${esc(s.title)}${s.done?'<span class="sr-only"> (done)</span>':''}</div><div class="ov-row-detail">${esc(s.detail)}</div></div>${ovButton(s.done?(s.key==='company'?'Edit':'Open'):s.action.label,s.action.name,s.action.key,!s.done&&setup.steps.findIndex(x=>!x.done)===i?'ov-act primary':'ov-act')}</div>`).join('')}</section>`;
}
function ovEmptyCompany(setup){
 return `<div class="ov"><section class="ov-hello"><div><div class="eyebrow ov-date">Welcome to EstateAegis</div><h1 class="ov-title">Let’s set up ${esc(data.company)}</h1><p class="ov-lede">Most companies are ready for their first visit in about 15 minutes.</p></div></section>
  <div class="ov-cols">${ovSetupPanel(setup,{full:true})}<div class="ov-stack"><section class="panel ov-panel" aria-labelledby="ovPreviewTitle"><div class="ov-head"><h2 id="ovPreviewTitle">What this page will show</h2></div>
   <div class="ov-row no-action"><span class="ov-pill fail">Fail</span><div class="ov-row-detail">Failed checklist items, as soon as staff submit a visit.</div></div>
   <div class="ov-row no-action"><span class="ov-pill sign">Sign</span><div class="ov-row-detail">Reports waiting for your sign-off before the client sees them.</div></div>
   <div class="ov-row no-action"><span class="ov-pill info">Visits</span><div class="ov-row-detail">Today’s visits, with GPS proof that staff were on site.</div></div>
   <div class="ov-row no-action"><span class="ov-pill storm">Storm</span><div class="ov-row-detail">Storm preparation progress across your residences.</div></div></section></div></div></div>`;
}
/** The Overview for admins and staff (clients use clientHome, vendors the job tiles). */
function overviewPage(){
 const O=window.EAOverview,now=new Date(),today=O.localDay(now);
 const statusOf=typeof offlineDisplayStatus==='function'?i=>offlineDisplayStatus(i):null;
 const ctx=O.context(data,{today,statusOf}),admin=data.user.role==='admin';
 const setup=admin?O.setupSteps(data):null;
 if(admin&&!(data.properties||[]).length)return ovEmptyCompany(setup);
 if(!admin&&!(data.properties||[]).length)return `<div class="ov"><section class="ov-hello"><div><div class="eyebrow ov-date">${esc(O.longDate(today))}</div><h1 class="ov-title">${esc(O.greeting(now.getHours()))}, ${esc(O.firstName(data.user.name))}</h1><p class="ov-lede">Your workspace is ready. Your administrator will assign residences and visits to your account.</p></div></section>${ovMessagesPanel(O.messages(data),today)}</div>`;
 const att=O.attention(data,{ctx}),vis=O.visits(data,{ctx}),stormList=O.storms(data,{ctx}),sum=O.summary(att,stormList,{today});
 const numbers=O.kpis(data,{ctx,visits:vis,attention:att});
 const quick=admin?`<div class="ov-quick">${ovButton('Start visit','new-inspection','','')}${ovButton('New work order','new-work','','primary')}</div>`:`<div class="ov-quick">${ovButton('Start visit','new-inspection','','primary')}</div>`;
 const strong=t=>'<b>'+esc(t)+'</b>';
 const ledeHtml=(sum.parts.length?(sum.parts.length>1?sum.parts.slice(0,-1).map(strong).join(', ')+' and '+strong(sum.parts.at(-1)):strong(sum.parts[0]))+' '+sum.verb+' you today.':'Nothing needs you right now.')+(sum.storm?' '+esc(sum.storm):'');
 return `<div class="ov">
  <section class="ov-hello"><div><div class="eyebrow ov-date">${esc(O.longDate(today))}</div><h1 class="ov-title">${esc(O.greeting(now.getHours()))}, ${esc(O.firstName(data.user.name))}</h1><p class="ov-lede">${ledeHtml}</p></div>${quick}</section>
  ${ovStormStrip(stormList)}
  <section class="ov-kpis" aria-label="At a glance">${numbers.map(k=>`<button type="button" class="ov-kpi" data-action="${esc(k.action.name)}" data-id="${esc(k.action.key)}"><span class="ov-kpi-value${k.warn?' warn':''}">${esc(k.value)}</span><span class="ov-kpi-label">${esc(k.label)}</span></button>`).join('')}</section>
  <div class="ov-cols">${ovAttentionPanel(att)}<div class="ov-stack">${ovVisitsPanel(vis,today)}${ovMessagesPanel(O.messages(data),today)}${ovArrivalsPanel(O.arrivals(data,{ctx}))}</div></div>
  ${setup&&setup.done<setup.total?ovSetupPanel(setup,{full:false}):''}
  ${ovResidencesPanel(O.residences(data,{ctx}))}
 </div>`;
}
const overviewBaseAction=action;
action=async function(name,key,button){
 if(name==='overview-more'){overviewShowAll=key==='show';render();if(!overviewShowAll)document.getElementById('overviewAttention')?.scrollIntoView({block:'start'});return;}
 if(name==='overview-jump'){const el=document.getElementById(key);if(el){el.scrollIntoView({behavior:'smooth',block:'start'});el.focus({preventScroll:true});}return;}
 if(name==='overview-message'){page='messages';search='';return overviewBaseAction('message-open',key,button);}
 return overviewBaseAction(name,key,button);
};
