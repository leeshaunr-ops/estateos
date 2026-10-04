/* EstateAegis service worker.
   - Caches only the app shell (HTML, JS, CSS, icons). It never stores /api/* responses: user data lives in the per-user IndexedDB.
   - The cache name carries a hash of the shell files (filled in by the server), so each deploy installs a fresh cache.
   - A new version waits until the user taps "Reload" (never mid-inspection), then takes over.
     Exception: workers from before the v2 cache name are replaced at once (they had a broken Sign out).
   - The app page carries an X-EA-Shell header; a page from a newer deploy never runs on this worker's older cached scripts.
   - Background Sync (Chrome/Android) replays the offline inspection outbox even after the tab is closed. */
const VERSION='__SHELL_VERSION__',CACHE='estateaegis-shell-v2-'+VERSION;
const SHELL=['/login','/plan-panel.js','/plan-panel.css','/platform-owner.js','/platform-owner.css','/live.js','/login.js','/login.css','/fonts/inter-latin-var.woff2','/inspection-checklist.js','/visit-verification.js','/visit-card.js','/view-route.js','/sidebar-core.js','/overview-core.js','/overview.js','/overview.css','/app-format.js','/app.css','/storm-core.js','/storm.js','/storm.css','/weather-core.js','/weather.js','/weather.css','/ai-summaries.js','/ai-summaries.css','/smart-locks.js','/smart-locks.css','/flights.js','/flights.css','/insurance.js','/insurance.css','/photo-spots.js','/photo-spots.css','/inspection-drafts.js','/proactive.js','/offline-core.js','/offline-store.js','/logo-background.js','/live.css','/company.css','/refresh.css','/checklist-editor.css','/proactive.css','/offline.css','/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/ea-shield.png','/ea-shield-80.png','/ea-shield-120.png','/checklist-editor.mjs','/checklist-editor-model.mjs'];
const APP_ROUTES=/^\/(login|client-login|client\/[a-z0-9-]+)?$/i;
importScripts('/offline-core.js','/offline-store.js');

self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await Promise.all(SHELL.map(url=>fetch(new Request(url,{cache:'reload',credentials:'same-origin'})).then(response=>{if(!response.ok)throw Error('Precache failed: '+url);return cache.put(url,response);})));
  // Workers from before the v2 cache name (Oct 3, 2026) shipped a broken Sign out and could serve their cached scripts with a
  // newer page. Replace them right away instead of waiting for the Reload banner; the open page keeps running and the next
  // load is all new. Later updates wait for Reload as usual.
  if((await caches.keys()).some(key=>key.startsWith('estateaegis-shell-')&&!key.startsWith('estateaegis-shell-v2-')))await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('estateaegis-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})());
});
self.addEventListener('message',event=>{
 if(event.data?.type==='SKIP_WAITING'){
  // The page's Reload button. If this worker already took over (see install), reload that page on the user's tap,
  // since an older page only reloads itself when it sees the worker change after the tap.
  if(!self.registration.waiting&&self.registration.active&&event.source&&typeof event.source.navigate==='function')event.waitUntil(event.source.navigate(event.source.url).catch(()=>{}));
  else self.skipWaiting();
 }
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
   let response;
   try{response=await withTimeout(fetch(request),4000);}
   catch{return (await caches.match('/login',{cacheName:CACHE}))||offlinePage();}
   // A newer deploy's app page must not run on this worker's older cached scripts: keep the whole shell on this version
   // until the waiting worker takes over (the update banner offers Reload).
   const shell=response.headers.get('X-EA-Shell');
   if(shell&&shell!==VERSION){const cached=await caches.match('/login',{cacheName:CACHE});if(cached)return cached;}
   return response;
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
