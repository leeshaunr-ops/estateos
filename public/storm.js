/* Hurricane and storm workflow (browser): Storms list, the 3-step "New storm" wizard (details, residences, pre-storm
   visits), the live storm status board (admins see every residence; employees see the residences assigned to them),
   storm banners on the dashboard, residence and inspection screens, and storm cards on the client home.
   Storm visits are ordinary inspections, so they open, work offline and sync exactly like any other visit.
   Rules and labels come from storm-core.js (window.EAStorm). Every value is escaped; no inline styles or scripts. */
const ST=window.EAStorm;
let stormState={view:'list',eventId:null,wizard:null,filters:{q:'',prep:'',post:'',assignee:'',layout:'table'},refreshedAt:0};
const stormSelected=new Set();
let stormRoutePreset=null;
const STORM_BADGE={done:'ck-pass',issue:'ck-fail',progress:'ck-monitor',open:'',muted:''};
const stormEvents=()=>data?.storm?.events||[];
const stormEvent=id=>stormEvents().find(e=>e.id===id);
const stormAdmin=()=>data?.user?.role==='admin';
const stormOpenEvents=()=>stormEvents().filter(e=>e.status!=='closed');
function stormPill(tone,text){return `<span class="badge storm-pill ${STORM_BADGE[tone]||''}"><span aria-hidden="true">${esc(ST.ICONS[tone]||'')}</span> ${esc(text)}</span>`;}
function stormWhen(iso,tz){if(!iso)return '';try{return window.EAVisit.formatTime(iso,tz||data.companyTimezone||'America/New_York');}catch{return new Date(iso).toLocaleString();}}
const stormDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(String(d||''))?new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}):'';
const stormLocalInput=iso=>{if(!iso)return '';const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;};
const stormIso=v=>v?new Date(v).toISOString():'';
const stormStaff=()=>(data.users||[]).filter(u=>['admin','employee'].includes(u.role)&&u.active!==false&&u.active!==0);
const stormPhaseName=phase=>phase==='pre'?'pre-storm':'post-storm';
async function stormRefresh(){if(!data||data.user.role==='vendor')return;data.storm=await api('storm');stormState.refreshedAt=Date.now();}
function stormArea(text,name,value=''){return `<div class="field full"><label for="f-${name}">${esc(text)}</label><textarea id="f-${name}" name="${name}" data-autosize rows="3">${esc(value)}</textarea></div>`;}
function stormDateTime(name,title,iso){return `<div class="field"><label for="f-${name}">${esc(title)}</label><input id="f-${name}" name="${name}" type="datetime-local" value="${esc(stormLocalInput(iso))}"></div>`;}
function stormTypeSelect(value='hurricane'){return select('type','Storm type',Object.entries(ST.TYPES).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${esc(v)}</option>`).join(''));}

/* ---------- Storms list ---------- */
function stormProgress(done,total,text){return `<div class="storm-progress"><div class="storm-progress-label"><span>${esc(text)}</span><strong>${total?Math.round(done/total*100):0}%</strong></div><progress max="${Math.max(total,1)}" value="${done}">${done} of ${total}</progress></div>`;}
function stormCard(ev){
 const c=ev.counts,recovery=['recovery','closed'].includes(ev.status);
 return `<article class="panel storm-card"><div class="eyebrow">${esc(ev.type_label)} · ${esc(ev.status_label)}</div><h2>${esc(ev.name)}</h2><p class="muted">${ev.expected_impact_at?'Expected impact '+esc(stormWhen(ev.expected_impact_at)):'Expected impact not set'}${ev.prep_deadline_at?' · Prep deadline '+esc(stormWhen(ev.prep_deadline_at)):''}</p>${stormProgress(c.secured,c.total,`${c.secured} of ${c.total} residences secured`)}${recovery?stormProgress(c.postChecked,c.total,`${c.postChecked} of ${c.total} checked after the storm`):''}<p class="storm-card-facts">${c.damageFound?stormPill('issue',c.damageFound+' with damage found'):''}${c.securedWithIssues?stormPill('issue',c.securedWithIssues+' secured with issues'):''}</p><div class="actions">${btn('Open storm board','storm-open',ev.id,true)}</div></article>`;
}
function stormListView(){
 const admin=stormAdmin(),events=stormEvents(),open=events.filter(e=>e.status!=='closed'),closed=events.filter(e=>e.status==='closed');
 let html=head('Storms',admin?'Prepare residences before a storm, follow every home during it, and document each one after.':'The storm visits assigned to you.',admin?btn('New storm','storm-new','',true):'');
 if(!data.storm)return html+`<div class="notice">Storm information could not load. Refresh the page to try again.</div>`;
 if(!events.length)return html+`<div class="panel storm-empty"><h2>${admin?'No storms yet':'No storm visits assigned to you'}</h2><p class="muted">${admin?'When a storm is forecast, create it here, choose the residences in its path and schedule pre-storm visits for all of them in one step. The status board then shows which homes are secured, and after the storm which homes have damage.':'When your office schedules storm visits for you, the residences appear here.'}</p>${admin?btn('New storm','storm-new','',true):''}</div>`;
 html+=open.map(stormCard).join('');
 if(closed.length)html+=`<div class="panel"><h2>Closed storms</h2>${closed.map(ev=>`<div class="row"><div><strong>${esc(ev.name)}</strong><div class="muted">${esc(ev.type_label)} · ${ev.counts.total} residences · ${ev.counts.damageFound} with damage found · Closed ${esc(stormWhen(ev.closed_at))}</div></div>${btn('Open','storm-open',ev.id)}</div>`).join('')}</div>`;
 return html;
}

/* ---------- New storm wizard (full page, 3 steps) ---------- */
function stormStepper(step){return `<ol class="storm-steps" aria-label="Steps">${['Storm details','Residences','Pre-storm visits'].map((t,i)=>`<li class="${i+1===step?'active':i+1<step?'done':''}" ${i+1===step?'aria-current="step"':''}><span>${i+1}</span>${esc(t)}</li>`).join('')}</ol>`;}
function stormWizardView(){
 const w=stormState.wizard,ev=w.eventId?stormEvent(w.eventId):null;
 const title=ev?ev.name:'New storm';
 let body='';
 if(w.step===1)body=`<form id="stormStep1" class="form storm-form">${input('name','Storm name','text',ev?.name||w.name||'')}${stormTypeSelect(ev?.type||'hurricane')}${stormDateTime('expectedImpactAt','Expected impact',ev?.expected_impact_at)}${stormDateTime('prepDeadlineAt','Preparation deadline',ev?.prep_deadline_at)}${stormDateTime('postCheckTargetAt','Post-storm check target',ev?.post_check_target_at)}${stormArea('Notes for the team','notes',ev?.notes||'')}<p class="muted storm-hint">Times use this device's time zone. Reports show them in each residence's time zone.</p><div class="dialog-footer">${btn('Cancel','storm-wizard-cancel')}<button class="primary" type="submit">Save and choose residences</button></div></form>`;
 if(w.step===2)body=stormPickView(ev);
 if(w.step===3)body=`<form id="stormStep3" class="form storm-form">${stormScheduleFields('pre',stormScheduleTargets(ev,'pre'))}<div class="dialog-footer">${btn('Skip for now','storm-wizard-skip')}<button class="primary" type="submit">Create pre-storm visits</button></div></form>`;
 return head(title,w.step===1?'Step 1 of 3 · Name the storm and its key times.':w.step===2?'Step 2 of 3 · Choose every residence in the storm path.':'Step 3 of 3 · Schedule a pre-storm visit at each residence.',btn('Back to storms','storm-list'))+`<div class="panel storm-wizard">${stormStepper(w.step)}${body}</div>`;
}
function stormPickMatches(){const w=stormState.wizard;return ST.selectResidences(data.properties,w.filter||{});}
function stormPickView(ev){
 const w=stormState.wizard,cities=[...new Set(data.properties.map(p=>String(p.city||'').trim()).filter(Boolean))].sort(),staff=stormStaff();
 const f=w.filter||{};
 return `<div class="storm-filters"><div class="field"><label for="storm-f-city">City</label><select id="storm-f-city" data-storm-pick-filter="city"><option value="">Any city</option>${cities.map(c=>`<option ${c===f.city?'selected':''}>${esc(c)}</option>`).join('')}</select></div><div class="field"><label for="storm-f-zip">ZIP code</label><input id="storm-f-zip" data-storm-pick-filter="zip" inputmode="numeric" value="${esc(f.zip||'')}" placeholder="33480"></div><div class="field"><label for="storm-f-manager">Residence Manager</label><select id="storm-f-manager" data-storm-pick-filter="managerId"><option value="">Anyone</option><option value="none" ${f.managerId==='none'?'selected':''}>No Residence Manager</option>${staff.map(u=>`<option value="${esc(u.id)}" ${u.id===f.managerId?'selected':''}>${esc(u.name||u.email)}</option>`).join('')}</select></div><div class="field"><label for="storm-f-search">Search</label><input id="storm-f-search" data-storm-pick-filter="search" value="${esc(f.search||'')}" placeholder="Name, address or family"></div></div><div class="storm-pick-tools">${btn('Select all matching','storm-pick-all')}${btn('Clear selection','storm-pick-none')}<span id="stormPickCount" class="storm-count" role="status" aria-live="polite"></span></div><div id="stormPickList" class="storm-pick-list">${stormPickRows(ev)}</div><div class="dialog-footer">${btn('Back','storm-wizard-back')}${btn('Save residences and continue','storm-wizard-residences','',true)}</div>`;
}
function stormPickRows(ev){
 const w=stormState.wizard,included=new Set((ev?.residences||[]).map(r=>r.property_id)),matches=stormPickMatches();
 setTimeout(stormPickCount,0);
 if(!matches.length)return empty('No residences match these filters.');
 return matches.map(p=>{const on=included.has(p.id);return `<label class="check-row storm-pick"><input type="checkbox" data-storm-pick value="${esc(p.id)}" ${on||w.selected.has(p.id)?'checked':''} ${on?'disabled':''}><span><b>${esc(p.name)}</b>${on?' <span class="badge">Already on this storm</span>':''}<br><span class="muted">${esc(p.address||'Address not entered')} · ${esc(p.client_name||'')}${p.account_manager_name?' · Residence Manager: '+esc(p.account_manager_name):' · No Residence Manager'}</span></span></label>`;}).join('');
}
function stormPickCount(){const w=stormState.wizard,el=$('stormPickCount');if(!w||!el)return;const ev=w.eventId?stormEvent(w.eventId):null,already=(ev?.residences||[]).length;el.textContent=`${w.selected.size} selected${already?` · ${already} already on this storm`:''}`;}

/* ---------- schedule visits form (wizard step 3, board dialog, recovery dialog) ---------- */
function stormScheduleTargets(ev,phase,ids){const rows=(ev?.residences||[]).filter(r=>!r[phase+'_inspection_id']&&(phase==='post'||!['client_declined','not_needed'].includes(r.prep_status)));return ids?rows.filter(r=>ids.includes(r.id)):rows;}
function stormScheduleFields(phase,targets){
 const staff=stormStaff(),type=ST.PHASE_VISIT[phase],options=(data.checklists||[]).filter(c=>c.visit_type===type);
 const starter=phase==='pre'?'Hurricane prep':'Post-storm';
 const checklist=options.length?`<option value="">Newest published ${esc(starter)} checklist (automatic)</option>`+options.map(o=>`<option value="${esc(o.template_id)}">${esc(o.name)} · version ${esc(o.template_version)}</option>`).join(''):`<option value="">${esc(starter)} starter checklist (published automatically)</option>`;
 stormState.scheduleTargets=targets;
 // Default: Residence Managers when every residence has one; otherwise share the visits among the staff.
 const mode=targets.length&&targets.every(r=>r.account_manager_id)||!staff.some(u=>u.role==='employee')?'residence_manager':'round_robin';
 return `<input type="hidden" name="phase" value="${phase}"><p class="storm-lead">${targets.length?`Creates a ${stormPhaseName(phase)} visit at <strong>${targets.length}</strong> residence${targets.length===1?'':'s'} that ${targets.length===1?'does':'do'} not have one yet.`:`Every residence on this storm already has a ${stormPhaseName(phase)} visit.`}</p>
 ${input('date','Visit date','date',today())}
 ${select('templateId','Checklist',checklist)}
 <div class="field full"><label for="f-assignment">Assign the visits to</label><select id="f-assignment" name="assignment" data-storm-assignment>${[['residence_manager','Each Residence Manager'],['round_robin','Share among team members'],['user','One team member']].map(([v,t])=>`<option value="${v}" ${v===mode?'selected':''}>${esc(t)}</option>`).join('')}</select></div>
 <fieldset class="field full storm-staff" data-storm-assign-group="round_robin" ${mode==='round_robin'?'':'hidden'}><legend>Team members to share the visits</legend>${staff.map(u=>`<label class="check-row"><input type="checkbox" name="userIds" value="${esc(u.id)}" ${u.role==='employee'?'checked':''} data-storm-assign-input><span>${esc(u.name||u.email)} <small class="muted">${esc(label(u.role))}</small></span></label>`).join('')||'<p class="muted">Invite team members first.</p>'}</fieldset>
 <div class="field full" data-storm-assign-group="user" hidden><label for="f-userId">Team member</label><select id="f-userId" name="userId" data-storm-assign-input>${staff.map(u=>`<option value="${esc(u.id)}" ${u.id===data.user.id?'selected':''}>${esc(u.name||u.email)}</option>`).join('')}</select></div>
 <div class="field full"><span class="storm-preview-title">Who gets each visit</span><div id="stormAssignPreview" class="storm-assign-preview">${stormAssignPreview(targets,mode,staff.filter(u=>u.role==='employee').map(u=>u.id))}</div></div>`;
}
function stormAssignPreview(targets,mode,userIds=[],userId=''){
 if(!targets.length)return '<p class="muted">Nothing to schedule.</p>';
 const name=id=>{const u=stormStaff().find(x=>x.id===id);return u?(u.name||u.email):''};
 const rr=mode==='round_robin'?ST.roundRobin(targets.map(r=>({id:r.property_id,name:r.property_name})),userIds):null;
 return `<ul class="storm-assign-list">${targets.map(r=>{let who;if(mode==='residence_manager')who=r.account_manager_id&&name(r.account_manager_id)?name(r.account_manager_id):'You (no Residence Manager)';else if(mode==='round_robin')who=name(rr.get(r.property_id))||'Choose team members';else who=name(userId)||'Choose a team member';return `<li><span>${esc(r.property_name)}</span><strong>${esc(who)}</strong></li>`;}).join('')}</ul>`;
}
function stormSyncAssignment(form){
 if(!form)return;const mode=form.querySelector('[data-storm-assignment]')?.value||'residence_manager';
 form.querySelectorAll('[data-storm-assign-group]').forEach(el=>{el.hidden=el.dataset.stormAssignGroup!==mode;});
 const ids=[...form.querySelectorAll('[name=userIds]:checked')].map(el=>el.value),uid=form.querySelector('[name=userId]')?.value||'';
 const box=form.querySelector('#stormAssignPreview');if(box)box.innerHTML=stormAssignPreview(stormState.scheduleTargets||[],mode,ids,uid);
}
function stormSchedulePayload(form,targets){
 const v=Object.fromEntries(new FormData(form));
 return {phase:v.phase,date:v.date,assignment:v.assignment,templateId:v.templateId||undefined,userId:v.assignment==='user'?v.userId:undefined,userIds:v.assignment==='round_robin'?[...form.querySelectorAll('[name=userIds]:checked')].map(el=>el.value):undefined,residenceIds:targets.map(r=>r.id)};
}
function stormScheduleResult(r){const t=r.template?` using ${r.template.name} (version ${r.template.template_version})${r.template.created?', published automatically from the starter checklist':''}`:'';return `${r.created} visit${r.created===1?'':'s'} created${t}.${r.skipped.length?` ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s=>s.reason))].join('; ')}).`:''}`;}
function stormScheduleDialog(ev,phase,ids){
 const targets=stormScheduleTargets(ev,phase,ids);
 dialog(`Schedule ${stormPhaseName(phase)} visits`,stormScheduleFields(phase,targets),targets.length?`Create ${targets.length} visit${targets.length===1?'':'s'}`:'Close',async(b,form)=>{if(!targets.length)return;const r=await api(`storm-events/${encodeURIComponent(ev.id)}/visits`,stormSchedulePayload(form,targets));await stormRefresh();toast(stormScheduleResult(r));});
 setTimeout(()=>stormSyncAssignment($('actionForm')),0);
}

/* ---------- status board ---------- */
function stormRowsFiltered(ev){
 const f=stormState.filters,q=String(f.q||'').trim().toLowerCase();
 return ev.residences.filter(r=>(!f.prep||r.prep_status===f.prep||(f.prep==='issues'&&r.prep_status==='secured'&&r.prep_issues))&&(!f.post||r.post_status===f.post)&&(!f.assignee||(f.assignee==='none'?!r.assigned_user_id:r.assigned_user_id===f.assignee))&&(!q||[r.property_name,r.address,r.client_name,r.assigned_name,r.city].some(v=>String(v||'').toLowerCase().includes(q))));
}
function stormVisitCell(r,phase){
 const v=r[phase];if(!v)return `<span class="muted">No ${stormPhaseName(phase)} visit</span>`;
 const status={draft:'Scheduled',submitted:'Submitted',published:'Published'}[v.status]||label(v.status);
 return `<button class="link-button" data-action="inspection" data-id="${esc(v.id)}">${esc(phase==='pre'?'Pre-storm':'Post-storm')} · ${esc(stormDay(v.date))}</button><div class="muted">${esc(status)}</div>`;
}
function stormRowActions(ev,r){
 const open=ev.status!=='closed',mine=r.assigned_user_id===data.user.id||stormAdmin();
 const next=r.post?.status==='draft'?r.post:r.pre?.status==='draft'?r.pre:null;
 return `${next&&mine?btn(next===r.pre?'Open pre-storm visit':'Open post-storm visit','inspection',next.id,true):''}${open?btn('Update status','storm-status',r.id):''}${r.report_available?`<a class="button" href="/api/storm-events/${encodeURIComponent(ev.id)}/residences/${encodeURIComponent(r.id)}/report.pdf" download>Storm report</a>`:''}`;
}
function stormTable(ev,rows){
 const admin=stormAdmin(),all=rows.length&&rows.every(r=>stormSelected.has(r.id));
 return `<div class="storm-table-wrap"><table class="storm-table"><thead><tr><th scope="col"><input type="checkbox" data-storm-select-all aria-label="Select all shown residences" ${all?'checked':''}></th><th scope="col">Residence</th><th scope="col">Assigned</th><th scope="col">Prep</th><th scope="col">After the storm</th><th scope="col">Visits</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.prep_tone==='issue'||r.post_tone==='issue'?'storm-row-issue':''}"><td><input type="checkbox" data-storm-select value="${esc(r.id)}" ${stormSelected.has(r.id)?'checked':''} aria-label="Select ${esc(r.property_name)}"></td><td><strong>${esc(r.property_name)}</strong><div class="muted">${esc(r.client_name)}</div><div class="muted">${esc(r.address||'Address not entered')}</div>${r.internal_notes&&admin?`<div class="storm-note">${esc(r.internal_notes)}</div>`:''}</td><td>${esc(r.assigned_name||'Unassigned')}</td><td>${stormPill(r.prep_tone,r.prep_label)}${r.client_prep_notified_at?'<div class="muted">Family told</div>':''}</td><td>${stormPill(r.post_tone,r.post_label)}${r.severity_label?`<div class="muted">Severity: ${esc(r.severity_label)}</div>`:''}${r.client_post_notified_at?'<div class="muted">Family told</div>':''}</td><td>${stormVisitCell(r,'pre')}${r.post?stormVisitCell(r,'post'):''}</td><td><div class="storm-row-actions">${stormRowActions(ev,r)}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function stormCards(ev,rows){
 return `<div class="storm-cards">${rows.map(r=>`<article class="storm-mobile-card ${r.prep_tone==='issue'||r.post_tone==='issue'?'storm-row-issue':''}"><label class="storm-card-select"><input type="checkbox" data-storm-select value="${esc(r.id)}" ${stormSelected.has(r.id)?'checked':''}><span class="sr-only">Select ${esc(r.property_name)}</span></label><h2 class="h3">${esc(r.property_name)}</h2><p class="muted">${esc(r.address||'Address not entered')}</p><dl class="storm-card-status"><dt>Prep</dt><dd>${stormPill(r.prep_tone,r.prep_label)}</dd><dt>After</dt><dd>${stormPill(r.post_tone,r.post_label)}${r.severity_label?' · '+esc(r.severity_label):''}</dd><dt>Assigned</dt><dd>${esc(r.assigned_name||'Unassigned')}</dd></dl><div class="storm-card-actions">${stormRowActions(ev,r)}</div></article>`).join('')}</div>`;
}
function stormColumns(ev,rows){
 const recovery=['recovery','closed'].includes(ev.status),phase=recovery?'post':'prep',map=recovery?ST.POST:ST.PREP;
 return `<div class="storm-columns">${Object.entries(map).map(([k,v])=>{const list=rows.filter(r=>r[phase+'_status']===k);if(!list.length&&['client_declined','not_needed','unreachable','inaccessible'].includes(k))return '';return `<section class="storm-column"><h3>${esc(v)} <span class="badge">${list.length}</span></h3>${list.map(r=>`<article class="storm-column-card"><strong>${esc(r.property_name)}</strong><div class="muted">${esc(r.assigned_name||'Unassigned')}</div>${phase==='prep'?stormPill(r.prep_tone,r.prep_label):stormPill(r.post_tone,r.post_label)+(r.severity_label?` <span class="muted">${esc(r.severity_label)}</span>`:'')}<div class="storm-card-actions">${stormRowActions(ev,r)}</div></article>`).join('')||'<p class="muted">None</p>'}</section>`;}).join('')}</div>`;
}
function stormBulkBar(ev){
 const n=[...stormSelected].filter(id=>ev.residences.some(r=>r.id===id)).length;if(!n||ev.status==='closed')return '';
 const admin=stormAdmin();
 return `<div class="storm-bulk" role="region" aria-label="Bulk actions"><strong>${n} selected</strong>${btn('Update status','storm-status','')}${admin?btn('Assign','storm-assign')+btn('Schedule pre-storm visits','storm-schedule','pre')+btn('Schedule post-storm visits','storm-schedule','post')+btn('Message families','storm-notify')+btn('Remove from storm','storm-remove'):''}${btn('Clear selection','storm-select-none')}</div>`;
}
function stormBoardRows(ev){
 const rows=stormRowsFiltered(ev),layout=stormState.filters.layout;
 if(!ev.residences.length)return empty(stormAdmin()?'No residences on this storm yet. Add the residences in its path.':'No residences assigned to you on this storm.');
 if(!rows.length)return empty('No residences match these filters.');
 return (layout==='columns'?stormColumns(ev,rows):stormTable(ev,rows))+stormCards(ev,rows);
}
function stormBoardView(ev){
 const admin=stormAdmin(),c=ev.counts,open=ev.status!=='closed',recovery=['recovery','closed'].includes(ev.status),f=stormState.filters;
 const mine=ev.residences.filter(r=>r.assigned_user_id===data.user.id);
 const sub=[ev.type_label,ev.status_label,ev.expected_impact_at?'Expected impact '+stormWhen(ev.expected_impact_at):''].filter(Boolean).join(' · ');
 const actions=`<div class="actions">${btn('All storms','storm-list')}${admin&&open?btn('Edit storm','storm-edit',ev.id):''}${admin&&!open?btn('Reopen storm','storm-reopen',ev.id):''}</div>`;
 const tiles=[['Residences',c.total,''],['Secured',c.secured,c.securedWithIssues?`${c.securedWithIssues} with issues`:''],['Not secured yet',c.prepOpen+c.prepInProgress,c.prepInProgress?`${c.prepInProgress} in progress`:''],['Checked after',c.postChecked,c.noDamage?`${c.noDamage} no damage`:''],['Damage found',c.damageFound,c.inaccessible?`${c.inaccessible} inaccessible`:'']];
 const assignees=[...new Map(ev.residences.filter(r=>r.assigned_user_id).map(r=>[r.assigned_user_id,r.assigned_name])).entries()];
 const csvLink=(admin||ev.residences.length)?`<a class="button" href="/api/storm-events/${encodeURIComponent(ev.id)}/export.csv" download>Export CSV</a>`:'',pdfLink=admin?`<a class="button" href="/api/storm-events/${encodeURIComponent(ev.id)}/summary.pdf" download>Summary PDF</a>`:'';
 // Three everyday actions stay visible; the rest sit behind More.
 const steps=admin&&open?`<div class="storm-toolbar">${ev.status!=='recovery'?btn('Storm passed: start recovery','storm-recovery',ev.id,true):btn('Schedule post-storm visits','storm-schedule','post',true)}${btn('Schedule pre-storm visits','storm-schedule','pre')}${btn('Message families','storm-notify')}${moreMenu(btn('Add residences','storm-add-residences',ev.id)+(ev.status==='preparing'?btn('Mark storm active','storm-active',ev.id):'')+csvLink+pdfLink+btn('Close storm','storm-close',ev.id))}</div>`:'';
 const files=`<div class="storm-downloads">${admin&&open?'':csvLink+pdfLink}${mine.length?btn('Plan route for my storm visits','storm-route',ev.id):''}${typeof offlineDownloadButton==='function'&&(mine.length||!admin)?offlineDownloadButton([...new Set((mine.length?mine:ev.residences).map(r=>r.property_id))],'Make my storm visits available offline'):''}</div>`;
 const filters=`<div class="storm-filters storm-board-filters"><div class="field"><label for="storm-q">Search</label><input id="storm-q" data-storm-filter="q" value="${esc(f.q)}" placeholder="Residence, address, family"></div><div class="field"><label for="storm-prep">Prep</label><select id="storm-prep" data-storm-filter="prep"><option value="">All</option><option value="issues" ${f.prep==='issues'?'selected':''}>Secured with issues</option>${Object.entries(ST.PREP).map(([k,v])=>`<option value="${k}" ${f.prep===k?'selected':''}>${esc(v)}</option>`).join('')}</select></div><div class="field"><label for="storm-post">After the storm</label><select id="storm-post" data-storm-filter="post"><option value="">All</option>${Object.entries(ST.POST).map(([k,v])=>`<option value="${k}" ${f.post===k?'selected':''}>${esc(v)}</option>`).join('')}</select></div>${admin?`<div class="field"><label for="storm-assignee">Assigned</label><select id="storm-assignee" data-storm-filter="assignee"><option value="">Anyone</option><option value="none" ${f.assignee==='none'?'selected':''}>Unassigned</option>${assignees.map(([id,n])=>`<option value="${esc(id)}" ${f.assignee===id?'selected':''}>${esc(n)}</option>`).join('')}</select></div>`:''}<div class="storm-layout" role="group" aria-label="Board layout"><button type="button" class="${f.layout==='table'?'active':''}" data-action="storm-layout" data-id="table" aria-pressed="${f.layout==='table'}">Table</button><button type="button" class="${f.layout==='columns'?'active':''}" data-action="storm-layout" data-id="columns" aria-pressed="${f.layout==='columns'}">Columns</button></div></div>`;
 const jobs=ev.workOrders.length?`<div class="panel"><h2>Repair work orders from this storm</h2>${ev.workOrders.map(w=>`<div class="row"><div><strong>${esc(w.title)}</strong><div class="muted">${esc(w.property_name)}${w.vendor_name?' · '+esc(w.vendor_name):''}</div></div>${badge(w.status)}</div>`).join('')}</div>`:'';
 const updated=stormState.refreshedAt?new Date(stormState.refreshedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'';
 return head(ev.name,sub,actions)+`<div class="panel storm-board"><div class="storm-tiles">${tiles.map(([t,n,s],i)=>`<div class="storm-tile ${i===4&&n?'storm-tile-alert':''}"><span>${esc(t)}</span><strong>${n}</strong>${s?`<small>${esc(s)}</small>`:''}</div>`).join('')}</div>${stormProgress(c.secured,c.total,`Prep: ${c.secured} of ${c.total} secured`)}${recovery?stormProgress(c.postChecked,c.total,`After the storm: ${c.postChecked} of ${c.total} checked`):''}${ev.notes?`<p class="storm-notes">${esc(ev.notes)}</p>`:''}${steps}${files}<p class="muted storm-updated">${open?`Updates on its own every 30 seconds${updated?' · last updated '+esc(updated):''}.`:'This storm is closed.'}</p></div><div class="panel">${filters}<div id="stormBulk">${stormBulkBar(ev)}</div><div id="stormRows">${stormBoardRows(ev)}</div></div>${jobs}`;
}
function stormView(){
 if(stormState.view==='wizard'&&stormAdmin()&&stormState.wizard)return stormWizardView();
 if(stormState.view==='board'){const ev=stormEvent(stormState.eventId);if(ev)return stormBoardView(ev);stormState.view='list';}
 return stormListView();
}

/* ---------- dialogs ---------- */
function stormStatusDialog(ev,ids){
 const rows=ev.residences.filter(r=>ids.includes(r.id)),one=rows.length===1?rows[0]:null,admin=stormAdmin();
 const radios=(name,map,current,legend)=>`<fieldset class="field full storm-choices"><legend>${esc(legend)}</legend>${one?'':`<label class="storm-choice"><input type="radio" name="${name}" value="" checked><span>Leave unchanged</span></label>`}${Object.entries(map).map(([k,v])=>`<label class="storm-choice"><input type="radio" name="${name}" value="${k}" ${one&&current===k?'checked':''}><span>${esc(v)}</span></label>`).join('')}</fieldset>`;
 const sev=`<fieldset class="field full storm-choices"><legend>Damage severity</legend>${one?'':`<label class="storm-choice"><input type="radio" name="severity" value="__keep" checked><span>Leave unchanged</span></label>`}<label class="storm-choice"><input type="radio" name="severity" value="" ${one&&!one.damage_severity?'checked':''}><span>Not assessed</span></label>${Object.entries(ST.SEVERITY).map(([k,v])=>`<label class="storm-choice"><input type="radio" name="severity" value="${k}" ${one&&one.damage_severity===k?'checked':''}><span>${esc(v)}</span></label>`).join('')}</fieldset>`;
 dialog(one?one.property_name:`Update ${rows.length} residences`,`${radios('prepStatus',ST.PREP,one?.prep_status,'Pre-storm prep')}${radios('postStatus',ST.POST,one?.post_status,'After the storm')}${sev}${one?stormArea('Internal notes (staff only)','internalNotes',one.internal_notes):''}<p class="muted storm-hint">Completing a storm visit updates these on its own: a submitted pre-storm visit marks the home Secured, and a published post-storm visit records No damage or Damage found.</p>`,'Save',async v=>{
  const payload={residenceIds:rows.map(r=>r.id)};
  if(v.prepStatus)payload.prepStatus=v.prepStatus;if(v.postStatus)payload.postStatus=v.postStatus;if(v.severity!=='__keep'&&v.severity!==undefined)payload.severity=v.severity;if(one)payload.internalNotes=v.internalNotes||'';
  if(Object.keys(payload).length===1)throw Error('Choose what to change.');
  await api(`storm-events/${encodeURIComponent(ev.id)}/residences/update`,payload);await stormRefresh();toast(admin||rows.length>1?`${rows.length} residence${rows.length===1?'':'s'} updated.`:'Status updated.');
 });
}
function stormEditDialog(ev){
 dialog('Edit storm',`${input('name','Storm name','text',ev.name)}${stormTypeSelect(ev.type)}${select('status','Status',Object.entries(ST.EVENT_STATUSES).filter(([k])=>k!=='closed').map(([k,v])=>`<option value="${k}" ${k===ev.status?'selected':''}>${esc(v)}</option>`).join(''))}${stormDateTime('expectedImpactAt','Expected impact',ev.expected_impact_at)}${stormDateTime('prepDeadlineAt','Preparation deadline',ev.prep_deadline_at)}${stormDateTime('postCheckTargetAt','Post-storm check target',ev.post_check_target_at)}${stormArea('Notes for the team','notes',ev.notes)}`,'Save storm',async v=>{await api(`storm-events/${encodeURIComponent(ev.id)}`,{version:ev.version,name:v.name,type:v.type,status:v.status,expectedImpactAt:stormIso(v.expectedImpactAt),prepDeadlineAt:stormIso(v.prepDeadlineAt),postCheckTargetAt:stormIso(v.postCheckTargetAt),notes:v.notes||''});await stormRefresh();toast('Storm saved.');});
}
function stormAssignDialog(ev,ids){
 dialog(`Assign ${ids.length} residence${ids.length===1?'':'s'}`,`${select('assignedUserId','Team member',`<option value="">Unassigned</option>`+stormStaff().map(u=>`<option value="${esc(u.id)}">${esc(u.name||u.email)}</option>`).join(''))}<p class="muted storm-hint">Storm visits that are not started yet move to the new person. The assigned person can open these residences until the storm is closed.</p>`,'Assign',async v=>{await api(`storm-events/${encodeURIComponent(ev.id)}/residences/update`,{residenceIds:ids,assignedUserId:v.assignedUserId||''});await stormRefresh();toast('Assignment saved.');});
}
function stormNotifyPreview(ev,ids){
 const form=$('actionForm'),box=$('stormNotifyPreview');if(!form||!box)return;const template=form.querySelector('[name=template]').value;
 box.innerHTML='<p class="muted">Checking recipients…</p>';
 api(`storm-events/${encodeURIComponent(ev.id)}/notify`,{template,residenceIds:ids,preview:true}).then(p=>{if(!$('stormNotifyPreview'))return;stormState.notifyReady=p.recipients.length;const submit=form.querySelector('button[type=submit]');if(submit){submit.textContent=p.recipients.length?`Send to ${p.recipients.length} famil${p.recipients.length===1?'y':'ies'}`:'Nothing to send';submit.disabled=!p.recipients.length;}
  box.innerHTML=`${p.emailDisabled?'<p class="notice">Email is turned off in demo workspaces. Families with portal accounts still get the message in the portal.</p>':''}<p><strong>${p.recipients.length}</strong> famil${p.recipients.length===1?'y':'ies'} will get this message.</p>${p.recipients.length?`<ul class="storm-recipients">${p.recipients.map(r=>`<li><strong>${esc(r.residence)}</strong> <span class="muted">${esc(r.emails.join(', ')||'Portal message only')}</span></li>`).join('')}</ul>`:''}${p.skipped.length?`<p class="muted">Not sent: ${p.skipped.map(s=>esc(s.residence)+' ('+esc(s.reason)+')').join(', ')}.</p>`:''}${p.sample?`<div class="storm-sample"><div class="eyebrow">Example for ${esc(p.sample.residence)}</div><strong>${esc(p.sample.subject)}</strong><p class="pre">${esc(p.sample.text)}</p></div>`:''}`;}).catch(e=>{if($('stormNotifyPreview'))box.innerHTML=`<p class="error">${esc(e.message)}</p>`;});
}
function stormNotifyDialog(ev,ids){
 dialog(`Message families (${ids.length} residence${ids.length===1?'':'s'})`,`${select('template','Message',Object.entries(ST.NOTIFY).map(([k,v])=>`<option value="${k}" ${ev.status==='recovery'&&k==='post_check_complete'?'selected':''}>${esc(v)}</option>`).join(''))}<div id="stormNotifyPreview" class="field full storm-notify-preview"></div>`,'Send',async v=>{const r=await api(`storm-events/${encodeURIComponent(ev.id)}/notify`,{template:v.template,residenceIds:ids});await stormRefresh();toast(`${r.notified} famil${r.notified===1?'y':'ies'} notified${r.skipped.length?`, ${r.skipped.length} skipped`:''}.`);});
 $('actionForm').querySelector('[name=template]').addEventListener('change',()=>stormNotifyPreview(ev,ids));stormNotifyPreview(ev,ids);
}
const stormBoardEvent=()=>stormEvent(stormState.eventId);
const stormChosen=ev=>[...stormSelected].filter(id=>ev.residences.some(r=>r.id===id));

/* ---------- actions ---------- */
const stormBaseAction=action;
action=async function(name,key,button){
 if(name==='navigate'){stormRoutePreset=null;if(key==='storm'){stormState.view='list';stormSelected.clear();}}
 if(!String(name).startsWith('storm-'))return stormBaseAction(name,key,button);
 const ev=stormBoardEvent();
 switch(name){
  case 'storm-list':stormState.view='list';stormState.wizard=null;await stormRefresh().catch(()=>{});render();return;
  case 'storm-open':stormState={...stormState,view:'board',eventId:key,wizard:null};stormSelected.clear();page='storm';await stormRefresh().catch(()=>{});render();window.scrollTo(0,0);return;
  case 'storm-new':stormState.view='wizard';stormState.wizard={step:1,eventId:null,selected:new Set(),filter:{}};page='storm';render();window.scrollTo(0,0);return;
  case 'storm-add-residences':stormState.view='wizard';stormState.wizard={step:2,eventId:key,selected:new Set(),filter:{},addOnly:true};render();window.scrollTo(0,0);return;
  case 'storm-wizard-cancel':case 'storm-wizard-skip':{const id=stormState.wizard?.eventId;stormState.wizard=null;stormState.view=id?'board':'list';stormState.eventId=id;await stormRefresh().catch(()=>{});render();window.scrollTo(0,0);return;}
  case 'storm-wizard-back':stormState.wizard.step=Math.max(1,stormState.wizard.step-1);render();return;
  case 'storm-wizard-residences':{const w=stormState.wizard;const evw=stormEvent(w.eventId),included=new Set((evw?.residences||[]).map(r=>r.property_id)),ids=[...w.selected].filter(id=>!included.has(id));if(!ids.length&&!included.size)throw Error('Choose at least one residence.');if(ids.length){const r=await api(`storm-events/${encodeURIComponent(w.eventId)}/residences`,{propertyIds:ids});toast(`${r.added} residence${r.added===1?'':'s'} added to the storm.`);}await stormRefresh();w.selected=new Set();if(w.addOnly){stormState.wizard=null;stormState.view='board';stormState.eventId=w.eventId;}else w.step=3;render();window.scrollTo(0,0);setTimeout(()=>stormSyncAssignment($('stormStep3')),0);return;}
  case 'storm-pick-all':{const w=stormState.wizard,evw=w.eventId?stormEvent(w.eventId):null,included=new Set((evw?.residences||[]).map(r=>r.property_id));stormPickMatches().forEach(p=>{if(!included.has(p.id))w.selected.add(p.id);});$('stormPickList').innerHTML=stormPickRows(evw);return;}
  case 'storm-pick-none':{const w=stormState.wizard;w.selected.clear();$('stormPickList').innerHTML=stormPickRows(w.eventId?stormEvent(w.eventId):null);return;}
  case 'storm-layout':stormState.filters.layout=key==='columns'?'columns':'table';render();return;
  case 'storm-select-none':stormSelected.clear();render();return;
 }
 if(!ev)throw Error('Open a storm first.');
 switch(name){
  case 'storm-edit':return stormEditDialog(ev);
  case 'storm-status':{const ids=key?[key]:stormChosen(ev);if(!ids.length)throw Error('Select residences first.');return stormStatusDialog(ev,ids);}
  case 'storm-assign':{const ids=stormChosen(ev);if(!ids.length)throw Error('Select residences first.');return stormAssignDialog(ev,ids);}
  case 'storm-schedule':{const chosen=stormChosen(ev);return stormScheduleDialog(ev,key==='post'?'post':'pre',chosen.length?chosen:undefined);}
  case 'storm-notify':{const chosen=stormChosen(ev),ids=chosen.length?chosen:ev.residences.map(r=>r.id);if(!ids.length)throw Error('Add residences first.');return stormNotifyDialog(ev,ids);}
  case 'storm-remove':{const ids=stormChosen(ev);if(!ids.length)throw Error('Select residences first.');if(!confirm(`Remove ${ids.length} residence${ids.length===1?'':'s'} from ${ev.name}? Storm visits that are not started stay in Inspection reports as ordinary visits.`))return;await api(`storm-events/${encodeURIComponent(ev.id)}/residences/remove`,{residenceIds:ids});stormSelected.clear();await stormRefresh();render();toast('Removed from the storm.');return;}
  case 'storm-active':await api(`storm-events/${encodeURIComponent(ev.id)}`,{version:ev.version,status:'active'});await stormRefresh();render();toast('Storm marked active.');return;
  case 'storm-close':if(!confirm(`Close ${ev.name}? The board becomes read-only and storm assignments stop giving access to residences.`))return;await api(`storm-events/${encodeURIComponent(ev.id)}`,{version:ev.version,status:'closed'});await stormRefresh();render();toast('Storm closed.');return;
  case 'storm-reopen':await api(`storm-events/${encodeURIComponent(ev.id)}`,{version:ev.version,status:'recovery'});await stormRefresh();render();toast('Storm reopened.');return;
  case 'storm-recovery':{
   if(!confirm(`Has ${ev.name} passed? This moves the storm to recovery so the team can check every home.`))return;
   const r=await api(`storm-events/${encodeURIComponent(ev.id)}/recovery`,{});await stormRefresh();render();
   const next=stormBoardEvent(),ids=r.securedWithoutPostVisit.length?r.securedWithoutPostVisit:r.withoutPostVisit;
   if(ids.length)stormScheduleDialog(next,'post',ids);else toast('Storm moved to recovery.');
   return;
  }
  case 'storm-route':{const mine=ev.residences.filter(r=>r.assigned_user_id===data.user.id&&[r.pre,r.post].some(v=>v&&v.status==='draft'));stormRoutePreset=[...new Set((mine.length?mine:ev.residences.filter(r=>r.assigned_user_id===data.user.id)).map(r=>r.property_id))];if(!stormRoutePreset.length)throw Error('No storm visits are assigned to you.');page='routes';render();window.scrollTo(0,0);return;}
 }
 return stormBaseAction(name,key,button);
};

/* ---------- form events (wizard, filters, selection) ---------- */
document.addEventListener('submit',async event=>{
 const form=event.target;if(!['stormStep1','stormStep3'].includes(form.id))return;
 event.preventDefault();const button=event.submitter;if(button)button.disabled=true;
 try{
  const w=stormState.wizard;
  if(form.id==='stormStep1'){const v=Object.fromEntries(new FormData(form));const payload={name:v.name,type:v.type,expectedImpactAt:stormIso(v.expectedImpactAt),prepDeadlineAt:stormIso(v.prepDeadlineAt),postCheckTargetAt:stormIso(v.postCheckTargetAt),notes:v.notes||''};
   if(w.eventId){const ev=stormEvent(w.eventId);await api(`storm-events/${encodeURIComponent(w.eventId)}`,{...payload,version:ev?.version});}else{const r=await api('storm-events',payload);w.eventId=r.event.id;}
   await stormRefresh();w.step=2;render();window.scrollTo(0,0);return;}
  const ev=stormEvent(w.eventId),targets=stormScheduleTargets(ev,'pre');
  if(targets.length){const r=await api(`storm-events/${encodeURIComponent(w.eventId)}/visits`,stormSchedulePayload(form,targets));toast(stormScheduleResult(r));}
  stormState.wizard=null;stormState.view='board';stormState.eventId=w.eventId;await stormRefresh();render();window.scrollTo(0,0);
 }catch(error){toast(error.message);}finally{if(button&&button.isConnected)button.disabled=false;}
});
document.addEventListener('change',event=>{
 const el=event.target;
 if(el.matches?.('[data-storm-pick]')){const w=stormState.wizard;if(!w)return;if(el.checked)w.selected.add(el.value);else w.selected.delete(el.value);stormPickCount();return;}
 if(el.matches?.('[data-storm-assignment],[data-storm-assign-input]')){stormSyncAssignment(el.form);return;}
 if(el.matches?.('[data-storm-select]')){if(el.checked)stormSelected.add(el.value);else stormSelected.delete(el.value);document.querySelectorAll(`[data-storm-select][value="${CSS.escape(el.value)}"]`).forEach(x=>{x.checked=el.checked;});const ev=stormBoardEvent();if(ev&&$('stormBulk'))$('stormBulk').innerHTML=stormBulkBar(ev);return;}
 if(el.matches?.('[data-storm-select-all]')){const ev=stormBoardEvent();if(!ev)return;stormRowsFiltered(ev).forEach(r=>el.checked?stormSelected.add(r.id):stormSelected.delete(r.id));render();return;}
 if(el.matches?.('select[data-storm-filter]')){stormState.filters[el.dataset.stormFilter]=el.value;stormRedrawRows();return;}
 if(el.matches?.('select[data-storm-pick-filter]')){stormPickFilter(el);return;}
});
document.addEventListener('input',event=>{
 const el=event.target;
 if(el.matches?.('textarea[data-autosize]')){stormAutosize(el);return;}
 if(el.matches?.('input[data-storm-filter]')){stormState.filters[el.dataset.stormFilter]=el.value;stormRedrawRows();return;}
 if(el.matches?.('input[data-storm-pick-filter]')){stormPickFilter(el);}
});
function stormPickFilter(el){const w=stormState.wizard;if(!w)return;w.filter={...w.filter,[el.dataset.stormPickFilter]:el.value};$('stormPickList').innerHTML=stormPickRows(w.eventId?stormEvent(w.eventId):null);}
function stormRedrawRows(){const ev=stormBoardEvent();if(ev&&$('stormRows'))$('stormRows').innerHTML=stormBoardRows(ev);}
/* Text boxes grow with their content instead of scrolling inside. */
function stormAutosize(el){el.style.height='auto';el.style.height=(el.scrollHeight+2)+'px';}
new MutationObserver(()=>document.querySelectorAll('textarea[data-autosize]').forEach(el=>{if(!el.dataset.sized){el.dataset.sized='1';stormAutosize(el);}})).observe(document.documentElement,{childList:true,subtree:true});

/* Live board: refresh every 30 seconds while it is on screen, unless a dialog is open or someone is typing. */
setInterval(()=>{
 if(!data||data.offline||page!=='storm'||stormState.view!=='board'||document.visibilityState!=='visible'||$('modal')?.open)return;
 const typing=document.activeElement&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);if(typing)return;
 stormRefresh().then(()=>{if(page==='storm'&&stormState.view==='board'&&!$('modal')?.open)render();}).catch(()=>{});
},30000);

/* ---------- hooks into existing screens ---------- */
const stormBaseView=view;
view=function(...args){if(page==='storm'&&data&&!data.offline&&['admin','employee'].includes(data.user.role))return stormView();return stormBaseView(...args);};

/* Storm banners: staff dashboard (red), client home (plain-language storm cards). */
const stormBaseActionNeeded=actionNeeded;
actionNeeded=function(...args){
 const base=stormBaseActionNeeded(...args);if(page!=='dashboard'||!data?.storm)return base;
 if(data.user.role==='client')return stormClientCards()+base;
 if(!['admin','employee'].includes(data.user.role))return base;
 return stormOpenEvents().map(ev=>{const c=ev.counts,mine=ev.residences.filter(r=>r.assigned_user_id===data.user.id&&[r.pre,r.post].some(v=>v&&v.status==='draft')).length;return `<div class="storm-banner" role="status"><span class="storm-tag">${esc(ev.type_label)}</span><div><strong>${esc(ev.name)} · ${esc(ev.status_label)}</strong><div>${stormAdmin()?`${c.secured} of ${c.total} residences secured${c.damageFound?` · ${c.damageFound} with damage found`:''}`:`${mine} storm visit${mine===1?'':'s'} waiting for you`}${ev.expected_impact_at?' · Expected impact '+esc(stormWhen(ev.expected_impact_at)):''}</div></div>${btn('Open storm board','storm-open',ev.id,true)}</div>`;}).join('')+base;
};
function stormClientCards(){
 const cards=(data.storm?.portal||[]).filter(c=>c.eventStatus!=='closed'||c.reportUrl).slice(0,6);if(!cards.length)return '';
 return `<section class="storm-client" aria-label="Storm updates">${cards.map(c=>`<article class="panel storm-client-card"><div class="eyebrow">${esc(c.typeLabel)} · ${esc(c.statusLabel)}</div><h2>${esc(c.eventName)}</h2><p class="muted">${esc(c.propertyName)}${c.expectedImpact?' · Expected impact '+esc(c.expectedImpact):''}</p><p class="storm-client-line">${stormPill(c.prepTone,'Preparation')} ${esc(c.prep)}.</p>${c.post?`<p class="storm-client-line">${stormPill(c.postTone||'open','After the storm')} ${esc(c.post)}.</p>`:''}${c.reportUrl?`<div class="actions"><a class="button primary" href="${esc(c.reportUrl)}" download>Download storm report (PDF)</a></div>`:''}</article>`).join('')}</section>`;
}
/* Residence overview: red banner while the residence is on an open storm. */
const stormBaseResidenceView=residenceView;
residenceView=function(...args){
 const html=stormBaseResidenceView(...args);if(!data?.storm)return html;let banner='';
 if(['admin','employee'].includes(data.user.role))banner=stormOpenEvents().flatMap(ev=>ev.residences.filter(r=>r.property_id===propertyId).map(r=>`<div class="storm-banner" role="status"><span class="storm-tag">${esc(ev.type_label)}</span><div><strong>${esc(ev.name)}</strong><div>Prep: ${esc(r.prep_label)} · After the storm: ${esc(r.post_label)}${r.assigned_name?' · Assigned to '+esc(r.assigned_name):''}</div></div>${btn('Open storm board','storm-open',ev.id)}</div>`)).join('');
 else if(data.user.role==='client')banner=(data.storm.portal||[]).filter(c=>c.propertyId===propertyId&&(c.eventStatus!=='closed'||c.reportUrl)).map(c=>`<div class="storm-banner storm-banner-client" role="status"><span class="storm-tag">${esc(c.typeLabel)}</span><div><strong>${esc(c.eventName)}</strong><div>${esc(c.prep)}.${c.post?' '+esc(c.post)+'.':''}</div></div>${c.reportUrl?`<a class="button" href="${esc(c.reportUrl)}" download>Storm report</a>`:''}</div>`).join('');
 if(!banner)return html;const at=html.indexOf('<div class="hero summary">');return at<0?banner+html:html.slice(0,at)+banner+html.slice(at);
};
/* Inspection screen: storm visit banner with the storm's key times and what to capture. */
const stormBaseInspectionView=inspectionView;
inspectionView=function(...args){
 const html=stormBaseInspectionView(...args),i=data.inspections.find(x=>x.id===activeInspection);if(!i?.storm_event_id)return html;
 const ev=stormEvent(i.storm_event_id),post=i.visit_type==='post_storm',tz=(data.properties.find(p=>p.id===i.property_id)||{}).effective_timezone;
 const times=ev?[ev.prep_deadline_at&&!post?'Preparation deadline '+stormWhen(ev.prep_deadline_at,tz):'',ev.expected_impact_at?'Expected impact '+stormWhen(ev.expected_impact_at,tz):''].filter(Boolean).join(' · '):'';
 const banner=`<div class="storm-visit-banner" role="note"><span class="storm-tag">Storm visit</span><div><strong>${esc(ev?.name||'Storm')} · ${post?'Post-storm visit':'Pre-storm visit'}</strong>${times?`<div class="muted">${esc(times)}</div>`:''}<div>${post?'Photograph every room and each side of the exterior, including any damage, before anything is cleaned up. These photos go into the family\'s storm report.':'Secure the home and photograph its condition. These photos become the "before" pictures in the family\'s storm report.'}</div></div>${ev&&!data.offline?btn('Open storm board','storm-open',ev.id):''}</div>`;
 const at=html.indexOf('<div class="panel inspection-screen"');return at<0?banner+html:html.slice(0,at)+banner+html.slice(at);
};
/* Daily route: "Plan route for my storm visits" preselects the storm residences. */
const stormBaseRouteView=routeView;
routeView=function(...args){
 const html=stormBaseRouteView(...args),preset=stormRoutePreset;if(!preset?.length)return html;
 routePlannerSelections.inspections=false;for(const id of preset)routePlannerSelections.manual.set(id,true);
 setTimeout(()=>{const group=document.querySelector('[data-route-group="inspections"]');if(group)group.checked=false;document.querySelectorAll('.route-stop').forEach(stop=>{stop.checked=!!routeSelected(stop.value);});},0);
 return `<div class="storm-banner" role="status"><span class="storm-tag">Storm</span><div><strong>Route for your storm visits</strong><div>${preset.length} residence${preset.length===1?'':'s'} selected below. Add your starting address, then open directions.</div></div></div>`+html;
};
