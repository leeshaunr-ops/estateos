// Full-page checklist template editor.
// Layout follows the approved reference (checklist list · item inspector · live phone preview);
// colours, type and controls come from the workspace theme (live.css / refresh.css tokens).
import * as M from './checklist-editor-model.mjs?v=ce-2';

const ICON_PATHS={
 grip:'<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
 chevDown:'<path d="m6 9 6 6 6-6"/>',
 chevUpDown:'<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
 arrowLeft:'<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
 arrowUp:'<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
 arrowDown:'<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
 arrowRight:'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
 plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
 camera:'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
 cameraOff:'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><path d="M3 3l18 18"/>',
 imagePlus:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
 alert:'<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
 checkCircle:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
 xCircle:'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
 minusCircle:'<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
 check:'<path d="M20 6 9 17l-5-5"/>',
 listChecks:'<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
 listOne:'<circle cx="5" cy="7" r="2"/><circle cx="5" cy="17" r="2"/><path d="M11 7h10"/><path d="M11 17h10"/>',
 toggle:'<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="16" cy="12" r="2.5"/>',
 hash:'<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/>',
 type:'<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
 star:'<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>',
 eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 more:'<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
 copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
 trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
 x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
 history:'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
 layers:'<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
 home:'<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
 logIn:'<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
 logOut:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
 trees:'<path d="M12 22v-5"/><path d="M8 17h8l-2.5-3.5H15L12 9l-3 4.5h1.5z"/><path d="M12 9 9.5 5.5h1L12 2l1.5 3.5h1z"/>',
 sofa:'<path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5H6V11a2 2 0 0 0-4 0z"/><path d="M4 18v2"/><path d="M20 18v2"/>',
 zap:'<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
 shield:'<path d="M12 2.2c2 1.6 4.7 2.6 7.6 2.8.4 0 .7.4.7.8v6c0 5-3.6 8.6-8 10-4.4-1.4-8-5-8-10v-6c0-.4.3-.8.7-.8 2.9-.2 5.6-1.2 7.6-2.8.2-.2.5-.2.7 0z"/>',
 note:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
 wrench:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
 cloudCheck:'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/><path d="m9.5 14 2 2 3.5-3.5"/>',
 cloudAlert:'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/><path d="M12 10v3"/><path d="M12 16h.01"/>',
 pin:'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
 pencil:'<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
 sliders:'<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
 storm:'<path d="M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 8.97"/><path d="m13 12-3 5h4l-3 5"/>',
 cloudSun:'<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.95 12.65a4 4 0 0 0-5.93-4.13"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6z"/>',
 waves:'<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
 car:'<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
 sparkles:'<path d="M9.94 14.06 4 20"/><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'
};
const icon=(name,cls='')=>`<svg class="ce-i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name]||''}</svg>`;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SECTION_ICONS=[[/pool|spa\b/i,'waves'],[/vehicle|boat|car\b|dock/i,'car'],[/document|photo|walk.?through/i,'camera'],[/opening|shutter|protect|storm|window/i,'shield'],[/arriv|entry|check.?in/i,'logIn'],[/depart|exit|lock.?up|check.?out/i,'logOut'],[/exterior|outside|garden|landscap|pool|perimeter/i,'trees'],[/interior|room|inside|living/i,'sofa'],[/system|utilit|electric|hvac|power|equipment/i,'zap'],[/secur|safety|alarm/i,'shield'],[/note|follow|record/i,'note'],[/maint|service|repair/i,'wrench']];
const sectionIcon=name=>(SECTION_ICONS.find(([re])=>re.test(name))||[0,'layers'])[1];
const DESKTOP_PREVIEW=1280, MOBILE=900;

export async function mountChecklistEditor({root,templateId,api,context={},onExit=()=>{},notify=()=>{}}){
 const loaded=await api('checklist-templates/'+encodeURIComponent(templateId)+'/items');
 const S={
  template:loaded.template,
  version:loaded.version||{version:loaded.template.current_version,status:'draft'},
  published:loaded.published||null,
  items:M.fromApi(loaded.items),
  selected:null,collapsed:new Set(),renaming:null,lifted:null,liftSnapshot:null,
  lastSavedAt:loaded.template.updated_at?Date.parse(loaded.template.updated_at):null,
  undo:null,menu:null,newSectionPending:false,
  starterSets:null,starter:null
 };
 const mqMobile=matchMedia(`(max-width:${MOBILE-0.02}px)`), mqPreview=matchMedia(`(min-width:${DESKTOP_PREVIEW}px)`);
 if(!mqMobile.matches&&S.items.length)S.selected=S.items[0].uid;
 const company=context.company||'EstateAegis', userName=context.userName||'';
 const initials=userName.split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0].toUpperCase()).join('');
 const cleanups=[];
 const on=(target,type,fn,opts)=>{target.addEventListener(type,fn,opts);cleanups.push(()=>target.removeEventListener(type,fn,opts));};

 // ---------- autosave ----------
 const autosave=new M.Autosave({delay:800,save:async()=>{
  const payload=M.toPayload(S.items);
  const result=await api('checklist-templates/'+encodeURIComponent(S.template.id)+'/items',{items:payload});
  if(result&&result.version)S.version={...S.version,version:result.version,status:result.status||'draft'};
  S.lastSavedAt=Date.now();
 },onStatus:()=>{const wasDraft=S.headerDraft;renderStatus();renderTopState();if(wasDraft!==(S.version.status!=='published'))renderHeader();}});
 const changed=({list=true,inspector=false,preview=true}={})=>{autosave.schedule();renderHeader();if(list)renderList();if(inspector)renderInspector();if(preview)renderPreview();renderTopState();};

 // Starter sets load in the background; the empty state re-renders once they arrive.
 const starterSetsReady=api('checklist-templates/starter-sets').then(r=>{S.starterSets=Array.isArray(r?.sets)?r.sets:[];if(!S.items.length&&root.isConnected)renderList();return S.starterSets;}).catch(()=>{S.starterSets=[];return S.starterSets;});

 // ---------- static frame ----------
 root.innerHTML=`<div class="ce" id="ceApp">
  <header class="ce-topbar">
   <div class="ce-brand">${context.logo?`<img class="ce-brand-logo" src="${esc(context.logo)}" alt="">`:`<span class="ce-brand-mark" aria-hidden="true">${esc(company.trim().charAt(0)||'E')}</span>`}<span class="ce-brand-name">${esc(company)}</span></div>
   <div class="ce-vsep" aria-hidden="true"></div>
   <button type="button" class="ce-iconbtn ce-back" data-ce="back" aria-label="Back to checklist templates">${icon('arrowLeft')}</button>
   <nav class="ce-crumbs" aria-label="Breadcrumb"><button type="button" class="ce-crumb-link" data-ce="back">Checklist templates</button><span class="ce-sep" aria-hidden="true">/</span><strong class="ce-crumb-current" aria-current="page">${esc(S.template.name)}</strong><span class="ce-pill" id="cePill"></span></nav>
   <div class="ce-spacer"></div>
   <div class="ce-top-actions">
    <span class="ce-saved" id="ceSaved" aria-live="polite"></span>
    <button type="button" class="ce-iconbtn ce-hist" data-ce="history" aria-label="Version history" title="Version history">${icon('history')}</button>
    <button type="button" class="ce-btn" data-ce="preview" aria-haspopup="dialog">${icon('eye')}Preview</button>
    <button type="button" class="primary ce-btn ce-publish" data-ce="publish" id="cePublish">Publish</button>
   </div>
   ${initials?`<div class="ce-avatar" title="${esc(userName)}" aria-hidden="true">${esc(initials)}</div>`:''}
  </header>
  <main class="ce-page" id="cePage">
   <section class="ce-canvas" aria-label="Checklist">
    <div class="ce-tpl-head" id="ceHead"><div id="ceHeadTitle"></div><div id="ceHeadBody"></div></div>
    <div class="ce-toolbar"><h2>Sections <span class="ce-count" id="ceSecCount"></span></h2><span class="ce-spacer"></span><button type="button" class="ce-btn-ghost" data-ce="collapse-all" id="ceCollapseAll">${icon('chevUpDown','ce-i-sm')}<span>Collapse all</span></button></div>
    <p id="ceDragHelp" class="ce-sr">Press Space to pick up. Use the up and down arrow keys to move, Space to drop, Escape to cancel.</p>
    <div id="ceSections" class="ce-sections"></div>
    <div class="ce-drop-line" id="ceDropLine" hidden></div>
    <button type="button" class="ce-add-section" data-ce="add-section">${icon('plus')}Add section</button>
   </section>
   <section class="ce-inspector" id="ceInspector" aria-label="Edit item"></section>
   <section class="ce-preview-col" aria-label="Field app preview">
    <div class="ce-pv-head">${icon('eye')}<span class="ce-pv-title">Field app preview</span><span class="ce-live">Live</span></div>
    <div class="ce-phone-host" id="cePreview"></div>
    <p class="ce-pv-cap">Updates as you type. This is how the item reads for your field team on site.</p>
   </section>
  </main>
  <div class="ce-sr" aria-live="assertive" id="ceAnnounce"></div>
  <div class="ce-snackbar" id="ceSnackbar" role="status" hidden></div>
  <div class="ce-menu" id="ceMenu" role="menu" hidden></div>
  <dialog class="ce-dialog" id="ceDialog"></dialog>
 </div>`;
 const $=sel=>root.querySelector(sel);
 const app=$('#ceApp'), sectionsEl=$('#ceSections'), inspectorEl=$('#ceInspector'), pageEl=$('#cePage'), dialog=$('#ceDialog');
 document.documentElement.classList.add('ce-fullpage');
 cleanups.push(()=>document.documentElement.classList.remove('ce-fullpage'));

 // ---------- helpers ----------
 const selectedItem=()=>S.items.find(x=>x.uid===S.selected)||null;
 const diff=()=>M.diffPublished(S.items,S.published?.items||null);
 const announce=msg=>{const el=$('#ceAnnounce');el.textContent='';setTimeout(()=>{el.textContent=msg;},30);};
 const preserveFocus=fn=>{
  const a=document.activeElement, key=a&&root.contains(a)?a.getAttribute('data-fk'):null;
  const sel=key&&typeof a.selectionStart==='number'?[a.selectionStart,a.selectionEnd]:null;
  fn();
  if(key){const el=root.querySelector(`[data-fk="${CSS.escape(key)}"]`);if(el&&el!==document.activeElement){el.focus({preventScroll:true});if(sel&&typeof el.setSelectionRange==='function')try{el.setSelectionRange(sel[0],sel[1]);}catch{}}}
 };
 const growAll=()=>root.querySelectorAll('textarea[data-autosize]').forEach(grow);
 const supportsFieldSizing=typeof CSS!=='undefined'&&CSS.supports&&CSS.supports('field-sizing','content');
 function grow(el){
  // field-sizing:content handles growth natively; the JS fallback sizes to content (no inner scroll).
  if(supportsFieldSizing)return;
  const cs=getComputedStyle(el);
  el.style.height='auto';
  el.style.height=M.autosizeHeight({scrollHeight:el.scrollHeight,borderTop:parseFloat(cs.borderTopWidth),borderBottom:parseFloat(cs.borderBottomWidth),minHeight:parseFloat(cs.minHeight)})+'px';
 }

 // ---------- top bar / header ----------
 // Template details (name and visit type) are rendered separately from the stats so typing in
 // the name field is never interrupted by autosave re-renders.
 function renderTitle(){
  const vt=M.visitType(S.template.visit_type);
  $('#ceHeadTitle').innerHTML=`<div class="ce-head-row"><div class="eyebrow">Checklist template</div><span class="ce-spacer"></span>
    <button type="button" class="ce-iconbtn" data-ce="template-menu" data-fk="tmenu" aria-label="Template options" aria-haspopup="menu" title="Template options">${icon('more')}</button></div>
   <h1 class="ce-tpl-title"><label class="ce-sr" for="ceName">Template name</label><input id="ceName" class="ce-name-input" data-fk="name" value="${esc(S.template.name)}" maxlength="120" autocomplete="off" spellcheck="true" title="Click to rename"></h1>
   ${S.template.description?`<p class="ce-tpl-desc">${esc(S.template.description)}</p>`:''}
   <div class="ce-type-row"><label class="ce-type-k" for="ceVisitType">Visit type</label>
    <div class="ce-select ce-select-sm"><span class="ce-sec-icon ce-sec-icon-sm" aria-hidden="true">${icon(vt.icon,'ce-i-sm')}</span><select id="ceVisitType" data-fk="vtype">${M.VISIT_TYPES.map(t=>`<option value="${t.value}" ${t.value===vt.value?'selected':''}>${esc(t.label)}</option>`).join('')}</select>${icon('chevUpDown','ce-chev2')}</div></div>`;
  const crumb=root.querySelector('.ce-crumb-current');if(crumb)crumb.textContent=S.template.name;
 }
 let detailsSaving=Promise.resolve();
 function saveDetails(patch,{message}={}){
  const before={name:S.template.name,visit_type:S.template.visit_type};
  Object.assign(S.template,patch);
  preserveFocus(()=>{renderTitle();if(!S.items.length)renderList();});renderPreview();
  detailsSaving=detailsSaving.then(async()=>{
   try{
    const r=await api('checklist-templates/'+encodeURIComponent(S.template.id)+'/details',patch);
    if(r&&r.template)Object.assign(S.template,{name:r.template.name,visit_type:r.template.visit_type,description:r.template.description});
    S.lastSavedAt=Date.now();renderStatus();
    if(message)notify(message);
   }catch(error){
    Object.assign(S.template,before);
    notify(error.message||'Could not save the template details.');
   }
   // Don't overwrite a name the user is still typing.
   if(document.activeElement?.id!=='ceName')preserveFocus(()=>{renderTitle();});
   renderPreview();
  });
  return detailsSaving;
 }
 function renderTopState(){
  const draft=S.version.status!=='published';
  const pill=$('#cePill');
  pill.className='ce-pill '+(draft?'ce-pill-draft':'ce-pill-published');
  pill.textContent=draft?'Draft':'Published';
  const pub=$('#cePublish'), nothing=!draft&&!autosave.busy&&M.pendingLabelCount(S.items)===0;
  pub.disabled=false;pub.setAttribute('aria-disabled',nothing?'true':'false');
  pub.title=nothing?'Everything is already published':'Publish this draft to your field team';
 }
 function renderStatus(){
  const el=$('#ceSaved'), pending=M.pendingLabelCount(S.items);
  const needs=pending?`<span class="ce-saved-warn">${pending===1?'1 item needs a label':pending+' items need a label'}</span>`:'';
  el.classList.toggle('ce-saved-error',autosave.status==='error');
  if(autosave.status==='error'){el.innerHTML=`${icon('cloudAlert','ce-i-sm')}<span role="alert">Couldn't save changes.</span><button type="button" class="ce-link" data-ce="retry">Retry</button>`;return;}
  if(autosave.status==='saving'){el.innerHTML=`<span class="ce-spinner" aria-hidden="true"></span><span>Saving…</span>${needs}`;return;}
  if(autosave.status==='pending'){el.innerHTML=`<span class="ce-dot" aria-hidden="true"></span><span>Unsaved changes</span>${needs}`;return;}
  el.innerHTML=`${icon('cloudCheck','ce-i-sm')}<span>${S.lastSavedAt?'Saved '+M.relativeTime(S.lastSavedAt):'All changes saved'}</span>${needs}`;
 }
 function renderHeader(){
  const st=M.stats(S.items), d=diff(), draft=S.version.status!=='published';
  S.headerDraft=draft;
  const pubV=S.published?.version;
  let notice;
  if(!S.published)notice=`<b>You're editing a draft.</b> This checklist hasn't been published yet, so field staff can't use it until you publish.`;
  else if(draft){
   const parts=[];
   if(d.edited.size)parts.push(d.edited.size===1?'1 item has unpublished changes.':d.edited.size+' items have unpublished changes.');
   if(d.removed)parts.push(d.removed===1?'1 item was removed.':d.removed+' items were removed.');
   if(!parts.length&&d.orderChanged)parts.push('The item order has changed.');
   notice=`<b>You're editing a draft.</b> Field staff keep using published version ${esc(pubV)} until you publish.${parts.length?' '+parts.join(' '):''}`;
  }else notice=`<b>Version ${esc(pubV)} is published.</b> Changes you make are saved as a new draft. Field staff keep using version ${esc(pubV)} until you publish again.`;
  $('#ceHeadBody').innerHTML=`<div class="ce-stats">
    <span class="ce-stat">${icon('listChecks')}<b>${st.items}</b> ${st.items===1?'item':'items'}</span>
    <span class="ce-stat">${icon('layers')}<b>${st.sections}</b> ${st.sections===1?'section':'sections'}</span>
    <span class="ce-stat">${icon('camera')}<b>${st.photos}</b> ask for photos</span>
   </div>
   <div class="ce-notice ${draft?'':'ce-notice-ok'}">${icon('info')}<span>${notice}</span></div>`;
  $('#ceSecCount').textContent='· '+st.sections;
  const groups=M.groupSections(S.items), allCollapsed=groups.length&&groups.every(g=>S.collapsed.has(g.name));
  $('#ceCollapseAll').querySelector('span').textContent=allCollapsed?'Expand all':'Collapse all';
  $('#ceCollapseAll').setAttribute('aria-pressed',allCollapsed?'true':'false');
 }

 // ---------- checklist (left) ----------
 function chipsHTML(item,edited){
  const photo=M.photoChip(item.photo_rule), type=M.ALL_TYPES.find(t=>t.value===item.response_type);
  return `<span class="ce-tag">${icon(type?.icon||'checkCircle')}${esc(M.typeLabel(item.response_type))}</span>`+
   (photo?`<span class="ce-tag ce-tag-photo">${icon(item.photo_rule==='required_on_fail'?'camera':'imagePlus')}${esc(photo)}</span>`:'')+
   (item.required?`<span class="ce-tag ce-tag-req">Required</span>`:'')+
   (item.alert_on_fail?`<span class="ce-tag ce-tag-alert">Alerts office</span>`:'')+
   (item.scope==='room'?`<span class="ce-tag">${icon('home')}Each room</span>`:'')+
   (edited?`<span class="ce-changed">Edited</span>`:'')+
   (!item.label.trim()?`<span class="ce-tag ce-tag-warn">Needs a label</span>`:'');
 }
 function itemRowHTML(item,num,edited){
  const sel=item.uid===S.selected, lifted=S.lifted?.type==='item'&&S.lifted.id===item.uid;
  const label=item.label.trim()||'Untitled item';
  return `<div class="ce-item${sel?' is-selected':''}${lifted?' is-lifted':''}" data-uid="${esc(item.uid)}">
   <button type="button" class="ce-grip" data-ce="grip" data-kind="item" data-id="${esc(item.uid)}" data-fk="grip:${esc(item.uid)}" aria-label="Reorder item ${num}: ${esc(label)}" aria-describedby="ceDragHelp" aria-pressed="${lifted?'true':'false'}" title="Drag to reorder">${icon('grip')}</button>
   <span class="ce-num" aria-hidden="true">${num}</span>
   <button type="button" class="ce-item-body" data-ce="select" data-id="${esc(item.uid)}" data-fk="sel:${esc(item.uid)}" aria-current="${sel?'true':'false'}" aria-label="Item ${num}: ${esc(label)}${sel?' (editing)':''}">
    <span class="ce-label${item.label.trim()?'':' is-empty'}" data-label-for="${esc(item.uid)}">${esc(label)}</span>
    <span class="ce-meta" data-meta-for="${esc(item.uid)}">${chipsHTML(item,edited)}</span>
   </button>
   <div class="ce-item-side">
    <div class="ce-item-actions">
     <button type="button" class="ce-iconbtn ce-iconbtn-sm" data-ce="duplicate" data-id="${esc(item.uid)}" data-fk="dup:${esc(item.uid)}" aria-label="Duplicate item ${num}" title="Duplicate">${icon('copy','ce-i-sm')}</button>
     <button type="button" class="ce-iconbtn ce-iconbtn-sm" data-ce="item-menu" data-id="${esc(item.uid)}" data-fk="more:${esc(item.uid)}" aria-label="More actions for item ${num}" aria-haspopup="menu" title="More">${icon('more')}</button>
    </div>
    ${sel?'<span class="ce-editing" aria-hidden="true">Editing</span>':''}
   </div>
  </div>`;
 }
 function renderList(){
  closeMenu();
  const d=diff(), groups=M.groupSections(S.items);let n=0;
  const html=groups.map((g,gi)=>{
   const collapsed=S.collapsed.has(g.name), photos=M.sectionPhotoCount(g), lifted=S.lifted?.type==='section'&&S.lifted.id===g.name;
   const rows=g.items.map(item=>itemRowHTML(item,++n,d.edited.has(item.uid))).join('');
   const renaming=S.renaming===g.name;
   const bodyId='ce-sec-body-'+gi;
   return `<div class="ce-section${collapsed?' is-collapsed':''}${lifted?' is-lifted':''}" data-section="${esc(g.name)}">
    <div class="ce-sec-head">
     <button type="button" class="ce-grip" data-ce="grip" data-kind="section" data-id="${esc(g.name)}" data-fk="sgrip:${esc(g.name)}" aria-label="Reorder section ${esc(g.name)}" aria-describedby="ceDragHelp" aria-pressed="${lifted?'true':'false'}" title="Drag to reorder">${icon('grip')}</button>
     ${renaming?`<span class="ce-chev-spacer"></span><span class="ce-sec-icon">${icon(sectionIcon(g.name))}</span><input class="ce-rename" data-ce-rename="${esc(g.name)}" data-fk="rename" value="${esc(g.name)}" aria-label="Section name" maxlength="80">`:
     `<button type="button" class="ce-sec-toggle" data-ce="toggle-section" data-id="${esc(g.name)}" data-fk="toggle:${esc(g.name)}" aria-expanded="${collapsed?'false':'true'}" aria-controls="${bodyId}">
      ${icon('chevDown','ce-chev')}<span class="ce-sec-icon">${icon(sectionIcon(g.name))}</span><span class="ce-sec-name">${esc(g.name)}</span><span class="ce-count-pill">${g.items.length} ${g.items.length===1?'item':'items'}</span>
     </button>`}
     <span class="ce-sec-meta">${photos?`<span class="ce-photos">${icon('camera','ce-i-sm')}${photos} with photos</span>`:''}
      <button type="button" class="ce-iconbtn" data-ce="section-menu" data-id="${esc(g.name)}" data-fk="smenu:${esc(g.name)}" aria-label="Section options for ${esc(g.name)}" aria-haspopup="menu">${icon('more')}</button></span>
    </div>
    ${collapsed?`<div class="ce-sec-summary">${esc(M.sectionSummary(g))}</div>`:''}
    <div class="ce-sec-body" id="${bodyId}" ${collapsed?'hidden':''}>${rows}
     <button type="button" class="ce-add-item" data-ce="add-item" data-id="${esc(g.name)}" data-fk="add:${esc(g.name)}"><span class="ce-plus">${icon('plus','ce-i-sm')}</span>Add item to ${esc(g.name)}</button>
    </div>
   </div>`;
  }).join('');
  sectionsEl.innerHTML=html||emptyHTML();
  placeInspector();
  const rename=root.querySelector('[data-ce-rename]');
  if(rename&&document.activeElement!==rename){rename.focus();rename.select();}
 }

 function emptyHTML(){
  const sets=S.starterSets, pick=sets&&sets.length?sets.find(x=>M.starterKey(x)===M.suggestStarter(S.template,sets)):null;
  const sections=pick?M.sectionNames(M.fromApi(pick.items)).length:0;
  const lead=pick?`Start from the <b>${esc(pick.label)}</b> starter checklist (${pick.items.length} items in ${sections} ${sections===1?'section':'sections'}) and adjust it to this residence, or add your own sections.`:'Load a ready-made starter checklist and adjust it, or add a section to build your own.';
  return `<div class="ce-empty ce-empty-start">
   <span class="ce-empty-ic" aria-hidden="true">${icon(pick?M.visitType(pick.visit_type).icon:'listChecks','ce-i-lg')}</span>
   <h3>This checklist has no items yet</h3>
   <p>${lead}</p>
   <div class="ce-empty-actions"><button type="button" class="primary ce-btn" data-ce="starter" data-fk="starter-empty" ${sets&&!sets.length?'disabled':''}>${icon('sparkles')}Load starter items</button></div>
   <p class="ce-empty-foot">Starter items are saved to this draft only. Field staff won't see them until you publish.</p>
  </div>`;
 }

 // ---------- inspector (middle) ----------
 function placeInspector(){
  const mobile=mqMobile.matches;
  inspectorEl.classList.toggle('is-inline',mobile);
  if(mobile){
   const row=S.selected&&sectionsEl.querySelector(`.ce-item[data-uid="${CSS.escape(S.selected)}"]`);
   if(row){
    let wrap=row.nextElementSibling;
    if(!wrap||!wrap.classList.contains('ce-inline-wrap')){wrap=document.createElement('div');wrap.className='ce-inline-wrap';row.after(wrap);}
    if(inspectorEl.parentElement!==wrap)wrap.appendChild(inspectorEl);
    inspectorEl.hidden=false;
   }else{inspectorEl.hidden=true;if(inspectorEl.parentElement!==pageEl)pageEl.insertBefore(inspectorEl,pageEl.querySelector('.ce-preview-col'));}
  }else{
   inspectorEl.hidden=false;
   if(inspectorEl.parentElement!==pageEl)pageEl.insertBefore(inspectorEl,pageEl.querySelector('.ce-preview-col'));
   sectionsEl.querySelectorAll('.ce-inline-wrap').forEach(w=>w.remove());
  }
 }
 function renderInspector(){
  const item=selectedItem();
  if(!item){inspectorEl.innerHTML=`<div class="ce-insp-empty">${icon('pencil','ce-i-lg')}<h3>Select an item to edit</h3><p>Choose any item in the checklist to change its question, answer type, photo rule and settings.</p></div>`;placeInspector();renderPreview();return;}
  const groups=M.groupSections(S.items), g=groups.find(x=>x.name===item.section), pos=g.items.findIndex(x=>x.uid===item.uid)+1;
  const choices=M.answerChoices(item.response_type,item.options);
  const isChoice=item.response_type==='select'||item.response_type==='multi_select';
  const len=item.label.length;
  const tile=t=>`<button type="button" class="ce-tile${item.response_type===t.value?' is-on':''}" role="radio" aria-checked="${item.response_type===t.value}" data-ce="type" data-id="${t.value}" data-fk="type:${t.value}" tabindex="${item.response_type===t.value||(!M.ALL_TYPES.some(x=>x.value===item.response_type)&&t.value==='pass_fail_na')?0:-1}"><span class="ce-tile-badge" aria-hidden="true">${icon('check')}</span>${icon(t.icon)}<span>${esc(t.label)}</span></button>`;
  const photoCard=r=>`<button type="button" class="ce-opt-card${item.photo_rule===r.value?' is-on':''}${r.unsupported?' is-unsupported':''}" role="radio" aria-checked="${item.photo_rule===r.value}" ${r.unsupported?'aria-disabled="true" disabled':''} data-ce="photo" data-id="${r.value}" data-fk="photo:${r.value}" tabindex="${item.photo_rule===r.value?0:-1}"><span class="ce-opt-ic">${icon(r.icon)}</span><span><span class="ce-opt-t">${esc(r.label)}</span><span class="ce-opt-d">${esc(r.desc)}</span></span></button>`;
  inspectorEl.innerHTML=`<div class="ce-insp-head">
    <div class="ce-insp-titles"><h3>Edit item</h3><div class="ce-insp-sub">${esc(item.section)} · Item ${pos} of ${g.items.length}</div></div>
    <span class="ce-spacer"></span>
    <button type="button" class="ce-iconbtn" data-ce="duplicate" data-id="${esc(item.uid)}" data-fk="i-dup" aria-label="Duplicate item" title="Duplicate">${icon('copy')}</button>
    <button type="button" class="ce-iconbtn" data-ce="delete" data-id="${esc(item.uid)}" data-fk="i-del" aria-label="Delete item" title="Delete">${icon('trash')}</button>
    <button type="button" class="ce-iconbtn" data-ce="close" data-fk="i-close" aria-label="Close editor" title="Close">${icon('x')}</button>
   </div>
   <div class="ce-insp-body">
    <div class="ce-field">
     <div class="ce-field-label"><label for="ceLabel">Item label</label></div>
     <textarea id="ceLabel" class="ce-ta ce-ta-title" rows="1" maxlength="${M.LABEL_MAX}" data-autosize data-field="label" data-fk="label" aria-describedby="ceLabelHint ceLabelCount" placeholder="What should your field tech check?">${esc(item.label)}</textarea>
     <div class="ce-hint"><span id="ceLabelHint">The question your field tech answers.</span><span id="ceLabelCount" class="${len>M.LABEL_MAX?'ce-over':''}">${len} / ${M.LABEL_MAX}</span></div>
    </div>
    <div class="ce-field">
     <div class="ce-field-label"><label for="ceHelp">Helpful instructions</label><span class="ce-opt">Optional</span></div>
     <textarea id="ceHelp" class="ce-ta ce-ta-notes" rows="3" data-autosize data-field="help_text" data-fk="help" aria-describedby="ceHelpHint" placeholder="Add steps, tips or what “good” looks like.">${esc(item.help_text)}</textarea>
     <div class="ce-hint"><span id="ceHelpHint">Shown under the question in the field app.</span></div>
    </div>
    <div class="ce-field">
     <div class="ce-field-label"><span class="ce-lbl" id="ceTypeLbl">How should it be answered?</span></div>
     <div class="ce-answer-grid" role="radiogroup" aria-labelledby="ceTypeLbl" data-group="type">${M.ANSWER_TYPES.map(tile).join('')}</div>
     <div class="ce-choice-types" role="radiogroup" aria-label="Choice list answers" data-group="type"><span class="ce-choice-k">Or a list of choices</span>${M.CHOICE_TYPES.map(t=>`<button type="button" class="ce-mini-tile${item.response_type===t.value?' is-on':''}" role="radio" aria-checked="${item.response_type===t.value}" data-ce="type" data-id="${t.value}" data-fk="type:${t.value}" tabindex="${item.response_type===t.value?0:-1}">${icon(t.icon,'ce-i-sm')}${esc(t.label)}</button>`).join('')}</div>
     <div class="ce-choices"><span class="ce-k">Tech can choose</span>${choices.map(c=>`<span class="ce-chip ce-chip-${c.tone}">${c.tone==='pass'?icon('check','ce-i-xs'):c.tone==='fail'?icon('x','ce-i-xs'):''}${esc(c.label)}</span>`).join('')}</div>
     ${isChoice?`<div class="ce-field ce-sub-field"><div class="ce-field-label"><label for="ceOptions">Choices</label><span class="ce-opt">One per line</span></div><textarea id="ceOptions" class="ce-ta ce-ta-notes" rows="3" data-autosize data-field="options" data-fk="options" placeholder="Good&#10;Needs attention&#10;Not applicable">${esc(item.options.join('\n'))}</textarea></div>`:''}
    </div>
    <div class="ce-field">
     <div class="ce-field-label"><span class="ce-lbl" id="cePhotoLbl">Photo evidence</span></div>
     <div class="ce-photo-grid" role="radiogroup" aria-labelledby="cePhotoLbl" data-group="photo">${M.PHOTO_RULES.map(photoCard).join('')}</div>
    </div>
    <div class="ce-field">
     <div class="ce-field-label"><label for="ceSection">Section</label></div>
     <div class="ce-select"><span class="ce-sec-icon ce-sec-icon-sm" aria-hidden="true">${icon(sectionIcon(item.section),'ce-i-sm')}</span><select id="ceSection" data-fk="section">${groups.map(x=>`<option value="${esc(x.name)}" ${x.name===item.section?'selected':''}>${esc(x.name)}</option>`).join('')}<option value="__new__">New section…</option></select>${icon('chevUpDown','ce-chev2')}</div>
    </div>
    <div class="ce-field ce-switches">
     <div class="ce-switch-row"><div><div class="ce-sw-t" id="ceReqT">Required</div><div class="ce-sw-d" id="ceReqD">The visit can't be submitted until this is answered.</div></div><button type="button" class="ce-switch${item.required?' is-on':''}" role="switch" aria-checked="${item.required}" aria-labelledby="ceReqT" aria-describedby="ceReqD" data-ce="switch" data-id="required" data-fk="sw:required"></button></div>
     <div class="ce-switch-row"><div><div class="ce-sw-t" id="ceAlertT">Alert the office on fail</div><div class="ce-sw-d" id="ceAlertD">When a visit is completed with this item failed, every admin and the residence manager get one in-app and email alert.</div></div><button type="button" class="ce-switch${item.alert_on_fail?' is-on':''}" role="switch" aria-checked="${item.alert_on_fail}" aria-labelledby="ceAlertT" aria-describedby="ceAlertD" data-ce="switch" data-id="alert_on_fail" data-fk="sw:alert"></button></div>
    </div>
    <details class="ce-advanced" ${S.advancedOpen?'open':''}>
     <summary data-fk="adv">${icon('sliders','ce-i-sm')}Advanced<span class="ce-adv-sum">${item.scope==='room'?'Each room'+(item.room_types.length?' · '+esc(item.room_types.join(', ')):''):'Whole property'}</span></summary>
     <div class="ce-adv-body">
      <div class="ce-field-label"><span class="ce-lbl" id="ceScopeLbl">Applies to</span></div>
      <div class="ce-seg" role="radiogroup" aria-labelledby="ceScopeLbl" data-group="scope">
       <button type="button" role="radio" class="ce-seg-btn${item.scope!=='room'?' is-on':''}" aria-checked="${item.scope!=='room'}" data-ce="scope" data-id="property" data-fk="scope:property" tabindex="${item.scope!=='room'?0:-1}">Whole property</button>
       <button type="button" role="radio" class="ce-seg-btn${item.scope==='room'?' is-on':''}" aria-checked="${item.scope==='room'}" data-ce="scope" data-id="room" data-fk="scope:room" tabindex="${item.scope==='room'?0:-1}">Each room</button>
      </div>
      <div class="ce-hint"><span>“Each room” repeats this item for every matching room in the residence.</span></div>
      ${item.scope==='room'?`<div class="ce-field ce-sub-field"><div class="ce-field-label"><label for="ceRooms">Room types</label><span class="ce-opt">Optional · one per line</span></div><textarea id="ceRooms" class="ce-ta ce-ta-notes ce-ta-short" rows="2" data-autosize data-field="room_types" data-fk="rooms" placeholder="Leave empty for every room">${esc(item.room_types.join('\n'))}</textarea></div>`:''}
      ${!isChoice&&item.options.length?`<div class="ce-field ce-sub-field"><div class="ce-field-label"><label for="ceOptions2">Saved answer choices</label><span class="ce-opt">Used by choice lists</span></div><textarea id="ceOptions2" class="ce-ta ce-ta-notes ce-ta-short" rows="2" data-autosize data-field="options" data-fk="options2">${esc(item.options.join('\n'))}</textarea></div>`:''}
     </div>
    </details>
   </div>
   <div class="ce-insp-foot">
    <span class="ce-note"><span class="ce-kbd">↑</span><span class="ce-kbd">↓</span> to move between items</span>
    <span class="ce-spacer"></span>
    <button type="button" class="ce-btn ce-btn-sm" data-ce="prev" data-fk="prev" aria-label="Previous item">${icon('arrowUp','ce-i-sm')}</button>
    <button type="button" class="ce-btn ce-btn-sm" data-ce="next" data-fk="next">Next item${icon('arrowDown','ce-i-sm')}</button>
   </div>`;
  placeInspector();
  growAll();
  inspectorEl.querySelectorAll('textarea[data-autosize]').forEach(t=>resizeObserver?.observe(t));
  renderPreview();
 }

 // ---------- live phone preview (right) ----------
 function phoneHTML(){
  const item=selectedItem();
  const total=S.items.length, idx=item?S.items.findIndex(x=>x.uid===item.uid)+1:0;
  const pct=total?Math.round(idx/total*100):0;
  let answers='';
  if(item){
   const t=item.response_type;
   if(t==='pass_fail_na')answers=`<div class="ce-p-answers ce-p-3"><span class="ce-p-ans ce-p-pass">${icon('checkCircle')}Pass</span><span class="ce-p-ans ce-p-fail">${icon('xCircle')}Fail</span><span class="ce-p-ans">${icon('minusCircle')}N/A</span></div>`;
   else if(t==='yes_no')answers=`<div class="ce-p-answers ce-p-2"><span class="ce-p-ans ce-p-pass">${icon('check')}Yes</span><span class="ce-p-ans ce-p-fail">${icon('x')}No</span></div>`;
   else if(t==='number'||t==='rating')answers=`<div class="ce-p-input">${icon(t==='rating'?'star':'hash','ce-i-sm')}<span>${t==='rating'?'Enter a rating':'Enter a number'}</span></div>`;
   else if(t==='text')answers=`<div class="ce-p-input ce-p-textarea"><span>Type your answer</span></div>`;
   else{const opts=item.options.length?item.options:['Add choices in the editor'];answers=`<div class="ce-p-options">${opts.map(o=>`<span class="ce-p-opt"><span class="ce-p-${t==='select'?'radio':'check'}" aria-hidden="true"></span>${esc(o)}</span>`).join('')}</div>`;}
  }
  const prompt=item?M.photoPrompt(item):'';
  return `<div class="ce-phone" aria-hidden="${item?'false':'true'}">
   <div class="ce-screen">
    <div class="ce-island" aria-hidden="true"></div>
    <div class="ce-status" aria-hidden="true"><span>9:41</span><span class="ce-sb"><i></i><i></i><i></i><b></b></span></div>
    <div class="ce-app-bar"><div class="ce-app-row">${icon('arrowLeft')}<span class="ce-ttl">${esc(S.template.name)}</span><span class="ce-step">${idx} of ${total}</span></div>
     <div class="ce-progress"><i data-pct="${pct}"></i></div>
     <div class="ce-prop">${icon('pin','ce-i-xs')}${esc(M.visitType(S.template.visit_type).label)} visit</div></div>
    <div class="ce-p-body">${item?`
     <div class="ce-p-card">
      <div class="ce-p-sec">${icon(sectionIcon(item.section),'ce-i-xs')}${esc(item.section)}</div>
      <div class="ce-p-q"><span>${esc(item.label.trim()||'Your question appears here')}</span>${item.required?' <span class="ce-req" aria-label="required">*</span>':''}</div>
      ${item.help_text.trim()?`<p class="ce-p-help">${esc(item.help_text)}</p>`:''}
      ${answers}
     </div>
     ${prompt?`<div class="ce-p-photo"><span class="ce-p-ic">${icon('camera','ce-i-sm')}</span><span>${esc(prompt)}</span></div>`:''}
     <div class="ce-p-note">Add a note (optional)</div>`:`<div class="ce-p-card ce-p-placeholder">Select an item to preview it.</div>`}
    </div>
    <div class="ce-p-foot"><span class="ce-p-btn ce-p-back">${icon('arrowLeft')}</span><span class="ce-p-btn ce-p-next">Next item${icon('arrowRight','ce-i-sm')}</span></div>
   </div>
  </div>`;
 }
 function renderPreview(){
  const html=phoneHTML();
  root.querySelectorAll('#cePreview, #cePreviewDialogBody').forEach(el=>{el.innerHTML=html;el.querySelectorAll('.ce-progress i').forEach(i=>{i.style.width=i.dataset.pct+'%';});});
 }

 // ---------- selection & keyboard ----------
 function select(uid,{focusLabel=false,scroll=true}={}){
  if(S.lifted)return;
  S.selected=uid;
  const item=selectedItem();
  if(item&&S.collapsed.has(item.section))S.collapsed.delete(item.section);
  preserveFocus(()=>{renderList();renderHeader();renderInspector();});
  if(item&&scroll){
   const row=sectionsEl.querySelector(`.ce-item[data-uid="${CSS.escape(uid)}"]`);
   if(row)row.scrollIntoView({block:mqMobile.matches?'start':'nearest',behavior:'smooth'});
  }
  if(focusLabel){const ta=root.querySelector('#ceLabel');if(ta){ta.focus({preventScroll:mqMobile.matches?false:true});const v=ta.value.length;ta.setSelectionRange(v,v);}}
 }
 function step(delta){
  const order=S.items.map(x=>x.uid);if(!order.length)return;
  let i=order.indexOf(S.selected);
  i=i<0?(delta>0?0:order.length-1):Math.max(0,Math.min(order.length-1,i+delta));
  select(order[i]);
  const row=sectionsEl.querySelector(`.ce-item[data-uid="${CSS.escape(order[i])}"] .ce-item-body`);
  if(row&&root.contains(document.activeElement)&&document.activeElement.closest('.ce-item'))row.focus({preventScroll:true});
 }
 on(document,'keydown',e=>{
  if(dialog.open)return;
  if(e.key==='Escape'&&S.menu){closeMenu(true);e.preventDefault();return;}
  if(e.target.closest&&e.target.closest('.ce-grip'))return; // grips handle their own keys
  if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;
  if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;
  if(M.isTypingTarget(e.target))return;
  if(e.target.closest&&e.target.closest('[role="radiogroup"],[role="menu"],details summary'))return;
  if(!root.contains(e.target)&&e.target!==document.body)return;
  e.preventDefault();step(e.key==='ArrowDown'?1:-1);
 });

 // ---------- mutations ----------
 const commit=(items,{selected,inspector=true,focusLabel=false,announceMsg}={})=>{
  S.items=items;
  if(selected!==undefined)S.selected=selected;
  if(S.selected&&!S.items.some(x=>x.uid===S.selected))S.selected=null;
  autosave.schedule();
  preserveFocus(()=>{renderHeader();renderList();if(inspector)renderInspector();else renderPreview();renderTopState();renderStatus();});
  if(focusLabel)select(S.selected,{focusLabel:true});
  if(announceMsg)announce(announceMsg);
 };
 function showUndo(message,snapshot){
  const bar=$('#ceSnackbar');
  clearTimeout(S.undoTimer);
  S.undo={snapshot,selected:S.selected};
  bar.innerHTML=`<span>${esc(message)}</span><button type="button" class="ce-link" data-ce="undo">Undo</button><button type="button" class="ce-iconbtn ce-iconbtn-sm" data-ce="dismiss-undo" aria-label="Dismiss">${icon('x','ce-i-sm')}</button>`;
  bar.hidden=false;
  S.undoTimer=setTimeout(()=>{bar.hidden=true;S.undo=null;},10000);
 }
 function addItemTo(section){
  const r=M.addItem(S.items,section);
  S.collapsed.delete(section);
  commit(r.items,{selected:r.uid,announceMsg:'New item added to '+section+'.'});
  select(r.uid,{focusLabel:true});
 }
 function addSection(){
  const name=M.newSectionName(S.items);
  const r=M.addItem(S.items,name);
  S.renaming=name;S.afterRenameFocus=r.uid;
  commit(r.items,{selected:r.uid});
  const card=sectionsEl.querySelector(`.ce-section[data-section="${CSS.escape(name)}"]`);card?.scrollIntoView({block:'nearest',behavior:'smooth'});
 }
 function deleteItemUid(uid){
  const item=S.items.find(x=>x.uid===uid);if(!item)return;
  const snapshot=S.items, order=S.items.map(x=>x.uid), i=order.indexOf(uid);
  const nextSel=S.selected===uid?(order[i+1]||order[i-1]||null):S.selected;
  commit(M.deleteItem(S.items,uid),{selected:nextSel});
  showUndo(`Deleted “${item.label.trim()||'Untitled item'}”.`,snapshot);
 }
 function deleteSectionName(name){
  const snapshot=S.items, count=S.items.filter(x=>x.section===name).length;
  commit(M.deleteSection(S.items,name));
  showUndo(`Deleted section “${name}” and its ${count} ${count===1?'item':'items'}.`,snapshot);
 }
 function commitRename(input,cancel=false){
  const from=input.getAttribute('data-ce-rename');S.renaming=null;
  const focusUid=S.afterRenameFocus;S.afterRenameFocus=null;
  if(cancel||input.value.trim()===from){renderList();if(focusUid)select(focusUid,{focusLabel:true});return;}
  try{
   const items=M.renameSection(S.items,from,input.value);
   if(S.collapsed.has(from)){S.collapsed.delete(from);S.collapsed.add(input.value.trim());}
   commit(items);
   if(focusUid)select(focusUid,{focusLabel:true});
  }catch(error){notify(error.message);S.renaming=from;renderList();}
 }

 // ---------- menus ----------
 function openMenu(trigger,items){
  closeMenu();
  const menu=$('#ceMenu');
  menu.innerHTML=items.map((m,i)=>m==='-'?'<div class="ce-menu-sep" role="separator"></div>':`<button type="button" role="menuitem" class="ce-menu-item${m.danger?' is-danger':''}" data-menu-index="${i}" ${m.disabled?'disabled':''}>${m.icon?icon(m.icon,'ce-i-sm'):''}${esc(m.label)}</button>`).join('');
  S.menu={trigger,items};
  menu.hidden=false;
  const r=trigger.getBoundingClientRect(), w=menu.offsetWidth, h=menu.offsetHeight;
  menu.style.left=Math.max(8,Math.min(window.innerWidth-w-8,r.right-w))+'px';
  menu.style.top=(r.bottom+6+h>window.innerHeight?Math.max(8,r.top-h-6):r.bottom+6)+'px';
  trigger.setAttribute('aria-expanded','true');
  menu.querySelector('.ce-menu-item:not([disabled])')?.focus();
 }
 function closeMenu(returnFocus=false){
  if(!S.menu)return;
  const {trigger}=S.menu;S.menu=null;
  const menu=$('#ceMenu');menu.hidden=true;menu.innerHTML='';
  trigger.setAttribute('aria-expanded','false');
  if(returnFocus&&trigger.isConnected)trigger.focus();
 }
 function itemMenu(uid,trigger){
  const item=S.items.find(x=>x.uid===uid);if(!item)return;
  const groups=M.groupSections(S.items), gi=groups.findIndex(g=>g.name===item.section), g=groups[gi], idx=g.items.findIndex(x=>x.uid===uid);
  const first=gi===0&&idx===0, last=gi===groups.length-1&&idx===g.items.length-1;
  openMenu(trigger,[
   {label:'Edit item',icon:'pencil',run:()=>select(uid,{focusLabel:true})},
   {label:'Duplicate',icon:'copy',run:()=>{const r=M.duplicateItem(S.items,uid);commit(r.items,{selected:r.uid,announceMsg:'Item duplicated.'});}},
   {label:'Move up',icon:'arrowUp',disabled:first,run:()=>commit(M.moveItemBy(S.items,uid,-1),{announceMsg:'Item moved up.'})},
   {label:'Move down',icon:'arrowDown',disabled:last,run:()=>commit(M.moveItemBy(S.items,uid,1),{announceMsg:'Item moved down.'})},
   ...groups.filter(x=>x.name!==item.section).map(x=>({label:'Move to '+x.name,icon:'arrowRight',run:()=>commit(M.moveItem(S.items,uid,x.name,Infinity),{announceMsg:'Item moved to '+x.name+'.'})})),
   '-',
   {label:'Delete item',icon:'trash',danger:true,run:()=>deleteItemUid(uid)}
  ]);
 }
 function sectionMenu(name,trigger){
  const names=M.sectionNames(S.items), i=names.indexOf(name);
  openMenu(trigger,[
   {label:'Rename section',icon:'pencil',run:()=>{S.renaming=name;renderList();}},
   {label:'Add item',icon:'plus',run:()=>addItemTo(name)},
   {label:'Move section up',icon:'arrowUp',disabled:i<=0,run:()=>commit(M.moveSectionBy(S.items,name,-1),{inspector:true,announceMsg:'Section moved up.'})},
   {label:'Move section down',icon:'arrowDown',disabled:i>=names.length-1,run:()=>commit(M.moveSectionBy(S.items,name,1),{inspector:true,announceMsg:'Section moved down.'})},
   '-',
   {label:'Delete section',icon:'trash',danger:true,run:()=>deleteSectionName(name)}
  ]);
 }
 function templateMenu(trigger){
  openMenu(trigger,[
   {label:'Load starter items',icon:'sparkles',run:()=>openStarter()},
   {label:'Rename template',icon:'pencil',run:()=>{const n=root.querySelector('#ceName');if(n){n.focus();n.select();}}},
   {label:'Version history',icon:'history',run:()=>openHistory()}
  ]);
 }
 on($('#ceMenu'),'click',e=>{const b=e.target.closest('[data-menu-index]');if(!b||!S.menu)return;const m=S.menu.items[Number(b.dataset.menuIndex)];closeMenu();m.run();});
 on($('#ceMenu'),'keydown',e=>{
  const items=[...$('#ceMenu').querySelectorAll('.ce-menu-item:not([disabled])')], i=items.indexOf(document.activeElement);
  if(e.key==='ArrowDown'){e.preventDefault();items[(i+1)%items.length]?.focus();}
  else if(e.key==='ArrowUp'){e.preventDefault();items[(i-1+items.length)%items.length]?.focus();}
  else if(e.key==='Tab'){closeMenu();}
 });
 on(document,'pointerdown',e=>{if(S.menu&&!e.target.closest('#ceMenu')&&e.target.closest('[data-ce]')!==S.menu.trigger)closeMenu();},true);
 on(window,'scroll',()=>closeMenu(),{passive:true});
 on(window,'resize',()=>closeMenu());

 // ---------- dialogs ----------
 function openDialog(html,{wide=false,onClose}={}){
  dialog.className='ce-dialog'+(wide?' ce-dialog-wide':'');
  dialog.innerHTML=html;
  dialog.showModal();
  const close=()=>{dialog.removeEventListener('close',close);onClose&&onClose();};
  dialog.addEventListener('close',close);
 }
 // ---------- starter items ----------
 async function openStarter(){
  openDialog(`<div class="ce-dialog-head"><h2>Load starter items</h2><button type="button" class="ce-iconbtn" data-ce="dialog-close" aria-label="Close">${icon('x')}</button></div><div class="ce-dialog-body" id="ceStarterBody"><p class="ce-muted">Loading starter checklists…</p></div><div class="ce-dialog-foot" id="ceStarterFoot"><button type="button" class="ce-btn" data-ce="dialog-close">Cancel</button></div>`,{wide:true,onClose:()=>{S.starter=null;}});
  const sets=await starterSetsReady;
  if(!dialog.open)return;
  if(!sets.length){dialog.querySelector('#ceStarterBody').innerHTML='<p class="ce-error-text">Starter checklists are not available right now. Try again in a moment.</p>';return;}
  const pick=M.suggestStarter(S.template,sets);
  S.starter={pick,mode:S.items.length?'append':'replace',setType:(sets.find(x=>M.starterKey(x)===pick)?.visit_type)!==S.template.visit_type&&!S.items.length};
  renderStarter();
  dialog.querySelector('.ce-starter-card.is-on')?.focus();
 }
 function renderStarter(){
  const st=S.starter, sets=S.starterSets||[];if(!st||!dialog.open)return;
  const set=sets.find(x=>M.starterKey(x)===st.pick)||sets[0];
  // The suggested set first, then the rest in their usual order.
  const suggested=M.suggestStarter(S.template,sets),ordered=[...sets].sort((a,b)=>(M.starterKey(b)===suggested)-(M.starterKey(a)===suggested));
  const card=x=>{const on=M.starterKey(x)===M.starterKey(set), secs=M.sectionNames(M.fromApi(x.items)), vt=M.visitType(x.visit_type);
   return `<button type="button" class="ce-opt-card ce-starter-card${on?' is-on':''}" role="radio" aria-checked="${on}" tabindex="${on?0:-1}" data-ce="starter-pick" data-id="${esc(M.starterKey(x))}"><span class="ce-opt-ic">${icon(vt.icon)}</span><span class="ce-starter-text"><span class="ce-opt-t">${esc(x.label)}${x.visit_type===S.template.visit_type?' <span class="ce-starter-match">This template\'s visit type</span>':''}</span><span class="ce-opt-d">${esc(secs.join(' · '))}</span></span><span class="ce-starter-count">${x.items.length} items</span></button>`;};
  const typeLabel=M.visitType(set.visit_type).label;
  dialog.querySelector('#ceStarterBody').innerHTML=`<p class="ce-muted">Pick a starter checklist. You can edit, reorder or delete any item afterwards. Items are saved to this draft; nothing reaches field staff until you publish.</p>
   <div class="ce-starter-list" role="radiogroup" aria-label="Starter checklists" data-group="starter">${ordered.map(card).join('')}</div>
   ${S.items.length?`<div class="ce-starter-mode"><span class="ce-lbl" id="ceStarterModeLbl">This checklist already has ${S.items.length} ${S.items.length===1?'item':'items'}</span><div class="ce-seg" role="radiogroup" aria-labelledby="ceStarterModeLbl"><button type="button" role="radio" class="ce-seg-btn${st.mode==='append'?' is-on':''}" aria-checked="${st.mode==='append'}" data-ce="starter-mode" data-id="append">Add after current items</button><button type="button" role="radio" class="ce-seg-btn${st.mode==='replace'?' is-on':''}" aria-checked="${st.mode==='replace'}" data-ce="starter-mode" data-id="replace">Replace current items</button></div></div>`:''}
   ${set.visit_type!==S.template.visit_type?`<label class="ce-check"><input type="checkbox" id="ceStarterType" ${st.setType?'checked':''}><span>Also change this template's visit type to <b>${esc(typeLabel)}</b></span></label>`:''}`;
  dialog.querySelector('#ceStarterFoot').innerHTML=`<button type="button" class="ce-btn" data-ce="dialog-close">Cancel</button><button type="button" class="primary ce-btn" data-ce="starter-confirm">${st.mode==='replace'&&S.items.length?'Replace with':'Load'} ${set.items.length} items</button>`;
 }
 async function confirmStarter(){
  const st=S.starter, set=(S.starterSets||[]).find(x=>M.starterKey(x)===st?.pick);if(!set)return;
  const setType=set.visit_type!==S.template.visit_type&&!!dialog.querySelector('#ceStarterType')?.checked;
  const snapshot=S.items, r=M.loadStarterItems(S.items,set.items,st.mode);
  dialog.close();
  S.collapsed=new Set();
  commit(r.items,{selected:mqMobile.matches?null:r.added[0],announceMsg:`Loaded ${r.added.length} ${set.label} starter items.`});
  showUndo(`Loaded ${r.added.length} ${set.label} starter items into the draft.`,snapshot);
  if(setType)saveDetails({visit_type:set.visit_type});
  const first=r.added[0]&&sectionsEl.querySelector(`.ce-item[data-uid="${CSS.escape(r.added[0])}"]`);
  (first||sectionsEl).scrollIntoView({block:'nearest',behavior:'smooth'});
 }
 async function openHistory(){
  openDialog(`<div class="ce-dialog-head"><h2>Version history</h2><button type="button" class="ce-iconbtn" data-ce="dialog-close" aria-label="Close">${icon('x')}</button></div><div class="ce-dialog-body" id="ceHistoryBody"><p class="ce-muted">Loading versions…</p></div>`);
  try{
   const r=await api('checklist-templates/'+encodeURIComponent(S.template.id)+'/versions');
   const body=dialog.querySelector('#ceHistoryBody');if(!body)return;
   body.innerHTML=`<ol class="ce-versions">${r.versions.map(v=>`<li><div><strong>Version ${esc(v.version)}</strong> <span class="ce-pill ${v.status==='published'?'ce-pill-published':'ce-pill-draft'}">${v.status==='published'?'Published':'Draft'}</span>${Number(v.version)===Number(r.current_version)?' <span class="ce-muted">· current</span>':''}</div><div class="ce-muted">${esc(v.item_count)} items${v.published_at?' · published '+esc(new Date(v.published_at).toLocaleString())+(v.published_by_name?' by '+esc(v.published_by_name):''):' · created '+esc(new Date(v.created_at).toLocaleString())}</div></li>`).join('')}</ol><p class="ce-muted">Field staff always use the newest published version.</p>`;
  }catch(error){const body=dialog.querySelector('#ceHistoryBody');if(body)body.innerHTML=`<p class="ce-error-text">${esc(error.message)}</p>`;}
 }
 function openPreviewDialog(){
  openDialog(`<div class="ce-dialog-head"><h2>Field app preview</h2><button type="button" class="ce-iconbtn" data-ce="dialog-close" aria-label="Close preview">${icon('x')}</button></div><div class="ce-dialog-body ce-preview-dialog-body"><div id="cePreviewDialogBody" class="ce-phone-host"></div><p class="ce-pv-cap">Updates as you type.</p></div>`);
  renderPreview();
 }
 function openPublish(){
  const d=diff(), pending=M.pendingLabelCount(S.items), draft=S.version.status!=='published';
  if(!draft&&!pending){notify('Everything is already published.');return;}
  const changes=[];
  if(d.hasPublished){
   if(d.edited.size)changes.push(`${d.edited.size} changed or new ${d.edited.size===1?'item':'items'}`);
   if(d.removed)changes.push(`${d.removed} removed ${d.removed===1?'item':'items'}`);
   if(!changes.length&&d.orderChanged)changes.push('a new item order');
  }
  openDialog(`<div class="ce-dialog-head"><h2>Publish this checklist?</h2><button type="button" class="ce-iconbtn" data-ce="dialog-close" aria-label="Close">${icon('x')}</button></div>
   <div class="ce-dialog-body"><p>Field staff will start using version ${esc(S.version.version)} of <strong>${esc(S.template.name)}</strong> on their next visit${changes.length?', with '+esc(changes.join(' and ')):''}.</p>
   ${pending?`<p class="ce-warn-text">${pending===1?'1 item has no label and will not be published.':pending+' items have no label and will not be published.'}</p>`:''}
   <div class="ce-error-text" id="cePublishError" hidden></div></div>
   <div class="ce-dialog-foot"><button type="button" class="ce-btn" data-ce="dialog-close">Cancel</button><button type="button" class="primary ce-btn" data-ce="confirm-publish">Publish version ${esc(S.version.version)}</button></div>`);
 }
 async function publish(button){
  button.disabled=true;
  try{
   await autosave.flush();
   await api('checklist-templates/'+encodeURIComponent(S.template.id)+'/publish',{});
   const fresh=await api('checklist-templates/'+encodeURIComponent(S.template.id)+'/items');
   const selKey=selectedItem()?.stable_key;
   S.template=fresh.template;S.version=fresh.version;S.published=fresh.published;
   S.items=M.fromApi(fresh.items).concat(S.items.filter(x=>!x.label.trim()));
   S.selected=(S.items.find(x=>x.stable_key===selKey)||(mqMobile.matches?null:S.items[0])||{}).uid||null;
   dialog.close();
   preserveFocus(()=>{renderHeader();renderList();renderInspector();renderTopState();renderStatus();});
   notify(`Version ${fresh.published?.version||''} published. Field staff will use it on their next visit.`);
   announce('Checklist published.');
  }catch(error){const el=dialog.querySelector('#cePublishError');if(el){el.hidden=false;el.textContent=error.message||'Publishing failed.';}button.disabled=false;}
 }

 // ---------- events ----------
 on(app,'click',e=>{
  const b=e.target.closest('[data-ce]');if(!b||!app.contains(b))return;
  const act=b.dataset.ce, id=b.dataset.id;
  if(b.getAttribute('aria-disabled')==='true'&&act!=='publish')return;
  switch(act){
   case 'back':return exit();
   case 'select':return select(id);
   case 'toggle-section':{S.collapsed.has(id)?S.collapsed.delete(id):S.collapsed.add(id);preserveFocus(()=>{renderList();renderHeader();});return;}
   case 'collapse-all':{const names=M.sectionNames(S.items), all=names.every(n=>S.collapsed.has(n));S.collapsed=all?new Set():new Set(names);preserveFocus(()=>{renderList();renderHeader();});return;}
   case 'add-item':return addItemTo(id);
   case 'add-section':return addSection();
   case 'duplicate':{const r=M.duplicateItem(S.items,id);return commit(r.items,{selected:r.uid,announceMsg:'Item duplicated.'});}
   case 'delete':return deleteItemUid(id);
   case 'close':{const uid=S.selected;S.selected=null;renderList();renderInspector();const row=sectionsEl.querySelector(`.ce-item[data-uid="${CSS.escape(uid||'')}"] .ce-item-body`);row?.focus();return;}
   case 'prev':return step(-1);
   case 'next':return step(1);
   case 'item-menu':return S.menu&&S.menu.trigger===b?closeMenu():itemMenu(id,b);
   case 'section-menu':return S.menu&&S.menu.trigger===b?closeMenu():sectionMenu(id,b);
   case 'type':{const item=selectedItem();if(!item||item.response_type===id)return;return commit(M.updateItem(S.items,item.uid,{response_type:id}));}
   case 'photo':{const item=selectedItem();if(!item||item.photo_rule===id)return;return commit(M.updateItem(S.items,item.uid,{photo_rule:id}));}
   case 'scope':{const item=selectedItem();if(!item||item.scope===id)return;S.advancedOpen=true;return commit(M.updateItem(S.items,item.uid,{scope:id}));}
   case 'switch':{const item=selectedItem();if(!item)return;return commit(M.updateItem(S.items,item.uid,{[id]:!item[id]}));}
   case 'undo':{if(!S.undo)return;const {snapshot,selected}=S.undo;S.undo=null;$('#ceSnackbar').hidden=true;return commit(snapshot,{selected,announceMsg:'Restored.'});}
   case 'dismiss-undo':{$('#ceSnackbar').hidden=true;S.undo=null;return;}
   case 'retry':return autosave.retry();
   case 'history':return openHistory();
   case 'preview':{
    if(mqPreview.matches){const col=root.querySelector('.ce-preview-col');col.scrollIntoView({block:'nearest',behavior:'smooth'});col.classList.remove('is-flash');void col.offsetWidth;col.classList.add('is-flash');return;}
    return openPreviewDialog();
   }
   case 'publish':return openPublish();
   case 'template-menu':return S.menu&&S.menu.trigger===b?closeMenu():templateMenu(b);
   case 'starter':return openStarter();
   case 'starter-pick':{if(!S.starter)return;S.starter.pick=id;S.starter.setType=((S.starterSets||[]).find(x=>M.starterKey(x)===id)?.visit_type)!==S.template.visit_type&&!S.items.length;renderStarter();dialog.querySelector('.ce-starter-card.is-on')?.focus();return;}
   case 'starter-mode':{if(!S.starter)return;S.starter.mode=id;renderStarter();dialog.querySelector(`[data-ce="starter-mode"][data-id="${id}"]`)?.focus();return;}
   case 'starter-confirm':return confirmStarter();
   case 'confirm-publish':return publish(b);
   case 'dialog-close':return dialog.close();
  }
 });
 on(dialog,'click',e=>{if(e.target===dialog)dialog.close();});
 on(app,'input',e=>{
  const t=e.target;
  if(t.matches('textarea[data-field]')){
   const item=selectedItem();if(!item)return;
   const field=t.dataset.field;
   const value=field==='options'||field==='room_types'?M.parseLines(t.value):t.value;
   S.items=M.updateItem(S.items,item.uid,{[field]:value});
   grow(t);
   autosave.schedule();
   if(field==='label'){
    const lbl=sectionsEl.querySelector(`[data-label-for="${CSS.escape(item.uid)}"]`);
    if(lbl){lbl.textContent=t.value.trim()||'Untitled item';lbl.classList.toggle('is-empty',!t.value.trim());}
    const c=root.querySelector('#ceLabelCount');if(c){c.textContent=t.value.length+' / '+M.LABEL_MAX;c.classList.toggle('ce-over',t.value.length>M.LABEL_MAX);}
   }
   if(field==='options'&&t.id==='ceOptions'){const strip=inspectorEl.querySelector('.ce-choices');if(strip)strip.innerHTML='<span class="ce-k">Tech can choose</span>'+M.answerChoices(item.response_type,value).map(c=>`<span class="ce-chip ce-chip-${c.tone}">${esc(c.label)}</span>`).join('');}
   updateRowMeta(item.uid);renderHeader();renderPreview();renderStatus();renderTopState();
  }
 });
 on(app,'change',e=>{
  const t=e.target;
  if(t.id==='ceName'){
   const name=t.value.trim();
   if(!name){t.value=S.template.name;notify('Template name is required.');return;}
   if(name!==S.template.name)saveDetails({name},{message:'Template renamed.'});
   return;
  }
  if(t.id==='ceVisitType'){
   if(t.value!==S.template.visit_type)saveDetails({visit_type:t.value},{message:'Visit type changed to '+M.visitType(t.value).label+'.'});
   return;
  }
  if(t.id==='ceStarterType'){if(S.starter)S.starter.setType=t.checked;return;}
  if(t.id==='ceSection'){
   const item=selectedItem();if(!item)return;
   if(t.value==='__new__'){
    const name=(window.prompt('Name the new section','')||'').trim();
    if(!name){t.value=item.section;return;}
    if(M.sectionNames(S.items).includes(name)){t.value=item.section;notify('A section with that name already exists.');return;}
    return commit(M.updateItem(S.items,item.uid,{section:name}),{announceMsg:'Moved to new section '+name+'.'});
   }
   return commit(M.updateItem(S.items,item.uid,{section:t.value}),{announceMsg:'Moved to '+t.value+'.'});
  }
 });
 on(app,'toggle',e=>{if(e.target.matches&&e.target.matches('.ce-advanced'))S.advancedOpen=e.target.open;},true);
 on(app,'keydown',e=>{
  const t=e.target;
  if(t.id==='ceName'){
   if(e.key==='Enter'){e.preventDefault();t.blur();}
   else if(e.key==='Escape'){e.preventDefault();t.value=S.template.name;t.blur();}
   return;
  }
  if(t.closest&&t.closest('[data-group="starter"]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
   const cards=[...dialog.querySelectorAll('.ce-starter-card')], i=cards.indexOf(t.closest('.ce-starter-card'));if(i<0)return;
   e.preventDefault();cards[(i+(e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:1)+cards.length)%cards.length].click();return;
  }
  if(t.matches&&t.matches('[data-ce-rename]')){
   if(e.key==='Enter'){e.preventDefault();t.dataset.done='1';commitRename(t);}
   else if(e.key==='Escape'){e.preventDefault();t.dataset.done='1';commitRename(t,true);}
   return;
  }
  // Roving arrow keys inside radio groups (answer tiles, photo cards, scope).
  const group=t.closest&&t.closest('[role="radiogroup"]');
  if(group&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
   const radios=[...inspectorEl.querySelectorAll(`[data-group="${group.dataset.group}"] [role="radio"]:not([disabled])`)], i=radios.indexOf(t);
   if(i<0)return;e.preventDefault();
   const next=radios[(i+(e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:1)+radios.length)%radios.length];
   next.click();
   const fk=next.dataset.fk;requestAnimationFrame(()=>root.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus());
   return;
  }
  if(t.matches&&t.matches('.ce-grip'))return gripKey(e,t);
 });
 on(app,'focusout',e=>{
  const t=e.target;
  if(t.matches&&t.matches('[data-ce-rename]')&&!t.dataset.done){t.dataset.done='1';commitRename(t);}
  if(t.matches&&t.matches('.ce-grip')&&S.lifted&&!(e.relatedTarget&&e.relatedTarget.matches&&e.relatedTarget.matches('.ce-grip'))){setTimeout(()=>{if(S.lifted&&!root.querySelector('.ce-grip:focus'))drop();},0);}
 });
 function updateRowMeta(uid){
  const item=S.items.find(x=>x.uid===uid), meta=sectionsEl.querySelector(`[data-meta-for="${CSS.escape(uid)}"]`);
  if(item&&meta)meta.innerHTML=chipsHTML(item,diff().edited.has(uid));
  const g=M.groupSections(S.items).find(x=>x.name===item?.section), sec=item&&sectionsEl.querySelector(`.ce-section[data-section="${CSS.escape(item.section)}"]`);
  if(g&&sec){const ph=sec.querySelector('.ce-photos');const count=M.sectionPhotoCount(g);if(ph)ph.innerHTML=count?icon('camera','ce-i-sm')+count+' with photos':'';}
 }

 // ---------- keyboard drag and drop ----------
 function gripKey(e,grip){
  const kind=grip.dataset.kind, id=grip.dataset.id;
  if(e.key===' '||e.key==='Enter'){
   e.preventDefault();
   if(S.lifted)return drop();
   S.lifted={type:kind,id};S.liftSnapshot=S.items;
   preserveFocus(()=>renderList());
   announce(`Picked up ${kind==='item'?'item':'section'} ${kind==='item'?(S.items.find(x=>x.uid===id)?.label||''):id}. Use the arrow keys to move it, Space to drop, Escape to cancel.`);
   return;
  }
  if(!S.lifted)return;
  if(e.key==='Escape'){e.preventDefault();S.items=S.liftSnapshot;S.lifted=null;S.liftSnapshot=null;preserveFocus(()=>{renderList();renderHeader();renderInspector();});announce('Move cancelled.');return;}
  if(e.key==='ArrowUp'||e.key==='ArrowDown'){
   e.preventDefault();const delta=e.key==='ArrowUp'?-1:1;
   if(S.lifted.type==='item'){
    S.items=M.moveItemBy(S.items,S.lifted.id,delta);
    const item=S.items.find(x=>x.uid===S.lifted.id);S.collapsed.delete(item.section);
    const g=M.groupSections(S.items).find(x=>x.name===item.section);
    preserveFocus(()=>{renderList();renderHeader();});
    announce(`Position ${g.items.findIndex(x=>x.uid===item.uid)+1} of ${g.items.length} in ${item.section}.`);
   }else{
    S.items=M.moveSectionBy(S.items,S.lifted.id,delta);
    const names=M.sectionNames(S.items);
    preserveFocus(()=>{renderList();renderHeader();});
    announce(`Section position ${names.indexOf(S.lifted.id)+1} of ${names.length}.`);
   }
   root.querySelector('.ce-grip:focus')?.scrollIntoView({block:'nearest'});
  }
 }
 function drop(){
  if(!S.lifted)return;
  const moved=S.items!==S.liftSnapshot;
  S.lifted=null;S.liftSnapshot=null;
  if(moved)commit(S.items,{announceMsg:'Dropped. New order saved.'});else{preserveFocus(()=>renderList());announce('Dropped.');}
 }

 // ---------- pointer drag and drop ----------
 const dropLine=$('#ceDropLine');
 let drag=null;
 on(app,'pointerdown',e=>{
  const grip=e.target.closest('.ce-grip');if(!grip||e.button!==0||S.lifted)return;
  drag={grip,kind:grip.dataset.kind,id:grip.dataset.id,x:e.clientX,y:e.clientY,active:false,pointerId:e.pointerId,target:null};
  grip.setPointerCapture(e.pointerId);
 });
 on(app,'pointermove',e=>{
  if(!drag||e.pointerId!==drag.pointerId)return;
  if(!drag.active){if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;drag.active=true;app.classList.add('is-dragging');const src=drag.kind==='item'?sectionsEl.querySelector(`.ce-item[data-uid="${CSS.escape(drag.id)}"]`):sectionsEl.querySelector(`.ce-section[data-section="${CSS.escape(drag.id)}"]`);src?.classList.add('is-drag-source');closeMenu();}
  e.preventDefault();
  drag.lastY=e.clientY;
  drag.target=drag.kind==='item'?itemDropTarget(e.clientY):sectionDropTarget(e.clientY);
  showDropLine(drag.target);
  autoScroll(e.clientY);
 });
 const endDrag=commitDrop=>e=>{
  if(!drag||e.pointerId!==drag.pointerId)return;
  const d=drag;drag=null;cancelAnimationFrame(scrollRaf);scrollRaf=0;
  dropLine.hidden=true;app.classList.remove('is-dragging');
  sectionsEl.querySelectorAll('.is-drag-source').forEach(x=>x.classList.remove('is-drag-source'));
  if(!d.active||!commitDrop||!d.target)return;
  if(d.kind==='item'){
   const before=S.items.map(x=>x.uid+x.section).join();
   const items=M.moveItem(S.items,d.id,d.target.section,d.target.index);
   if(items.map(x=>x.uid+x.section).join()!==before){S.collapsed.delete(d.target.section);commit(items,{announceMsg:'Item moved.'});}
  }else{
   const names=M.sectionNames(S.items), from=names.indexOf(d.id);
   let to=d.target.index;if(to>from)to--;
   if(to!==from)commit(M.moveSection(S.items,d.id,to),{announceMsg:'Section moved.'});
  }
 };
 on(app,'pointerup',endDrag(true));
 on(app,'pointercancel',endDrag(false));
 on(app,'lostpointercapture',e=>{if(drag&&e.pointerId===drag.pointerId)endDrag(true)(e);});
 function itemDropTarget(y){
  const cards=[...sectionsEl.querySelectorAll('.ce-section')];if(!cards.length)return null;
  let card=cards.find(c=>{const r=c.getBoundingClientRect();return y>=r.top&&y<=r.bottom;});
  if(!card)card=y<cards[0].getBoundingClientRect().top?cards[0]:cards.at(-1);
  const section=card.dataset.section;
  const rows=[...card.querySelectorAll('.ce-sec-body:not([hidden]) > .ce-item')].filter(r=>r.dataset.uid!==drag.id);
  if(card.classList.contains('is-collapsed')||!rows.length){const r=card.getBoundingClientRect();return {section,index:Infinity,y:card.classList.contains('is-collapsed')?r.bottom-2:(card.querySelector('.ce-add-item')||card).getBoundingClientRect().top,card};}
  let index=rows.findIndex(r=>{const b=r.getBoundingClientRect();return y<b.top+b.height/2;});
  if(index<0)index=rows.length;
  const ly=index<rows.length?rows[index].getBoundingClientRect().top:rows.at(-1).getBoundingClientRect().bottom;
  return {section,index,y:ly,card};
 }
 function sectionDropTarget(y){
  const cards=[...sectionsEl.querySelectorAll('.ce-section')];
  let index=cards.findIndex(c=>{const r=c.getBoundingClientRect();return y<r.top+r.height/2;});
  if(index<0)index=cards.length;
  const ly=index<cards.length?cards[index].getBoundingClientRect().top-6:cards.at(-1).getBoundingClientRect().bottom+6;
  return {index,y:ly};
 }
 function showDropLine(t){
  if(!t){dropLine.hidden=true;return;}
  const host=root.querySelector('.ce-canvas').getBoundingClientRect();
  dropLine.hidden=false;
  dropLine.style.top=(t.y-host.top)+'px';
 }
 let scrollRaf=0;
 function autoScroll(y){
  const edge=70, speed=y<edge?-(edge-y)/4:y>window.innerHeight-edge?(y-(window.innerHeight-edge))/4:0;
  cancelAnimationFrame(scrollRaf);scrollRaf=0;
  if(!speed||!drag)return;
  const tick=()=>{if(!drag)return;window.scrollBy(0,speed);drag.target=drag.kind==='item'?itemDropTarget(drag.lastY):sectionDropTarget(drag.lastY);showDropLine(drag.target);scrollRaf=requestAnimationFrame(tick);};
  scrollRaf=requestAnimationFrame(tick);
 }

 // ---------- responsive & lifecycle ----------
 const resizeObserver=typeof ResizeObserver!=='undefined'&&!supportsFieldSizing?new ResizeObserver(entries=>{for(const en of entries)if(en.target.isConnected)grow(en.target);}):null;
 const onMq=()=>{preserveFocus(()=>{placeInspector();growAll();});};
 mqMobile.addEventListener('change',onMq);cleanups.push(()=>mqMobile.removeEventListener('change',onMq));
 on(window,'resize',()=>growAll());
 if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>growAll()).catch(()=>{});
 const clock=setInterval(()=>{if(autosave.status==='saved'||autosave.status==='idle')renderStatus();},30000);cleanups.push(()=>clearInterval(clock));
 on(window,'beforeunload',e=>{if(autosave.busy||autosave.status==='error'){e.preventDefault();e.returnValue='';}});

 async function exit(){
  try{await autosave.flush();}
  catch{if(!window.confirm('Some changes could not be saved. Leave the editor anyway?'))return;}
  onExit();
 }
 function unmount(){cleanups.splice(0).forEach(fn=>{try{fn();}catch{}});resizeObserver?.disconnect();if(dialog.open)dialog.close();}

 renderTitle();renderHeader();renderList();renderInspector();renderTopState();renderStatus();
 window.scrollTo(0,0);
 return {unmount,flush:()=>autosave.flush(),get templateId(){return S.template.id;},get busy(){return autosave.busy;},state:S};
}
