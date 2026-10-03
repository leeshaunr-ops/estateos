/* Offline mobile inspections (page side).
   Drafts, photos and the outbox live in IndexedDB (offline-store.js), one database per signed-in user, so work survives closing the tab,
   restarting the phone and losing signal. The sync engine (offline-core.js) replays the outbox in order with idempotency keys.
   This file replaces the old sessionStorage drafts; it keeps the function names live.js and proactive.js call. */
const OFF={pending:new Map(),rendered:new Map(),userId:null,store:null,engine:null,drafts:new Map(),outbox:[],snapshots:new Map(),workspace:null,thumbs:new Map(),reachable:navigator.onLine,state:{waiting:0,attention:0,conflicts:0,progress:{done:0,total:0},running:false,authRequired:false},lastPreload:0,installEvent:null,updateWorker:null,writeTimer:null,syncTimer:null};
const offlineCore=window.EAOfflineCore,offlineStoreApi=window.EAOfflineStore;
const OFFLINE_USER_KEY='estateaegis-offline-user';
const offlineHasIdb=()=>!!(window.indexedDB&&offlineStoreApi);
function draftKey(id){return 'estateaegis-draft:'+(data?.user?.id||OFF.userId)+':'+id;}

/* ---------- storage + mirror ---------- */
async function offlineOpen(userId){
 if(OFF.userId===userId&&OFF.store)return OFF.store;
 if(OFF.store?.close)OFF.store.close();
 OFF.userId=userId;OFF.drafts.clear();OFF.outbox=[];OFF.snapshots.clear();OFF.workspace=null;
 try{OFF.store=offlineHasIdb()?await offlineStoreApi.openUserStore(userId):offlineCore.memoryStore();}catch(error){console.warn('Offline storage unavailable',error);OFF.store=offlineCore.memoryStore();}
 OFF.engine=offlineCore.createSyncEngine({store:OFF.store,send:offlineSend,onChange:offlineOnEngineChange});
 await offlineRefreshMirror();return OFF.store;
}
async function offlineRefreshMirror(){
 if(!OFF.store)return;
 const [drafts,outbox,snapshots,workspace]=await Promise.all([OFF.store.getDrafts(),OFF.store.getOutbox(),OFF.store.getSnapshots(),OFF.store.getMeta('workspace')]);
 OFF.drafts=new Map(drafts.map(d=>[d.inspectionId,offlineOverlay(d)]));OFF.outbox=outbox;OFF.snapshots=new Map(snapshots.map(s=>[s.id,s]));OFF.workspace=workspace;
 OFF.state={...OFF.state,...offlineCore.summarize(outbox)};
}
async function offlineInit(){
 let userId=null;try{userId=localStorage.getItem(OFFLINE_USER_KEY);}catch{}
 if(userId)await offlineOpen(userId);
 offlineRegisterServiceWorker();
}
window.EAOffline={ready:offlineInit().catch(error=>console.warn('Offline init failed',error)),holdSession:()=>!!OFF.userId&&(!navigator.onLine||!OFF.reachable||OFF.outbox.length>0),state:()=>({...OFF.state,outbox:OFF.outbox.map(o=>({...o})),drafts:[...OFF.drafts.values()]}),sync:()=>offlineSync()};

/* ---------- network ---------- */
async function offlineSend(method,path,body,key){
 try{
  const headers={'Content-Type':'application/json'};if(key)headers['Idempotency-Key']=key;
  const response=await fetch(path,{method,credentials:'same-origin',headers,body:body===undefined?undefined:JSON.stringify(body)});
  let parsed={};try{parsed=await response.json();}catch{}
  offlineSetReachable(true);return {status:response.status,body:parsed};
 }catch{offlineSetReachable(false);return {status:0,body:{}};}
}
function offlineSetReachable(value){if(OFF.reachable===value)return;OFF.reachable=value;offlineUpdateUi();}
const offlineIsOnline=()=>navigator.onLine&&OFF.reachable;

/* ---------- sync ---------- */
async function offlineSync(){
 if(!OFF.engine)return;
 await offlineFlushing;const run=()=>OFF.engine.run();
 try{if(navigator.locks)await navigator.locks.request('estateaegis-outbox',run);else await run();}catch(error){console.warn('Sync failed',error);}
 await offlineRefreshMirror();offlineAfterSync();
}
function offlineScheduleSync(delay=1200){clearTimeout(OFF.syncTimer);OFF.syncTimer=setTimeout(()=>{if(navigator.onLine)offlineSync();},delay);}
function offlineRequestBackgroundSync(){if(navigator.serviceWorker?.ready)navigator.serviceWorker.ready.then(r=>r.sync?.register('estateaegis-outbox')).catch(()=>{});}
async function offlineOnEngineChange(state){OFF.state={...OFF.state,...state};try{OFF.outbox=await OFF.store.getOutbox();}catch{}offlineUpdateUi();}
/* Reflect synced drafts into the in-memory data so the screen updates without a reload. */
function offlineAfterSync(){
 if(!data)return;
 let changed=false;OFF.merged=OFF.merged||new Map();
 for(const d of OFF.drafts.values()){
  if(d.mergedAt&&OFF.merged.get(d.inspectionId)!==d.mergedAt){OFF.merged.set(d.inspectionId,d.mergedAt);if(d.inspectionId===activeInspection)changed=true;}
  const i=data.inspections.find(x=>x.id===d.inspectionId);if(!i)continue;
  if(i.version!==d.baseVersion&&d.baseVersion){i.version=d.baseVersion;changed=true;}
  if(d.status&&d.status!=='draft'&&i.status!==d.status){i.status=d.status;changed=true;}
  if(!d.localOnly&&i.localOnly){delete i.localOnly;changed=true;}
  if(d.base&&!OFF.outbox.some(o=>o.inspectionId===d.inspectionId)){i.answers=d.answers.map(a=>({...a}));i.summary=d.summary;i.notes=d.notes;i.internal_notes=d.internalNotes;}
  for(const ph of d.photos||[])if(ph.fileId&&!data.files.some(f=>f.id===ph.fileId)){data.files.push({id:ph.fileId,inspection_id:d.inspectionId,property_id:d.propertyId,name:ph.name,mime:'image/jpeg',captured_at:ph.capturedAt,created_at:ph.uploadedAt});changed=true;}
 }
 if(data.offline&&offlineIsOnline()&&!OFF.outbox.length){offlineLeaveOfflineMode();return;}
 const typing=document.activeElement&&document.activeElement.closest?.('.inspection-screen')&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
 if(changed&&!typing&&!$('modal').open&&['inspection','inspections','property'].includes(page))render();else offlineUpdateUi();
}
async function offlineLeaveOfflineMode(){try{lastLoadAt=0;await load();toast('Back online. Everything is synced.');}catch(error){offlineUpdateUi();}}
window.addEventListener('online',()=>{OFF.reachable=true;offlineUpdateUi();offlineSync();});
window.addEventListener('offline',()=>{offlineUpdateUi();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){if(navigator.onLine)offlineSync();}else offlineFlushNow();});
window.addEventListener('pagehide',()=>offlineFlushNow());
setInterval(async()=>{if(!OFF.engine||!navigator.onLine||!OFF.outbox.length||OFF.engine.running)return;const wake=await OFF.engine.nextWakeAt();if(wake!==null&&wake<=Date.now())offlineSync();else if(!OFF.reachable)offlineSync();},15000);
navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='SYNCED')offlineRefreshMirror().then(offlineAfterSync);});

/* ---------- drafts ----------
   Typing records only the fields that changed (field-level), and they are written with an atomic read-modify-write.
   So the sync engine can update base versions or merge server changes at the same time without either side losing data. */
function offlineDraft(id){return OFF.drafts.get(id)||null;}
function offlineNewDraft(i){return {inspectionId:i.id,userId:OFF.userId,propertyId:i.property_id,inspectionDate:i.inspection_date,baseVersion:i.version,base:offlineCore.content({answers:i.answers,summary:i.summary,notes:i.notes,internalNotes:i.internal_notes}),answers:i.answers.map(a=>({...a})),summary:i.summary||'',notes:i.notes||'',internalNotes:i.internal_notes||'',rev:0,dirty:false,status:'draft',photos:[],localOnly:!!i.localOnly,createdAt:new Date().toISOString()};}
function offlineApplyFields(d,fields){
 for(const [id,f] of fields){
  if(id.startsWith('answer:')){let a=d.answers.find(x=>x.key===f.key);if(!a){a={...f.template,status:'unchecked',note:''};d.answers.push(a);}a[f.field]=f.value;}
  else d[id]=f.value;
 }
 return d;
}
function offlineOverlay(d){const p=OFF.pending.get(d.inspectionId);if(!p)return d;const copy={...d,answers:d.answers.map(a=>({...a})),dirty:true};return offlineApplyFields(copy,p.fields);}
async function offlineUpdateDraft(id,fn,seed){
 const next=await OFF.store.updateDraft(id,cur=>fn(cur||(seed?offlineNewDraft(seed):null)));
 if(next)OFF.drafts.set(id,offlineOverlay(next));return next;
}
function offlineStorageError(error){const full=error?.name==='QuotaExceededError';draftStatus(full?'This device is out of storage. Free up space — unsynced work is still kept.':'Could not save on this device. Keep this screen open and reconnect.',true);}
function offlineNoteRendered(id,answers){OFF.rendered.set(id,answers);}
/** The stored value of an answer control. Template answers keep every type in `status` (see inspection-checklist.js): a blank box is "unchecked" and ticked choices are a JSON list. */
function offlineAnswerValue(el){
 if(el.dataset.answer===undefined)return el.value;
 if(el.dataset.answerMulti!==undefined){const picked=[...(el.closest('.ck-choices')||el.parentNode).querySelectorAll('input[data-answer-multi]:checked')].map(x=>x.value);return picked.length?JSON.stringify(picked):'unchecked';}
 if(el.type!=='radio'&&el.tagName!=='SELECT'&&String(el.value).trim()==='')return 'unchecked';
 return el.value;
}
function offlineFieldFor(el){
 if(el.dataset.answer!==undefined)return ['answer:'+el.dataset.answer+':status',{key:el.dataset.answer,field:'status'}];
 if(el.dataset.answerNote!==undefined)return ['answer:'+el.dataset.answerNote+':note',{key:el.dataset.answerNote,field:'note'}];
 const map={'f-summary':'summary','f-notes':'notes','f-internalNotes':'internalNotes'};return map[el.id]?[map[el.id],{}]:null;
}
/** Record one edited field on this device (instant in memory, persisted within 250 ms) and queue a save. */
function storeDraft(target){
 if(page!=='inspection'||!OFF.store)return null;
 const i=data.inspections.find(x=>x.id===activeInspection);if(!i)return null;
 const current=offlineDraft(i.id);if(current&&(current.completeQueued||current.status!=='draft'))return null;
 if(target){
  const field=offlineFieldFor(target);if(!field)return null;
  const [id,info]=field,pending=OFF.pending.get(i.id)||{seed:i,fields:new Map()};
  const template=info.key?(OFF.rendered.get(i.id)||i.answers).find(a=>a.key===info.key):null;
  pending.fields.set(id,{...info,value:offlineAnswerValue(target),template});OFF.pending.set(i.id,pending);
  const d=offlineOverlay(current||offlineNewDraft(i));OFF.drafts.set(i.id,d);
  clearTimeout(OFF.writeTimer);OFF.writeTimer=setTimeout(()=>offlineFlushNow(),250);
 }
 offlineRefreshItemBadges();draftStatus(offlineStatusText(i.id));return offlineDraft(i.id);
}
let offlineFlushing=Promise.resolve();
function offlineFlushNow(){
 clearTimeout(OFF.writeTimer);
 offlineFlushing=offlineFlushing.then(async()=>{
  const batch=[...OFF.pending.entries()];if(!batch.length)return;
  for(const [id,p] of batch){
   if(OFF.pending.get(id)===p)OFF.pending.delete(id);
   const next=await offlineUpdateDraft(id,d=>{if(!d)return null;offlineApplyFields(d,p.fields);d.rev=(d.rev||0)+1;d.dirty=true;d.updatedAt=new Date().toISOString();return d;},p.seed);
   if(next&&next.status==='draft'&&!next.conflict&&!next.completeQueued)await offlineCore.enqueue(OFF.store,{type:'save_draft',inspectionId:id});
  }
  OFF.outbox=await OFF.store.getOutbox();OFF.state={...OFF.state,...offlineCore.summarize(OFF.outbox)};offlineUpdateUi();offlineRequestBackgroundSync();
 }).catch(error=>{offlineStorageError(error);});
 return offlineFlushing;
}
function restoreDraft(){if(page!=='inspection')return;offlineRefreshItemBadges();offlineHydrateThumbs();}
/** Save now: write to the device, then sync this visit if there is signal. Throws if a connection is required and the save could not finish. */
async function syncInspectionDraft(options={}){
 await offlineFlushNow();
 const id=activeInspection;
 if(offlineIsOnline()||navigator.onLine)await offlineSync();
 const pending=OFF.outbox.filter(o=>o.inspectionId===id);
 if(options.requireSynced&&pending.length)throw Error(pending.some(o=>o.state==='conflict')?'This inspection changed on another device. Resolve the conflict first.':'Changes are still waiting to sync. Try again when you have signal.');
 return data.inspections.find(i=>i.id===id);
}
function clearInspectionDrafts(){clearTimeout(OFF.writeTimer);}
function draftStatus(message,error=false){const el=$('draft-status');if(el){el.querySelector('.draft-status-text').textContent=message;el.classList.toggle('error',error);}}
function offlineStatusText(id){
 const d=offlineDraft(id),ops=OFF.outbox.filter(o=>o.inspectionId===id);
 if(d?.conflict)return d.conflict.type==='locked'?'This visit was completed on another device. Your copy is kept on this device.':'Changed on another device — choose which version to keep.';
 if(ops.some(o=>o.state==='failed'))return 'Needs attention: '+(ops.find(o=>o.state==='failed').lastError||'a change could not sync.');
 if(d?.completeQueued)return offlineIsOnline()?'Submitting…':'Marked complete. Will submit when back online.';
 if(!offlineIsOnline())return 'Saved on this device. It will sync automatically when you\u2019re back online.';
 if(ops.length||d?.dirty)return OFF.state.running?'Syncing…':'Saved on this device. Syncing…';
 return 'All changes saved.';
}
function offlineDraftStatus(i){const d=offlineDraft(i.id);const problem=!!(d?.conflict||OFF.outbox.some(o=>o.inspectionId===i.id&&o.state==='failed'));return `<div id="draft-status" class="draft-status${problem?' error':''}" role="status" aria-live="polite"><span class="draft-status-text">${esc(offlineStatusText(i.id))}</span>${d?.conflict?btn(d.conflict.type==='locked'?'Review':'Resolve','sync-resolve',i.id):''}</div>`;}
function offlineRefreshItemBadges(){
 const id=activeInspection;const d=offlineDraft(id);const keys=d?offlineCore.unsyncedKeys(d):new Set();
 const ops=OFF.outbox.some(o=>o.inspectionId===id&&o.type==='save_draft')||d?.dirty;
 document.querySelectorAll('.inspection-screen [data-sync-key]').forEach(el=>el.classList.toggle('sync-pending',!!(ops&&keys.has(el.dataset.syncKey))));
}
document.addEventListener('input',e=>{if(!e.target.matches('[data-answer],[data-answer-note],#f-summary,#f-notes,#f-internalNotes')||page!=='inspection')return;storeDraft(e.target);offlineScheduleSync(1200);});
document.addEventListener('change',e=>{if(e.target.matches('[data-answer]')&&page==='inspection'){const row=e.target.closest('.inspection-item');if(row){
 // Template rows: tone from the answer type (Fail red, Monitor and No amber). Built-in rows: Monitor amber, Attention red.
 const tone=row.dataset.ckType?window.EAChecklist.tone({response_type:row.dataset.ckType,status:offlineAnswerValue(e.target),required:true}):e.target.value==='monitor'?'monitor':e.target.value==='attention'?'fail':'';
 row.classList.toggle('status-monitor',tone==='monitor');row.classList.toggle('status-attention',tone==='fail');
 const note=row.dataset.ckType&&row.querySelector('[data-answer-note]');if(note)note.placeholder=window.EAChecklist.notePrompt(row.dataset.ckType,offlineAnswerValue(e.target));}}});
window.addEventListener('beforeunload',()=>{if(OFF.pending.size)offlineFlushNow();});

/* ---------- photos ---------- */
function offlineInspectionPhotos(i){
 const server=(data.files||[]).filter(f=>f.inspection_id===i.id).map(f=>({fileId:f.id,name:f.name}));
 const d=offlineDraft(i.id),seen=new Set(server.map(p=>p.fileId));
 const local=(d?.photos||[]).filter(p=>!p.fileId||!seen.has(p.fileId)).map(p=>p.fileId?{fileId:p.fileId,name:p.name}:{opId:p.opId,name:p.name,failed:OFF.outbox.some(o=>o.opId===p.opId&&o.state==='failed')});
 return [...server,...local];
}
async function offlineHydrateThumbs(){
 for(const img of document.querySelectorAll('img[data-local-photo]')){
  const opId=img.dataset.localPhoto;let url=OFF.thumbs.get(opId);
  if(!url){const blob=await OFF.store?.getBlob(opId);if(!blob)continue;url=URL.createObjectURL(blob);OFF.thumbs.set(opId,url);}
  img.src=url;
 }
}
document.addEventListener('error',e=>{const img=e.target;if(img?.tagName==='IMG'&&img.closest('.photo-grid')&&!img.dataset.localPhoto&&!img.dataset.failed){img.dataset.failed='1';img.closest('a')?.classList.add('photo-unavailable');img.alt='Saved online — shows when connected';}},true);
async function offlineCompressPhoto(file){
 if(!/^image\//.test(file.type||'image/jpeg'))throw Error('Choose a photo.');
 if(file.size>25*1024*1024)throw Error('Choose a photo smaller than 25 MB.');
 let bitmap;try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{throw Error('This photo format is not supported. Choose a JPEG, PNG or WebP photo.');}
 const size=offlineCore.fitWithin(bitmap.width,bitmap.height,2048);
 const canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;canvas.getContext('2d').drawImage(bitmap,0,0,size.width,size.height);bitmap.close?.();
 return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Could not process this photo.')),'image/jpeg',0.8));
}
function offlineCaptureTime(file){const t=Number(file.lastModified);return Number.isFinite(t)&&t>Date.now()-365*86400000&&t<=Date.now()+60000?new Date(t).toISOString():new Date().toISOString();}
function offlinePhotoDialog(i){
 $('modalBody').innerHTML=`<h2>Add inspection photos</h2><div id="formError" class="error" hidden></div><form id="offlinePhotoForm" class="form"><div class="field full"><label for="offlinePhotos">Take or choose photos</label><input id="offlinePhotos" type="file" accept="image/*" multiple required></div><p class="muted full">Photos are resized on this phone and saved here first. They upload automatically when there is signal.</p><div class="dialog-footer">${btn('Cancel','close')}<button class="primary" type="submit">Save photos</button></div></form>`;
 $('offlinePhotoForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{
  const files=[...$('offlinePhotos').files];if(!files.length)throw Error('Choose at least one photo.');if(files.length>20)throw Error('Add at most 20 photos at a time.');
  // Visit verification: one position for this batch, kept only on photos taken in the last 10 minutes (no prompt here).
  const where=typeof visitPhotoPosition==='function'?await visitPhotoPosition():null;
  for(const [n,file] of files.entries()){
   button.textContent=`Saving ${n+1} of ${files.length}…`;
   const blob=await offlineCompressPhoto(file),capturedAt=offlineCaptureTime(file),opId=offlineCore.uuid();
   const name=(file.name||'photo').replace(/\.[^.]+$/,'').replace(/[^\w .-]/g,'').slice(0,80)+'.jpg';
   await OFF.store.putBlob(opId,blob);                       // bytes first, so a queued upload always has its photo
   await offlineUpdateDraft(i.id,d=>{d.photos=[...(d.photos||[]),{opId,name,capturedAt,bytes:blob.size}];return d;},i);
   const fresh=where&&(!capturedAt||Math.abs(Date.parse(capturedAt)-Date.now())<=window.EAVisit.PHOTO_FRESH_MS);
   await offlineCore.enqueue(OFF.store,{opId,type:'upload_photo',inspectionId:i.id,payload:{propertyId:i.property_id,name,capturedAt,...(fresh?{captureLatitude:where.lat,captureLongitude:where.lon,captureAccuracy:where.accuracy}:{})}});
  }
  await offlineRefreshMirror();$('modal').close();render();offlineRequestBackgroundSync();
  toast(offlineIsOnline()?`${files.length} photo${files.length===1?'':'s'} saved. Uploading…`:`${files.length} photo${files.length===1?'':'s'} saved on this device. They will upload when you're back online.`);
  offlineSync();
 }catch(error){$('formError').hidden=false;$('formError').textContent=error?.name==='QuotaExceededError'?'This device is out of storage. Free up space and try again.':error.message;}finally{button.disabled=false;button.textContent='Save photos';}};
 $('modal').showModal();
}

/* ---------- complete / submit ---------- */
/* Same rules as the server (inspection-checklist.js): built-in visits need every item; template visits need their Required items, and a failed "photo required on fail" item needs a photo on the visit. */
function offlineCompletionProblems(d,i){
 return window.EAChecklist.completionProblems(d.answers,{summary:d.summary,photoCount:i?offlineInspectionPhotos(i).length:null});
}
async function offlineComplete(i){
 await offlineFlushNow();const d=offlineDraft(i.id)||offlineNewDraft(i);
 const problems=offlineCompletionProblems(d,i);
 if(problems.length){$('modalBody').innerHTML=`<h2>Almost done</h2><p>Finish these before marking the inspection complete:</p><ul>${problems.map(p=>`<li>${esc(p)}</li>`).join('')}</ul><div class="dialog-footer">${btn('Keep editing','close','',true)}</div>`;$('modal').showModal();return;}
 const admin=data.user.role==='admin';
 $('modalBody').innerHTML=`<h2>Mark inspection complete?</h2><form id="offlineCompleteForm" class="form"><p class="full">${offlineIsOnline()?'The inspection is submitted for review now.':'You are offline. It is saved on this device and <strong>will submit when you are back online</strong>.'} You can’t edit it after this.</p>${admin?'<label class="check-row full"><input type="checkbox" name="autoPublish"> Publish automatically when synced (sends the report to the family)</label>':'<p class="muted full">An admin publishes the report after review.</p>'}<div class="dialog-footer">${btn('Cancel','close')}<button class="primary" type="submit">Mark complete</button></div></form>`;
 $('offlineCompleteForm').onsubmit=async e=>{e.preventDefault();const autoPublish=admin&&e.target.autoPublish?.checked;
  if(typeof visitAutoCheckOut==='function')await visitAutoCheckOut(i);   // visit verification: check out (automatic) before submitting
  const next=await offlineUpdateDraft(i.id,x=>Object.assign(x,{completeQueued:true,autoPublish:!!autoPublish}),i);
  if(next.dirty)await offlineCore.enqueue(OFF.store,{type:'save_draft',inspectionId:i.id});
  await offlineCore.enqueue(OFF.store,{type:'complete_inspection',inspectionId:i.id,payload:{autoPublish:!!autoPublish}});
  await offlineRefreshMirror();$('modal').close();render();offlineRequestBackgroundSync();
  toast(offlineIsOnline()?'Submitting inspection…':'Will submit when back online.');offlineSync();};
 $('modal').showModal();
}

/* ---------- offline snapshot (pre-download) ---------- */
async function offlineDownload(propertyIds,{quiet=false}={}){
 if(!OFF.store||!isStaff())return;
 const ids=[...new Set(propertyIds.filter(Boolean))];if(!ids.length){if(!quiet)toast('Choose at least one residence.');return;}
 const r=await offlineSend('GET','/api/offline/visits?propertyIds='+encodeURIComponent(ids.join(',')));
 if(r.status!==200){if(!quiet)toast(r.status===0?'You are offline. Connect to download residences.':(r.body.error||'Could not download for offline use.'));return;}
 const s=r.body,savedAt=new Date().toISOString();
 await OFF.store.putMeta('workspace',{user:s.user,company:s.company,companyLogo:s.companyLogo,template:s.template,checklist:{source:s.checklist.source,template_id:s.checklist.template_id,template_version:s.checklist.template_version},checklists:s.checklists||[],visitVerification:s.visitVerification||null,savedAt});
 for(const p of s.properties)await OFF.store.putSnapshot({id:p.id,property:p,inspections:s.inspections.filter(i=>i.property_id===p.id),files:s.files.filter(f=>f.property_id===p.id),savedAt});
 try{await navigator.storage?.persist?.();}catch{}
 await offlineRefreshMirror();
 if(!quiet){toast(`${s.properties.length} residence${s.properties.length===1?'':'s'} available offline.`);render();}else offlineUpdateUi();
}
async function offlineAutoPreload(){
 if(!data||data.offline||!isStaff()||!OFF.store)return;
 const soon=new Date(Date.now()+86400000).toLocaleDateString('en-CA');
 const ids=new Set([...OFF.snapshots.keys()].filter(id=>data.properties.some(p=>p.id===id)));
 for(const i of data.inspections)if(i.status==='draft'&&i.inspection_date<=soon)ids.add(i.property_id);
 if(page==='inspection'){const i=data.inspections.find(x=>x.id===activeInspection);if(i)ids.add(i.property_id);}
 const key=[...ids].sort().join(',');if(!ids.size||(key===OFF.lastPreloadKey&&Date.now()-OFF.lastPreload<120000))return;   // refresh at most every 2 minutes unless the set of visits changed
 OFF.lastPreload=Date.now();OFF.lastPreloadKey=key;
 await offlineDownload([...ids].slice(0,100),{quiet:true}).catch(()=>{});
}
function offlineAvailabilityBadge(propertyId){const s=OFF.snapshots.get(propertyId);if(!s||!isStaff())return '';return `<span class="badge offline-ready" title="Saved on this device">✓ Available offline · updated ${esc(new Date(s.savedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))}</span>`;}
function offlineDownloadButton(ids,text='Make available offline',action='offline-download'){return isStaff()&&!data.offline?`<button data-action="${action}" data-id="${esc(ids.join(','))}">${esc(text)}</button>`:'';}
function offlineDisplayStatus(i){const d=offlineDraft(i.id);return d&&d.status&&d.status!=='draft'&&i.status==='draft'?d.status:i.status;}
function offlineRowBadges(i){if(!isStaff())return '';const ops=OFF.outbox.filter(o=>o.inspectionId===i.id),d=offlineDraft(i.id);let out='';if(ops.some(o=>o.state==='failed'||o.state==='conflict'))out+='<span class="badge red sync-badge">⚠ Needs attention</span>';else if(ops.length)out+=`<span class="badge amber sync-badge">↻ ${ops.length} waiting to sync</span>`;if(d?.completeQueued)out+='<span class="badge amber">Will submit when online</span>';if(i.status==='draft'&&OFF.snapshots.has(i.property_id))out+='<span class="badge offline-ready">✓ Offline</span>';return out;}
let offlinePriorCache={source:null,map:new Map()};
function offlinePriorAnswer(i,key){
 if(offlineDisplayStatus(i)!=='draft')return null;
 if(offlinePriorCache.source!==data.inspections){offlinePriorCache={source:data.inspections,map:new Map()};}
 if(!offlinePriorCache.map.has(i.id)){const prev=data.inspections.filter(x=>x.property_id===i.property_id&&x.status==='published'&&x.id!==i.id).sort((a,b)=>(b.inspection_date||'').localeCompare(a.inspection_date||''))[0];offlinePriorCache.map.set(i.id,new Map((prev?.answers||[]).filter(a=>['monitor','attention','fail'].includes(a.status)).map(a=>[a.key,a])));}
 return offlinePriorCache.map.get(i.id).get(key)||null;
}

/* ---------- offline boot (no signal when the app opens) ---------- */
function offlineData(){
 const ws=OFF.workspace;if(!ws)return null;
 const snaps=[...OFF.snapshots.values()];
 return {offline:true,user:{...ws.user,platformOwner:false,platformAccess:false},company:ws.company,companyLogo:ws.companyLogo,workspaceLogo:ws.companyLogo,template:ws.template,checklist:ws.checklist,checklists:ws.checklists||[],visitVerification:ws.visitVerification||null,properties:snaps.map(s=>s.property),inspections:snaps.flatMap(s=>s.inspections),files:snaps.flatMap(s=>s.files),archivedProperties:[],invitations:[],clients:[],vendors:[],users:[],assets:[],asset_inspections:[],work:[],requests:[],shopping:[],arrivals:[],maintenance:[],notes:[],invoices:[],audit:[],notifications:[],unreadMessages:0,demo:null,messaging:{threads:[],messages:[]},operations:{followups:[],approvals:[],plans:[],email:[],automation:{}},security:{enabled:false},staff:{assignments:[],profiles:[],schedules:[]},checklistTemplates:{templates:[]}};
}
async function offlineBoot(error){
 if(error&&error.status)return false;                 // the server answered: a real error, not "no signal"
 if(!OFF.userId)return false;
 await offlineRefreshMirror();const next=offlineData();if(!next)return false;
 const wasOffline=!!data?.offline;OFF.reachable=false;data=next;
 if(wasOffline){offlineMergeLocal();if(page==='inspection'&&!data.inspections.some(i=>i.id===activeInspection))page='inspections';render();return true;}   // already offline: keep the screen the user is on
 offlineMergeLocal();   // visits started on this device (e.g. just now from Start inspection) are part of the offline view
 if(page==='inspection'&&data.inspections.some(i=>i.id===activeInspection)){render();toast('You are offline. Inspections saved on this device are available.');return true;}   // keep the visit the user is on
 try{const saved=JSON.parse(localStorage.getItem('estateos:last-view')||'null');if(saved?.page==='inspection'&&(!saved.userId||saved.userId===OFF.userId)&&data.inspections.some(i=>i.id===saved.activeInspection)){page='inspection';activeInspection=saved.activeInspection;}else page='inspections';}catch{page='inspections';}
 render();toast('You are offline. Inspections saved on this device are available.');return true;
}
/* Merge visits started offline (not on the server yet) into the data the views read. */
function offlineMergeLocal(){
 if(!data||!isStaff())return;
 for(const d of OFF.drafts.values()){
  if(data.inspections.some(i=>i.id===d.inspectionId))continue;
  if(!d.localOnly&&!OFF.outbox.some(o=>o.inspectionId===d.inspectionId))continue;
  if(!data.properties.some(p=>p.id===d.propertyId))continue;
  data.inspections.push({id:d.inspectionId,property_id:d.propertyId,inspector_id:OFF.userId,inspector_name:data.user.name,inspection_date:d.inspectionDate,status:'draft',answers:d.answers.map(a=>({...a})),summary:d.summary,notes:d.notes,internal_notes:d.internalNotes,version:d.baseVersion||1,frequency:'One-time',next_due:'',localOnly:!!d.localOnly,created_at:d.createdAt,visit_type:d.visitType||'routine',checklist:d.checklist||null,template_id:d.checklist?.template_id||null,template_version:d.checklist?.template_version??null});
 }
}
/* Start a visit on this device. The chosen published checklist comes from the offline copy (items included), so the
   visit is filled against that exact version; the server creates it with the same version when the device syncs. */
async function offlineStartLocal(propertyId,date,{templateId='built-in',visitType='routine'}={}){
 const ws=OFF.workspace,template=data.template||ws?.template,lists=data.checklists||ws?.checklists||[];
 let snap=null,type=visitType||'routine';
 if(templateId&&templateId!=='built-in'){const c=lists.find(x=>x.template_id===templateId);if(!c||!Array.isArray(c.items))throw Error('This checklist is not saved on this device. Connect and use “Make available offline” first.');snap={template_id:c.template_id,template_version_id:c.template_version_id,template_version:c.template_version,name:c.name,visit_type:c.visit_type,published_at:c.published_at||null,items:c.items};type=c.visit_type;}
 if(!snap&&!template)throw Error('Download this residence while online first.');
 const id=offlineCore.uuid(),answers=snap?window.EAChecklist.propertyAnswers(snap):template.map(a=>({...a}));
 const d={inspectionId:id,userId:OFF.userId,propertyId,inspectionDate:date,baseVersion:1,base:offlineCore.content({answers,summary:'',notes:'',internalNotes:''}),answers,summary:'',notes:'',internalNotes:'',rev:0,dirty:false,status:'draft',photos:[],localOnly:true,createdAt:new Date().toISOString(),visitType:type,checklist:snap};
 await OFF.store.putDraft(d);await offlineCore.enqueue(OFF.store,{type:'start_inspection',inspectionId:id,payload:{propertyId,date,visitType:type,templateId:snap?snap.template_id:'built-in',...(snap?{templateVersionId:snap.template_version_id}:{})}});
 await offlineRefreshMirror();offlineMergeLocal();activeInspection=id;page='inspection';render();offlineRequestBackgroundSync();offlineSync();
 toast(offlineIsOnline()?'Inspection started.':'Inspection started on this device. It will sync when you are back online.');
}
function offlineOnlyView(){
 const visits=data.inspections.filter(i=>['draft','submitted'].includes(offlineDisplayStatus(i)));
 return head('Offline mode','You are offline. These visits are saved on this device.',btn('Start inspection','new-inspection','',true))+`<div class="panel"><p class="muted">Other pages need a connection. Everything you do here syncs automatically when you’re back online.</p>${inspectionRows(visits)}</div>`;
}

/* ---------- logout / wipe ---------- */
async function offlineWipe(){
 const userId=OFF.userId;if(!userId)return;
 for(const url of OFF.thumbs.values())URL.revokeObjectURL(url);OFF.thumbs.clear();
 try{OFF.store?.close?.();}catch{}OFF.store=null;OFF.engine=null;OFF.userId=null;OFF.drafts.clear();OFF.pending.clear();OFF.outbox=[];OFF.snapshots.clear();OFF.workspace=null;
 try{localStorage.removeItem(OFFLINE_USER_KEY);}catch{}
 for(const key of Object.keys(sessionStorage))if(key.startsWith('estateaegis-draft:'))sessionStorage.removeItem(key);
 if(offlineHasIdb()){await offlineStoreApi.deleteUserStore(userId).catch(()=>{});await offlineStoreApi.setCurrentUser(null).catch(()=>{});}
}

/* ---------- UI: banner, indicator, panel, conflicts ---------- */
function offlineIndicatorHtml(){
 const st=OFF.state,online=offlineIsOnline();let icon='✓',text='Online · all saved',tone='ok';
 if(st.authRequired){icon='!';text='Sign in to finish syncing';tone='attention';}
 else if(st.attention){icon='!';text=`Needs attention (${st.attention})`;tone='attention';}
 else if(!online){icon='⦸';text=st.waiting?`Offline · ${st.waiting} change${st.waiting===1?'':'s'} waiting`:'Offline · saved on this device';tone='offline';}
 else if(st.running&&st.progress.total){icon='↻';text=`Syncing ${Math.min(st.progress.done+1,st.progress.total)} of ${st.progress.total}…`;tone='syncing';}
 else if(st.waiting){icon='↻';text=`${st.waiting} change${st.waiting===1?'':'s'} waiting to sync`;tone='syncing';}
 return `<button type="button" id="syncIndicator" class="sync-indicator ${tone}" data-action="sync-panel" aria-label="Sync status: ${esc(text)}. Open sync details."><span aria-hidden="true">${icon}</span> <span>${esc(text)}</span></button>`;
}
function offlineUpdateUi(){
 if(!data||!document.querySelector('.shell'))return;
 if(isStaff()){
  const top=document.querySelector('.topbar');let live=$('syncStatusLive');
  if(top&&!live){top.insertAdjacentHTML('beforeend','<div id="syncStatusLive" class="sync-status-live" aria-live="polite"></div>');live=$('syncStatusLive');}
  if(live){const html=offlineIndicatorHtml();if(live.innerHTML!==html)live.innerHTML=html;}
 }
 const main=document.querySelector('.shell main');let banner=$('offlineBanner');const offline=!offlineIsOnline();
 if(main&&offline&&!banner){main.querySelector('.topbar')?.insertAdjacentHTML('afterend','<div id="offlineBanner" class="offline-banner" role="status"></div>');banner=$('offlineBanner');}
 if(banner){if(!offline)banner.remove();else{const t=`<strong>You’re offline.</strong> ${isStaff()?'Keep working — inspections and photos are saved on this device and sync when you’re back online.':'Reconnect to see the latest updates.'}`;if(banner.innerHTML!==t)banner.innerHTML=t;}}
 if(page==='inspection'){const id=activeInspection;const el=$('draft-status');if(el){const d=offlineDraft(id);const problem=!!(d?.conflict||OFF.outbox.some(o=>o.inspectionId===id&&o.state==='failed'));el.classList.toggle('error',problem);const t=el.querySelector('.draft-status-text');const msg=offlineStatusText(id);if(t&&t.textContent!==msg)t.textContent=msg;if(d?.conflict&&!el.querySelector('[data-action="sync-resolve"]'))el.insertAdjacentHTML('beforeend',btn(d.conflict.type==='locked'?'Review':'Resolve','sync-resolve',id));}offlineRefreshItemBadges();}
 offlineUpdateInstallBanner();
}
const OP_LABELS={start_inspection:'Start inspection',save_draft:'Checklist & notes',upload_photo:'Photo',complete_inspection:'Submit inspection',visit_check_in:'Check in',visit_check_out:'Check out'};
function offlinePanel(){
 const rows=OFF.outbox.map(o=>{const i=data.inspections.find(x=>x.id===o.inspectionId);const online=offlineIsOnline();const when=online&&o.state==='pending'&&o.nextAttemptAt>Date.now()?'Retrying '+new Date(o.nextAttemptAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}):'';const status=o.state==='conflict'?'Conflict':o.state==='failed'?'Needs attention':online?'Waiting to sync':'Waiting for signal';
  return `<div class="row sync-row"><div><strong>${esc(OP_LABELS[o.type]||o.type)}${o.type==='upload_photo'?' · '+esc(o.payload?.name||''):''}</strong><div class="muted">${esc(i?propertyName(i.property_id)+' · '+i.inspection_date:'Inspection')} · ${esc(status)}${when?' · '+esc(when):''}</div>${o.lastError&&(o.state!=='pending'||online)?`<div class="sync-error">${esc(o.lastError)}</div>`:''}</div><div class="actions">${o.state==='conflict'?btn('Resolve','sync-resolve',o.inspectionId,true):''}${o.state==='failed'?btn('Retry now','sync-retry',o.opId,true)+btn('Discard','sync-discard',o.opId):''}${i?btn('Open','inspection',i.id):''}</div></div>`;}).join('');
 $('modalBody').innerHTML=`<h2>Sync</h2><p class="muted" role="status">${esc(offlineIndicatorHtml().replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim())}</p>${OFF.state.authRequired?`<div class="notice">Your session ended. Sign in again to finish syncing — your changes stay on this device. <a class="button" href="/login">Sign in</a></div>`:''}${rows||empty('Everything is synced.')}<div class="dialog-footer">${btn('Close','close')}${OFF.outbox.length?btn('Retry all now','sync-retry-all','',true):''}</div>`;
 if(!$('modal').open)$('modal').showModal();
}
function offlineConflictDialog(id){
 const d=offlineDraft(id);if(!d?.conflict)return toast('No conflict to resolve.');
 if(d.conflict.type==='locked'){$('modalBody').innerHTML=`<h2>Completed on another device</h2><p>This inspection is already <strong>${esc(d.conflict.serverStatus)}</strong>, so your local changes can’t be applied. Download your copy to keep your notes, then discard it from this device.</p><div class="dialog-footer">${btn('Close','close')}${btn('Download device copy','draft-export',id)}${btn('Discard my copy','sync-discard-draft',id)}</div>`;$('modal').showModal();return;}
 const show=(c,v)=>c.field==='status'?(v==='na'?'Not applicable':label(v||'unchecked')):(v||'(empty)');
 const rows=d.conflict.conflicts.map((c,n)=>`<fieldset class="conflict-row"><legend>${esc(c.section?c.section+' · ':'')}${esc(c.label)}${c.field==='note'?' — note':''}</legend><label class="check-row"><input type="radio" name="c${n}" value="local" checked> <span><b>Your version</b><br>${esc(show(c,c.local))}</span></label><label class="check-row"><input type="radio" name="c${n}" value="server"> <span><b>Server version</b><br>${esc(show(c,c.server))}</span></label></fieldset>`).join('');
 $('modalBody').innerHTML=`<h2>Choose which version to keep</h2><p class="muted">Someone changed this inspection on another device. Other changes were merged automatically. Your copy is safe until you choose.</p><form id="conflictForm" class="form conflict-form">${rows}<div class="dialog-footer">${btn('Cancel','close')}<button type="button" data-conflict-all="server">Use all server</button><button type="button" data-conflict-all="local">Keep all mine</button><button class="primary" type="submit">Save choices</button></div></form>`;
 const form=$('conflictForm');form.querySelectorAll('[data-conflict-all]').forEach(b=>b.onclick=()=>form.querySelectorAll(`input[value="${b.dataset.conflictAll}"]`).forEach(r=>r.checked=true));
 form.onsubmit=async e=>{e.preventDefault();const choices={};let mine=0,theirs=0;d.conflict.conflicts.forEach((c,n)=>{const v=form.querySelector(`input[name="c${n}"]:checked`).value;choices[c.id]=v;v==='server'?theirs++:mine++;});
  const merged=offlineCore.applyResolution({merged:d.conflict.merged,conflicts:d.conflict.conflicts},choices);
  const conflict=d.conflict;await offlineUpdateDraft(id,x=>Object.assign(x,merged,{base:offlineCore.content(conflict.server),baseVersion:conflict.serverVersion,conflict:null,rev:(x.rev||0)+1,dirty:true}));
  for(const op of await OFF.store.getOutbox())if(op.inspectionId===id&&op.state==='conflict'){op.state='pending';op.body=null;op.attempts=0;op.lastError='';op.nextAttemptAt=0;op.payload={...op.payload,conflictResolution:`kept ${mine} of mine, ${theirs} from server`};await OFF.store.putOp(op);}
  await offlineRefreshMirror();$('modal').close();render();toast('Choices saved. Syncing…');offlineSync();};
 $('modal').showModal();
}
async function offlineDiscardOp(opId){
 const op=OFF.outbox.find(o=>o.opId===opId);if(!op)return;
 const msg=op.type==='start_inspection'?'Discard this inspection and everything queued for it? This can’t be undone.':op.type==='upload_photo'?'Discard this photo from the device? It will not be uploaded.':'Discard this queued change from the device?';
 if(!confirm(msg))return;
 const ops=op.type==='start_inspection'?OFF.outbox.filter(o=>o.inspectionId===op.inspectionId):[op];
 for(const o of ops){await OFF.store.deleteOp(o.opId);if(o.type==='upload_photo')await OFF.store.deleteBlob(o.opId);}
 const d=offlineDraft(op.inspectionId);
 if(d){if(op.type==='start_inspection')await OFF.store.deleteDraft(d.inspectionId);else await offlineUpdateDraft(d.inspectionId,x=>{if(op.type==='upload_photo')x.photos=(x.photos||[]).filter(p=>p.opId!==op.opId);if(op.type==='complete_inspection')x.completeQueued=false;return x;});}
 if(op.type==='visit_check_in'||op.type==='visit_check_out'){const k='visit:'+op.inspectionId,m=await OFF.store.getMeta(k);if(m&&m.local){delete m.local[op.type==='visit_check_in'?'check_in':'check_out'];await OFF.store.putMeta(k,m);}}
 await offlineRefreshMirror();if(op.type==='start_inspection'){data.inspections=data.inspections.filter(i=>i.id!==op.inspectionId);if(activeInspection===op.inspectionId){activeInspection=null;page='inspections';}}
}
async function offlineDiscardDraft(id){
 for(const o of OFF.outbox.filter(o=>o.inspectionId===id&&o.type!=='upload_photo'&&o.type!=='start_inspection'))await OFF.store.deleteOp(o.opId);
 OFF.pending.delete(id);await OFF.store.deleteDraft(id);await offlineRefreshMirror();
}
/** Forget everything on this device for an inspection (after it was deleted on the server). */
async function offlineForget(id){OFF.pending.delete(id);for(const o of OFF.outbox.filter(o=>o.inspectionId===id)){await OFF.store.deleteOp(o.opId);if(o.type==='upload_photo')await OFF.store.deleteBlob(o.opId);}await OFF.store.deleteDraft(id);await offlineRefreshMirror();}
function offlineExportDraft(id){const d=offlineDraft(id);if(!d)throw Error('No device copy for this inspection.');const {_persistedRev,...copy}=d;const url=URL.createObjectURL(new Blob([JSON.stringify(copy,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='inspection-device-copy.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

/* ---------- install prompt + offline data in My profile ---------- */
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();OFF.installEvent=e;offlineUpdateInstallBanner();});
window.addEventListener('appinstalled',()=>{OFF.installEvent=null;try{localStorage.setItem('estateaegis-install-dismissed','1');}catch{}offlineUpdateInstallBanner();});
const offlineIsIos=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)&&!window.MSStream;
const offlineStandalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
function offlineUpdateInstallBanner(){
 const existing=$('installBanner');let dismissed=false;try{dismissed=localStorage.getItem('estateaegis-install-dismissed')==='1';}catch{}
 const show=data&&isStaff()&&!offlineStandalone()&&!dismissed&&matchMedia('(max-width: 820px)').matches&&(OFF.installEvent||offlineIsIos())&&page!=='inspection';
 if(!show){existing?.remove();return;}if(existing)return;
 document.querySelector('.shell main .content')?.insertAdjacentHTML('afterbegin',`<div id="installBanner" class="install-banner" role="region" aria-label="Install the app"><span>${OFF.installEvent?'Install EstateAegis on this phone for one-tap, offline inspections.':'Install EstateAegis: tap <b>Share</b>, then <b>Add to Home Screen</b>.'}</span><span class="actions">${OFF.installEvent?btn('Install app','install-app','',true):''}${btn('Not now','install-dismiss')}</span></div>`);
}
async function offlineProfilePanel(){
 const est=await navigator.storage?.estimate?.().catch(()=>null);const persisted=await navigator.storage?.persisted?.().catch(()=>false);
 const el=$('offlineDataPanel');if(!el)return;
 const mb=n=>(n/1048576).toFixed(n>10485760?0:1)+' MB';const photos=[...OFF.drafts.values()].reduce((n,d)=>n+(d.photos||[]).filter(p=>!p.fileId).length,0);
 el.querySelector('.offline-data-body').innerHTML=`<p><strong>${OFF.snapshots.size}</strong> residence${OFF.snapshots.size===1?'':'s'} available offline · <strong>${OFF.outbox.length}</strong> change${OFF.outbox.length===1?'':'s'} waiting to sync · <strong>${photos}</strong> photo${photos===1?'':'s'} on this device</p>${est?`<p class="muted">Using ${mb(est.usage||0)} of about ${mb(est.quota||0)} available to EstateAegis on this device${persisted?' · protected from automatic cleanup':''}.</p>`:''}`;
}
const baseProfileView=profileView;
profileView=function(){
 let html=baseProfileView();if(!isStaff()||data.offline)return html;
 const install=offlineStandalone()?'<p>EstateAegis is installed on this device.</p>':OFF.installEvent?`<p>Install the app for one-tap access and offline inspections.</p>${btn('Install app','install-app','',true)}`:offlineIsIos()?'<p>On iPhone or iPad: open this page in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>':'<p class="muted">Use your browser menu’s “Install app” or “Add to Home screen” option.</p>';
 setTimeout(offlineProfilePanel,0);
 return html+`<div class="two"><section class="panel"><h2>Install app</h2>${install}</section><section class="panel" id="offlineDataPanel"><h2>Offline data</h2><div class="offline-data-body"><p class="muted">Checking this device…</p></div>${btn('Clear offline data','offline-clear')}</section></div>`;
};

/* ---------- service worker + updates ---------- */
function offlineRegisterServiceWorker(){
 if(!('serviceWorker' in navigator)||!(location.protocol==='https:'||['localhost','127.0.0.1'].includes(location.hostname)))return;
 navigator.serviceWorker.register('/sw.js',{scope:'/'}).then(reg=>{
  const watch=worker=>{if(!worker)return;const check=()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){OFF.updateWorker=worker;offlineShowUpdate();}};worker.addEventListener('statechange',check);check();};
  watch(reg.waiting);reg.addEventListener('updatefound',()=>watch(reg.installing));
  setInterval(()=>reg.update().catch(()=>{}),60*60*1000);
 }).catch(error=>console.warn('Service worker registration failed',error));
 let reloading=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(OFF.updateRequested&&!reloading){reloading=true;location.reload();}});
}
function offlineShowUpdate(){
 if($('updateBanner'))return;
 document.body.insertAdjacentHTML('beforeend',`<div id="updateBanner" class="update-banner" role="status"><span>A new version of EstateAegis is available.</span>${btn('Reload','app-update','',true)}${btn('Later','app-update-later')}</div>`);
}

/* ---------- actions ---------- */
const offlineBaseAction=action;
action=async function(name,key,button){
 const inspectionFor=id=>data.inspections.find(i=>i.id===(id||activeInspection));
 if(name==='inspection'){const r=await offlineBaseAction(name,key,button);const i=inspectionFor(key);if(i&&i.status==='draft'&&isStaff()&&!data.offline&&!OFF.snapshots.has(i.property_id))offlineDownload([i.property_id],{quiet:true}).catch(()=>{});return r;}
 if(name==='inspection-save'){await offlineFlushNow();if(navigator.onLine)await offlineSync();const pending=OFF.outbox.filter(o=>o.inspectionId===activeInspection);toast(!pending.length?'All changes saved.':offlineIsOnline()&&!pending.some(o=>o.state!=='pending')?'Saved on this device. Syncing…':!offlineIsOnline()?'Saved on this device. It will sync automatically when you’re back online.':'Saved on this device. Some changes need attention — open Sync.');render();return;}
 if(name==='inspection-photo'){await offlineFlushNow();const i=inspectionFor(key);if(!i)throw Error('Inspection unavailable.');return offlinePhotoDialog(i);}
 if(name==='inspection-complete'){const i=inspectionFor(key);if(!i)throw Error('Inspection unavailable.');return offlineComplete(i);}
 if(name==='inspection-publish'){if(!offlineIsOnline()&&!navigator.onLine)throw Error('Publishing needs a connection. Use Mark complete — it submits when you’re back online.');await syncInspectionDraft({requireSynced:true});const r=await offlineBaseAction(name,key,button);if(inspectionFor(key)?.status!=='published'){lastLoadAt=0;await load();}return r;}
 if(name==='inspection-reopen'){const i=inspectionFor(key);await api('inspections/reopen',{id:key,version:i.version});const d=offlineDraft(key);if(d&&!OFF.outbox.some(o=>o.inspectionId===key)){await OFF.store.deleteDraft(key);await offlineRefreshMirror();}lastLoadAt=0;await load();toast('Returned to draft.');return;}
 if(name==='inspection-delete'&&inspectionFor(key)?.localOnly){if(!confirm('Delete this inspection from the device? It was never synced.'))return;const start=OFF.outbox.find(o=>o.inspectionId===key&&o.type==='start_inspection');if(start){for(const o of OFF.outbox.filter(o=>o.inspectionId===key)){await OFF.store.deleteOp(o.opId);if(o.type==='upload_photo')await OFF.store.deleteBlob(o.opId);}}await OFF.store.deleteDraft(key);await offlineRefreshMirror();data.inspections=data.inspections.filter(i=>i.id!==key);activeInspection=null;page='inspections';render();return;}
 if(name==='new-inspection'&&(data.offline||!offlineIsOnline())){
  const homes=data.properties.filter(p=>OFF.snapshots.has(p.id));if(!homes.length)throw Error('No residences are saved on this device. Connect and use “Make available offline” first.');
  return dialog('Start inspection (offline)',select('propertyId','Residence',option(homes,'id','name',key||propertyId))+input('date','Inspection date','date',today())+checklistPicker()+'<p class="muted full">It is saved on this device and created on the server when you’re back online.</p>','Start',async b=>{await offlineStartLocal(b.propertyId,b.date,{templateId:b.templateId,visitType:b.visitType});});
 }
 if(name==='offline-download'){return offlineDownload(String(key||'').split(','));}
 if(name==='offline-download-route'){return offlineDownload([...document.querySelectorAll('.route-stop:checked')].map(el=>el.value));}
 if(name==='sync-panel')return offlinePanel();
 if(name==='sync-retry'){await OFF.engine.retry(key);await offlineRefreshMirror();offlineAfterSync();return offlinePanel();}
 if(name==='sync-retry-all'){await offlineSync();OFF.engine.retryAll().then(()=>offlineRefreshMirror()).then(offlineAfterSync);return offlinePanel();}
 if(name==='sync-discard'){await offlineDiscardOp(key);render();return offlinePanel();}
 if(name==='sync-discard-draft'){if(!confirm('Discard your device copy of this inspection?'))return;await offlineDiscardDraft(key);$('modal').close();render();return;}
 if(name==='sync-resolve')return offlineConflictDialog(key);
 if(name==='install-app'){if(OFF.installEvent){OFF.installEvent.prompt();await OFF.installEvent.userChoice.catch(()=>{});OFF.installEvent=null;}offlineUpdateInstallBanner();return;}
 if(name==='install-dismiss'){try{localStorage.setItem('estateaegis-install-dismissed','1');}catch{}offlineUpdateInstallBanner();return;}
 if(name==='app-update'){await offlineFlushNow();OFF.updateRequested=true;OFF.updateWorker?.postMessage({type:'SKIP_WAITING'});return;}
 if(name==='app-update-later'){$('updateBanner')?.remove();return;}
 if(name==='offline-clear'){const n=OFF.outbox.length;if(!confirm(n?`${n} change${n===1?' has':'s have'} not synced yet. Clearing deletes ${n===1?'it':'them'} from this device for good. Clear anyway?`:'Remove residences, drafts and photos saved on this device?'))return;const userId=OFF.userId;await offlineWipe();if(userId){await offlineOpen(userId);try{localStorage.setItem(OFFLINE_USER_KEY,userId);}catch{}}toast('Offline data cleared.');render();return;}
 if(name==='logout'){
  const n=OFF.outbox.length;
  if(n&&!confirm(`${n} change${n===1?' has':'s have'} not synced yet. Signing out deletes ${n===1?'it':'them'} from this device. Sign out anyway?`))return;
  if(!offlineIsOnline()&&!navigator.onLine)throw Error('Connect to sign out. Your work is saved on this device.');
  await offlineWipe();return offlineBaseAction(name,key,button);
 }
 if(name==='navigate'&&data.offline&&!['inspections','dashboard'].includes(key)){toast('That page needs a connection.');page='inspections';render();return;}
 return offlineBaseAction(name,key,button);
};

/* ---------- hooks into load / render / view ---------- */
const offlineBaseLoad=load;
load=async function(...args){
 let result;
 try{result=await offlineBaseLoad(...args);}
 catch(error){if(!error.status&&OFF.userId&&isStaffUser(OFF.workspace?.user)&&await offlineBoot(error))return data;throw error;}
 if(data?.user){await offlineAfterLoad();}
 return result;
};
function isStaffUser(u){return !!u&&['admin','employee'].includes(u.role);}
async function offlineAfterLoad(){
 const user=data.user;OFF.reachable=true;
 if(OFF.userId!==user.id){await offlineOpen(user.id);}
 try{localStorage.setItem(OFFLINE_USER_KEY,user.id);}catch{}
 if(offlineHasIdb())offlineStoreApi.setCurrentUser(user.id).catch(()=>{});
 if(!['admin','employee'].includes(user.role)){offlineUpdateUi();return;}
 // One-time move of old sessionStorage drafts into IndexedDB.
 const legacy=offlineCore.parseLegacyDrafts(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]),user.id);
 for(const l of legacy){const i=data.inspections.find(x=>x.id===l.inspectionId);if(i&&i.status==='draft'&&!OFF.drafts.has(i.id)){const d=offlineNewDraft(i);Object.assign(d,{answers:l.answers,summary:l.summary,notes:l.notes,internalNotes:l.internalNotes,baseVersion:l.baseVersion,base:l.baseVersion===i.version?d.base:null,rev:1,dirty:true});await OFF.store.putDraft(d);await offlineCore.enqueue(OFF.store,{type:'save_draft',inspectionId:i.id});}sessionStorage.removeItem(l.legacyKey);}
 // Drop clean device copies the server has caught up with.
 for(const d of [...OFF.drafts.values()]){
  if(OFF.outbox.some(o=>o.inspectionId===d.inspectionId)||d.conflict||OFF.pending.has(d.inspectionId))continue;
  const i=data.inspections.find(x=>x.id===d.inspectionId);
  if(i?(i.status!=='draft'||(!d.dirty&&d.baseVersion===i.version&&!(d.photos||[]).some(p=>!p.fileId))):!d.dirty&&!d.localOnly){await OFF.store.deleteDraft(d.inspectionId);for(const p of d.photos||[]){const u=OFF.thumbs.get(p.opId);if(u){URL.revokeObjectURL(u);OFF.thumbs.delete(p.opId);}}}
 }
 await offlineRefreshMirror();offlineMergeLocal();
 if(legacy.length||OFF.outbox.length||OFF.drafts.size)render();else offlineUpdateUi();
 if(OFF.outbox.length)offlineSync();
 offlineAutoPreload();
}
const offlineBaseRender=render;
render=function(...args){if(data)offlineMergeLocal();const r=offlineBaseRender(...args);offlineUpdateUi();if(page==='inspection')offlineHydrateThumbs();return r;};
const offlineBaseView=view;
view=function(...args){if(data?.offline&&!['inspection'].includes(page))return offlineOnlyView();return offlineBaseView(...args);};
