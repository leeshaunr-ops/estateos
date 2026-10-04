/* Repeat-angle photo baselines (browser). Server: photo-spots.mjs, data in data.photoSpots.
   - Residence › Home records: "Photo spots" (name, room, optional checklist item) with the baseline photo and a dated
     timeline per spot; staff add and edit spots, take a new baseline or set any timeline photo as the baseline.
   - Visit (draft): a "Photo spots" panel. "Take photo" opens the camera (getUserMedia) with the baseline as a
     see-through overlay and an opacity slider; where the live camera is not available (some iPhones, permission
     denied) the phone's camera app opens through a file input and the overlay is shown on the preview instead.
     The photo is saved on the device first and uploads through the offline outbox, carrying the spot ID.
   - Visit report (submitted/published, also in the client portal): "Photo comparisons", baseline and this visit's
     photo side by side. The PDF and the storm report get the same pairs on the server.
   Offline: the spot list is kept in the device database and baseline photos in the Cache API, so the overlay works
   without signal for residences saved for offline use. No inline styles or scripts (CSP). */
const PS={cached:null,loading:false,saved:'',open:new Set(),stream:null,ghostUrl:null,shotUrl:null,shot:null,cacheKey:''};
const PS_CACHE='ea-photo-spots-v1';
const psData=()=>data?.photoSpots||null;
const psSpots=pid=>(psData()?.spots||[]).filter(s=>s.property_id===pid);
const psShots=spotId=>(psData()?.shots||[]).filter(s=>s.spot_id===spotId);
const psSpot=id=>(psData()?.spots||[]).find(s=>s.id===id)||null;
const psImg=fileId=>'/api/photo-spots/image/'+encodeURIComponent(fileId);
const psCanEdit=()=>!!psData()?.canEdit&&isStaff();
const psPlural=(n,one)=>`${n} ${n===1?one:one+'s'}`;
function psTaken(shot){return shot?.taken_label||(shot?.taken_day?fmtDay(shot.taken_day):'');}
function psDayOf(shot){return shot?.taken_day?fmtDay(shot.taken_day):'';}
function psThumb(fileId,alt,cls='ps-thumb'){return fileId?`<img class="${cls}" src="${esc(psImg(fileId))}" alt="${esc(alt)}" loading="lazy">`:`<div class="${cls} ps-thumb-empty" role="img" aria-label="${esc(alt)}"><span>No baseline yet</span></div>`;}

/* ---------- residence › Home records ---------- */
function psTimeline(spot){
 const shots=psShots(spot.id);
 if(!shots.length)return `<p class="res-empty">No photos yet. ${psCanEdit()?'Take a baseline photo to start the timeline.':''}</p>`;
 return `<ol class="ps-timeline" aria-label="${esc(spot.name)} photos, newest first">${shots.map(s=>{const isBase=s.file_id===spot.baseline_file_id,visit=s.inspection_id&&(data.inspections||[]).some(i=>i.id===s.inspection_id);
  return `<li class="ps-tl-item"><a href="${esc(psImg(s.file_id))}" target="_blank" rel="noopener">${psThumb(s.file_id,`${spot.name}, ${psDayOf(s)}`,'ps-tl-img')}</a><div class="ps-tl-meta"><strong>${esc(psDayOf(s)||'Date not recorded')}</strong>${isBase?'<span class="badge ps-base-badge">Baseline</span>':''}<small>${esc(s.kind==='baseline'?'Baseline photo':'Visit photo')}${s.taken_label?' · '+esc(s.taken_label.replace(/^.*?, \d{4}, /,'')):''}</small></div><div class="ps-tl-actions">${visit?btn('Open visit','inspection',s.inspection_id):''}${psCanEdit()&&!isBase?btn('Set as baseline','spot-baseline-set',spot.id+'|'+s.file_id):''}</div></li>`;}).join('')}</ol>`;
}
function psSpotCard(spot){
 const shots=psShots(spot.id),last=shots[0],open=PS.open.has(spot.id),staff=psCanEdit();
 const sub=[spot.location,spot.checklist_label?'Checklist: '+spot.checklist_label:''].filter(Boolean).join(' · ');
 const menu=staff?[btn('Edit spot','spot-edit',spot.id),btn(spot.baseline_file_id?'Take a new baseline':'Add baseline photo','spot-baseline-new',spot.id),psData()?.canArchive?btn('Archive spot','spot-archive',spot.id):''].join(''):'';
 return `<li class="ps-card"><div class="ps-card-main">${spot.baseline_file_id?`<a href="${esc(psImg(spot.baseline_file_id))}" target="_blank" rel="noopener">${psThumb(spot.baseline_file_id,'Baseline: '+spot.name)}</a>`:psThumb(null,'No baseline yet for '+spot.name)}<div class="ps-card-text"><h3>${esc(spot.name)}</h3>${sub?`<p class="ps-sub">${esc(sub)}</p>`:''}<p class="ps-sub">${spot.baseline_file_id?`Baseline ${esc(fmtDay(String(spot.baseline_set_at||'').slice(0,10))||'set')}`:'No baseline yet'} · ${esc(psPlural(spot.photo_count||0,'photo'))}${last?` · last ${esc(psDayOf(last))}`:''}</p>${spot.notes&&staff?`<p class="ps-note">${esc(spot.notes)}</p>`:''}</div></div><div class="ps-card-actions"><button type="button" data-action="spot-timeline" data-id="${esc(spot.id)}" aria-expanded="${open}">${open?'Hide timeline':'Timeline'}</button>${!spot.baseline_file_id&&staff?btn('Add baseline photo','spot-baseline-new',spot.id,true):''}${moreMenu(menu)}</div>${open?`<div class="ps-tl-wrap">${psTimeline(spot)}</div>`:''}</li>`;
}
function psSection(p){
 if(!psData()||data.user.role==='vendor')return '';
 const spots=psSpots(p.id),staff=psCanEdit();
 if(!spots.length&&!staff)return '';
 const lede='Fixed angles photographed on every visit, so changes over time are easy to see. The camera shows the baseline as a see-through overlay to line up the shot.';
 return `<section class="panel res-record ps-record" id="res-photo-spots"><div class="res-panel-head"><h2>Photo spots${spots.length?` <span class="ov-count">${spots.length}</span>`:''}</h2><div class="actions">${staff&&spots.length?btn('Add photo spot','spot-new',p.id):''}</div></div>${spots.length?`<p class="ps-lede">${esc(lede)}</p><ul class="ps-list">${spots.map(psSpotCard).join('')}</ul>`:empty('No photo spots yet',lede,btn('Add photo spot','spot-new',p.id,true))}</section>`;
}
const psBaseResidenceView=residenceView;
residenceView=function(...args){
 const html=psBaseResidenceView(...args);if(!psData()||tab!=='records')return html;
 const p=data.properties.find(x=>x.id===propertyId);if(!p)return html;
 const section=psSection(p);if(!section)return html;
 const at=html.indexOf('<section class="res-record" id="res-assets">');return at<0?html+section:html.slice(0,at)+section+html.slice(at);
};

/* ---------- visit ---------- */
function psLocalShots(i){const d=typeof offlineDraft==='function'?offlineDraft(i.id):null;const known=new Set((psData()?.shots||[]).map(s=>s.file_id));return (d?.photos||[]).filter(ph=>ph.spotId&&(!ph.fileId||!known.has(ph.fileId)));}
function psVisitShot(i,spot){
 const server=(psData()?.shots||[]).filter(s=>s.spot_id===spot.id&&s.inspection_id===i.id).sort((a,b)=>String(b.taken_at).localeCompare(String(a.taken_at)))[0];
 if(server)return {fileId:server.file_id,label:psTaken(server)};
 const local=psLocalShots(i).filter(ph=>ph.spotId===spot.id).pop();
 return local?(local.fileId?{fileId:null,localFile:local.fileId,opId:local.opId,label:'Uploaded'}:{opId:local.opId,label:'Saved on this device · uploads when online'}):null;
}
function psVisitPanel(i){
 const spots=psSpots(i.property_id);if(!spots.length)return '';
 const done=spots.filter(s=>psVisitShot(i,s)).length;
 return `<section class="ps-visit" id="ps-visit"><div class="ps-visit-head"><h2>Photo spots</h2><span class="badge${done===spots.length?'':' amber'}">${done} of ${spots.length} taken</span></div><p class="ps-lede">Photograph each spot from the same angle as its baseline. The camera shows the baseline over the live view.</p><ul class="ps-visit-list">${spots.map(s=>{const shot=psVisitShot(i,s);const img=shot?(shot.fileId?`<img class="ps-thumb" src="${esc(psImg(shot.fileId))}" alt="${esc(s.name)}, this visit">`:shot.opId?`<img class="ps-thumb" data-local-photo="${esc(shot.opId)}" alt="${esc(s.name)}, this visit">`:''):psThumb(s.baseline_file_id,'Baseline: '+s.name);
  return `<li class="ps-visit-row">${img}<div class="ps-card-text"><strong>${esc(s.name)}</strong><small>${esc([s.location,s.checklist_label?'Checklist: '+s.checklist_label:''].filter(Boolean).join(' · '))}</small><small class="${shot?'ps-ok':''}">${shot?esc('Taken · '+shot.label):s.baseline_file_id?'Not taken yet':'No baseline yet · this photo becomes the baseline'}</small></div><div class="ps-card-actions">${btn(shot?'Retake':'Take photo','spot-capture',i.id+'|'+s.id,!shot)}</div></li>`;}).join('')}</ul></section>`;
}
function psComparisons(i){
 const shots=(psData()?.shots||[]).filter(s=>s.inspection_id===i.id&&s.baseline_file_id&&s.baseline_file_id!==s.file_id);
 if(!shots.length)return '';
 const base=id=>(psData()?.shots||[]).find(s=>s.file_id===id);
 return `<section class="ps-compare" id="ps-compare"><h2>Photo comparisons</h2><p class="ps-lede">Each spot from the same angle: the baseline on the left, this visit on the right.</p>${shots.map(s=>{const spot=psSpot(s.spot_id),b=base(s.baseline_file_id);if(!spot)return '';
  return `<article class="ps-pair-card"><div class="ps-pair-head"><h3>${esc(spot.name)}</h3>${spot.location?`<small>${esc(spot.location)}</small>`:''}</div><div class="ps-pair"><figure><a href="${esc(psImg(s.baseline_file_id))}" target="_blank" rel="noopener"><img src="${esc(psImg(s.baseline_file_id))}" alt="${esc(spot.name)}: baseline${b?', '+psDayOf(b):''}" loading="lazy"></a><figcaption><strong>Baseline</strong>${b?' · '+esc(psDayOf(b)):''}</figcaption></figure><figure><a href="${esc(psImg(s.file_id))}" target="_blank" rel="noopener"><img src="${esc(psImg(s.file_id))}" alt="${esc(spot.name)}: this visit, ${esc(psDayOf(s))}" loading="lazy"></a><figcaption><strong>This visit</strong> · ${esc(psDayOf(s))}</figcaption></figure></div>${psCanEdit()&&spot.baseline_file_id!==s.file_id?`<div class="ps-pair-actions">${btn('Set as new baseline','spot-baseline-set',spot.id+'|'+s.file_id)}</div>`:spot.baseline_file_id===s.file_id?'<p class="ps-sub">This photo is now the baseline.</p>':''}</article>`;}).join('')}</section>`;
}
const psBaseInspectionView=inspectionView;
inspectionView=function(...args){
 const html=psBaseInspectionView(...args);if(!psData())return html;
 const i=data.inspections.find(x=>x.id===activeInspection);if(!i)return html;
 const draft=typeof offlineDraft==='function'?offlineDraft(i.id):null,status=draft&&draft.status!=='draft'&&i.status==='draft'?draft.status:i.status;
 const editing=status==='draft'&&isStaff()&&!draft?.completeQueued;
 const block=editing?psVisitPanel(i):psComparisons(i);if(!block)return html;
 const at=html.indexOf('<h2>Photo evidence</h2>');return at<0?html:html.slice(0,at)+block+html.slice(at);
};

/* ---------- camera with baseline overlay ---------- */
async function psImageBlob(url){
 try{const r=await fetch(url,{credentials:'same-origin'});if(r.ok){const blob=await r.blob();try{(await caches.open(PS_CACHE)).put(url,new Response(blob.slice(0),{headers:{'Content-Type':'image/jpeg'}}));}catch{}return blob;}}catch{}
 try{const hit=await (await caches.open(PS_CACHE)).match(url);if(hit)return await hit.blob();}catch{}
 return null;
}
function psStop(){if(PS.stream){for(const t of PS.stream.getTracks())t.stop();PS.stream=null;}for(const k of ['ghostUrl','shotUrl'])if(PS[k]){URL.revokeObjectURL(PS[k]);PS[k]=null;}PS.shot=null;}
function psSetOpacity(v){for(const g of document.querySelectorAll('#modal .ps-ghost'))g.style.opacity=String(Math.max(0,Math.min(100,Number(v)))/100);const out=$('ps-opacity-value');if(out)out.textContent=v+'%';}
/** mode: 'visit' (key "inspectionId|spotId") or 'baseline' (key spotId, online only). */
async function psCamera(mode,key){
 const [inspectionId,spotId]=mode==='visit'?String(key).split('|'):[null,key];
 const spot=psSpot(spotId);if(!spot)throw Error('Photo spot unavailable.');
 const i=inspectionId?data.inspections.find(x=>x.id===inspectionId):null;if(mode==='visit'&&!i)throw Error('Inspection unavailable.');
 if(mode==='baseline'&&data.offline)throw Error('Connect to the internet to set a new baseline.');
 psStop();
 const ghost=spot.baseline_file_id?await psImageBlob(psImg(spot.baseline_file_id)):null;
 if(ghost)PS.ghostUrl=URL.createObjectURL(ghost);
 const live=!!navigator.mediaDevices?.getUserMedia;
 const title=mode==='baseline'?`New baseline: ${spot.name}`:spot.name;
 $('modalBody').innerHTML=`<h2>${esc(title)}</h2><div id="formError" class="error" hidden></div>
 <p class="ps-hint" id="ps-help">${spot.location?esc(spot.location)+' · ':''}${PS.ghostUrl?'Line up the live view with the baseline, then take the photo.':spot.baseline_file_id?'The baseline photo is not saved on this device, so there is no overlay this time.':mode==='baseline'?'Take the photo that future visits will match.':'No baseline yet: this photo becomes the baseline.'}</p>
 <div class="ps-stage" id="ps-stage"><video id="ps-video" playsinline muted autoplay hidden></video><img id="ps-shot" alt="Photo just taken" hidden>${PS.ghostUrl?`<img class="ps-ghost" id="ps-ghost" src="${esc(PS.ghostUrl)}" alt="">`:''}<p class="ps-stage-msg" id="ps-stage-msg">${live?'Starting the camera…':'Use “Open camera” to take the photo.'}</p></div>
 ${PS.ghostUrl?`<div class="field full ps-slider"><label for="ps-opacity">Baseline overlay <span id="ps-opacity-value">50%</span></label><input id="ps-opacity" type="range" min="0" max="100" step="5" value="50"></div>`:''}
 <div class="dialog-footer ps-cam-actions">${btn('Cancel','close')}<label class="button ps-file-label${live?'':' primary'}" id="ps-file-label"><span id="ps-file-text">${live?'Use the camera app':'Open camera'}</span><input id="ps-file" class="ps-file" type="file" accept="image/*" capture="environment"></label><button type="button" class="primary" id="ps-take" ${live?'':'hidden'} disabled>Take photo</button><button type="button" id="ps-retake" hidden>Retake</button><button type="button" class="primary" id="ps-save" hidden>Save photo</button></div>`;
 const modal=$('modal');
 modal.addEventListener('close',psStop,{once:true});
 if(!modal.open)modal.showModal();
 psSetOpacity(50);
 $('ps-opacity')?.addEventListener('input',e=>psSetOpacity(e.target.value));
 const video=$('ps-video'),shotImg=$('ps-shot'),msg=$('ps-stage-msg'),take=$('ps-take'),retake=$('ps-retake'),save=$('ps-save'),fileLabel=$('ps-file-label');
 const showError=m=>{$('formError').hidden=false;$('formError').textContent=m;};
 const preview=blob=>{PS.shot=blob;if(PS.shotUrl)URL.revokeObjectURL(PS.shotUrl);PS.shotUrl=URL.createObjectURL(blob);shotImg.src=PS.shotUrl;shotImg.hidden=false;video.hidden=true;msg.hidden=true;take.hidden=true;fileLabel.hidden=true;retake.hidden=false;save.hidden=false;save.focus();};
 const startLive=async()=>{
  if(!live)return;
  try{PS.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1440}},audio:false});
   if(!modal.open){psStop();return;}
   video.srcObject=PS.stream;video.hidden=false;msg.hidden=true;await video.play().catch(()=>{});take.disabled=false;take.hidden=false;
  }catch(e){take.hidden=true;msg.hidden=false;msg.textContent='The live camera is not available here'+(e?.name==='NotAllowedError'?' (camera permission is off)':'')+'. Use “Open camera” instead; the baseline overlay shows on the preview.';$('ps-file-text').textContent='Open camera';fileLabel.classList.add('primary');}
 };
 take.onclick=()=>{if(!video.videoWidth)return;const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);c.toBlob(b=>{if(b){PS.capturedAt=new Date().toISOString();preview(b);if(PS.stream)for(const t of PS.stream.getTracks())t.enabled=false;}},'image/jpeg',.9);};
 retake.onclick=()=>{PS.shot=null;shotImg.hidden=true;save.hidden=true;retake.hidden=true;fileLabel.hidden=false;$('ps-file').value='';if(PS.stream){for(const t of PS.stream.getTracks())t.enabled=true;video.hidden=false;take.hidden=false;}else{msg.hidden=false;}};
 $('ps-file').onchange=e=>{const f=e.target.files?.[0];if(!f)return;if(!/^image\//.test(f.type||'image/jpeg')){showError('Choose a photo.');return;}PS.capturedAt=typeof offlineCaptureTime==='function'?offlineCaptureTime(f):new Date().toISOString();preview(f);};
 save.onclick=async()=>{if(!PS.shot)return;save.disabled=true;save.textContent='Saving…';try{
   if(mode==='visit')await psSaveVisitPhoto(i,spot,PS.shot,PS.capturedAt);else await psSaveBaseline(spot,PS.shot);
   modal.close();
  }catch(error){showError(error?.name==='QuotaExceededError'?'This device is out of storage. Free up space and try again.':error.message||'Could not save the photo.');}finally{save.disabled=false;save.textContent='Save photo';}};
 await startLive();
}
const psName=spot=>(spot.name||'spot').replace(/[^\w .-]/g,'').trim().slice(0,60).replace(/\s+/g,'-')||'spot';
async function psSaveVisitPhoto(i,spot,blob,capturedAt){
 await offlineFlushNow?.();
 const where=typeof visitPhotoPosition==='function'?await visitPhotoPosition():null;
 const small=await offlineCompressPhoto(blob),opId=offlineCore.uuid(),name=`${psName(spot)}-${(capturedAt||new Date().toISOString()).slice(0,10)}.jpg`,at=capturedAt||new Date().toISOString();
 await OFF.store.putBlob(opId,small);
 await offlineUpdateDraft(i.id,d=>{d.photos=[...(d.photos||[]),{opId,name,capturedAt:at,bytes:small.size,spotId:spot.id}];return d;},i);
 const fresh=where&&Math.abs(Date.parse(at)-Date.now())<=window.EAVisit.PHOTO_FRESH_MS;
 await offlineCore.enqueue(OFF.store,{opId,type:'upload_photo',inspectionId:i.id,payload:{propertyId:i.property_id,name,capturedAt:at,spotId:spot.id,...(fresh?{captureLatitude:where.lat,captureLongitude:where.lon,captureAccuracy:where.accuracy}:{})}});
 await offlineRefreshMirror();render();offlineRequestBackgroundSync?.();
 toast(offlineIsOnline()?`Photo of ${spot.name} saved. Uploading…`:`Photo of ${spot.name} saved on this device. It uploads when you're back online.`);
 offlineSync();
}
async function psSaveBaseline(spot,blob){
 const file=blob instanceof File?blob:new File([blob],'baseline.jpg',{type:'image/jpeg'});
 const base64=await jpeg(file);
 await api('files',{propertyId:spot.property_id,spotId:spot.id,name:`${psName(spot)}-baseline.jpg`,base64,capturedAt:PS.capturedAt||new Date().toISOString(),visibility:'internal'});
 toast(`New baseline saved for ${spot.name}.`);lastLoadAt=0;await load();
}

/* ---------- spot dialogs ---------- */
function psChecklistOptions(pid,current){
 const seen=new Map();
 const visits=(data.inspections||[]).filter(i=>i.property_id===pid).sort((a,b)=>String(b.inspection_date).localeCompare(String(a.inspection_date)));
 for(const v of visits.slice(0,3))for(const a of v.answers||[])if(a?.key&&a.label&&!seen.has(a.key))seen.set(a.key,(a.section?a.section+' · ':'')+a.label);
 if(current?.checklist_key&&!seen.has(current.checklist_key))seen.set(current.checklist_key,current.checklist_label||current.checklist_key);
 return `<option value="">None</option>`+[...seen].slice(0,200).map(([k,l])=>`<option value="${esc(k)}" ${current?.checklist_key===k?'selected':''}>${esc(l)}</option>`).join('');
}
function psEdit(pid,spot){
 dialog(spot?'Edit photo spot':'Add photo spot',`<p class="field full ps-hint">Pick an angle that shows something worth watching: under a sink, the water heater, a ceiling stain, the roofline from the drive.</p>${input('name','Spot name','text',spot?.name||'',true)}${input('location','Room or location','text',spot?.location||'',false)}${select('checklistKey','Checklist item (optional)',psChecklistOptions(pid,spot))}${textarea('notes','How to frame it (staff only)',spot?.notes||'')}`,spot?'Save':'Add spot',async(b,form)=>{
  const sel=form.querySelector('select[name="checklistKey"]'),label=b.checklistKey?sel.options[sel.selectedIndex]?.textContent||'':'';
  if(spot)await api('photo-spots/'+encodeURIComponent(spot.id),{name:b.name,location:b.location,checklistKey:b.checklistKey||null,checklistLabel:label,notes:b.notes,version:spot.version});
  else await api('photo-spots',{propertyId:pid,name:b.name,location:b.location,checklistKey:b.checklistKey||null,checklistLabel:label,notes:b.notes});
  toast(spot?'Photo spot saved.':'Photo spot added. Add a baseline photo next.');
 });
 const n=$('f-name');if(n)n.maxLength=80;const l=$('f-location');if(l)l.maxLength=80;
}

/* ---------- actions ---------- */
const psBaseAction=action;
action=async function(name,key,button){
 if(!String(name).startsWith('spot-'))return psBaseAction(name,key,button);
 try{
  switch(name){
   case 'spot-new':psEdit(key,null);return;
   case 'spot-edit':{const s=psSpot(key);if(s)psEdit(s.property_id,s);return;}
   case 'spot-timeline':if(PS.open.has(key))PS.open.delete(key);else PS.open.add(key);render();return;
   case 'spot-capture':return await psCamera('visit',key);
   case 'spot-baseline-new':return await psCamera('baseline',key);
   case 'spot-baseline-set':{const [spotId,fileId]=String(key).split('|');const s=psSpot(spotId);if(!s)return;if(!confirm(`Use this photo as the new baseline for ${s.name}? Future visits will line up with it. Earlier comparisons keep the baseline they were taken against.`))return;await api('photo-spots/'+encodeURIComponent(spotId)+'/baseline',{fileId});toast('New baseline set.');lastLoadAt=0;await load();return;}
   case 'spot-archive':{const s=psSpot(key);if(!s||!confirm(`Archive ${s.name}? It disappears from visits; its photos stay in the visit reports.`))return;await api('photo-spots/'+encodeURIComponent(key)+'/archive',{});toast('Photo spot archived.');lastLoadAt=0;await load();return;}
  }
 }catch(error){toast(error.message||'Something went wrong.');return;}
 return psBaseAction(name,key,button);
};

/* ---------- offline: keep the spot list on the device and the baselines in the Cache API ---------- */
if(typeof offlineData==='function'){const psBaseOfflineData=offlineData;offlineData=function(...args){const d=psBaseOfflineData(...args);if(d&&PS.cached)d.photoSpots=PS.cached;return d;};}
async function psPersist(){
 const d=psData();if(!d||data.offline||!isStaff()||!OFF?.store)return;
 const json=JSON.stringify(d);if(json!==PS.saved){PS.saved=json;PS.cached=d;try{await OFF.store.putMeta('photoSpots',d);}catch{}}
 const homes=new Set([...(OFF.snapshots?.keys?.()||[])]),urls=d.spots.filter(s=>s.baseline_file_id&&homes.has(s.property_id)).map(s=>psImg(s.baseline_file_id));
 const key=urls.join(',');if(!urls.length||key===PS.cacheKey||!('caches' in window))return;PS.cacheKey=key;
 try{const cache=await caches.open(PS_CACHE);for(const u of urls)if(!(await cache.match(u))){const r=await fetch(u,{credentials:'same-origin'});if(r.ok)await cache.put(u,r);}}catch{}
}
async function psRestore(){
 if(PS.loading||!OFF?.store)return;PS.loading=true;
 try{const d=await OFF.store.getMeta('photoSpots');if(d&&data?.offline&&!data.photoSpots){PS.cached=d;data.photoSpots=d;render();}}catch{}finally{PS.loading=false;}
}
const psBaseRender=render;
render=function(...args){
 const out=psBaseRender(...args);
 if(data?.user){if(data.offline&&!data.photoSpots)psRestore();else if(!data.offline)setTimeout(()=>psPersist(),0);}
 if(page==='inspection'&&typeof offlineHydrateThumbs==='function')offlineHydrateThumbs();
 return out;
};
if(typeof AUDIT_NOUN==='object')Object.assign(AUDIT_NOUN,{photo_spot:'Photo spot'});
