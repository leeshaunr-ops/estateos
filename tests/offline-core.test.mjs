import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sandbox={crypto:globalThis.crypto,btoa:globalThis.btoa,console};sandbox.globalThis=sandbox;
vm.createContext(sandbox);vm.runInContext(readFileSync(path.join(root,'public/offline-core.js'),'utf8'),sandbox);
const C=sandbox.EAOfflineCore;
const plain=v=>JSON.parse(JSON.stringify(v));
const answers=()=>[{key:'a',label:'Water',section:'Plumbing',status:'unchecked',note:''},{key:'b',label:'Doors',section:'Security',status:'unchecked',note:''},{key:'c',label:'Lights',section:'Power',status:'unchecked',note:''}];
function draft(extra={}){const a=answers();return {inspectionId:'i1',propertyId:'p1',baseVersion:1,base:C.content({answers:a,summary:'',notes:'',internalNotes:''}),answers:a,summary:'',notes:'',internalNotes:'',rev:0,dirty:false,status:'draft',photos:[],...extra};}
/** Fake server: one draft inspection with optimistic versions and idempotent keys, like server.mjs. */
function fakeServer(){
 const state={inspection:{id:'i1',status:'draft',version:1,answers:answers(),summary:'',notes:'',internal_notes:''},files:[],keys:new Map(),calls:[],down:false,failNext:0,expired:false,dropResponse:0};
 async function send(method,p,body,key){
  state.calls.push({method,p,key});
  if(state.down)return {status:0,body:{}};
  if(state.expired)return {status:401,body:{error:'Please sign in.'}};
  if(state.failNext>0){state.failNext--;return {status:503,body:{error:'Unavailable'}};}
  if(key&&state.keys.has(key))return state.keys.get(key);
  let r;const i=state.inspection;
  if(method==='GET')r={status:200,body:{inspection:plain(i)}};
  else if(p==='/api/inspections/save'){if(body.version!==i.version)r={status:409,body:{error:'This record changed.'}};else{Object.assign(i,{answers:plain(body.answers),summary:body.summary,notes:body.notes,internal_notes:body.internalNotes,version:i.version+1});r={status:201,body:{id:i.id,version:i.version}};}}
  else if(p==='/api/files'){const f={id:'f'+(state.files.length+1),clientOpId:body.clientOpId,capturedAt:body.capturedAt};state.files.push(f);r={status:201,body:{id:f.id}};}
  else if(p==='/api/inspections/submit'){if(body.version!==i.version)r={status:409,body:{}};else{i.status='submitted';i.version++;r={status:201,body:{id:i.id,status:'submitted',version:i.version}};}}
  else if(p==='/api/inspections'){r={status:201,body:{id:body.id}};}
  if(key&&r.status>=200&&r.status<300)state.keys.set(key,r);
  if(state.dropResponse>0&&method==='POST'){state.dropResponse--;return {status:0,body:{}};} // the write happened but the phone never heard back
  return r;
 }
 return {state,send};
}
async function setup(extra){const store=C.memoryStore();await store.putDraft(draft(extra));const server=fakeServer();let clock=1000;const engine=C.createSyncEngine({store,send:server.send,now:()=>clock,random:()=>0});return {store,server,engine,tick:ms=>{clock+=ms;}};}
async function edit(store,fn){await store.updateDraft('i1',d=>{fn(d);d.rev++;d.dirty=true;return d;});await C.enqueue(store,{type:'save_draft',inspectionId:'i1'});}

test('backoff doubles from 2 s and caps at 5 minutes',()=>{
 assert.deepEqual([1,2,3,4].map(n=>C.backoffMs(n)),[2000,4000,8000,16000]);
 assert.equal(C.backoffMs(30),C.MAX_BACKOFF_MS);assert.equal(C.backoffMs(20,1),C.MAX_BACKOFF_MS);
 assert.ok(C.backoffMs(2,1)>4000&&C.backoffMs(2,1)<=4800,'jitter adds at most 20%');
});
test('classifies outcomes',()=>{
 assert.deepEqual([200,201,0,503,429,425,401,409,422,403].map(s=>C.classify(s)),['ok','ok','retry','retry','retry','retry','auth','conflict','fatal','fatal']);
});
test('photo resize keeps aspect ratio, caps the long edge at 2048 and never upscales',()=>{
 assert.deepEqual(plain(C.fitWithin(4032,3024)),{width:2048,height:1536});
 assert.deepEqual(plain(C.fitWithin(3024,4032)),{width:1536,height:2048});
 assert.deepEqual(plain(C.fitWithin(800,600)),{width:800,height:600});
});
test('outbox keeps per-inspection order, coalesces unsent saves and runs at most 3 visits at once',async()=>{
 const store=C.memoryStore();
 await C.enqueue(store,{type:'save_draft',inspectionId:'x'});
 assert.equal(await C.enqueue(store,{type:'save_draft',inspectionId:'x'}),null,'second unsent save is coalesced');
 await C.enqueue(store,{type:'upload_photo',inspectionId:'x'});
 const ops=await store.getOutbox();assert.deepEqual(plain(ops.map(o=>o.type)),['save_draft','upload_photo']);
 ops[0].body={frozen:true};await store.putOp(ops[0]);
 assert.ok(await C.enqueue(store,{type:'save_draft',inspectionId:'x'}),'a save that was already sent is never reused');
 for(const id of ['y','z','w'])await C.enqueue(store,{type:'save_draft',inspectionId:id});
 const run=C.runnable(await store.getOutbox());
 assert.equal(run.length,3);assert.equal(run[0].inspectionId,'x');assert.equal(run[0].type,'save_draft');
 assert.ok(!run.some(o=>o.type==='upload_photo'),'later ops for a visit wait for the head op');
 const blocked=await store.getOutbox();blocked[0].state='failed';await store.putOp(blocked[0]);
 assert.ok(!C.runnable(await store.getOutbox()).some(o=>o.inspectionId==='x'),'a failed head op blocks only its own visit');
 await assert.rejects(C.enqueue(store,{type:'drop_table'}),/Unknown offline operation/);
});
test('replays the outbox in order once the connection returns; photos upload exactly once',async()=>{
 const {store,server,engine,tick}=await setup();
 await edit(store,d=>{d.answers[0].status='pass';});
 await store.putBlob('p1',{arrayBuffer:async()=>new Uint8Array([255,216,1,2]).buffer});
 await C.enqueue(store,{opId:'p1',type:'upload_photo',inspectionId:'i1',payload:{propertyId:'p1',name:'a.jpg',capturedAt:'2026-10-02T12:00:00.000Z'}});
 server.state.down=true;await engine.run();
 assert.equal((await store.getOutbox()).length,2,'nothing is lost while offline');
 assert.equal((await store.getOutbox())[0].nextAttemptAt,1000+2000,'retry is scheduled with backoff');
 server.state.down=false;tick(2000);await engine.run();
 assert.equal((await store.getOutbox()).length,0);
 assert.equal(server.state.inspection.answers[0].status,'pass');assert.equal(server.state.inspection.version,2);
 assert.equal(server.state.files.length,1);assert.equal(server.state.files[0].clientOpId,'p1');assert.equal(server.state.files[0].capturedAt,'2026-10-02T12:00:00.000Z');
 const d=await store.getDraft('i1');assert.equal(d.baseVersion,2);assert.equal(d.dirty,false);assert.equal(await store.getBlob('p1'),null,'local Blob removed after upload');
 assert.deepEqual(server.state.calls.filter(c=>c.p==='/api/inspections/save').map(c=>c.method),['POST','POST'],'the save was attempted offline and once online');
});
test('a lost response is retried with the same key and frozen body, so nothing is written twice',async()=>{
 const {store,server,engine,tick}=await setup();
 await edit(store,d=>{d.summary='All good';});
 await store.putBlob('p2',{arrayBuffer:async()=>new Uint8Array([255,216]).buffer});
 await C.enqueue(store,{opId:'p2',type:'upload_photo',inspectionId:'i1',payload:{propertyId:'p1',name:'b.jpg'}});
 server.state.dropResponse=1;await engine.run();
 const saveKey=server.state.calls[0].key;
 await edit(store,d=>{d.summary='All good, gate locked';});  // typed while the first save was in doubt
 tick(5000);await engine.run();
 assert.equal(server.state.calls.filter(c=>c.key===saveKey).length,2,'same idempotency key reused');
 assert.equal(server.state.inspection.summary,'All good, gate locked','follow-up save carries the later edit');
 assert.equal(server.state.inspection.version,3);assert.equal(server.state.files.length,1);
 assert.equal((await store.getOutbox()).length,0);
});
test('server changes to other items merge automatically; overlapping edits become a conflict and keep the local copy',async()=>{
 const {store,server,engine}=await setup();
 await edit(store,d=>{d.answers[0].status='pass';d.answers[1].note='Front door sticks';});
 Object.assign(server.state.inspection,{version:2,answers:[{...answers()[0]},{...answers()[1]},{...answers()[2],status:'attention'}]});
 await engine.run();
 let s=server.state.inspection;
 assert.equal(s.answers[0].status,'pass');assert.equal(s.answers[1].note,'Front door sticks');assert.equal(s.answers[2].status,'attention','server change kept');
 assert.equal((await store.getOutbox()).length,0);
 // Now both sides edit the same item.
 await edit(store,d=>{d.answers[0].status='monitor';});
 s.answers[0].status='attention';s.version++;
 await engine.run();
 const [op]=await store.getOutbox();assert.equal(op.state,'conflict');
 const d=await store.getDraft('i1');assert.equal(d.answers[0].status,'monitor','local value is never overwritten');
 assert.equal(d.conflict.conflicts.length,1);assert.equal(d.conflict.conflicts[0].server,'attention');
 const merged=C.applyResolution({merged:d.conflict.merged,conflicts:d.conflict.conflicts},{[d.conflict.conflicts[0].id]:'server'});
 assert.equal(merged.answers.find(a=>a.key==='a').status,'attention');
});
test('three-way merge without a known base treats every difference as a conflict',()=>{
 const local={answers:[{key:'a',status:'pass',note:''}],summary:'x',notes:'',internalNotes:''};
 const server={answers:[{key:'a',status:'monitor',note:''}],summary:'x',notes:'',internal_notes:''};
 const r=C.threeWayMerge(null,local,server);assert.equal(r.conflicts.length,1);assert.equal(r.conflicts[0].field,'status');
});
test('a visit already published elsewhere stops sync for that visit and keeps the device copy',async()=>{
 const {store,server,engine}=await setup();
 await edit(store,d=>{d.notes='Pool cover replaced';});
 Object.assign(server.state.inspection,{status:'published',version:5});
 await engine.run();
 const [op]=await store.getOutbox();assert.equal(op.state,'failed');assert.match(op.lastError,/published/);
 assert.equal((await store.getDraft('i1')).notes,'Pool cover replaced');assert.equal((await store.getDraft('i1')).conflict.type,'locked');
});
test('an expired session pauses sync without losing or counting attempts',async()=>{
 const {store,server,engine}=await setup();
 await edit(store,d=>{d.summary='Done';});
 server.state.expired=true;await engine.run();
 assert.equal(engine.authRequired,true);const [op]=await store.getOutbox();assert.equal(op.state,'pending');assert.equal(op.attempts,0);
 server.state.expired=false;await engine.run();assert.equal((await store.getOutbox()).length,0);
});
test('complete is queued behind saves and photos, and submits once',async()=>{
 const {store,server,engine}=await setup();
 await edit(store,d=>{d.answers.forEach(a=>a.status='pass');d.summary='Ready';});
 await store.updateDraft('i1',d=>Object.assign(d,{completeQueued:true}));
 await C.enqueue(store,{type:'complete_inspection',inspectionId:'i1',payload:{autoPublish:false}});
 server.state.failNext=1;await engine.run();
 assert.equal(server.state.inspection.status,'draft','5xx: retried later');
 const ops=await store.getOutbox();ops[0].nextAttemptAt=0;await store.putOp(ops[0]);
 await engine.run();
 assert.equal(server.state.inspection.status,'submitted');
 assert.equal(server.state.calls.filter(c=>c.p==='/api/inspections/submit').length,1);
 const d=await store.getDraft('i1');assert.equal(d.status,'submitted');assert.equal(d.completeQueued,false);
});
test('unsynced keys drive the per-item badges',()=>{
 const d=draft();d.answers[1].status='pass';d.summary='hi';
 assert.deepEqual([...C.unsyncedKeys(d)].sort(),['b','summary']);
});
test('old sessionStorage drafts are migrated for the signed-in user only',()=>{
 const entries=[['estateaegis-draft:u1:i9',JSON.stringify({id:'i9',version:3,answers:[{key:'a',status:'pass',note:''}],summary:'s',notes:'n',internalNotes:'x'})],['estateaegis-draft:u2:i8',JSON.stringify({id:'i8',version:1,answers:[]})],['other','x'],['estateaegis-draft:u1:bad','{']];
 const out=plain(C.parseLegacyDrafts(entries,'u1'));
 assert.equal(out.length,1);assert.equal(out[0].inspectionId,'i9');assert.equal(out[0].baseVersion,3);assert.equal(out[0].internalNotes,'x');
});
test('uuid is a v4 UUID',()=>{assert.match(C.uuid(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);});
