/* EstateAegis storm workflow rules. Pure logic shared by the server (status hooks, API, PDF), the browser (status
   board, wizard) and Node tests. Exposed as globalThis.EAStorm.

   A storm event lists the residences it affects. Each residence has a prep status (before the storm) and a post status
   (after it). Storm visits are ordinary inspections with visit_type pre_storm / post_storm, so their answers follow
   the checklist rules in inspection-checklist.js: template pass/fail items answer pass|monitor|fail|na; built-in
   items answer pass|monitor|attention|na. */
(function(root){
 'use strict';
 const TYPES={hurricane:'Hurricane',tropical_storm:'Tropical storm',freeze:'Freeze',flood:'Flood',wildfire:'Wildfire',winter_storm:'Winter storm',severe_storm:'Severe storm',extreme_heat:'Extreme heat',other:'Other'};
 const EVENT_STATUSES={preparing:'Preparing',active:'Storm active',recovery:'Recovery',closed:'Closed'};
 const PREP={not_started:'Not started',scheduled:'Scheduled',in_progress:'In progress',secured:'Secured',client_declined:'Client declined',not_needed:'Not needed',unreachable:'Unreachable'};
 const POST={not_started:'Not started',scheduled:'Scheduled',in_progress:'In progress',no_damage:'No damage',damage_found:'Damage found',inaccessible:'Inaccessible'};
 const SEVERITY={none:'None',minor:'Minor',moderate:'Moderate',major:'Major'};
 const NOTIFY={prep_planned:'Storm preparation planned',secured:'Home secured',post_check_complete:'Post-storm check complete'};
 const PHASE_VISIT={pre:'pre_storm',post:'post_storm'};
 const str=v=>String(v??'');
 const isTemplate=a=>!!(a&&a.response_type);
 /** Answers that use the Pass / Monitor / Fail (Attention) / N/A scale. Yes/No, numbers and text never decide damage. */
 const conditionAnswers=answers=>(answers||[]).filter(a=>a&&(!isTemplate(a)||a.response_type==='pass_fail_na'));
 const failed=a=>a.status==='fail'||a.status==='attention';
 /** True once anything is recorded on a visit (a result or a note): the visit has started. */
 function recorded(answers,row={}){return (answers||[]).some(a=>a&&((a.status&&a.status!=='unchecked')||str(a.note).trim()))||!!str(row.summary).trim()||!!str(row.notes).trim();}
 /** Damage severity suggested from a post-storm visit: Monitor only = minor, 1-2 failed = moderate, 3+ = major. */
 function suggestSeverity(failCount,monitorCount){if(failCount>=3)return 'major';if(failCount>=1)return 'moderate';if(monitorCount>=1)return 'minor';return 'none';}
 /** Pre-storm visit completed: the home is secured; any failed item means "Secured with issues". */
 function prepOutcome(answers){const items=conditionAnswers(answers);return {status:'secured',issues:items.some(failed),failed:items.filter(failed).length};}
 /** Post-storm visit published: no Monitor/Fail items = no damage, otherwise damage found with a suggested severity. */
 function postOutcome(answers){const items=conditionAnswers(answers),f=items.filter(failed).length,m=items.filter(a=>a.status==='monitor').length;return f||m?{status:'damage_found',severity:suggestSeverity(f,m),failed:f,monitored:m}:{status:'no_damage',severity:'none',failed:0,monitored:0};}
 /** Monitor / Fail / Attention items: the damage list on the storm report. */
 const findings=answers=>conditionAnswers(answers).filter(a=>failed(a)||a.status==='monitor');
 /** Status label; a secured home with failed items reads "Secured with issues". */
 function prepLabel(status,issues){return status==='secured'&&Number(issues)?'Secured with issues':PREP[status]||label(status);}
 function postLabel(status){return POST[status]||label(status);}
 function label(s){return str(s).replaceAll('_',' ').replace(/^\w/,c=>c.toUpperCase());}
 /** Text-plus-icon tone for a status (never colour alone): done | issue | open | progress | muted. */
 function tone(phase,status,issues){
  if(phase==='prep'){if(status==='secured')return Number(issues)?'issue':'done';if(status==='in_progress')return 'progress';if(['client_declined','not_needed'].includes(status))return 'muted';if(status==='unreachable')return 'issue';return 'open';}
  if(status==='no_damage')return 'done';if(status==='damage_found'||status==='inaccessible')return 'issue';if(status==='in_progress')return 'progress';return 'open';
 }
 const ICONS={done:'✓',issue:'!',open:'○',progress:'◐',muted:'–'};
 const norm=v=>str(v).trim().toLowerCase();
 /**
  * Residences matching a selection filter: {all} (every active residence), {city}, {zip}, {managerId}, {search}
  * (name, address, family). Several fields narrow together. Archived residences are never selected.
  */
 function selectResidences(properties,filter={}){
  const f=filter||{},q=norm(f.search);
  return (properties||[]).filter(p=>!p.archived_at)
   .filter(p=>!norm(f.city)||norm(p.city)===norm(f.city))
   .filter(p=>!norm(f.zip)||norm(p.postal_code).slice(0,5)===norm(f.zip).slice(0,5))
   .filter(p=>!f.managerId||(f.managerId==='none'?!p.account_manager_id:p.account_manager_id===f.managerId))
   .filter(p=>!q||[p.name,p.address,p.client_name,p.city,p.postal_code].some(v=>norm(v).includes(q)));
 }
 /** Round robin: residences (sorted by name) dealt to the chosen staff in turn. Returns Map(propertyId -> userId). */
 function roundRobin(residences,userIds){const out=new Map(),ids=[...new Set(userIds||[])].filter(Boolean);if(!ids.length)return out;[...residences].sort((a,b)=>str(a.name).localeCompare(str(b.name))||str(a.id).localeCompare(str(b.id))).forEach((r,i)=>out.set(r.property_id||r.id,ids[i%ids.length]));return out;}
 /** Board header counts for one event's residences. */
 function counts(rows){
  const c={total:0,secured:0,securedWithIssues:0,prepOpen:0,prepInProgress:0,prepOther:0,postChecked:0,noDamage:0,damageFound:0,postOpen:0,postInProgress:0,inaccessible:0};
  for(const r of rows||[]){c.total++;
   if(r.prep_status==='secured'){c.secured++;if(Number(r.prep_issues))c.securedWithIssues++;}else if(r.prep_status==='in_progress')c.prepInProgress++;else if(['not_started','scheduled'].includes(r.prep_status))c.prepOpen++;else c.prepOther++;
   if(r.post_status==='no_damage'){c.noDamage++;c.postChecked++;}else if(r.post_status==='damage_found'){c.damageFound++;c.postChecked++;}else if(r.post_status==='in_progress')c.postInProgress++;else if(r.post_status==='inaccessible')c.inaccessible++;else c.postOpen++;
  }
  return c;
 }
 /**
  * Before/after photo pairs for the storm report. Photos pair by checklist item (answer_key) when both visits have a
  * photo for the same item, then by the same photo name ("North elevation.jpg"). The rest are shown side by side in
  * the order they were taken, and labelled that way. Each photo: {id, name, answer_key?, captured_at?, created_at}.
  */
 function pairPhotos(before,after){
  const when=p=>str(p.captured_at||p.created_at);
  const sorted=list=>[...(list||[])].sort((a,b)=>when(a).localeCompare(when(b))||str(a.id).localeCompare(str(b.id)));
  const left=sorted(before),right=sorted(after),pairs=[],used=new Set();
  const take=(match,keyOf)=>{for(const b of left){if(used.has(b))continue;const k=keyOf(b);if(!k)continue;const a=right.find(x=>!used.has(x)&&keyOf(x)===k);if(a){used.add(b);used.add(a);pairs.push({before:b,after:a,match});}}};
  take('item',p=>str(p.answer_key).trim());
  take('name',p=>{const n=norm(p.name).replace(/\.(jpe?g|png|webp)$/,'').replace(/[^a-z0-9]+/g,' ').trim();return /^(img|dsc|pxl|photo|image)\s*\d+$/.test(n)||/^\d+$/.test(n)?'':n;});
  const restB=left.filter(p=>!used.has(p)),restA=right.filter(p=>!used.has(p));
  for(let i=0;i<Math.max(restB.length,restA.length);i++)pairs.push({before:restB[i]||null,after:restA[i]||null,match:'order'});
  return pairs;
 }
 /** One CSV cell: quoted, and spreadsheet formulas neutralised. */
 function csvCell(value){let v=str(value);if(/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';}
 const csvRow=cells=>cells.map(csvCell).join(',');
 /**
  * Plain-language status for the client portal. at() formats an ISO time in the residence time zone; day() a
  * YYYY-MM-DD visit date. ctx: {preAt, postAt, preDate, postDate, preReport, postReport}.
  */
 function clientText(r,ctx={},at=v=>v,day=v=>v){
  let prep;
  switch(r.prep_status){
   case 'secured':prep=ctx.preAt?`Your home was secured on ${at(ctx.preAt)}`:'Your home was secured';if(Number(r.prep_issues))prep+='. A few items need attention; see the storm report';break;
   case 'in_progress':prep='Our team is preparing your home now';break;
   case 'scheduled':prep=ctx.preDate?`Storm preparation is scheduled for ${day(ctx.preDate)}`:'Storm preparation is scheduled';break;
   case 'client_declined':prep='You chose not to have storm preparation for this storm';break;
   case 'not_needed':prep='Storm preparation is not needed for this home';break;
   case 'unreachable':prep='We could not reach your home before the storm. Our office will contact you';break;
   default:prep='Storm preparation is being planned';
  }
  let post='';
  switch(r.post_status){
   case 'no_damage':post='Post-storm check: no damage found';break;
   case 'damage_found':post=`Post-storm check: damage found${r.damage_severity&&r.damage_severity!=='none'?' ('+(SEVERITY[r.damage_severity]||r.damage_severity).toLowerCase()+')':''}. See the storm report for details`;break;
   case 'in_progress':post='Post-storm check in progress';break;
   case 'scheduled':post=ctx.postDate?`Post-storm check scheduled for ${day(ctx.postDate)}`:'Post-storm check scheduled';break;
   case 'inaccessible':post='We could not reach your home after the storm yet. We will keep trying';break;
  }
  if(post&&ctx.postAt&&['no_damage','damage_found'].includes(r.post_status))post+=` (checked ${at(ctx.postAt)})`;
  return {prep,post};
 }
 root.EAStorm={TYPES,EVENT_STATUSES,PREP,POST,SEVERITY,NOTIFY,PHASE_VISIT,ICONS,conditionAnswers,recorded,suggestSeverity,prepOutcome,postOutcome,findings,prepLabel,postLabel,tone,selectResidences,roundRobin,counts,pairPhotos,csvCell,csvRow,clientText};
})(typeof self!=='undefined'?self:globalThis);
