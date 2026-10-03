/* EstateAegis service worker.
   - Caches only the app shell (HTML, JS, CSS, icons). It never stores /api/* responses: user data lives in the per-user IndexedDB.
   - The cache name carries a hash of the shell files (filled in by the server), so each deploy installs a fresh cache.
   - A new version waits until the user taps "Reload" (never mid-inspection), then takes over.
   - Background Sync (Chrome/Android) replays the offline inspection outbox even after the tab is closed. */
const VERSION='__SHELL_VERSION__',CACHE='estateaegis-shell-'+VERSION;
const SHELL=['/login','/live.js','/inspection-checklist.js','/inspection-drafts.js','/proactive.js','/offline-core.js','/offline-store.js','/logo-background.js','/live.css','/company.css','/refresh.css','/checklist-editor.css','/proactive.css','/offline.css','/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/ea-shield.png','/checklist-editor.mjs','/checklist-editor-model.mjs'];
const APP_ROUTES=/^\/(login|client-login|client\/[a-z0-9-]+)?$/i;
importScripts('/offline-core.js','/offline-store.js');

self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>Promise.all(SHELL.map(url=>fetch(new Request(url,{cache:'reload',credentials:'same-origin'})).then(response=>{if(!response.ok)throw Error('Precache failed: '+url);return cache.put(url,response);})))));
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('estateaegis-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})());
});
self.addEventListener('message',event=>{
 if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
 if(event.data?.type==='VERSION')event.ports[0]?.postMessage({version:VERSION});
});
function withTimeout(promise,ms){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),ms);promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(request.mode==='navigate'){
  if(!APP_ROUTES.test(url.pathname))return;
  const offlinePage=()=>new Response('<!doctype html><title>Offline</title><p>EstateAegis is offline. Reconnect and refresh.</p>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});
  if(url.pathname!=='/'){
   // /login and the client portal routes always serve the same static shell: serve the cached copy so HTML and scripts stay on one version.
   event.respondWith(caches.match('/login',{cacheName:CACHE}).then(cached=>cached||fetch(request)).catch(offlinePage));
   return;
  }
  // "/" depends on the sign-in cookie (marketing page vs app), so go to the network first and fall back to the shell without signal.
  event.respondWith((async()=>{
   try{return await withTimeout(fetch(request),4000);}
   catch{return (await caches.match('/login',{cacheName:CACHE}))||offlinePage();}
  })());
  return;
 }
 const path=url.pathname;
 if(!SHELL.includes(path))return;
 // Shell assets: cache first (ignoring ?v= cache busters), then network.
 event.respondWith(caches.match(path,{cacheName:CACHE}).then(cached=>cached||fetch(request)));
});

async function sendFromWorker(method,path,body,key){
 try{
  const headers={'Content-Type':'application/json'};if(key)headers['Idempotency-Key']=key;
  const response=await fetch(path,{method,credentials:'same-origin',headers,body:body===undefined?undefined:JSON.stringify(body)});
  let data={};try{data=await response.json();}catch{}
  return {status:response.status,body:data};
 }catch{return {status:0,body:{}};}
}
async function backgroundSync(){
 const userId=await EAOfflineStore.getCurrentUser();if(!userId)return;
 const run=async()=>{const store=await EAOfflineStore.openUserStore(userId);try{await EAOfflineCore.createSyncEngine({store,send:sendFromWorker}).run();}finally{store.close();}
  for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'SYNCED'});};
 // The page uses the same lock, so the outbox is never replayed twice at once.
 if(self.navigator.locks)return self.navigator.locks.request('estateaegis-outbox',run);
 return run();
}
self.addEventListener('sync',event=>{if(event.tag==='estateaegis-outbox')event.waitUntil(backgroundSync());});
