/* Import data (company admins): bring clients + residences, contacts, vendors, staff and past visit history over
   from another system. Four steps on one page: Upload -> Match columns -> Preview -> Done.
   - The file stays in this browser tab and is sent again for the preview and the import, so the server never stores
     raw rows. Access codes are masked in every step and saved encrypted by the server.
   - Everything is stacked cards (no tables, no scrolling boxes); 44px tap targets; works at 390px.
   - window.EAImport.page() renders the screen; action() handles the Team & access "Send invite" button and
     historyHtml(propertyId) renders imported visit history on a residence. No inline scripts or styles (CSP). */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const TZ='America/New_York';
 const fmtDate=v=>{const t=Date.parse(v);return Number.isNaN(t)?'':new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric'}).format(new Date(t));};
 const fmtDay=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(v+'T12:00:00Z')):esc(v);
 const fmtDateTime=v=>{const t=Date.parse(v);return Number.isNaN(t)?'':new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(t))+' ET';};
 const plural=(n,one,many=one+'s')=>`${Number(n).toLocaleString('en-US')} ${Number(n)===1?one:many}`;
 const STEPS=[['upload','Upload'],['map','Match columns'],['preview','Preview'],['done','Done']];
 const STATUS={create:['New','imp-new'],update:['Update','imp-update'],skip:['Duplicate','imp-skip'],error:['Not imported','imp-error']};
 const DETAIL_LABEL={clients:['family','families'],residences:['residence','residences'],contacts:['contact','contacts'],vendors:['vendor','vendors'],staff:['staff member','staff members'],inspectors:['field inspector','field inspectors'],visits:['past visit','past visits']};
 const state={info:null,loading:false,error:'',step:'upload',type:'clients',file:null,parsed:null,mapping:{},mode:'skip',preview:null,filter:'all',shown:30,result:null,busy:'',note:''};

 async function call(path,payload){
  const r=await fetch('/api/import/'+path,payload===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(d.error||'Something went wrong. Try again.'),{status:r.status});return d;
 }
 const redraw=()=>{if(typeof root.render==='function')root.render();};
 // live.js keeps the app data in a global load(); refresh it after an import so lists and counts are current.
 const reloadData=async()=>{try{if(typeof root.load==='function')await root.load();}catch{}};
 async function load(){if(state.loading)return;state.loading=true;try{state.info=await call('info');state.error='';}catch(e){state.error=e.message;}finally{state.loading=false;redraw();}}
 const typeInfo=()=>state.info?.types.find(t=>t.key===state.type);
 const payload=extra=>({type:state.type,fileName:state.file.name,data:state.file.data,...extra});
 async function run(label,fn){if(state.busy)return;const step=state.step;state.busy=label;state.error='';redraw();try{await fn();}catch(e){state.error=e.message;}finally{state.busy='';redraw();const top=document.querySelector('.imp-page');if(top&&(state.step!==step||state.error)&&top.getBoundingClientRect().top<0)top.scrollIntoView({block:'start'});}}

 function toTop(){const top=document.querySelector('.imp-page');if(top&&top.getBoundingClientRect().top<0)top.scrollIntoView({block:'start'});}
 // ---------- pieces ----------
 function stepper(){
  const at=STEPS.findIndex(s=>s[0]===state.step);
  return `<ol class="imp-steps" aria-label="Import steps">${STEPS.map(([k,l],i)=>`<li class="${i<at?'done':i===at?'current':''}"${i===at?' aria-current="step"':''}><span class="imp-step-num" aria-hidden="true">${i<at?'✓':i+1}</span><span class="imp-step-label">${esc(l)}</span></li>`).join('')}</ol>`;
 }
 const button=(text,action,{primary=false,id='',disabled=false,extra=''}={})=>`<button type="button" class="imp-btn${primary?' primary':''}" data-imp="${action}"${id?` data-imp-id="${esc(id)}"`:''}${disabled?' disabled':''}${extra}>${esc(text)}</button>`;
 const errorBox=()=>state.error?`<div class="imp-alert" role="alert">${esc(state.error)}</div>`:'';
 const card=(title,body,{id='',cls=''}={})=>`<section class="panel imp-card ${cls}"${id?` aria-labelledby="${id}"`:''}>${title?`<h2 class="imp-h2"${id?` id="${id}"`:''}>${esc(title)}</h2>`:''}${body}</section>`;

 function uploadStep(){
  const info=state.info,limits=info.limits;
  const types=info.types.map(t=>`<label class="imp-type${t.key===state.type?' selected':''}"><input type="radio" name="impType" value="${esc(t.key)}"${t.key===state.type?' checked':''}><span class="imp-type-text"><strong>${esc(t.label)}</strong><small>${esc(t.help)}</small></span><a class="imp-template" href="/api/import/template/${esc(t.key)}.csv" download aria-label="Download the ${esc(t.label.toLowerCase())} template (CSV)">Download template</a></label>`).join('');
  const chosen=typeInfo();
  const fileCard=card('Upload your file',`<p class="imp-muted">CSV or Excel (.xlsx), up to 5 MB and ${limits.rows.toLocaleString('en-US')} rows. For Excel, the first sheet is read. Nothing is saved until you confirm the preview.</p>
   <label class="imp-drop" for="impFile"><span class="imp-drop-title">${state.file?esc(state.file.name):'Choose a file'}</span><span class="imp-drop-sub">${state.file?esc(Math.max(1,Math.round(state.file.size/1024)).toLocaleString('en-US'))+' KB · tap to choose another':'.csv or .xlsx'}</span></label>
   <input id="impFile" class="imp-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
   <div class="imp-actions">${button(state.busy==='parse'?'Reading file…':'Next: match columns','parse',{primary:true,disabled:!state.file||!!state.busy})}</div>`,{id:'impUploadTitle'});
  const sources=card('Coming from another system?',`<p class="imp-muted">Export your clients or customers to CSV or Excel and upload the file as it is. Column names are matched automatically, and you can change any match before importing.</p><ul class="imp-sources">${info.knownSources.map(s=>`<li><strong>${esc(s.name)}</strong><span>${esc(s.detail)}</span></li>`).join('')}</ul>`,{id:'impSourcesTitle',cls:'imp-side'});
  return `<div class="imp-cols"><div class="imp-main">${card('What are you importing?',`<p class="imp-muted">Start with clients and residences, then contacts, vendors, staff and past visits. Each type has a template you can fill in.</p><div class="imp-types" role="radiogroup" aria-label="Data type">${types}</div>`,{id:'impTypeTitle'})}${fileCard}</div><div class="imp-side-col">${historyCard()}${sources}</div></div>`;
 }

 function historyCard(){
  const info=state.info,b=info.batches||[],pending=info.pendingStaff||[];
  const rows=b.slice(0,6).map(x=>`<div class="imp-batch"><div class="imp-batch-text"><strong>${esc(x.typeLabel)}</strong><span>${esc(fmtDateTime(x.createdAt))}${x.createdBy?' · '+esc(x.createdBy):''}</span><span>${esc([x.created?plural(x.created,'added','added'):'',x.updated?plural(x.updated,'updated','updated'):'',x.skipped?plural(x.skipped,'skipped','skipped'):''].filter(Boolean).join(' · ')||'Nothing imported')}${x.status==='undone'?' · <b class="imp-undone">Undone</b>':''}</span></div><div class="imp-batch-actions">${x.canUndo?button('Undo','undo',{id:x.id}):''}${x.skipped?`<a class="imp-link" href="/api/import/batches/${encodeURIComponent(x.id)}/skipped.csv" download>Skipped rows (CSV)</a>`:''}</div></div>`).join('');
  const people=pending.length?`<div class="imp-pending"><h3 class="imp-h3">Waiting for an invitation</h3><p class="imp-muted">Imported staff can’t sign in until you invite them. No email has been sent.</p>${pending.map(u=>`<div class="imp-person"><div><strong>${esc(u.name)}</strong><span>${esc(u.email)} · ${u.role==='inspector'?'Field inspector':'Staff'}</span></div>${button('Send invite','invite',{id:u.id})}</div>`).join('')}</div>`:'';
  if(!rows&&!people)return '';
  return card('Recent imports',`${rows?`<p class="imp-muted">Undo removes everything an import added, for ${esc(info.undoDays)} days. Updates to existing records stay.</p>${rows}`:''}${people}`,{id:'impRecentTitle',cls:'imp-side'});
 }

 function mapStep(){
  const t=typeInfo(),p=state.parsed,used=new Set(Object.values(state.mapping).map(Number));
  const options=current=>`<option value="">Don’t import</option>`+p.headers.map((h,i)=>`<option value="${i}"${String(current)===String(i)?' selected':''}${used.has(i)&&String(current)!==String(i)?' disabled':''}>${esc(h)}</option>`).join('');
  const rows=t.fields.map(f=>{const col=state.mapping[f.key],sample=col===undefined?[]:(p.samples[col]||[]);
   const example=col===undefined?'':f.secret?'<span class="imp-sample">Saved encrypted · hidden here</span>':sample.length?`<span class="imp-sample">e.g. ${esc(sample.join(' · '))}</span>`:'<span class="imp-sample">Empty in the first rows</span>';
   return `<div class="imp-map-row${col!==undefined?' mapped':''}"><label class="imp-map-label" for="impMap-${esc(f.key)}">${esc(f.label)}${f.secret?' <span class="imp-lock">Encrypted</span>':''}${f.hint?`<small>${esc(f.hint)}</small>`:''}</label><div class="imp-map-pick"><select id="impMap-${esc(f.key)}" data-imp-map="${esc(f.key)}">${options(col)}</select>${example}</div></div>`;}).join('');
  const unused=p.headers.filter((_,i)=>!used.has(i));
  const matched=Object.keys(state.mapping).length;
  return card(`Match your columns to ${t.short.toLowerCase()}`,`<p class="imp-muted"><strong>${esc(p.fileName)}</strong> · ${plural(p.rowCount,'row')} · ${plural(p.headers.length,'column')}. ${matched?`${plural(matched,'column was','columns were')} matched automatically; check each one.`:'No column names were recognized; choose a column for each field you want to import.'}</p>
   <div class="imp-map">${rows}</div>${unused.length?`<p class="imp-unused"><strong>Not imported:</strong> ${esc(unused.join(', '))}</p>`:''}
   <div class="imp-actions">${button('Back','back-upload')}${button(state.busy==='preview'?'Checking rows…':'Next: preview','preview',{primary:true,disabled:!!state.busy})}</div>`,{id:'impMapTitle'});
 }

 function rowCard(r){
  const [label,cls]=STATUS[r.status]||['',''];
  const details=r.cells.filter(c=>c.value).map(c=>`<div class="imp-fact"><dt>${esc(c.label)}</dt><dd${c.secret?' class="imp-secret"':''}>${esc(c.value)}</dd></div>`).join('');
  return `<article class="imp-row ${cls}"><div class="imp-row-head"><span class="imp-badge ${cls}">${esc(label)}</span><span class="imp-row-num">Row ${esc(r.line)}</span></div><h3 class="imp-row-title">${esc(r.title)}</h3>${r.subtitle?`<p class="imp-row-sub">${esc(r.subtitle)}</p>`:''}${r.action?`<p class="imp-row-action">${esc(r.action)}</p>`:''}
   ${r.status==='skip'||r.status==='error'?`<p class="imp-row-reason">${esc(r.reason)}</p>`:''}
   ${r.errors.length>1?`<ul class="imp-msgs err">${r.errors.slice(1).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:''}${r.warnings.length?`<ul class="imp-msgs warn">${r.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}
   ${details?`<details class="imp-more"><summary>Show imported values</summary><dl class="imp-facts">${details}</dl></details>`:''}</article>`;
 }

 function previewStep(){
  const pv=state.preview,c=pv.counts,t=typeInfo();
  const list=pv.rows.filter(r=>state.filter==='all'||r.status==='error'||r.status==='skip'||r.warnings.length);
  const shown=list.slice(0,state.shown);
  const total=c.create+c.update;
  const stat=(n,l,cls)=>`<div class="imp-stat ${cls}"><b>${esc(n.toLocaleString('en-US'))}</b><span>${esc(l)}</span></div>`;
  const limit=pv.limits&&pv.limits.blocked?'<div class="imp-alert" role="alert">Your subscription needs attention in Company settings before you can import.</div>':'';
  return card('Preview',`<p class="imp-muted"><strong>${esc(pv.fileName)}</strong> · ${esc(t.label)}. Nothing has been saved yet.</p>
   <div class="imp-stats">${stat(c.create,'to add','new')}${stat(c.update,'to update','update')}${stat(c.duplicates,'duplicates','skip')}${stat(c.error,'with errors','error')}</div>${limit}
   <fieldset class="imp-mode"><legend>When a record already exists</legend>
    <label class="imp-choice"><input type="radio" name="impMode" value="skip"${state.mode==='skip'?' checked':''}><span><strong>Skip it</strong><small>Keep what’s in EstateAegis. Matched by name and address, or email.</small></span></label>
    <label class="imp-choice"><input type="radio" name="impMode" value="update"${state.mode==='update'?' checked':''}><span><strong>Update it</strong><small>Fill in details from the file. Blank cells never erase anything.</small></span></label>
   </fieldset>
   ${c.warnings?`<p class="imp-muted">${plural(c.warnings,'row has','rows have')} warnings: they import, but check the note on each.</p>`:''}
   <div class="imp-filter" role="group" aria-label="Rows to show">${button(`All rows (${pv.rows.length.toLocaleString('en-US')})`,'filter-all',{extra:` aria-pressed="${state.filter==='all'}"`})}${button(`Needs a look (${(c.error+c.skip+pv.rows.filter(r=>r.warnings.length&&r.status!=='error'&&r.status!=='skip').length).toLocaleString('en-US')})`,'filter-problems',{extra:` aria-pressed="${state.filter!=='all'}"`})}</div>
   <div class="imp-rows">${shown.map(rowCard).join('')||'<p class="imp-muted">No rows need a look.</p>'}</div>
   ${list.length>shown.length?`<div class="imp-more-rows">${button(`Show ${Math.min(30,list.length-shown.length)} more of ${list.length-shown.length}`,'more')}</div>`:''}
   <div class="imp-actions imp-sticky">${button('Back','back-map')}${button(state.busy==='run'?'Importing…':total?`Import ${plural(total,'row')}`:'Nothing to import','run',{primary:true,disabled:!total||!!state.busy})}</div>`,{id:'impPreviewTitle'});
 }

 function doneStep(){
  const r=state.result,detail=Object.entries(r.detail||{}).filter(([,n])=>n).map(([k,n])=>`${n.toLocaleString('en-US')} ${(DETAIL_LABEL[k]||[k,k])[Number(n)===1?0:1]}`).join(', ');
  const stat=(n,l,cls)=>`<div class="imp-stat ${cls}"><b>${esc(Number(n).toLocaleString('en-US'))}</b><span>${esc(l)}</span></div>`;
  const pending=r.pendingStaff?.length?`<h3 class="imp-h3">Send invitations when you’re ready</h3><p class="imp-muted">No emails were sent. Each person gets an invitation only when you click Send invite (also on Team & access).</p>${r.pendingStaff.map(u=>`<div class="imp-person"><div><strong>${esc(u.name)}</strong><span>${esc(u.email)} · ${u.role==='inspector'?'Field inspector':'Staff'}</span></div>${button('Send invite','invite',{id:u.id})}</div>`).join('')}`:'';
  const skipped=r.skippedRows?.length?`<h3 class="imp-h3">Skipped rows</h3><div class="imp-rows">${r.skippedRows.slice(0,8).map(s=>`<article class="imp-row imp-error"><div class="imp-row-head"><span class="imp-row-num">Row ${esc(s.line)}</span></div><h3 class="imp-row-title">${esc(s.title||'Row '+s.line)}</h3><p class="imp-row-reason">${esc(s.reason)}</p></article>`).join('')}</div>${r.skippedRows.length>8?`<p class="imp-muted">And ${plural(r.skippedRows.length-8,'more row')}: download the file for the full list.</p>`:''}`:'';
  const go={clients:['Open residences','properties'],contacts:['Open client families','clients'],vendors:['Open vendors','vendors'],staff:['Open Team & access','users'],history:['Open residences','properties']}[r.type];
  return card('Import finished',`<p class="imp-muted"><strong>${esc(r.fileName)}</strong>${detail?` · Added ${esc(detail)}`:''}.</p>
   <div class="imp-stats three">${stat(r.created,'added','new')}${stat(r.updated,'updated','update')}${stat(r.skipped,'skipped','skip')}</div>
   <div class="imp-actions imp-wrap">${r.skippedCsv?button('Download skipped rows (CSV)','download-skipped'):''}${r.created?button('Undo this import','undo',{id:r.batchId}):''}${button('Import another file','again')}<button type="button" class="imp-btn primary" data-action="navigate" data-id="${esc(go[1])}">${esc(go[0])}</button></div>
   ${r.created?`<p class="imp-muted">You can undo this import until ${esc(fmtDate(r.undoUntil))}. Undo removes what it added; updates stay.</p>`:''}${pending}${skipped}`,{id:'impDoneTitle'});
 }

 function page(){
  if(!state.info&&!state.loading&&!state.error)load();
  const heading=typeof root.head==='function'?root.head('Import data','Switching from another system? Bring your clients, residences, contacts, vendors, staff and past visits with you.'):'<h1>Import data</h1>';
  if(!state.info)return heading+`<div class="panel imp-card">${state.error?`<div class="imp-alert" role="alert">${esc(state.error)}</div>${button('Try again','reload')}`:'<p class="imp-muted">Loading…</p>'}</div>`;
  const body=state.step==='upload'?uploadStep():state.step==='map'?mapStep():state.step==='preview'?previewStep():doneStep();
  return heading+`<div class="imp-page">${stepper()}${state.note?`<div class="imp-note" role="status">${esc(state.note)}</div>`:''}${errorBox()}${body}</div>`;
 }

 // ---------- actions ----------
 function readFile(file){
  if(file.size>5*1024*1024){state.error='This file is larger than 5 MB. Split it into smaller files.';state.file=null;redraw();return;}
  const reader=new FileReader();
  reader.onload=()=>{const s=String(reader.result||'');state.file={name:file.name,size:file.size,data:s.slice(s.indexOf(',')+1)};state.error='';redraw();};
  reader.onerror=()=>{state.error='This file couldn’t be read. Try again.';redraw();};
  reader.readAsDataURL(file);
 }
 function download(name,text){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);}
 async function invite(id,btnEl){
  if(btnEl)btnEl.disabled=true;
  try{const r=await call('staff-invite',{userId:id});const msg=r.emailStatus==='sent'?`Invitation emailed to ${r.email}.`:`Invitation created for ${r.email}. Share this link: ${location.origin}${r.invitePath}`;
   if(typeof root.toast==='function')root.toast(msg);state.note=msg;
   for(const list of [state.info?.pendingStaff,state.result?.pendingStaff])if(list){const i=list.findIndex(u=>u.id===id);if(i>=0)list.splice(i,1);}
   await reloadData();}
  catch(e){state.error=e.message;if(typeof root.toast==='function')root.toast(e.message);}
  finally{if(btnEl)btnEl.disabled=false;redraw();}
 }
 async function handle(action,id,el){
  if(action==='reload'){state.error='';return load();}
  if(action==='parse')return run('parse',async()=>{const r=await call('parse',payload());state.parsed=r;state.mapping={...r.mapping};state.step='map';state.note='';});
  if(action==='back-upload'){state.step='upload';state.error='';redraw();return toTop();}
  if(action==='back-map'){state.step='map';state.error='';redraw();return toTop();}
  if(action==='preview')return run('preview',async()=>{state.preview=await call('preview',payload({mapping:state.mapping,mode:state.mode}));state.step='preview';state.filter='all';state.shown=30;});
  if(action==='filter-all'||action==='filter-problems'){state.filter=action==='filter-all'?'all':'problems';state.shown=30;return redraw();}
  if(action==='more'){state.shown+=30;return redraw();}
  if(action==='run'){
   const c=state.preview.counts;if(!confirm(`Import ${plural(c.create+c.update,'row')} now? You can undo what this adds for ${state.info.undoDays} days.`))return;
   return run('run',async()=>{state.result=await call('run',payload({mapping:state.mapping,mode:state.mode}));state.step='done';state.info=await call('info');await reloadData();});
  }
  if(action==='download-skipped')return download('EstateAegis-import-skipped-rows.csv',state.result.skippedCsv);
  if(action==='again'){Object.assign(state,{step:'upload',file:null,parsed:null,mapping:{},preview:null,result:null,error:'',note:''});return load();}
  if(action==='undo'){
   if(!confirm('Undo this import? Everything it added is removed. Records it updated keep their new details.'))return;
   return run('undo',async()=>{const r=await call('undo',{batchId:id});const n=Object.values(r.removed||{}).reduce((a,b)=>a+b,0);state.note=`Import undone: ${plural(n,'record')} removed.`;if(state.result&&state.result.batchId===id){Object.assign(state,{step:'upload',file:null,parsed:null,preview:null,result:null});}state.info=await call('info');await reloadData();});
  }
  if(action==='invite')return invite(id,el);
 }
 if(typeof document!=='undefined'){
  document.addEventListener('click',event=>{const b=event.target.closest&&event.target.closest('[data-imp]');if(!b||b.disabled)return;event.preventDefault();handle(b.dataset.imp,b.dataset.impId,b);});
  document.addEventListener('change',event=>{
   const t=event.target;if(!t||!t.closest||!t.closest('.imp-page'))return;
   if(t.id==='impFile'&&t.files&&t.files[0])return readFile(t.files[0]);
   if(t.name==='impType'){state.type=t.value;state.error='';return redraw();}
   if(t.dataset&&t.dataset.impMap){const k=t.dataset.impMap;if(t.value==='')delete state.mapping[k];else state.mapping[k]=Number(t.value);return redraw();}
   if(t.name==='impMode'){state.mode=t.value;handle('preview');}
  });
 }

 /** Team & access "Send invite" for imported staff (data-action="import-invite"). */
 async function action(name,key,btnEl){if(name!=='import-invite')return false;await invite(key,btnEl);return true;}
 /** Read-only visit history imported from a previous system, for a residence's Inspections tab (staff only). */
 function historyHtml(propertyId,data){
  const rows=(data?.importedVisits||[]).filter(v=>v.property_id===propertyId);if(!rows.length)return '';
  return `<section class="imp-history" aria-labelledby="impHist-${esc(propertyId)}"><h3 class="imp-h3" id="impHist-${esc(propertyId)}">Earlier visits from your previous system</h3><p class="imp-muted">Read-only history brought over by an import. These aren’t EstateAegis reports.</p>${rows.slice(0,50).map(v=>`<article class="imp-visit"><div class="imp-visit-head"><strong>${fmtDay(v.visit_date)}</strong>${v.outcome?`<span class="imp-badge imp-skip">${esc(v.outcome)}</span>`:''}</div>${[v.visit_type,v.inspector_name?'by '+v.inspector_name:''].filter(Boolean).length?`<p class="imp-row-sub">${esc([v.visit_type,v.inspector_name?'by '+v.inspector_name:''].filter(Boolean).join(' · '))}</p>`:''}${v.notes?`<p class="imp-visit-notes">${esc(v.notes)}</p>`:''}</article>`).join('')}${rows.length>50?`<p class="imp-muted">And ${plural(rows.length-50,'earlier visit')}.</p>`:''}</section>`;
 }
 root.EAImport={page,load,action,historyHtml,state};
})(typeof window!=='undefined'?window:globalThis);
