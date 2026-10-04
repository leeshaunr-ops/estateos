/* Insurance and vacancy compliance (browser). The server computes each residence's status in its own time zone and
   sends it as data.insurance (insurance.mjs); this file only shows it:
   - Residence page: an "Insurance" cell in the facts strip, a row in "Needs attention here", and the insurance
     profile (policy, broker, vacancy rule, protective devices, share links) at the top of Home records.
   - Insurance compliance page (Residences group, staff only): every residence, sortable, with status filters.
   - Client home: a compliance card per residence with the certificate and share link when the admin allows it.
   Admins edit; staff view; families see their own status; vendors see nothing. No inline styles or scripts. */
const INS_TONE={ok:'',due_soon:'amber',at_risk:'amber',breached:'red',not_set:'ins-muted'};
const INS_STATES=['breached','at_risk','due_soon','ok','not_set'];
const insState={sort:'status',dir:1,filter:''};
const insData=()=>(data&&!data.offline&&data.insurance)||null;
const insFor=id=>(insData()?.residences||[]).find(r=>r.property_id===id)||null;
const insAdmin=()=>!!insData()?.canEdit;
const insDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(String(d||''))?fmtDay(d):'';
const insRel=d=>/^\d{4}-\d{2}-\d{2}$/.test(String(d||''))?fmtDay(d,{relative:true}):'';
const insPlural=(n,one,many)=>`${n} ${n===1?one:(many||one+'s')}`;
function insBadge(st){return `<span class="badge ins-badge ${INS_TONE[st?.code]||''}">${esc(st?.label||'Not set up')}</span>`;}
/** One short line for strips and lists. */
function insShort(r){
 const st=r.status||{};
 if(st.code==='not_set')return r.profile?'Add the inspection interval':'No insurance profile';
 if(st.occupied)return 'Owners in residence';
 if(st.code==='breached'&&st.vacancyLeft!==null&&st.vacancyLeft<0)return `Unoccupied ${insPlural(st.vacancyDays,'day')} (limit ${st.maxVacancy})`;
 if(st.code==='breached')return `Visit was due ${insDay(st.deadline)}`;
 if(st.code==='at_risk')return `Due ${insRel(st.deadline)} · none scheduled`;
 return `Visit due ${insRel(st.deadline)}`;
}
function insOccupancy(r){
 const o=r.occupancy||{},st=r.status||{},src={arrival:'from an arrival',departure_visit:'from a departure visit',manual:'marked by the office',none:''}[o.source]||'';
 if(o.state==='occupied')return `Owners in residence${st.occupiedSince?' since '+insDay(st.occupiedSince):''}${src?' · '+src:''}`;
 return `Unoccupied${st.vacantSince?' since '+insDay(st.vacantSince):''}${src?' · '+src:' · no arrival on record'}`;
}
function insRule(pr){if(!pr?.inspect_every_days)return 'Not recorded';return `Inspect at least every ${insPlural(pr.inspect_every_days,'day')} while unoccupied${pr.max_vacancy_days?` · at most ${insPlural(pr.max_vacancy_days,'day')} unoccupied`:''}`;}
const insCertLink=(r,text='Download certificate',cls='button')=>r?.canCertificate?`<a class="${cls}" href="/api/insurance/${encodeURIComponent(r.property_id)}/certificate.pdf" download>${esc(text)}</a>`:'';

/* ---------- residence page ---------- */
const insBaseResFacts=resFacts;
resFacts=function(p){
 const html=insBaseResFacts(p),r=insFor(p.id);
 if(!r||(!r.profile&&!insAdmin()))return html;
 const cell=`<div class="res-fact ins-fact"><dt>Insurance</dt><dd><button type="button" class="ov-head-link" data-action="insurance-open" data-id="${esc(p.id)}">${esc(r.profile?r.status.label:'Not set up')}</button></dd><dd class="res-fact-sub">${esc(r.profile?insShort(r):'Add it in Home records')}</dd></div>`;
 return html.replace('<dl class="res-facts">','<dl class="res-facts ins-six">').replace(/<\/dl>\s*$/,cell+'</dl>');
};
const insBaseResAttention=resAttention;
resAttention=function(p){
 const html=insBaseResAttention(p),r=insFor(p.id);
 if(!r?.profile)return html;
 const rows=[];
 if(['breached','at_risk','due_soon'].includes(r.status.code))rows.push(resRow('Insurance: '+esc(r.status.label),esc(r.status.reason),`${insBadge(r.status)}${btn('Details','insurance-open',p.id)}`));
 if(isStaff()&&r.renewal?.due)rows.push(resRow('Policy renews '+esc(insRel(r.renewal.date)),esc(`${insPlural(r.renewal.daysLeft,'day')} left · review the renewal checklist`),btn('Checklist','insurance-renewal',p.id)));
 if(!rows.length)return html;
 // Insert the rows under the panel heading and keep the count right.
 const empty='<p class="res-empty">Nothing needs attention here.</p>';
 let out=html.includes(empty)?html.replace(empty,rows.join('')):html.replace(/(<div class="res-panel-head">[\s\S]*?<\/div>)/,'$1'+rows.join(''));
 const count=/<span class="ov-count">(\d+)<\/span>/.exec(out);
 out=count?out.replace(count[0],`<span class="ov-count">${Number(count[1])+rows.length}</span>`):out.replace('<h2>Needs attention here</h2>',`<h2>Needs attention here <span class="ov-count">${rows.length}</span></h2>`);
 if(!out.includes('res-attention'))out=out.replace('class="panel res-panel ','class="panel res-panel res-attention ');
 return out;
};
function insDevices(r){
 const list=(r.profile?.devices||[]).filter(d=>d.required||d.discount||d.installed||d.file_id);
 if(!list.length)return `<p class="res-empty">No required or discount devices recorded.</p>`;
 return `<ul class="ins-devices">${list.map(d=>`<li><span class="ins-device-name">${esc(d.label)}</span><span class="ins-tags">${d.required?'<span class="badge amber">Required</span>':''}${d.discount?'<span class="badge">Discount</span>':''}${d.installed?'<span class="badge">Installed</span>':'<span class="badge ins-muted">Not confirmed</span>'}</span>${d.file_id?`<a class="ins-proof" href="/api/files/${encodeURIComponent(d.file_id)}" target="_blank" rel="noopener">View proof</a>`:''}</li>`).join('')}</ul>`;
}
function insLinks(r){
 if(!r.links?.length)return r.canShare?`<p class="res-empty">No share links yet. Create one to send the certificate to a broker; it stops working after the number of days you choose.</p>`:'';
 const mayRevoke=l=>l.state==='active'&&(insAdmin()||data.user.role==='client');
 return r.links.map(l=>resRow(esc(l.label||'Certificate link'),esc([`Created ${fmtDay(l.created_at)}${l.created_by_name?' by '+l.created_by_name:''}`,l.state==='revoked'?'Turned off '+fmtDay(l.revoked_at):l.state==='expired'?'Expired '+fmtDay(l.expires_at):'Expires '+fmtDay(l.expires_at),insPlural(l.view_count,'view'),l.last_viewed_at?'last opened '+fmtDay(l.last_viewed_at,{relative:true}):''].filter(Boolean).join(' · ')),`<span class="badge ${l.state==='active'?'':'ins-muted'}">${l.state==='active'?'Active':l.state==='expired'?'Expired':'Turned off'}</span>${mayRevoke(l)?btn('Turn off','insurance-revoke',l.id):''}`)).join('');
}
function insSection(p){
 const r=insFor(p.id);if(!r)return '';
 const admin=insAdmin();
 if(!r.profile){
  if(!isStaff())return '';
  return `<section class="panel res-record ins-record" id="res-insurance"><div class="res-panel-head"><h2>Insurance &amp; vacancy rules</h2></div>${empty('No insurance details yet',admin?'Add the carrier, renewal date and the policy\'s unoccupancy rule. EstateAegis then tracks every visit against it and warns you before a deadline is missed.':'An administrator can add this home\'s insurance details.',admin?btn('Add insurance details','insurance-edit',p.id,true):'')}</section>`;
 }
 const pr=r.profile,menu=[insCertLink(r),r.canShare?btn('Create share link','insurance-share',p.id):'',admin?btn('Owners arrived','insurance-occupancy',p.id+'|occupied')+btn('Owners left','insurance-occupancy',p.id+'|vacant'):''].join('');
 const broker=[pr.broker_name,pr.broker_email,pr.broker_phone].filter(Boolean).join(' · ');
 const facts=[['Carrier',pr.carrier||'Not recorded'],['Policy number',pr.policy_number||'Not recorded'],['Renewal',pr.renewal_date?insDay(pr.renewal_date)+(r.renewal?.due?` · in ${insPlural(r.renewal.daysLeft,'day')}`:r.renewal?.passed?' · date has passed':''):'Not recorded'],['Broker or agent',broker||'Not recorded'],['Vacancy rule',insRule(pr)],['Occupancy',insOccupancy(r)],['Last visit',r.status.lastVisit?insDay(r.status.lastVisit):'No completed visits'],['Next scheduled',r.status.nextScheduled?insDay(r.status.nextScheduled):'Nothing scheduled']];
 return `<section class="panel res-record ins-record" id="res-insurance"><div class="res-panel-head"><h2>Insurance &amp; vacancy rules</h2><div class="actions">${admin?btn('Edit','insurance-edit',p.id):''}${moreMenu(menu)}</div></div>
<div class="ins-status ins-${esc(r.status.code)}">${insBadge(r.status)}<p>${esc(r.status.reason)}</p></div>
<dl class="ins-facts">${facts.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
<h3 class="res-sub">Protective devices</h3>${insDevices(r)}
${r.canShare||r.links?.length?`<h3 class="res-sub">Certificate share links</h3>${insLinks(r)}`:''}
${isStaff()&&r.events?.length?`<h3 class="res-sub">Occupancy marked by the office</h3>${r.events.map(e=>resRow(esc(e.state==='occupied'?'Owners arrived':'Owners left'),esc([fmtDay(e.at),e.note].filter(Boolean).join(' · ')))).join('')}`:''}
${pr.notes&&isStaff()?`<h3 class="res-sub">Office notes</h3><p class="res-note">${esc(pr.notes)}</p>`:''}
<p class="ins-foot">Dates follow the residence's time zone (${esc(r.timezone)}). The compliance status is a reminder tool; the policy wording decides what is required.</p></section>`;
}
const insBaseResidenceView=residenceView;
residenceView=function(...args){
 const html=insBaseResidenceView(...args);if(!insData()||tab!=='records')return html;
 const p=data.properties.find(x=>x.id===propertyId);if(!p)return html;
 const section=insSection(p);if(!section)return html;
 const at=html.indexOf('<section class="res-record" id="res-assets">');return at<0?html+section:html.slice(0,at)+section+html.slice(at);
};

/* ---------- Insurance compliance page ---------- */
const INS_COLS=[['name','Residence'],['status','Status'],['occupancy','Occupancy'],['last','Last visit'],['deadline','Visit due by'],['next','Next scheduled'],['renewal','Renewal']];
function insSortValue(r,key){const st=r.status||{};return key==='name'?String(r.name||'').toLowerCase():key==='status'?-(st.rank||0):key==='occupancy'?(st.occupied?1:0):key==='last'?(st.lastVisit||''):key==='deadline'?(st.deadline||'9999'):key==='next'?(st.nextScheduled||'9999'):key==='renewal'?(r.profile?.renewal_date||'9999'):'';}
function insRows(){
 const list=(insData()?.residences||[]).filter(r=>!insState.filter||r.status.code===insState.filter);
 const k=insState.sort,d=insState.dir;
 return list.sort((a,b)=>{const x=insSortValue(a,k),y=insSortValue(b,k);return (x<y?-1:x>y?1:0)*d||String(a.status.deadline||'9999').localeCompare(String(b.status.deadline||'9999'))||String(a.name).localeCompare(String(b.name));});
}
function insurancePage(){
 const all=insData()?.residences||[],counts=Object.fromEntries(INS_STATES.map(s=>[s,all.filter(r=>r.status.code===s).length]));
 let html=head('Insurance compliance','Each residence\'s policy rule, who is home, and when the next visit is due. Dates follow each residence\'s time zone.');
 if(!all.length)return html+`<div class="panel">${empty('No residences yet','Add a residence, then its insurance details.')}</div>`;
 const chips=[['','All',all.length],...INS_STATES.map(s=>[s,{breached:'Breached',at_risk:'At risk',due_soon:'Due soon',ok:'OK',not_set:'Not set up'}[s],counts[s]])].filter(([s,,n])=>!s||n);
 html+=`<div class="work-chips ins-chips" role="group" aria-label="Filter by status">${chips.map(([s,t,n])=>`<button type="button" class="chip${insState.filter===s?' active':''}" data-action="insurance-filter" data-id="${esc(s)}" aria-pressed="${insState.filter===s}">${esc(t)} <span>${n}</span></button>`).join('')}</div>`;
 html+=`<div class="ins-sort-mobile" role="group" aria-label="Sort by"><span>Sort by</span>${[['status','Status'],['deadline','Visit due'],['name','Name'],['renewal','Renewal']].map(([k,t])=>`<button type="button" class="chip${insState.sort===k?' active':''}" data-action="insurance-sort" data-id="${k}" aria-pressed="${insState.sort===k}">${esc(t)}</button>`).join('')}</div>`;
 const rows=insRows();
 const th=([key,title])=>{const on=insState.sort===key,dir=on?(insState.dir===1?'ascending':'descending'):'none';return `<th scope="col" aria-sort="${dir}"><button type="button" class="ins-sort${on?' active':''}" data-action="insurance-sort" data-id="${key}">${esc(title)}<span aria-hidden="true">${on?(insState.dir===1?' ↑':' ↓'):''}</span></button></th>`;};
 html+=`<section class="panel ins-list stack-table" aria-label="Insurance compliance by residence"><table><caption class="sr-only">Insurance compliance by residence, sorted by ${esc((INS_COLS.find(c=>c[0]===insState.sort)||[])[1]||'status')}</caption><thead><tr>${INS_COLS.map(th).join('')}</tr></thead><tbody>${rows.map(r=>{const st=r.status;return `<tr><td><button type="button" class="link-button ins-name" data-action="insurance-open" data-id="${esc(r.property_id)}">${esc(r.name)}</button>${r.client_name?`<div class="muted">${esc(r.client_name)}</div>`:''}</td><td data-label="Status">${insBadge(st)}${st.code==='not_set'&&insAdmin()?` ${btn('Set up','insurance-edit',r.property_id)}`:''}<div class="ins-reason">${esc(st.code==='not_set'?insShort(r):st.reason)}</div></td><td data-label="Occupancy">${esc(st.code==='not_set'?'—':st.occupied?'Owners in residence':st.vacantSince?'Unoccupied since '+insDay(st.vacantSince):'Unoccupied')}</td><td data-label="Last visit">${esc(st.lastVisit?insDay(st.lastVisit):'None yet')}</td><td data-label="Visit due by">${esc(st.occupied||!st.deadline?'—':insRel(st.deadline))}</td><td data-label="Next scheduled">${esc(st.nextScheduled?insRel(st.nextScheduled):'Not scheduled')}</td><td data-label="Renewal">${esc(r.profile?.renewal_date?insDay(r.profile.renewal_date):'—')}${r.renewal?.due?' <span class="badge amber">Soon</span>':''}</td></tr>`;}).join('')||`<tr><td colspan="7">${empty('No residences with this status.')}</td></tr>`}</tbody></table></section>`;
 html+=`<p class="ins-foot">OK means a visit is scheduled in time or the owners are in residence. Due soon means the deadline is within the warning window. At risk means nothing is scheduled before the deadline. Breached means the deadline or the vacancy limit has passed.</p>`;
 return html;
}
const insBaseView=view;
view=function(...args){if(page==='insurance'&&insData()&&isStaff())return insurancePage();return insBaseView(...args);};

/* ---------- client home ---------- */
const insBaseActionNeeded=actionNeeded;
actionNeeded=function(...args){
 const base=insBaseActionNeeded(...args);
 if(page!=='dashboard'||data?.user?.role!=='client')return base;
 const homes=(insData()?.residences||[]).filter(r=>r.profile&&r.status.code!=='not_set');if(!homes.length)return base;
 return `<section class="panel ins-client" aria-label="Insurance compliance"><div class="res-panel-head"><h2>Insurance visit record</h2></div>${homes.map(r=>`<div class="ins-client-row"><div class="res-row-text"><strong>${esc(r.name)}</strong><small>${esc(r.status.reason)}</small></div><div class="res-row-end">${insBadge(r.status)}${insCertLink(r,'Certificate')}${r.canShare?btn('Share with broker','insurance-share',r.property_id):''}</div></div>`).join('')}</section>`+base;
};

/* ---------- dialogs ---------- */
const insCheck=(name,title,on)=>`<label class="check-row ins-check"><input type="checkbox" name="${name}" ${on?'checked':''}> ${esc(title)}</label>`;
const insNum=(name,title,value,min,max,hint='')=>`<div class="field"><label for="f-${name}">${esc(title)}</label><input id="f-${name}" name="${name}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${esc(value??'')}"${hint?` aria-describedby="f-${name}-hint"`:''}>${hint?`<small id="f-${name}-hint" class="ins-hint">${esc(hint)}</small>`:''}</div>`;
async function insFileBase64(file){
 if(file.size>10*1024*1024)throw Error('Maximum size is 10 MB per file.');
 if(file.type==='application/pdf'){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let pos=0;pos<bytes.length;pos+=8192)binary+=String.fromCharCode(...bytes.subarray(pos,pos+8192));return btoa(binary);}
 return jpeg(file);
}
function insEdit(pid){
 const r=insFor(pid),pr=r?.profile||{},devices=pr.devices||(insData()?.devices||[]).map(d=>({...d}));
 const devFields=devices.map(d=>`<fieldset class="field full ins-device-edit"><legend>${esc(d.key==='other'?'Other device':d.label)}</legend>${d.key==='other'?`<div class="field"><label for="f-dev_other_name">Device name</label><input id="f-dev_other_name" name="dev_other_name" value="${esc(d.name||'')}" maxlength="80"></div>`:''}<div class="ins-check-row">${insCheck(`dev_${d.key}_required`,'Required by the policy',d.required)}${insCheck(`dev_${d.key}_discount`,'Gives a discount',d.discount)}${insCheck(`dev_${d.key}_installed`,'Installed',d.installed)}</div><div class="field"><label for="f-dev_${d.key}_file">${d.file_id?'Replace photo or document':'Photo or document (optional)'}</label><input id="f-dev_${d.key}_file" name="dev_${d.key}_file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp">${d.file_id?`<input type="hidden" name="dev_${d.key}_file_id" value="${esc(d.file_id)}">`:''}</div></fieldset>`).join('');
 dialog(r?.profile?'Edit insurance details':'Add insurance details',
  `<p class="field full ins-hint">Only administrators can change these details. Staff can see them; the family sees the status, the policy and the devices.</p>
  ${input('carrier','Insurance carrier','text',pr.carrier||'',false)}${input('policy_number','Policy number','text',pr.policy_number||'',false)}
  ${input('renewal_date','Renewal date','date',pr.renewal_date||'',false)}${input('broker_name','Broker or agent name','text',pr.broker_name||'',false)}
  ${input('broker_email','Broker email','email',pr.broker_email||'',false)}${input('broker_phone','Broker phone','tel',pr.broker_phone||'',false)}
  <h3 class="field full ins-form-head">Unoccupancy rule</h3>
  ${insNum('inspect_every_days','Inspect at least every (days)',pr.inspect_every_days,1,365,'While the home is unoccupied, as written in the policy.')}
  ${insNum('max_vacancy_days','Maximum days unoccupied (optional)',pr.max_vacancy_days,1,3650,'Leave empty if the policy has no limit.')}
  ${insNum('warn_days','Warn this many days before a deadline',pr.warn_days??3,0,30)}
  <h3 class="field full ins-form-head">Required and discount devices</h3>${devFields}
  <div class="field full">${insCheck('client_share','Let the family download the visit history certificate and create share links',pr.client_share)}</div>
  ${textarea('notes','Office notes (staff only)',pr.notes||'')}`,
  'Save',async(b,form)=>{
   const out=[];
   for(const d of devices){
    let fileId=b[`dev_${d.key}_file_id`]||null;const file=form.querySelector(`#f-dev_${d.key}_file`)?.files?.[0];
    if(file){const base64=await insFileBase64(file);const up=await api('files',{propertyId:pid,name:file.type==='application/pdf'?file.name:file.name.replace(/\.[^.]+$/,'')+'.jpg',base64,visibility:'internal'});fileId=up.id;}
    out.push({key:d.key,name:d.key==='other'?(b.dev_other_name||''):'',required:!!b[`dev_${d.key}_required`],discount:!!b[`dev_${d.key}_discount`],installed:!!b[`dev_${d.key}_installed`],file_id:fileId});
   }
   await api('insurance/'+encodeURIComponent(pid),{carrier:b.carrier,policy_number:b.policy_number,renewal_date:b.renewal_date,broker_name:b.broker_name,broker_email:b.broker_email,broker_phone:b.broker_phone,inspect_every_days:b.inspect_every_days,max_vacancy_days:b.max_vacancy_days,warn_days:b.warn_days,devices:out,client_share:!!b.client_share,notes:b.notes,version:pr.version});
   toast('Insurance details saved.');
  });
}
function insShare(pid){
 const r=insFor(pid),days=insData()?.shareDefaultDays||14,max=insData()?.shareMaxDays||90;
 dialog('Share the visit history certificate',`<p class="field full ins-hint">Anyone with the link can see this residence's certificate (visits, dates and GPS check) until it expires. They see nothing else. You can turn the link off at any time, and each view is counted.</p>${input('label','Who is it for?','text',r?.profile?.broker_name?'For '+r.profile.broker_name:'For our broker',false)}${select('days','Link works for',[7,14,30,60,90].filter(n=>n<=max).map(n=>`<option value="${n}" ${n===days?'selected':''}>${n} days</option>`).join(''))}`,'Create link',async b=>{
  const res=await api('insurance/'+encodeURIComponent(pid)+'/share-links',{label:b.label,days:Number(b.days)});
  insPendingLink={url:location.origin+res.path,expires:res.expires_at,pid};
 });
}
let insPendingLink=null;
function insShowLink(){
 const l=insPendingLink;if(!l)return;insPendingLink=null;const r=insFor(l.pid),pr=r?.profile||{};
 const subject=`Visit history certificate: ${r?.name||'residence'}`,bodyText=`Here is the visit history certificate for ${r?.name||'the residence'}${pr.policy_number?' (policy '+pr.policy_number+')':''}. The link works until ${fmtDay(l.expires)}:\n${l.url}`;
 $('modalBody').innerHTML=`<h2>Share link ready</h2><p class="ins-hint">Send this link to the broker. It works until ${esc(fmtDay(l.expires))}.</p><div class="field full"><label for="ins-link">Certificate link</label><input id="ins-link" readonly value="${esc(l.url)}"></div><div class="dialog-footer ins-link-actions">${pr.broker_email?`<a class="button" href="mailto:${encodeURIComponent(pr.broker_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}">Email the broker</a>`:''}${btn('Copy link','insurance-copy','',true)}${btn('Done','close')}</div>`;
 const modal=$('modal');if(!modal.open)modal.showModal();
}
function insOccupancyDialog(key){
 const [pid,state]=String(key).split('|'),r=insFor(pid);
 dialog(state==='occupied'?'Owners arrived':'Owners left',`<p class="field full ins-hint">${state==='occupied'?'While the owners are in residence the visit rule is paused.':'The visit clock restarts from the day the owners left.'} Arrivals planned in EstateAegis and completed departure visits are counted automatically.</p>${input('date','Date','date',r?.today||today())}${input('note','Note (optional)','text','',false)}`,'Save',async b=>{await api('insurance/'+encodeURIComponent(pid)+'/occupancy',{state,date:b.date,note:b.note});toast('Occupancy updated.');});
}
function insRenewal(pid){
 const r=insFor(pid);if(!r?.profile)return;const pr=r.profile,dev=(pr.devices||[]).filter(d=>d.required||d.discount);
 const items=['Confirm the carrier, policy number and renewal date with the broker.',`Confirm the unoccupancy clause (currently: ${insRule(pr).toLowerCase()}).`,...dev.map(d=>`${d.label}: ${d.required?'required':'discount'}${d.file_id?' (proof on file)':' (add a photo or certificate)'}.`),'Send the visit history certificate to the broker.','Update the renewal date here once the policy renews.'];
 $('modalBody').innerHTML=`<h2>Renewal checklist</h2><p class="ins-hint">${esc(r.name)} · renews ${esc(insDay(pr.renewal_date))}</p><ul class="ins-checklist">${items.map(i=>`<li>${esc(i)}</li>`).join('')}</ul><div class="dialog-footer">${insCertLink(r)}${btn('Close','close','',true)}</div>`;
 const modal=$('modal');if(!modal.open)modal.showModal();
}

/* ---------- actions ---------- */
const insBaseAction=action;
action=async function(name,key,button){
 if(!String(name).startsWith('insurance-'))return insBaseAction(name,key,button);
 switch(name){
  case 'insurance-open':propertyId=key;page='property';tab=data.user.role==='vendor'?'services':'records';render();setTimeout(()=>{const el=$('res-insurance');if(el){el.scrollIntoView({block:'start'});}},0);return;
  case 'insurance-edit':insEdit(key);return;
  case 'insurance-share':insShare(key);return;
  case 'insurance-occupancy':insOccupancyDialog(key);return;
  case 'insurance-renewal':insRenewal(key);return;
  case 'insurance-copy':{const field=$('ins-link');if(!field)return;try{await navigator.clipboard.writeText(field.value);toast('Link copied.');}catch{field.select();toast('Select the link and copy it.');}return;}
  case 'insurance-revoke':if(!confirm('Turn off this link? Anyone who has it will no longer be able to open the certificate.'))return;await api('insurance/share-links/'+encodeURIComponent(key)+'/revoke',{});toast('Link turned off.');await load();return;
  case 'insurance-sort':if(insState.sort===key)insState.dir=-insState.dir;else{insState.sort=key;insState.dir=1;}render();return;
  case 'insurance-filter':insState.filter=key||'';render();return;
 }
 return insBaseAction(name,key,button);
};
/* After the share dialog saves and the data reloads, show the new link. */
const insBaseRender=render;
render=function(...args){const out=insBaseRender(...args);if(insPendingLink)setTimeout(insShowLink,0);return out;};
if(typeof AUDIT_NOUN==='object')Object.assign(AUDIT_NOUN,{insurance:'Insurance details',insurance_share:'Certificate share link',occupancy:'Occupancy'});
