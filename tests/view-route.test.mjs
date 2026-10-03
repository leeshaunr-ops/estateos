// Refresh keeps you on the current screen: URL hash <-> view state, access checks with fallback to Overview,
// installed-app reopen, and the shell lists that make the script available offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../public/view-route.js';
const R=globalThis.EARoute;
const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');

const data={user:{id:'u-admin',role:'admin'},properties:[{id:'p1'}],inspections:[{id:'i1'}],assets:[{id:'a1'}],asset_inspections:[{id:'r1',asset_id:'a1'}],checklistTemplates:{templates:[{id:'t1'}]},clients:[{id:'c1'}],arrivals:[{id:'ar1'}]};

test('every screen round-trips through the hash', () => {
 const screens=[
  [{page:'dashboard'},''],
  [{page:'property',propertyId:'p1',tab:'overview'},'#/residence/p1'],
  [{page:'property',propertyId:'p1',tab:'inspections'},'#/residence/p1/inspections'],
  [{page:'inspection',activeInspection:'i1'},'#/inspection/i1'],
  [{page:'asset-inspection',activeAssetInspection:'a1',activeAssetInspectionRecord:'r1',assetInspectionReadOnly:true},'#/asset-inspection/a1/r1'],
  [{page:'checklist-editor',checklistTemplateId:'t1'},'#/checklist-templates/t1'],
  [{page:'clients',activeClient:'c1'},'#/clients/c1'],
  [{page:'arrivals',activeArrival:'ar1'},'#/arrivals/ar1'],
  [{page:'arrivals',arrivalFilter:'ready'},'#/arrivals/ready'],
  [{page:'inspections',inspectionUpcomingOnly:true},'#/inspections/upcoming'],
  [{page:'inspections',inspectionSubmittedOnly:true},'#/inspections/submitted'],
  [{page:'messages',activeMessageThread:'th1'},'#/messages/th1'],
  [{page:'notifications'},'#/notifications'],
  [{page:'checklist-templates'},'#/checklist-templates'],
  [{page:'properties'},'#/properties']
 ];
 for(const [state,hash] of screens){
  const full={...R.blank(),...state};
  assert.equal(R.toHash(full),hash,state.page);
  if(!hash)continue;
  const back=R.parse(hash);
  for(const k of Object.keys(state))assert.deepEqual(back[k],full[k],hash+' '+k);
  assert.equal(R.toHash(back),hash);
 }
});

test('ids are encoded; unknown, empty and legacy hashes are ignored', () => {
 assert.equal(R.toHash({...R.blank(),page:'inspection',activeInspection:'a/b c'}),'#/inspection/a%2Fb%20c');
 assert.equal(R.parse('#/inspection/a%2Fb%20c').activeInspection,'a/b c');
 for(const h of ['','#','#top','#/','#/no-such-page','#/residence','#/inspection','#/asset-inspection/a1','#/%E0%A4%A']) assert.equal(R.parse(h),null,h);
 assert.equal(R.parse('#/residence/p1/not-a-tab').tab,'overview');
 assert.equal(R.parse('#/overview').page,'dashboard');
});

test('dialogs and half-filled forms are never in the URL: they map to the page that contains them', () => {
 assert.equal(R.toHash({...R.blank(),page:'asset-inspection',activeAssetInspection:'a1',assetInspectionReadOnly:false}),'#/assets');
 assert.equal(R.toHash({...R.blank(),page:'checklist-editor'}),'#/checklist-templates');
 assert.equal(R.toHash({...R.blank(),page:'property'}),'#/properties');
 assert.equal(R.toHash({...R.blank(),page:'some-internal-state'}),'');
});

test('a missing record or no access falls back to Overview', () => {
 const ok=h=>R.resolve(R.parse(h),data);
 assert.deepEqual([ok('#/residence/p1/notes').state.page,ok('#/residence/p1/notes').fellBack],['property',false]);
 for(const h of ['#/residence/gone','#/inspection/gone','#/asset-inspection/a1/gone','#/asset-inspection/gone/r1','#/checklist-templates/gone','#/clients/gone','#/arrivals/gone']){
  const r=ok(h);assert.equal(r.fellBack,true,h);assert.equal(r.state.page,'dashboard',h);assert.equal(R.toHash(r.state),'',h);
 }
 // An employee: no checklist editor or family records; admin-only residence tabs fall back to the first tab.
 const staff={...data,user:{id:'u-staff',role:'employee'}};
 assert.equal(R.resolve(R.parse('#/checklist-templates/t1'),staff).fellBack,true);
 assert.equal(R.resolve(R.parse('#/clients/c1'),staff).fellBack,true);
 assert.equal(R.resolve(R.parse('#/residence/p1/off_site_butler'),staff).state.tab,'overview');
 assert.equal(R.resolve(R.parse('#/residence/p1/notes'),staff).state.tab,'notes');
 // A client: only staff tabs are refused; a vendor only has Services.
 const client={...data,user:{id:'u-client',role:'client'}};
 assert.equal(R.resolve(R.parse('#/residence/p1/access_codes'),client).state.tab,'overview');
 assert.equal(R.resolve(R.parse('#/residence/p1/inspections'),client).state.tab,'inspections');
 assert.equal(R.resolve(R.parse('#/residence/p1'),{...data,user:{id:'v',role:'vendor'}}).state.tab,'services');
 // No hash: Overview without a fallback notice. Offline: the saved-inspections list is home.
 assert.deepEqual(R.resolve(null,data),{state:R.blank(),fellBack:false});
 const offline={...data,offline:true,user:{id:'u-staff',role:'employee'}};
 assert.equal(R.resolve(R.parse('#/inspection/i1'),offline).state.page,'inspection');
 const gone=R.resolve(R.parse('#/inspection/not-on-this-phone'),offline);assert.equal(gone.fellBack,true);assert.equal(gone.state.page,'inspections');
});

test('first screen after sign-in: the URL wins; the installed app reopens the last screen for the same user only', () => {
 const now=Date.UTC(2026,9,2,12),saved={userId:'u1',route:'#/residence/p1/inspections',at:now-60_000};
 assert.deepEqual(R.initialRoute({hash:'#/inspection/i1',search:'?source=pwa',standalone:true,saved,userId:'u1',now}),{hash:'#/inspection/i1',from:'url'});
 assert.deepEqual(R.initialRoute({hash:'',search:'?source=pwa',standalone:false,saved,userId:'u1',now}),{hash:'#/residence/p1/inspections',from:'saved'});
 assert.deepEqual(R.initialRoute({hash:'',search:'',standalone:true,saved,userId:'u1',now}),{hash:'#/residence/p1/inspections',from:'saved'});
 assert.equal(R.initialRoute({hash:'',search:'',standalone:false,saved,userId:'u1',now}).from,'none','a normal tab without a hash opens Overview');
 assert.equal(R.initialRoute({hash:'',search:'?source=pwa',standalone:true,saved,userId:'someone-else',now}).from,'none','never another user\'s screen');
 assert.equal(R.initialRoute({hash:'',search:'?source=pwa',standalone:true,saved:{...saved,at:now-R.SAVED_VIEW_MAX_AGE-1},userId:'u1',now}).from,'none','stale');
 assert.equal(R.initialRoute({hash:'',search:'?source=pwa',standalone:true,saved:{page:'inspection',activeInspection:'i1',at:now},userId:'u1',now}).from,'none','old-format saved view without a user');
 assert.equal(R.initialRoute({hash:'#junk',search:'?source=pwa',standalone:true,saved,userId:'u1',now}).from,'saved');
});

test('the script ships with the app shell, loads last, and deep links stay intact', () => {
 const html=read('public/live.html');
 assert.match(html,/<script src="\/view-route\.js\?v=[^"]+"><\/script><\/body>/,'loads after every other app script');
 assert.match(read('public/sw.js'),/'\/view-route\.js'/);
 assert.match(read('server.mjs'),/'\/view-route\.js':'view-route\.js'/);
 assert.match(read('server.mjs'),/SHELL_FILES = \[[^\]]*'view-route\.js'/);
 const live=read('public/live.js');
 assert.match(live,/pendingInspectionLink=\(\(\)=>\{try\{return new URLSearchParams\(location\.search\)\.get\('inspection'\)/,'?inspection=<id> alert links');
 assert.equal((live.match(/history\.replaceState\(null,'','\/'\+\(\/\^#\\\/\.\/\.test\(location\.hash\)\?location\.hash:''\)\)/g)||[]).length,2,'sign-in keeps the screen hash');
 assert.match(read('public/manifest.webmanifest'),/"start_url": "\/login\?source=pwa"/);
 assert.match(read('public/marketing.js'),/location\.replace\('\/login' \+ location\.hash\)/,'signed-out refresh goes to sign-in');
});
