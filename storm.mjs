// Hurricane and storm workflow: storm events, bulk storm visit scheduling, the live status board, client storm
// notices, the CSV export and the insurance-claim-ready storm report. Storm visits are ordinary inspections
// (visit_type pre_storm / post_storm) linked by storm_event_id, so offline completion, checklist templates and
// snapshots, fail alerts, visit verification and EXIF stripping all work on them unchanged.
// Admins manage storms. Employees see and update the residences they are assigned on a storm (or manage).
// Clients see their own residences' storm status and, once a storm visit is published, the storm report.
import {createHash} from 'node:crypto';
import {presetItems,normalizeTemplate,VISIT_TYPE_LABELS} from './checklist-templates.mjs';
import {formatWhen,visitDate} from './fail-alerts.mjs';
import {stormReportPdf,stormSummaryPdf} from './storm-pdf.mjs';
import './public/inspection-checklist.js';
import './public/storm-core.js';
const S=globalThis.EAStorm, EAChecklist=globalThis.EAChecklist;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ITEM_COLUMNS='id,template_version_id,section,label,help_text,response_type,options,required,photo_rule,scope,room_types,sort_order,stable_key,alert_on_fail';
const slug=s=>String(s||'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'Storm';
const titleCase=s=>String(s||'').replaceAll('_',' ').replace(/^\w/,c=>c.toUpperCase());

/** Link that opens the portal after sign-in. Uses APP_URL when it is a valid https origin. */
export function portalLink(env=process.env){let origin='https://estateaegis.com';try{const base=new URL(env.APP_URL||origin);if(base.protocol==='https:'&&!base.username&&!base.password)origin=base.origin;}catch{}return origin+'/login';}

/** Subject, plain text and branded HTML for a client storm notice. Pure, so tests can check it. */
export function renderStormEmail(d){
 const subject={prep_planned:`Storm preparation planned: ${d.property_name}`,secured:`${d.property_name} is secured for ${d.event_name}`,post_check_complete:`Post-storm check complete: ${d.property_name}`}[d.template];
 const heading={prep_planned:`We are preparing ${d.property_name} for ${d.event_name}`,secured:`${d.property_name} is secured`,post_check_complete:`Post-storm check complete at ${d.property_name}`}[d.template];
 const text=[heading,'',...d.lines,'',`Sign in to see the storm status${d.template==='post_check_complete'?' and the storm report':''}: ${d.link}`,'',`You are receiving this because you are a family member on the ${d.company} account for ${d.property_name}.`].join('\n');
 const html=`<div style="margin:0;padding:24px 12px;background:#f7f8fa;font-family:Arial,Helvetica,sans-serif;color:#1f2933"><div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e7eb;border-radius:12px;overflow:hidden">`
  +`<div style="border-top:4px solid #7e202b;padding:24px 28px 6px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5f6b76">${esc(d.company)} · ${esc(d.event_name)}</div><h1 style="font-size:22px;line-height:1.3;margin:8px 0 6px;color:#7e202b">${esc(heading)}</h1><p style="margin:0;color:#5f6b76;font-size:14px">${esc(d.address||'')}</p></div>`
  +`<div style="padding:12px 28px 4px">${d.lines.map(l=>`<p style="margin:0 0 10px;font-size:15px;line-height:1.5;color:#1f2933">${esc(l)}</p>`).join('')}</div>`
  +`<div style="padding:14px 28px 26px"><a href="${esc(d.link)}" style="display:inline-block;background:#7e202b;color:#ffffff;padding:13px 22px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px">${d.template==='post_check_complete'?'View the storm report':'View storm status'}</a><p style="margin:16px 0 0;font-size:12px;color:#8a949d">If the button does not work, copy this link:<br>${esc(d.link)}</p></div>`
  +`<div style="padding:16px 28px;background:#faf9f6;border-top:1px solid #e2e7eb;font-size:12px;color:#5f6b76">You are receiving this because you are a family member on the ${esc(d.company)} account for ${esc(d.property_name)}. Powered by EstateAegis.</div></div></div>`;
 return {subject,text,html};
}

export function createStorm({get,all,run,transaction,id,now,fail,text,note,date,json,body,roles,property,audit,visitChecklists,visitVerification,readFile,readBytes,checklistLabel},{env=process.env}={}){
 const ROUTE=/^\/api\/storm-events\/([^/]+)(?:\/(residences|residences\/remove|residences\/update|visits|recovery|notify|export\.csv|summary\.pdf|residences\/([^/]+)\/report\.pdf))?$/;
 const isStaff=u=>['admin','employee'].includes(u.role);
 function when(value,label){if(value==null||value==='')return null;const t=Date.parse(String(value));if(Number.isNaN(t))fail(422,`${label} is not a valid date and time.`);return new Date(t).toISOString();}
 function oneOf(value,map,label){if(!Object.hasOwn(map,value))fail(422,`Choose a valid ${label}.`);return value;}
 function ids(list,label='residences',max=500){if(!Array.isArray(list)||!list.length)fail(422,`Choose at least one of the ${label}.`);if(list.length>max)fail(422,`Choose at most ${max} ${label}.`);const out=[...new Set(list.map(String))];if(out.some(x=>!x||x.length>100))fail(422,`Choose valid ${label}.`);return out;}
 async function eventFor(user,eventId){const ev=await get('SELECT * FROM storm_events WHERE id=? AND organization_id=?',String(eventId),user.organization_id);if(!ev)fail(404,'Storm not found.');return ev;}
 const open=ev=>{if(ev.status==='closed')fail(409,'This storm is closed. Reopen it before changing it.');};
 async function staffMember(user,userId){const u=await get("SELECT id,name,role FROM users WHERE id=? AND organization_id=? AND active=1 AND role IN ('admin','employee')",String(userId||''),user.organization_id);if(!u)fail(422,'Choose an active team member.');return u;}
 const tzSettings=async org=>visitVerification.settings(org);
 const tzOf=(p,s)=>{try{return visitVerification.timezoneFor(p,s)||'America/New_York';}catch{return p?.timezone||'America/New_York';}};

 /** Residences on an event, joined with residence, family, assignee and linked visit info. Employees: only theirs. */
 async function rows(user,ev){
  const list=await all(`SELECT r.*,p.name property_name,p.address,p.city,p.postal_code,p.timezone,p.client_id,p.account_manager_id,c.name client_name,u.name assigned_name,
   pre.status pre_visit_status,pre.inspection_date pre_date,pre.submitted_at pre_submitted_at,pre.published_at pre_published_at,pre.inspector_id pre_inspector_id,
   post.status post_visit_status,post.inspection_date post_date,post.submitted_at post_submitted_at,post.published_at post_published_at,post.inspector_id post_inspector_id
   FROM storm_event_residences r JOIN properties p ON p.id=r.property_id LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN users u ON u.id=r.assigned_user_id
   LEFT JOIN inspections pre ON pre.id=r.pre_inspection_id LEFT JOIN inspections post ON post.id=r.post_inspection_id
   WHERE r.storm_event_id=? AND r.organization_id=? ORDER BY p.name,r.id`,ev.id,user.organization_id);
  const mine=user.role==='admin'?list:list.filter(r=>r.assigned_user_id===user.id||r.account_manager_id===user.id);
  return mine.map(r=>shape(r,user));
 }
 function shape(r,user){
  const visit=(phase)=>r[phase+'_inspection_id']?{id:r[phase+'_inspection_id'],status:r[phase+'_visit_status'],date:r[phase+'_date'],submitted_at:r[phase+'_submitted_at'],published_at:r[phase+'_published_at'],inspector_id:r[phase+'_inspector_id']}:null;
  return {id:r.id,storm_event_id:r.storm_event_id,property_id:r.property_id,property_name:r.property_name,address:r.address||'',city:r.city||'',postal_code:r.postal_code||'',client_name:r.client_name||'',account_manager_id:r.account_manager_id||null,
   prep_status:r.prep_status,prep_issues:Number(r.prep_issues)||0,prep_label:S.prepLabel(r.prep_status,r.prep_issues),prep_tone:S.tone('prep',r.prep_status,r.prep_issues),
   post_status:r.post_status,post_label:S.postLabel(r.post_status),post_tone:S.tone('post',r.post_status),damage_severity:r.damage_severity||null,severity_label:r.damage_severity?S.SEVERITY[r.damage_severity]||titleCase(r.damage_severity):'',
   assigned_user_id:r.assigned_user_id||null,assigned_name:r.assigned_name||'',pre_inspection_id:r.pre_inspection_id||null,post_inspection_id:r.post_inspection_id||null,pre:visit('pre'),post:visit('post'),
   report_available:r.pre_visit_status==='published'||r.post_visit_status==='published',
   client_prep_notified_at:r.client_prep_notified_at||null,client_post_notified_at:r.client_post_notified_at||null,internal_notes:isStaff(user)?r.internal_notes||'':'',updated_at:r.updated_at};
 }
 async function workOrders(user,ev,visible){
  const list=await all('SELECT w.id,w.title,w.status,w.priority,w.property_id,w.due_date,v.name vendor_name,p.name property_name FROM work_orders w JOIN properties p ON p.id=w.property_id LEFT JOIN vendors v ON v.id=w.vendor_id WHERE w.storm_event_id=? AND p.organization_id=? ORDER BY w.created_at',ev.id,user.organization_id);
  return user.role==='admin'?list:list.filter(w=>visible.has(w.property_id));
 }
 async function eventOut(user,ev){
  const list=await rows(user,ev),visible=new Set(list.map(r=>r.property_id));
  return {id:ev.id,name:ev.name,type:ev.type,type_label:S.TYPES[ev.type]||titleCase(ev.type),status:ev.status,status_label:S.EVENT_STATUSES[ev.status]||titleCase(ev.status),expected_impact_at:ev.expected_impact_at,prep_deadline_at:ev.prep_deadline_at,post_check_target_at:ev.post_check_target_at,notes:ev.notes||'',closed_at:ev.closed_at,version:Number(ev.version),created_at:ev.created_at,updated_at:ev.updated_at,counts:S.counts(list),residences:list,workOrders:await workOrders(user,ev,visible)};
 }

 /** Client portal cards: plain-language status per residence of the family, newest storm first. */
 async function clientCards(user){
  const list=await all(`SELECT r.*,e.name event_name,e.type event_type,e.status event_status,e.expected_impact_at,e.created_at event_created_at,p.name property_name,p.timezone,p.timezone_source,p.client_id,
   pre.status pre_visit_status,pre.inspection_date pre_date,pre.submitted_at pre_submitted_at,pre.published_at pre_published_at,post.status post_visit_status,post.inspection_date post_date,post.submitted_at post_submitted_at,post.published_at post_published_at
   FROM storm_event_residences r JOIN storm_events e ON e.id=r.storm_event_id JOIN properties p ON p.id=r.property_id
   LEFT JOIN inspections pre ON pre.id=r.pre_inspection_id LEFT JOIN inspections post ON post.id=r.post_inspection_id
   WHERE r.organization_id=? AND p.client_id=? AND p.archived_at IS NULL ORDER BY e.created_at DESC,p.name LIMIT 40`,user.organization_id,user.client_id);
  const s=await tzSettings(user.organization_id);
  return list.map(r=>{const tz=tzOf(r,s),at=v=>formatWhen(v,tz),t=S.clientText(r,{preAt:r.pre_submitted_at||r.pre_published_at,postAt:r.post_submitted_at||r.post_published_at,preDate:r.pre_date,postDate:r.post_date},at,visitDate);
   const report=r.pre_visit_status==='published'||r.post_visit_status==='published';
   return {eventId:r.storm_event_id,residenceId:r.id,eventName:r.event_name,typeLabel:S.TYPES[r.event_type]||titleCase(r.event_type),eventStatus:r.event_status,statusLabel:S.EVENT_STATUSES[r.event_status]||titleCase(r.event_status),expectedImpact:r.expected_impact_at?at(r.expected_impact_at):'',propertyId:r.property_id,propertyName:r.property_name,prep:t.prep,post:t.post,prepTone:S.tone('prep',r.prep_status,r.prep_issues),postTone:r.post_status==='not_started'?'':S.tone('post',r.post_status),reportUrl:report?`/api/storm-events/${encodeURIComponent(r.storm_event_id)}/residences/${encodeURIComponent(r.id)}/report.pdf`:''};
  });
 }

 /** The newest published checklist for a storm phase, creating and publishing the starter one when there is none. */
 async function phaseChecklist(user,visitType,templateId){
  if(templateId)return {chosen:await visitChecklists.resolve(user.organization_id,{templateId:String(templateId),visitType}),created:false};
  let chosen=await visitChecklists.resolve(user.organization_id,{visitType});
  if(chosen.snapshot)return {chosen,created:false};
  const t=normalizeTemplate({name:VISIT_TYPE_LABELS[visitType],visit_type:visitType,description:'Starter checklist published automatically for storm visits. Edit it in Checklist templates; new versions apply to visits scheduled afterwards.',items:presetItems(visitType)});
  const key=id(),versionId=id(),at=now();
  await run('INSERT INTO checklist_templates(id,organization_id,name,visit_type,description,is_system,is_default,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',key,user.organization_id,t.name,t.visit_type,t.description,0,0,user.id,at,at);
  await run('INSERT INTO checklist_template_versions(id,template_id,version,status,created_at,published_at,published_by) VALUES(?,?,?,?,?,?,?)',versionId,key,1,'published',at,at,user.id);
  for(const [index,item] of t.items.entries())await run(`INSERT INTO checklist_template_items(${ITEM_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),versionId,item.section,item.label,item.help_text,item.response_type,JSON.stringify(item.options),item.required?1:0,item.photo_rule,item.scope,JSON.stringify(item.room_types),index,item.stable_key,item.alert_on_fail?1:0);
  await audit(user,'checklist_template.created',key);await audit(user,'checklist_template.published',key);
  chosen=await visitChecklists.resolve(user.organization_id,{templateId:key,visitType});
  return {chosen,created:true};
 }

 /** Create storm visits for residences on the event. Residences that already have a visit for the phase are skipped. */
 async function scheduleVisits(user,ev,b){
  const phase=b.phase==='post'?'post':b.phase==='pre'?'pre':fail(422,'Choose pre-storm or post-storm visits.');
  const visitType=S.PHASE_VISIT[phase],visitDay=date(b.date),assignment=['residence_manager','round_robin','user'].includes(b.assignment)?b.assignment:fail(422,'Choose how to assign the visits.');
  let list=await all('SELECT r.*,p.name property_name,p.account_manager_id,p.inspection_report_email,p.archived_at FROM storm_event_residences r JOIN properties p ON p.id=r.property_id WHERE r.storm_event_id=? AND r.organization_id=? ORDER BY p.name,r.id',ev.id,user.organization_id);
  if(b.residenceIds!==undefined){const wanted=new Set(ids(b.residenceIds));list=list.filter(r=>wanted.has(r.id));if(list.length!==wanted.size)fail(422,'Choose residences that are on this storm.');}
  const staffRows=await all("SELECT id,name,role FROM users WHERE organization_id=? AND active=1 AND role IN ('admin','employee') ORDER BY name",user.organization_id),staffById=new Map(staffRows.map(u=>[u.id,u]));
  let single=null,rr=new Map();
  if(assignment==='user')single=await staffMember(user,b.userId);
  if(assignment==='round_robin'){const chosen=Array.isArray(b.userIds)&&b.userIds.length?b.userIds.map(String):staffRows.filter(u=>u.role==='employee').map(u=>u.id);if(!chosen.length)fail(422,'Choose the team members to share the visits.');for(const u of chosen)if(!staffById.has(u))fail(422,'Choose active team members.');rr=S.roundRobin(list.map(r=>({id:r.property_id,name:r.property_name})),chosen);}
  const skipped=[],eligible=[];
  for(const r of list){
   if(r.archived_at){skipped.push({residenceId:r.id,residence:r.property_name,reason:'Residence is archived'});continue;}
   if(r[phase+'_inspection_id']){skipped.push({residenceId:r.id,residence:r.property_name,reason:'Already has a '+(phase==='pre'?'pre-storm':'post-storm')+' visit'});continue;}
   if(phase==='pre'&&['client_declined','not_needed'].includes(r.prep_status)){skipped.push({residenceId:r.id,residence:r.property_name,reason:S.PREP[r.prep_status]});continue;}
   eligible.push(r);
  }
  if(!eligible.length)return {created:0,skipped,assignments:[],template:null};
  const {chosen,created:templateCreated}=await phaseChecklist(user,visitType,b.templateId),snap=chosen.snapshot;
  const answers=JSON.stringify(snap?EAChecklist.propertyAnswers(snap):[]);
  if(!snap)fail(422,'Publish a checklist for this visit type first.');
  const assignments=[],perUser=new Map();
  await transaction(async()=>{
   for(const r of eligible){
    let assignee=single?.id||rr.get(r.property_id)||null,note='';
    if(assignment==='residence_manager'){assignee=staffById.has(r.account_manager_id)?r.account_manager_id:user.id;if(assignee===user.id&&r.account_manager_id!==user.id)note='No Residence Manager, assigned to you';}
    const key=id(),statusCol=phase==='pre'?'prep_status':'post_status',linkCol=phase+'_inspection_id';
    // Claim the residence first, so a repeated or concurrent request never creates a second visit.
    const claimed=await run(`UPDATE storm_event_residences SET ${linkCol}=?,assigned_user_id=?,${statusCol}=CASE WHEN ${statusCol} IN ('not_started','unreachable','inaccessible') THEN 'scheduled' ELSE ${statusCol} END,updated_at=? WHERE id=? AND ${linkCol} IS NULL`,key,assignee,now(),r.id);
    if(claimed.changes!==1){skipped.push({residenceId:r.id,residence:r.property_name,reason:'Already has a '+(phase==='pre'?'pre-storm':'post-storm')+' visit'});continue;}
    await run('INSERT INTO inspections(id,property_id,inspector_id,inspection_date,answers,created_at,frequency,next_due,visit_type,template_id,template_version,template_version_id,checklist_snapshot,storm_event_id,report_email) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,r.property_id,assignee,visitDay,answers,now(),'One-time','',visitType,snap.template_id,snap.template_version,snap.template_version_id,JSON.stringify(snap),ev.id,r.inspection_report_email||'');
    await audit(user,'inspection.started',key);
    assignments.push({residenceId:r.id,residence:r.property_name,inspectionId:key,assigneeId:assignee,assignee:staffById.get(assignee)?.name||'',note});
    if(assignee!==user.id)perUser.set(assignee,(perUser.get(assignee)||0)+1);
   }
   for(const [userId,count] of perUser)await run('INSERT INTO notifications(id,user_id,title,entity_id,read_at,created_at,kind,body) VALUES(?,?,?,?,?,?,?,?)',id(),userId,`${count} ${phase==='pre'?'pre-storm':'post-storm'} visit${count===1?'':'s'} assigned: ${ev.name}`,ev.id,null,now(),'storm_assigned',`Visit date ${visitDate(visitDay)}. Open Storms to see your residences.`);
   await audit(user,`storm.${phase}_visits_scheduled`,ev.id);
  });
  return {created:assignments.length,skipped,assignments,template:{...checklistLabel(snap),created:templateCreated}};
 }

 const NOTICE_PHASE={prep_planned:'prep',secured:'prep',post_check_complete:'post'};
 function noticeProblem(template,r){
  if(template==='prep_planned'&&['client_declined','not_needed'].includes(r.prep_status))return S.PREP[r.prep_status];
  if(template==='secured'&&r.prep_status!=='secured')return 'Not secured yet';
  if(template==='post_check_complete'&&!['no_damage','damage_found'].includes(r.post_status))return 'Post-storm check not complete';
  return '';
 }
 async function noticeFor(user,ev,r,template,company,s){
  const tz=tzOf(r,s),at=v=>formatWhen(v,tz),t=S.clientText(r,{preAt:r.pre_submitted_at||r.pre_published_at,postAt:r.post_submitted_at||r.post_published_at,preDate:r.pre_date,postDate:r.post_date},at,visitDate);
  const lines=template==='prep_planned'?[`Our team is preparing for ${ev.name}.`,r.pre_date?`We plan to secure ${r.property_name} on ${visitDate(r.pre_date)}.`:`We are planning storm preparation for ${r.property_name}.`,'We will let you know when your home is secured.']
   :template==='secured'?[t.prep+'.',ev.expected_impact_at?`The storm is expected around ${at(ev.expected_impact_at)}.`:'','We will check on your home after the storm passes.'].filter(Boolean)
   :[t.post+'.',r.post_visit_status==='published'?'The storm report with photos is ready in your portal.':'The storm report will be in your portal once it is finalized.'];
  return renderStormEmail({template,company,event_name:ev.name,property_name:r.property_name,address:r.address||'',lines,link:portalLink(env)});
 }
 async function notify(user,ev,b){
  const template=oneOf(b.template,S.NOTIFY,'message'),preview=b.preview===true;
  const wanted=new Set(ids(b.residenceIds));
  const list=(await all(`SELECT r.*,p.name property_name,p.address,p.timezone,p.timezone_source,p.client_id,c.email family_email,pre.inspection_date pre_date,pre.submitted_at pre_submitted_at,pre.published_at pre_published_at,post.status post_visit_status,post.inspection_date post_date,post.submitted_at post_submitted_at,post.published_at post_published_at
   FROM storm_event_residences r JOIN properties p ON p.id=r.property_id LEFT JOIN clients c ON c.id=p.client_id LEFT JOIN inspections pre ON pre.id=r.pre_inspection_id LEFT JOIN inspections post ON post.id=r.post_inspection_id WHERE r.storm_event_id=? AND r.organization_id=? ORDER BY p.name`,ev.id,user.organization_id)).filter(r=>wanted.has(r.id));
  if(list.length!==wanted.size)fail(422,'Choose residences that are on this storm.');
  const company=(await get('SELECT name FROM organizations WHERE id=?',user.organization_id))?.name||'Your residence care team',s=await tzSettings(user.organization_id);
  const demo=await get('SELECT organization_id FROM demo_workspaces WHERE organization_id=?',user.organization_id);
  const skipped=[],ready=[];
  for(const r of list){
   const problem=noticeProblem(template,r);if(problem){skipped.push({residenceId:r.id,residence:r.property_name,reason:problem});continue;}
   const members=await all("SELECT id,name,email FROM users WHERE organization_id=? AND role='client' AND client_id=? AND active=1 ORDER BY name",user.organization_id,r.client_id);
   const emails=members.filter(m=>m.email).map(m=>({userId:m.id,email:m.email}));
   if(!emails.length&&r.family_email)emails.push({userId:null,email:r.family_email});
   if(!emails.length&&!members.length){skipped.push({residenceId:r.id,residence:r.property_name,reason:'No family email or portal account'});continue;}
   const keys=emails.map(e=>createHash('sha256').update(user.organization_id+':storm:'+template+':'+r.id+':'+e.email.toLowerCase()).digest('hex'));
   const sent=keys.length?Number((await get(`SELECT COUNT(*) n FROM email_outbox WHERE id IN (${keys.map(()=>'?').join(',')})`,...keys))?.n||0):0;
   if(keys.length&&sent===keys.length){skipped.push({residenceId:r.id,residence:r.property_name,reason:'Already sent'});continue;}
   ready.push({r,members,emails,keys});
  }
  if(preview){const first=ready[0];const sample=first?await noticeFor(user,ev,first.r,template,company,s):null;return {preview:true,template,label:S.NOTIFY[template],recipients:ready.map(x=>({residenceId:x.r.id,residence:x.r.property_name,emails:x.emails.map(e=>e.email),portalAccounts:x.members.length})),skipped,sample:sample?{residence:first.r.property_name,subject:sample.subject,text:sample.text}:null,emailDisabled:!!demo};}
  let emails=0,inApp=0;
  await transaction(async()=>{
   for(const {r,members,emails:to,keys} of ready){
    const msg=await noticeFor(user,ev,r,template,company,s);
    if(!demo)for(const [i,e] of to.entries()){const ins=await run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,html,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',keys[i],user.organization_id,e.userId,e.email,msg.subject,msg.text,msg.html,now(),now());emails+=ins.changes||0;}
    for(const m of members){const kind='storm_'+template;if(await get('SELECT id FROM notifications WHERE user_id=? AND kind=? AND entity_id=?',m.id,kind,r.property_id+':'+ev.id))continue;await run('INSERT INTO notifications(id,user_id,title,entity_id,read_at,created_at,kind,body) VALUES(?,?,?,?,?,?,?,?)',id(),m.id,msg.subject,r.property_id+':'+ev.id,null,now(),kind,msg.text.split('\n').slice(2,4).join(' '));inApp++;}
    await run(`UPDATE storm_event_residences SET ${NOTICE_PHASE[template]==='prep'?'client_prep_notified_at':'client_post_notified_at'}=?,updated_at=? WHERE id=?`,now(),now(),r.id);
   }
   await audit(user,'storm.clients_notified:'+template,ev.id);
  });
  return {template,notified:ready.length,emails,inApp,skipped,emailDisabled:!!demo};
 }

 /** Everything the storm report PDF needs for one residence. Only published storm visits are used. */
 /** Creates a storm event (admin). Used by the storm page and by "Start storm event" on a weather alert. */
 async function createEvent(user,b){
  roles(user,'admin');const key=id(),at=now();
  await run('INSERT INTO storm_events(id,organization_id,name,type,status,expected_impact_at,prep_deadline_at,post_check_target_at,notes,created_by,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',key,user.organization_id,text(b.name,'Storm name',160),oneOf(b.type||'hurricane',S.TYPES,'storm type'),'preparing',when(b.expectedImpactAt,'Expected impact'),when(b.prepDeadlineAt,'Preparation deadline'),when(b.postCheckTargetAt,'Post-storm check target'),note(b.notes),user.id,1,at,at);
  await audit(user,'storm.created',key);
  return key;
 }
 /** Adds residences (already checked to be active residences in the user's company) to a storm. Returns how many were new. */
 async function insertResidences(user,ev,propertyIds){
  let added=0;const at=now();
  await transaction(async()=>{for(const pid of propertyIds){const r=await run('INSERT INTO storm_event_residences(id,organization_id,storm_event_id,property_id,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(storm_event_id,property_id) DO NOTHING',id(),user.organization_id,ev.id,pid,at,at);added+=r.changes||0;}await audit(user,'storm.residences_added',ev.id);});
  return added;
 }
 /** For the weather module: add residences to an open storm in the admin's company. */
 async function addResidences(user,eventId,propertyIds){
  roles(user,'admin');const ev=await eventFor(user,eventId);open(ev);
  const ok=new Set((await all('SELECT id FROM properties WHERE organization_id=? AND archived_at IS NULL',user.organization_id)).map(r=>r.id));
  const list=[...new Set(propertyIds)].filter(x=>ok.has(x));
  const added=await insertResidences(user,ev,list);return {event:ev,added,alreadyIncluded:list.length-added};
 }
 let reportExtras=null;
 /** Optional hook (weather alerts) that adds facts to the storm report. fn(user,event,residenceRow) -> {alert} */
 function setReportExtras(fn){reportExtras=fn;}

 async function reportData(user,ev,r){
  const pRow=await get('SELECT * FROM properties WHERE id=?',r.property_id),s=await tzSettings(user.organization_id),tz=tzOf(pRow,s);
  const org=await get('SELECT name FROM organizations WHERE id=?',user.organization_id),logo=(await get('SELECT logo_data FROM workspace_settings WHERE organization_id=?',user.organization_id))?.logo_data||'';
  const photos=new Map(),meta={pre:[],post:[]};
  const visit=async phase=>{
   const i=r[phase+'_inspection_id']?await get('SELECT * FROM inspections WHERE id=?',r[phase+'_inspection_id']):null;if(!i||i.status!=='published')return null;
   let snap={};try{snap=JSON.parse(i.report_snapshot||'{}');}catch{}
   const rep=await visitVerification.reportForPdf(user,i,{...snap});
   for(const fileId of snap.fileIds||[]){try{const f=await readFile(user,fileId);photos.set(f.id,{id:f.id,name:f.name,bytes:await readBytes(f.storage_key),capturedAt:f.captured_at||null,timezone:tz,atResidence:visitVerification.photoAtResidence(f,rep)});meta[phase].push({id:f.id,name:f.name,answer_key:f.answer_key,captured_at:f.captured_at,created_at:f.created_at});}catch{}}
   return {id:i.id,date:i.inspection_date,dateLabel:visitDate(i.inspection_date),completedAt:i.submitted_at||snap.completedAt||i.published_at,inspector:snap.inspector,reportNumber:snap.reportNumber||i.report_number||'',checklistName:snap.checklist?`${snap.checklist.name} (version ${snap.checklist.template_version})`:'Standard checklist',summary:snap.summary||'',notes:snap.notes||'',answers:snap.answers||[],verification:rep.visit||null,weatherLine:snap.weather?.line||'',weatherSource:snap.weather?.attribution||'',photoIds:meta[phase].map(p=>p.id)};
  };
  const pre=await visit('pre'),post=await visit('post');
  const pairs=pre&&post?S.pairPhotos(meta.pre,meta.post).map(p=>({beforeId:p.before?.id||null,afterId:p.after?.id||null,match:p.match})):[];
  const jobs=(await all('SELECT w.title,w.status,v.name vendor FROM work_orders w LEFT JOIN vendors v ON v.id=w.vendor_id WHERE w.storm_event_id=? AND w.property_id=? ORDER BY w.created_at',ev.id,r.property_id)).map(w=>({title:w.title,status:titleCase(w.status),vendor:w.vendor||''}));
  const extras=reportExtras?await reportExtras(user,ev,r).catch(()=>null):null;
  return {report:{weatherAlert:extras?.alert||null,weatherNote:extras?.note||[...new Set([pre?.weatherSource,post?.weatherSource].filter(Boolean))].join(' ')||'',company:org?.name||'',companyLogo:logo,timezone:tz,preparedAt:now(),reference:`Storm report reference ${r.id}`,event:{name:ev.name,typeLabel:S.TYPES[ev.type]||titleCase(ev.type),expectedImpactAt:ev.expected_impact_at,prepDeadlineAt:ev.prep_deadline_at},residence:{name:pRow.name,address:pRow.address||''},family:(await get('SELECT name FROM clients WHERE id=?',pRow.client_id))?.name||'',prepLabel:S.prepLabel(r.prep_status,r.prep_issues),prepTone:S.tone('prep',r.prep_status,r.prep_issues),postLabel:S.postLabel(r.post_status),postTone:S.tone('post',r.post_status),severity:r.damage_severity?S.SEVERITY[r.damage_severity]:'',pre,post,pairs,workOrders:jobs},photos,pRow};
 }

 function csv(event){
  const head=['Residence','Address','Family','Assigned to','Prep status','Post-storm status','Damage severity','Pre-storm visit date','Pre-storm visit','Post-storm visit date','Post-storm visit','Family told (prep)','Family told (post-storm)','Internal notes'];
  const out=[S.csvRow(head)];
  for(const r of event.residences)out.push(S.csvRow([r.property_name,r.address,r.client_name,r.assigned_name||'Unassigned',r.prep_label,r.post_label,r.severity_label,r.pre?.date||'',r.pre?titleCase(r.pre.status):'',r.post?.date||'',r.post?titleCase(r.post.status):'',r.client_prep_notified_at||'',r.client_post_notified_at||'',r.internal_notes]));
  return out.join('\r\n')+'\r\n';
 }

 async function handle(req,res,url,user){
  const p=url.pathname,method=req.method;
  if(p==='/api/storm'&&method==='GET'){
   if(!user)fail(401,'Please sign in.');
   if(user.role==='client')return json(res,200,{portal:await clientCards(user)});
   roles(user,'admin','employee');
   const events=await all("SELECT * FROM storm_events WHERE organization_id=? ORDER BY CASE WHEN status='closed' THEN 1 ELSE 0 END,created_at DESC LIMIT 30",user.organization_id);
   const out=[];for(const ev of events){const shaped=await eventOut(user,ev);if(user.role==='admin'||shaped.residences.length)out.push(shaped);}
   return json(res,200,{events:out,canManage:user.role==='admin'});
  }
  if(p==='/api/storm-events'&&method==='POST'){
   roles(user,'admin');const key=await createEvent(user,await body(req));
   return json(res,201,{event:await eventOut(user,await eventFor(user,key))});
  }
  const m=p.match(ROUTE);if(!m)return false;
  roles(user,'admin','employee','client');
  const ev=await eventFor(user,m[1]),sub=m[2]||'';
  if(sub.endsWith('/report.pdf')&&method==='GET'){
   const r=await get('SELECT * FROM storm_event_residences WHERE id=? AND storm_event_id=? AND organization_id=?',m[3],ev.id,user.organization_id);if(!r)fail(404,'Residence not found on this storm.');
   await property(user,r.property_id,'read');
   if(user.role==='employee'&&r.assigned_user_id!==user.id&&!(await get('SELECT 1 FROM properties WHERE id=? AND account_manager_id=?',r.property_id,user.id)))fail(404,'Residence not found on this storm.');
   const {report,photos,pRow}=await reportData(user,ev,r);
   if(!report.pre&&!report.post&&user.role==='client')fail(409,'The storm report will be available once a storm visit is published.');
   const pdf=stormReportPdf(report,photos);
   res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Storm-Report-${slug(ev.name)}-${slug(pRow.name)}.pdf"`,'Cache-Control':'no-store'});
   return res.end(pdf),true;
  }
  roles(user,'admin','employee');
  if(!sub&&method==='GET'){const out=await eventOut(user,ev);if(user.role!=='admin'&&!out.residences.length)fail(404,'Storm not found.');return json(res,200,{event:out});}
  if(sub==='export.csv'&&method==='GET'){
   const out=await eventOut(user,ev);if(user.role!=='admin'&&!out.residences.length)fail(404,'Storm not found.');
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="Storm-${slug(ev.name)}.csv"`,'Cache-Control':'no-store'});return res.end('\ufeff'+csv(out)),true;
  }
  if(sub==='residences/update'&&method==='POST'){
   const b=await body(req),wanted=ids(b.residenceIds);
   const list=(await rows(user,ev)).filter(r=>wanted.includes(r.id));if(list.length!==wanted.length)fail(user.role==='admin'?422:404,'Choose residences on this storm that you can update.');
   if(user.role!=='admin'&&b.assignedUserId!==undefined)fail(403,'Only an administrator can reassign storm residences.');
   open(ev);
   const set=[],args=[];
   if(b.prepStatus!==undefined){set.push('prep_status=?');args.push(oneOf(b.prepStatus,S.PREP,'prep status'));if(b.prepStatus!=='secured'){set.push('prep_issues=0');}}
   if(b.postStatus!==undefined){set.push('post_status=?');args.push(oneOf(b.postStatus,S.POST,'post-storm status'));}
   if(b.severity!==undefined){set.push('damage_severity=?');args.push(b.severity===''||b.severity===null?null:oneOf(b.severity,S.SEVERITY,'damage severity'));}
   if(b.internalNotes!==undefined){if(wanted.length!==1)fail(422,'Edit notes one residence at a time.');set.push('internal_notes=?');args.push(note(b.internalNotes,4000));}
   let assignee;if(b.assignedUserId!==undefined){assignee=b.assignedUserId?(await staffMember(user,b.assignedUserId)).id:null;set.push('assigned_user_id=?');args.push(assignee);}
   if(!set.length)fail(422,'Choose what to change.');
   await transaction(async()=>{
    for(const r of list){
     await run(`UPDATE storm_event_residences SET ${set.join(',')},updated_at=? WHERE id=? AND storm_event_id=?`,...args,now(),r.id,ev.id);
     // A reassigned residence moves its storm visits that are still drafts to the new person.
     if(assignee)for(const visitId of [r.pre_inspection_id,r.post_inspection_id].filter(Boolean))await run("UPDATE inspections SET inspector_id=? WHERE id=? AND status='draft'",assignee,visitId);
    }
    await audit(user,'storm.residences_updated',ev.id);
   });
   return json(res,200,{updated:list.length,event:await eventOut(user,await eventFor(user,ev.id))});
  }
  roles(user,'admin');
  if(!sub&&method==='POST'){
   const b=await body(req);if(b.version!==undefined&&Number(b.version)!==Number(ev.version))fail(409,'This storm changed. Reload it before saving.');
   const status=b.status===undefined?ev.status:oneOf(b.status,S.EVENT_STATUSES,'storm status');
   const v=k=>b[k]!==undefined;
   const changed=await run('UPDATE storm_events SET name=?,type=?,status=?,expected_impact_at=?,prep_deadline_at=?,post_check_target_at=?,notes=?,closed_at=?,version=version+1,updated_at=? WHERE id=? AND organization_id=? AND version=?',
    v('name')?text(b.name,'Storm name',160):ev.name,v('type')?oneOf(b.type,S.TYPES,'storm type'):ev.type,status,v('expectedImpactAt')?when(b.expectedImpactAt,'Expected impact'):ev.expected_impact_at,v('prepDeadlineAt')?when(b.prepDeadlineAt,'Preparation deadline'):ev.prep_deadline_at,v('postCheckTargetAt')?when(b.postCheckTargetAt,'Post-storm check target'):ev.post_check_target_at,v('notes')?note(b.notes):ev.notes,status==='closed'?(ev.closed_at||now()):null,now(),ev.id,user.organization_id,ev.version);
   if(changed.changes!==1)fail(409,'This storm changed. Reload it before saving.');
   await audit(user,status!==ev.status?'storm.status_'+status:'storm.updated',ev.id);
   return json(res,200,{event:await eventOut(user,await eventFor(user,ev.id))});
  }
  if(sub==='summary.pdf'&&method==='GET'){
   const out=await eventOut(user,ev),org=await get('SELECT name FROM organizations WHERE id=?',user.organization_id),logo=(await get('SELECT logo_data FROM workspace_settings WHERE organization_id=?',user.organization_id))?.logo_data||'',s=await tzSettings(user.organization_id);
   const pdf=stormSummaryPdf({company:org?.name||'',companyLogo:logo,timezone:s.timezone||'America/New_York',preparedAt:now(),event:{name:ev.name,typeLabel:out.type_label,statusLabel:out.status_label,expectedImpactAt:ev.expected_impact_at},counts:out.counts,rows:out.residences.map(r=>({name:r.property_name,family:r.client_name,assigned:r.assigned_name,prep:r.prep_label,post:r.post_label,severity:r.severity_label,preDate:r.pre?visitDate(r.pre.date):'',postDate:r.post?visitDate(r.post.date):''}))});
   res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Storm-Summary-${slug(ev.name)}.pdf"`,'Cache-Control':'no-store'});return res.end(pdf),true;
  }
  if(method!=='POST')return false;
  const b=await body(req);
  if(sub==='residences'){
   open(ev);
   const props=await all('SELECT p.*,c.name client_name FROM properties p LEFT JOIN clients c ON c.id=p.client_id WHERE p.organization_id=? AND p.archived_at IS NULL',user.organization_id);
   let chosen;
   if(b.propertyIds!==undefined){const wanted=ids(b.propertyIds);chosen=props.filter(x=>wanted.includes(x.id));if(chosen.length!==wanted.length)fail(422,'Choose active residences from your company.');}
   else if(b.filter&&typeof b.filter==='object'){const f=b.filter;chosen=S.selectResidences(props,{city:note(f.city,120),zip:note(f.zip,24),managerId:note(f.managerId,100),search:note(f.search,160)});}
   else fail(422,'Choose the residences this storm affects.');
   const added=await insertResidences(user,ev,chosen.map(x=>x.id));
   return json(res,200,{added,alreadyIncluded:chosen.length-added,event:await eventOut(user,ev)});
  }
  if(sub==='residences/remove'){
   const wanted=ids(b.residenceIds),list=(await rows(user,ev)).filter(r=>wanted.includes(r.id));if(list.length!==wanted.length)fail(422,'Choose residences that are on this storm.');
   const locked=list.filter(r=>[r.pre,r.post].some(v=>v&&v.status!=='draft'));if(locked.length)fail(409,`${locked.map(r=>r.property_name).join(', ')} already ${locked.length===1?'has':'have'} a completed storm visit, so ${locked.length===1?'it stays':'they stay'} on the storm.`);
   await transaction(async()=>{for(const r of list){for(const v of [r.pre_inspection_id,r.post_inspection_id].filter(Boolean))await run("UPDATE inspections SET storm_event_id=NULL WHERE id=? AND status='draft'",v);await run('DELETE FROM storm_event_residences WHERE id=? AND storm_event_id=?',r.id,ev.id);}await audit(user,'storm.residences_removed',ev.id);});
   return json(res,200,{removed:list.length,event:await eventOut(user,ev)});
  }
  if(sub==='visits'){open(ev);const result=await scheduleVisits(user,ev,b);return json(res,201,{...result,event:await eventOut(user,ev)});}
  if(sub==='recovery'){
   open(ev);
   if(ev.status!=='recovery'){await run("UPDATE storm_events SET status='recovery',version=version+1,updated_at=? WHERE id=?",now(),ev.id);await audit(user,'storm.status_recovery',ev.id);}
   const out=await eventOut(user,await eventFor(user,ev.id));
   return json(res,200,{event:out,securedWithoutPostVisit:out.residences.filter(r=>r.prep_status==='secured'&&!r.post_inspection_id).map(r=>r.id),withoutPostVisit:out.residences.filter(r=>!r.post_inspection_id).map(r=>r.id)});
  }
  if(sub==='notify'){open(ev);return json(res,200,await notify(user,ev,b));}
  return false;
 }

 /**
  * Automatic storm statuses, called by the inspection routes (inside their transaction where there is one):
  * save with results recorded -> In progress; pre-storm submit/publish -> Secured (with issues when an item failed);
  * post-storm publish -> No damage / Damage found with a suggested severity (an admin-set severity is kept);
  * reopen of a pre-storm visit -> back to In progress. Manual statuses that are further along are not undone by a save.
  */
 async function inspectionChanged(inspectionId,stage){
  const i=await get('SELECT * FROM inspections WHERE id=?',inspectionId);if(!i?.storm_event_id)return;
  const r=await get('SELECT * FROM storm_event_residences WHERE storm_event_id=? AND (pre_inspection_id=? OR post_inspection_id=?)',i.storm_event_id,i.id,i.id);if(!r)return;
  const phase=r.pre_inspection_id===i.id?'pre':'post',answers=JSON.parse(i.answers||'[]'),at=now();
  if(phase==='pre'){
   if(stage==='save'&&S.recorded(answers,i))await run("UPDATE storm_event_residences SET prep_status='in_progress',updated_at=? WHERE id=? AND prep_status IN ('not_started','scheduled')",at,r.id);
   if(stage==='submit'||stage==='publish'){const o=S.prepOutcome(answers);await run("UPDATE storm_event_residences SET prep_status='secured',prep_issues=?,updated_at=? WHERE id=?",o.issues?1:0,at,r.id);}
   if(stage==='reopen')await run("UPDATE storm_event_residences SET prep_status='in_progress',prep_issues=0,updated_at=? WHERE id=? AND prep_status='secured'",at,r.id);
  }else{
   if((stage==='save'&&S.recorded(answers,i))||stage==='submit')await run("UPDATE storm_event_residences SET post_status='in_progress',updated_at=? WHERE id=? AND post_status IN ('not_started','scheduled','inaccessible')",at,r.id);
   if(stage==='publish'){const o=S.postOutcome(answers);await run('UPDATE storm_event_residences SET post_status=?,damage_severity=COALESCE(damage_severity,?),updated_at=? WHERE id=?',o.status,o.severity,at,r.id);}
  }
 }
 /** A deleted draft storm visit frees the residence for a new visit. */
 async function inspectionDeleted(row){
  if(!row?.storm_event_id)return;
  await run("UPDATE storm_event_residences SET pre_inspection_id=NULL,prep_status=CASE WHEN prep_status IN ('scheduled','in_progress') THEN 'not_started' ELSE prep_status END,updated_at=? WHERE pre_inspection_id=?",now(),row.id);
  await run("UPDATE storm_event_residences SET post_inspection_id=NULL,post_status=CASE WHEN post_status IN ('scheduled','in_progress') THEN 'not_started' ELSE post_status END,updated_at=? WHERE post_inspection_id=?",now(),row.id);
 }
 /** True when an employee is assigned to the residence on a storm that is not closed (grants visit access). */
 async function assigned(user,propertyId){return !!(await get("SELECT 1 FROM storm_event_residences r JOIN storm_events e ON e.id=r.storm_event_id WHERE r.property_id=? AND r.assigned_user_id=? AND r.organization_id=? AND e.status<>'closed'",propertyId,user.id,user.organization_id));}
 return {handle,inspectionChanged,inspectionDeleted,assigned,clientCards,createEvent,addResidences,eventOut,eventFor,setReportExtras};
}
