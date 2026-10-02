/* EstateAegis offline storage: one IndexedDB database per signed-in user (estateaegis-offline-<userId>).
   Stores: drafts, outbox, blobs (photo Blobs), snapshots (residences + visits for offline use), meta.
   Exposed as globalThis.EAOfflineStore; works in the page and in the service worker. */
(function(root){
 'use strict';
 const PREFIX='estateaegis-offline-',META_DB='estateaegis-offline-meta',VERSION=1;
 const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage transaction aborted.'));});
 function open(name,upgrade){return new Promise((resolve,reject)=>{const r=root.indexedDB.open(name,VERSION);r.onupgradeneeded=()=>upgrade(r.result);r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Close other EstateAegis tabs and try again.'));});}
 async function openUserStore(userId){
  if(!/^[A-Za-z0-9-]{1,80}$/.test(String(userId||'')))throw Error('Invalid user for offline storage.');
  const db=await open(PREFIX+userId,db=>{
   if(!db.objectStoreNames.contains('outbox'))db.createObjectStore('outbox',{keyPath:'opId'});
   if(!db.objectStoreNames.contains('drafts'))db.createObjectStore('drafts',{keyPath:'inspectionId'});
   if(!db.objectStoreNames.contains('blobs'))db.createObjectStore('blobs');
   if(!db.objectStoreNames.contains('snapshots'))db.createObjectStore('snapshots',{keyPath:'id'});
   if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta');
  });
  const one=async(store,mode,fn)=>{const tx=db.transaction(store,mode);const result=await req(fn(tx.objectStore(store)));if(mode==='readwrite')await done(tx);return result;};
  return {
   userId,db,
   async getOutbox(){return (await one('outbox','readonly',s=>s.getAll())).sort((a,b)=>a.seq-b.seq);},
   putOp:op=>one('outbox','readwrite',s=>s.put(op)),deleteOp:id=>one('outbox','readwrite',s=>s.delete(id)),
   getDraft:async id=>(await one('drafts','readonly',s=>s.get(id)))||null,getDrafts:()=>one('drafts','readonly',s=>s.getAll()),
   putDraft:d=>one('drafts','readwrite',s=>s.put(d)),
   /** Read-modify-write in one transaction so the page (typing) and the sync engine never overwrite each other's fields. */
   updateDraft(id,fn){return new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite'),s=tx.objectStore('drafts');let next=null;const r=s.get(id);r.onsuccess=()=>{try{next=fn(r.result||null)||null;}catch(error){reject(error);tx.abort();return;}if(next)s.put(next);};tx.oncomplete=()=>resolve(next);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage transaction aborted.'));});},deleteDraft:id=>one('drafts','readwrite',s=>s.delete(id)),
   getBlob:async id=>(await one('blobs','readonly',s=>s.get(id)))||null,putBlob:(id,b)=>one('blobs','readwrite',s=>s.put(b,id)),deleteBlob:id=>one('blobs','readwrite',s=>s.delete(id)),
   async blobKeys(){return one('blobs','readonly',s=>s.getAllKeys());},
   getSnapshot:async id=>(await one('snapshots','readonly',s=>s.get(id)))||null,getSnapshots:()=>one('snapshots','readonly',s=>s.getAll()),
   putSnapshot:s=>one('snapshots','readwrite',x=>x.put(s)),deleteSnapshot:id=>one('snapshots','readwrite',s=>s.delete(id)),
   getMeta:async k=>(await one('meta','readonly',s=>s.get(k)))??null,putMeta:(k,v)=>one('meta','readwrite',s=>s.put(v,k)),
   /** Photo Blob + its outbox op in one transaction, so a photo is never queued without its bytes (or vice versa). */
   async addPhoto(op,blob){const tx=db.transaction(['outbox','blobs'],'readwrite');tx.objectStore('blobs').put(blob,op.opId);tx.objectStore('outbox').put(op);await done(tx);},
   close(){db.close();}
  };
 }
 async function metaDb(){return open(META_DB,db=>{if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');});}
 async function setCurrentUser(userId){const db=await metaDb();const tx=db.transaction('kv','readwrite');userId?tx.objectStore('kv').put(String(userId),'currentUser'):tx.objectStore('kv').delete('currentUser');await done(tx);db.close();}
 async function getCurrentUser(){const db=await metaDb();const value=await req(db.transaction('kv','readonly').objectStore('kv').get('currentUser'));db.close();return value||null;}
 function deleteUserStore(userId){return new Promise((resolve,reject)=>{const r=root.indexedDB.deleteDatabase(PREFIX+userId);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>resolve();});}
 root.EAOfflineStore={openUserStore,deleteUserStore,setCurrentUser,getCurrentUser,PREFIX};
})(typeof self!=='undefined'?self:globalThis);
