/* EstateAegis offline core: outbox, sync engine and merge logic for offline inspections.
   Pure logic with injected storage and network so it runs in the page, the service worker (Background Sync) and Node unit tests.
   Exposed as globalThis.EAOfflineCore. */
(function(root){
 'use strict';
 const MAX_BACKOFF_MS=5*60*1000,BASE_BACKOFF_MS=2000,PARALLEL_INSPECTIONS=3;
 const TYPES=['start_inspection','save_draft','upload_photo','complete_inspection'];

 function uuid(){
  if(root.crypto?.randomUUID)return root.crypto.randomUUID();
  const b=new Uint8Array(16);root.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
 }
 /** Exponential backoff: 2 s, 4 s, 8 s … capped at 5 minutes. `random` (0..1) adds up to 20% jitter. */
 function backoffMs(attempts,random=0){const n=Math.max(1,attempts);const base=Math.min(MAX_BACKOFF_MS,BASE_BACKOFF_MS*2**(n-1));return Math.min(MAX_BACKOFF_MS,Math.round(base*(1+0.2*random)));}
 /** Map an HTTP outcome to what the outbox should do next. status 0 = network failure. */
 function classify(status,body){
  if(status>=200&&status<300)return 'ok';
  if(status===0||status===408||status===425||status===429||status>=500)return 'retry';
  if(status===401)return 'auth';
  if(status===409)return 'conflict';
  return 'fatal';
 }
 /** Scale so the longest edge is at most `max` pixels (never upscales). */
 function fitWithin(width,height,max=2048){const scale=Math.min(1,max/Math.max(width,height));return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};}

 /** The parts of a draft the server stores. */
 function content(source){
  if(!source)return null;
  const answers={};for(const a of source.answers||[])answers[a.key]={status:a.status,note:a.note||''};
  return {answers,summary:source.summary||'',notes:source.notes||'',internalNotes:source.internalNotes??source.internal_notes??''};
 }
 function sameContent(a,b){return JSON.stringify(normalized(a))===JSON.stringify(normalized(b));}
 function normalized(c){if(!c)return null;return {answers:Object.keys(c.answers).sort().map(k=>[k,c.answers[k].status,c.answers[k].note||'']),summary:c.summary,notes:c.notes,internalNotes:c.internalNotes};}
 /** Keys of answers whose local value differs from the last synced copy (drives "Not synced" badges). */
 function unsyncedKeys(draft){
  const base=draft?.base?.answers;const keys=new Set();if(!draft)return keys;
  for(const a of draft.answers||[]){const b=base?.[a.key];if(!b||b.status!==a.status||(b.note||'')!==(a.note||''))keys.add(a.key);}
  for(const f of ['summary','notes','internalNotes'])if(!draft.base||(draft.base[f]||'')!==(draft[f]||''))keys.add(f);
  return keys;
 }
 /** Three-way merge of local edits and server changes against the last synced base.
     Non-overlapping changes merge automatically; a field changed differently on both sides becomes a conflict (never silently overwritten). */
 function threeWayMerge(base,localDraft,serverInspection){
  const local=content(localDraft),server=content(serverInspection),conflicts=[];
  const pick=(id,b,l,s,meta)=>{if(l===undefined)return s;if(s===undefined)return l;if(l===s)return l;if(base&&l===b)return s;if(base&&s===b)return l;conflicts.push({id,local:l,server:s,...meta});return l;};
  const byKey=new Map();for(const a of serverInspection.answers||[])byKey.set(a.key,{...a});
  for(const a of localDraft.answers||[])if(!byKey.has(a.key))byKey.set(a.key,{...a});
  const localAnswers=new Map((localDraft.answers||[]).map(a=>[a.key,a]));
  const answers=[...byKey.values()].map(a=>{
   const l=local.answers[a.key],s=server.answers[a.key],b=base?.answers?.[a.key];const meta={key:a.key,label:a.label||localAnswers.get(a.key)?.label||a.key,section:a.section||''};
   return {...(localAnswers.get(a.key)||{}),...a,status:pick('answer:'+a.key+':status',b?.status,l?.status,s?.status,{...meta,field:'status'}),note:pick('answer:'+a.key+':note',b?.note??'',l?.note,s?.note,{...meta,field:'note'})};
  });
  const text={};for(const [f,title] of [['summary','Inspection summary'],['notes','Notes to the client'],['internalNotes','Internal notes']])text[f]=pick(f,base?.[f],local[f],server[f],{field:f,label:title});
  return {merged:{answers,...text},conflicts};
 }
 /** Apply the user's per-item choices ('local' | 'server') to a merge result. */
 function applyResolution(mergeResult,choices){
  const merged={...mergeResult.merged,answers:mergeResult.merged.answers.map(a=>({...a}))};
  for(const c of mergeResult.conflicts){
   const value=(choices[c.id]||'local')==='server'?c.server:c.local;
   if(c.id.startsWith('answer:')){const a=merged.answers.find(x=>x.key===c.key);if(a)a[c.field]=value;}else merged[c.field]=value;
  }
  return merged;
 }
 /** Old drafts lived in sessionStorage under estateaegis-draft:<userId>:<inspectionId>. */
 function parseLegacyDrafts(entries,userId){
  const prefix='estateaegis-draft:'+userId+':',out=[];
  for(const [key,raw] of entries){if(!key.startsWith(prefix))continue;try{const d=JSON.parse(raw);if(d&&d.id&&Array.isArray(d.answers))out.push({inspectionId:d.id,baseVersion:Number(d.version)||1,answers:d.answers,summary:d.summary||'',notes:d.notes||'',internalNotes:d.internalNotes||'',legacyKey:key});}catch{}}
  return out;
 }

 /** Add an operation. Unsent saves coalesce (they read the latest draft when sent), so typing never floods the queue. */
 async function enqueue(store,op){
  if(!TYPES.includes(op.type))throw Error('Unknown offline operation.');
  const outbox=await store.getOutbox();
  if(op.type==='save_draft'&&outbox.some(o=>o.type==='save_draft'&&o.inspectionId===op.inspectionId&&o.state==='pending'&&!o.body))return null;
  const seq=outbox.reduce((m,o)=>Math.max(m,o.seq||0),0)+1;
  const full={opId:op.opId||uuid(),seq,type:op.type,inspectionId:op.inspectionId,payload:op.payload||{},createdAt:op.createdAt||new Date().toISOString(),attempts:0,state:'pending',lastError:'',nextAttemptAt:0,body:null};
  await store.putOp(full);return full;
 }
 /** Which ops may run now: the head op of each inspection (strict per-visit order), at most 3 visits at once. */
 function runnable(outbox,now=Date.now(),limit=PARALLEL_INSPECTIONS){
  const heads=new Map();for(const op of [...outbox].sort((a,b)=>a.seq-b.seq))if(!heads.has(op.inspectionId))heads.set(op.inspectionId,op);
  return [...heads.values()].filter(op=>op.state==='pending'&&(op.nextAttemptAt||0)<=now).slice(0,limit);
 }
 function summarize(outbox){
  const waiting=outbox.length,attention=outbox.filter(o=>o.state==='failed'||o.state==='conflict').length;
  return {waiting,attention,conflicts:outbox.filter(o=>o.state==='conflict').length};
 }
 async function toBase64(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
  return root.btoa(binary);
 }

 /** The sync engine. `send(method,path,body,idempotencyKey)` resolves {status, body}; status 0 means the network failed. */
 function createSyncEngine({store,send,now=()=>Date.now(),random=Math.random,onChange=()=>{},encode=toBase64}){
  let running=null,again=false,authRequired=false,progress={done:0,total:0};
  const emit=async(extra={})=>{const outbox=await store.getOutbox();onChange({...summarize(outbox),authRequired,progress:{...progress},running:!!running,...extra});};
  async function fail(op,state,message,retry){
   op.attempts=(op.attempts||0)+1;op.lastError=message;op.state=state;
   if(retry)op.nextAttemptAt=now()+backoffMs(op.attempts,random());
   await store.putOp(op);
  }
  async function done(op){await store.deleteOp(op.opId);progress.done++;}
  async function serverCopy(id){const r=await send('GET','/api/offline/inspections/'+encodeURIComponent(id));return r.status===200?r.body.inspection:null;}
  const handlers={
   async start_inspection(op){
    const r=await send('POST','/api/inspections',{id:op.inspectionId,propertyId:op.payload.propertyId,date:op.payload.date},op.opId);
    const kind=classify(r.status);if(kind!=='ok')return r;
    await store.updateDraft(op.inspectionId,d=>d&&Object.assign(d,{localOnly:false}));
    await done(op);return r;
   },
   async save_draft(op){
    const draft=await store.getDraft(op.inspectionId);
    if(!draft){await done(op);return {status:200};}
    if(!op.body){op.body={id:draft.inspectionId,version:draft.baseVersion,answers:draft.answers,summary:draft.summary,notes:draft.notes,internalNotes:draft.internalNotes,...(op.payload.conflictResolution?{conflictResolution:op.payload.conflictResolution}:{})};op.sentRev=draft.rev;await store.putOp(op);}
    const r=await send('POST','/api/inspections/save',op.body,op.opId);const kind=classify(r.status);
    if(kind==='ok'){
     let newer=false;
     await store.updateDraft(op.inspectionId,d=>{if(!d)return null;d.baseVersion=r.body.version;d.base=content(op.body);d.conflict=null;newer=d.rev!==op.sentRev;d.dirty=newer;return d;});
     await done(op);
     if(newer)await enqueue(store,{type:'save_draft',inspectionId:op.inspectionId});
     return r;
    }
    if(kind==='conflict'){
     const server=await serverCopy(op.inspectionId);if(!server)return {status:0,body:{error:'Could not load the server copy.'}};
     if(server.status!=='draft'){await store.updateDraft(op.inspectionId,d=>d&&Object.assign(d,{conflict:{type:'locked',serverStatus:server.status,server}}));await fail(op,'failed',`This inspection was already ${server.status} on another device. Your copy is kept on this device.`,false);return {status:-1};}
     let conflicts=[];
     await store.updateDraft(op.inspectionId,d=>{
      if(!d)return null;const result=threeWayMerge(d.base,d,server);conflicts=result.conflicts;
      if(!conflicts.length){Object.assign(d,result.merged);d.baseVersion=server.version;d.base=content(server);d.rev=(d.rev||0)+1;d.mergedAt=new Date(now()).toISOString();d.conflict=null;}
      else d.conflict={type:'edit',conflicts,merged:result.merged,server,serverVersion:server.version};
      return d;
     });
     op.body=null;
     if(!conflicts.length){op.payload={...op.payload,conflictResolution:'auto-merged'};op.state='pending';op.nextAttemptAt=0;await store.putOp(op);return {status:-1,retryNow:true};}
     await fail(op,'conflict','Changed on another device. Choose which version to keep.',false);return {status:-1};
    }
    return r;
   },
   async upload_photo(op){
    const blob=await store.getBlob(op.opId);
    if(!blob){await fail(op,'failed','The photo is missing from this device.',false);return {status:-1};}
    const r=await send('POST','/api/files',{propertyId:op.payload.propertyId,inspectionId:op.inspectionId,name:op.payload.name,capturedAt:op.payload.capturedAt,clientOpId:op.opId,base64:await encode(blob)},op.opId);
    if(classify(r.status)!=='ok')return r;
    await store.updateDraft(op.inspectionId,d=>{if(!d)return null;const photo=(d.photos||[]).find(p=>p.opId===op.opId);if(photo){photo.fileId=r.body.id;photo.uploadedAt=new Date(now()).toISOString();}return d;});
    await store.deleteBlob(op.opId);await done(op);return r;
   },
   async complete_inspection(op){
    const draft=await store.getDraft(op.inspectionId);
    const r=await send('POST','/api/inspections/submit',{id:op.inspectionId,version:draft?.baseVersion,autoPublish:!!op.payload.autoPublish},op.opId);const kind=classify(r.status);
    if(kind==='ok'){await store.updateDraft(op.inspectionId,d=>d&&Object.assign(d,{status:r.body.status,baseVersion:r.body.version,completeQueued:false,dirty:false}));await done(op);progress.completed=(progress.completed||0)+1;return r;}
    if(kind==='conflict'){
     const server=await serverCopy(op.inspectionId);
     if(server&&server.status!=='draft'){await store.updateDraft(op.inspectionId,d=>d&&Object.assign(d,{status:server.status,completeQueued:false}));await done(op);return {status:200};}
     if(server&&draft&&sameContent(content(server),content(draft))){await store.updateDraft(op.inspectionId,d=>d&&Object.assign(d,{baseVersion:server.version}));op.state='pending';op.nextAttemptAt=0;await store.putOp(op);return {status:-1,retryNow:true};}
    }
    if(kind==='fatal'||kind==='conflict')await store.updateDraft(op.inspectionId,d=>d&&Object.assign(d,{completeQueued:false}));
    return r;
   }
  };
  async function runOp(op){
   let r;
   try{r=await handlers[op.type](op);}catch(error){r={status:0,body:{error:error?.message||'Network error'}};}
   if(!r||r.status===-1||classify(r.status)==='ok')return r;
   const kind=classify(r.status),message=r.body?.error||(r.status===0?'Waiting for a connection.':'Request failed ('+r.status+').');
   if(kind==='auth'){authRequired=true;op.lastError='Sign in again to finish syncing.';await store.putOp(op);return r;}
   if(kind==='retry'){await fail(op,'pending',r.status===0?'Waiting for a connection.':message,true);return r;}
   await fail(op,'failed',message,false);return r;
  }
  async function cycle(){
   authRequired=false;const start=await store.getOutbox();progress={done:0,total:start.length};await emit();
   for(let guard=0;guard<500;guard++){
    const batch=runnable(await store.getOutbox(),now());if(!batch.length||authRequired)break;
    const results=await Promise.all(batch.map(runOp));
    progress.total=Math.max(progress.total,progress.done+(await store.getOutbox()).length);await emit();
    if(results.some(r=>r&&r.status===0))break;   // offline again: stop and wait for the next trigger
   }
  }
  async function run(){
   if(running){again=true;return running;}
   running=(async()=>{try{do{again=false;await cycle();}while(again&&!authRequired);}finally{running=null;await emit();}})();
   return running;
  }
  async function nextWakeAt(){const pending=(await store.getOutbox()).filter(o=>o.state==='pending');return pending.length?Math.min(...pending.map(o=>o.nextAttemptAt||0)):null;}
  async function retry(opId){const op=(await store.getOutbox()).find(o=>o.opId===opId);if(!op)return;op.state='pending';op.nextAttemptAt=0;op.lastError='';await store.putOp(op);return run();}
  async function retryAll(){for(const op of await store.getOutbox())if(op.state!=='conflict'){op.nextAttemptAt=0;if(op.state==='failed')op.state='pending';await store.putOp(op);}return run();}
  return {run,retry,retryAll,nextWakeAt,get authRequired(){return authRequired;},get running(){return !!running;}};
 }

 /** In-memory store with the same interface as the IndexedDB store (tests and fallback when IndexedDB is unavailable). */
 function memoryStore(){
  const outbox=new Map(),drafts=new Map(),blobs=new Map(),snapshots=new Map(),meta=new Map();
  const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
  return {
   async getOutbox(){return [...outbox.values()].map(clone).sort((a,b)=>a.seq-b.seq);},
   async putOp(op){outbox.set(op.opId,clone(op));},async deleteOp(id){outbox.delete(id);},
   async getDraft(id){return clone(drafts.get(id));},async putDraft(d){drafts.set(d.inspectionId,clone(d));},
   async updateDraft(id,fn){const next=fn(clone(drafts.get(id))??null);if(next)drafts.set(id,clone(next));return clone(next)||null;},async deleteDraft(id){drafts.delete(id);},async getDrafts(){return [...drafts.values()].map(clone);},
   async getBlob(id){return blobs.get(id)||null;},async putBlob(id,b){blobs.set(id,b);},async deleteBlob(id){blobs.delete(id);},
   async getSnapshot(id){return clone(snapshots.get(id));},async putSnapshot(s){snapshots.set(s.id,clone(s));},async getSnapshots(){return [...snapshots.values()].map(clone);},async deleteSnapshot(id){snapshots.delete(id);},
   async getMeta(k){return clone(meta.get(k));},async putMeta(k,v){meta.set(k,clone(v));}
  };
 }
 root.EAOfflineCore={uuid,backoffMs,classify,fitWithin,content,sameContent,unsyncedKeys,threeWayMerge,applyResolution,parseLegacyDrafts,enqueue,runnable,summarize,toBase64,createSyncEngine,memoryStore,MAX_BACKOFF_MS};
})(typeof self!=='undefined'?self:globalThis);
