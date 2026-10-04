// Field inspector logins (Oct 2026): explicit allow-list (every other API route refused), assigned-visit ownership,
// company isolation, door codes only on the visit day, a trimmed /api/data, inspectors never using an admin/staff
// seat, the free allowance (2 per included seat) and the $5 add-on that only works once its Stripe product exists.
// Server scenarios run on SQLite and Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLANS,ADDONS,subscriptionQuote,freeInspectors,inspectorAddonAvailable,SEAT_ROLES} from '../stripe-plans.mjs';
import {openDatabase} from '../database.mjs';
import {createStripeBilling} from '../stripe-billing.mjs';
import {createStripeClient} from '../stripe-client.mjs';
import {subscriptionFields} from '../platform-monitor.mjs';
import {planPrice} from '../subscriptions.mjs';
import {INSPECTOR_ROUTES,inspectorRoute} from '../inspector.mjs';
import '../public/sidebar-core.js';
import '../public/view-route.js';
import '../public/plan-panel.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-fi-'));dirs.push(d);return d;};
const engines=[['SQLite',d=>({ESTATEOS_DATA_DIR:d})],['Postgres (PGlite)',d=>({NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')})]];
const jpeg=readFileSync(path.join(root,'tests/fixture.jpg')).toString('base64');
const PRODUCT='prod_TestInspector01';
const withProduct=async(value,fn)=>{const old=process.env.STRIPE_INSPECTOR_PRODUCT_ID;if(value==null)delete process.env.STRIPE_INSPECTOR_PRODUCT_ID;else process.env.STRIPE_INSPECTOR_PRODUCT_ID=value;try{return await fn();}finally{if(old===undefined)delete process.env.STRIPE_INSPECTOR_PRODUCT_ID;else process.env.STRIPE_INSPECTOR_PRODUCT_ID=old;}};
const DENIED=/Field inspector logins can only open their assigned visits/;
const today=(tz='America/New_York',offsetDays=0)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+offsetDays*86400000));

test('pricing: 2 free inspectors per included seat (8/20/40), $5 each after, never a seat', () => {
 assert.deepEqual(Object.keys(PLANS).map(freeInspectors),[8,20,40]);
 assert.equal(ADDONS.inspectors.monthlyMinor,500);
 assert.deepEqual([...SEAT_ROLES],['admin','employee'],'inspectors are not a seat role');
 const q=subscriptionQuote('essentials',1,0,3);
 assert.equal(q.seats,5);assert.equal(q.freeInspectors,8,'extra admin/staff users do not raise the free inspector allowance');assert.equal(q.inspectors,11);assert.equal(q.monthlyMinor,5900+1500+3*500);
 assert.throws(()=>subscriptionQuote('growth',0,0,-1));assert.throws(()=>subscriptionQuote('growth',0,0,1.5));
 // Manual invoices: $5 for each inspector beyond the Essentials allowance of 8.
 assert.equal(planPrice(4,0,8),5900);assert.equal(planPrice(4,0,10),5900+1000);
});

test('the add-on product comes only from STRIPE_INSPECTOR_PRODUCT_ID and must look like a Stripe product id', async () => {
 await withProduct(null,()=>{assert.equal(ADDONS.inspectors.product,null);assert.equal(inspectorAddonAvailable(),false);});
 await withProduct('price_123456',()=>assert.equal(ADDONS.inspectors.product,null));
 await withProduct('prod_x',()=>assert.equal(ADDONS.inspectors.product,null,'too short'));
 await withProduct(PRODUCT,()=>{assert.equal(ADDONS.inspectors.product,PRODUCT);assert.equal(inspectorAddonAvailable(),true);});
});

test('Stripe checkout: extra inspectors refused without the product; with it, the $5 monthly price is looked up by product + amount', async () => {
 const calls=[];
 const fetcher=async(url,opts)=>{calls.push({url,body:opts.body?Object.fromEntries(opts.body):null});const u=new URL(url);
  if(u.pathname==='/v1/prices'){const product=u.searchParams.get('product'),amount=product===PRODUCT?500:Object.values({...PLANS}).find(p=>p.product===product)?.monthlyMinor;return {ok:true,json:async()=>({has_more:false,data:[{id:'price_for_'+product,active:true,currency:'usd',unit_amount:amount,recurring:{interval:'month',interval_count:1},billing_scheme:'per_unit'},{id:'price_wrong',active:true,currency:'usd',unit_amount:999,recurring:{interval:'month',interval_count:1},billing_scheme:'per_unit'}]})};}
  return {ok:true,json:async()=>({id:'cs_test',url:'https://checkout.stripe.com/c/pay/cs_test'})};};
 await withProduct(null,async()=>{
  const c=createStripeClient({secret:'sk_test_x',origin:'https://staging.example',fetcher});
  await assert.rejects(c.checkout({organizationId:'o',email:'a@example.test',plan:'essentials',extraInspectors:1,attemptId:'a1'}),/field inspector add-on is not configured/);
  assert.equal(calls.length,0,'nothing is sent to Stripe');
 });
 await withProduct(PRODUCT,async()=>{
  const c=createStripeClient({secret:'sk_test_x',origin:'https://staging.example',fetcher});
  await c.checkout({organizationId:'o',email:'a@example.test',plan:'essentials',extraInspectors:2,attemptId:'a2'});
  assert.ok(calls.some(x=>x.url.includes('product='+PRODUCT)),'looks up prices on the inspector product');
  const session=calls.find(x=>x.url.endsWith('/checkout/sessions')).body;
  assert.equal(session['line_items[1][price]'],'price_for_'+PRODUCT);assert.equal(session['line_items[1][quantity]'],'2');
 });
});

const item=(product,amount,quantity=1)=>({quantity,price:{product,currency:'usd',unit_amount:amount,recurring:{interval:'month',interval_count:1}}});
test('subscriptions: the inspector item is read as extra inspectors only when the product is configured', async () => {
 const db=await openDatabase(root,{ESTATEOS_DATA_DIR:tmp()});
 try{
  const billing=createStripeBilling({...db,id:randomUUID,now:()=>new Date().toISOString(),fail:(s,m)=>{throw Object.assign(Error(m),{status:s});},json:()=>{},body:async r=>r.body,audit:async()=>{},client:{},enabled:()=>false});
  const sub={items:{data:[item(PLANS.growth.product,10900),item(PRODUCT,500,3)]}};
  await withProduct(PRODUCT,()=>{const q=billing.parseSubscription(sub);assert.equal(q.plan,'growth');assert.equal(q.extraInspectors,3);assert.equal(q.inspectors,23);
   const f=subscriptionFields({id:'sub_1',customer:'cus_1',status:'active',...sub});assert.equal(f.extra_inspectors,3);assert.equal(f.amount_minor,10900+1500);});
  await withProduct(null,()=>{assert.throws(()=>billing.parseSubscription(sub),/requires review/,'an unknown price is never silently accepted');
   assert.equal(billing.parseSubscription({items:{data:[item(PLANS.growth.product,10900)]}}).extraInspectors,0);
   // A price with no product never matches the (unset) inspector add-on.
   assert.throws(()=>billing.parseSubscription({items:{data:[item(PLANS.growth.product,10900),item(undefined,500)]}}),/requires review/);});
 }finally{await db.close();}
});

for(const [label,envFor] of engines)test('allowance on '+label+': inspectors never use a seat; beyond the free allowance they are blocked until the add-on exists', async () => {
 const dir=tmp(),db=await openDatabase(root,envFor(dir));
 try{
  const now=()=>new Date().toISOString(),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
  const billing=createStripeBilling({...db,id:randomUUID,now,fail,json:()=>{},body:async r=>r.body,audit:async()=>{},client:{},enabled:()=>false});
  const user=async(role,active=1)=>{const id=randomUUID();await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',id,'ess','Sample '+role,id+'@example.invalid','hash',role,null,null,active,now());return id;};
  await db.run('INSERT INTO organizations VALUES(?,?,?)','ess','Harborline Home Watch',now());
  await db.run("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES('ess','cus_1','sub_1','active','essentials',0,0,?)",now());
  await user('admin');for(let i=0;i<3;i++)await user('employee');
  for(let i=0;i<8;i++)await user('inspector');await user('inspector',0);
  const s=await billing.state('ess');
  assert.equal(s.usage.seats,4,'8 inspectors use no admin/staff seat');assert.equal(s.usage.inspectors,8,'suspended inspectors are not counted');
  assert.equal(s.quote.inspectors,8);assert.equal(s.quote.freeInspectors,8);assert.deepEqual(s.catalog.map(p=>p.freeInspectors),[8,20,40]);
  await assert.rejects(billing.assertCapacity('ess','seats'),/includes 4 admin\/staff users/,'seats are full on their own');
  await withProduct(null,async()=>{
   assert.equal((await billing.state('ess')).inspectorAddon.available,false);
   await assert.rejects(billing.assertCapacity('ess','inspectors'),e=>e.status===409&&/Essentials plan includes 8 free field inspector logins/.test(e.message)&&/can't be added yet/.test(e.message)&&/never use an admin\/staff seat/.test(e.message));
   // Even a stored add-on quantity is honored (it can only come from Stripe), but the message never offers a purchase.
  });
  await withProduct(PRODUCT,async()=>{
   await assert.rejects(billing.assertCapacity('ess','inspectors'),e=>/\$5 each per month/.test(e.message)&&!/can't be added yet/.test(e.message));
   await db.run("UPDATE stripe_billing SET extra_inspectors=1 WHERE organization_id='ess'");
   await billing.assertCapacity('ess','inspectors');
   const q=(await billing.state('ess')).quote;assert.equal(q.inspectors,9);assert.equal(q.monthlyMinor,5900+500);
   await user('inspector');await assert.rejects(billing.assertCapacity('ess','inspectors'),/plus 1 extra/);
  });
 }finally{await db.close();}
});

test('allow-list: explicit, small and only for the inspector role', () => {
 assert.ok(Object.isFrozen(INSPECTOR_ROUTES));
 const allowed=INSPECTOR_ROUTES.map(r=>r.method+' '+(r.path||r.pattern.source));
 for(const forbidden of ['/api/clients','/api/users','/api/invitations','/api/work','/api/invoices','/api/messages','/api/properties','/api/access-codes/save','/api/inspections/publish','/api/inspections/delete','/api/inspectors/assign'])assert.ok(!allowed.some(a=>a.endsWith(' '+forbidden)),forbidden);
 assert.equal(inspectorRoute('GET','/api/inspections/x/pdf'),null);assert.equal(inspectorRoute('POST','/api/inspections/x/check-in').check,'visitInPath');
 assert.equal(inspectorRoute('DELETE','/api/files/x'),null);assert.ok(inspectorRoute('GET','/api/files/x'));
 // The gate runs before every handler in server.mjs, right after the suspended-workspace check.
 const server=read('server.mjs');
 const gate=server.indexOf('await inspectors.gate(req,url,user);'),first=server.indexOf('if(await demos.handle(req,res,url,user))return;');
 assert.ok(gate>0&&gate<first,'gate precedes every module handler');
});

test('menu, routes and screens for inspectors', () => {
 const nav=globalThis.EASidebar.navFor({role:'inspector'});
 assert.deepEqual(nav.map(n=>n[0]),['dashboard','notifications','profile']);assert.equal(nav[0][1],'Today');
 assert.equal(globalThis.EASidebar.menu(nav,'inspector').subtitle,'Field inspector');
 const R=globalThis.EARoute,data={user:{role:'inspector'},properties:[{id:'p1'}],inspections:[{id:'i1'}]};
 for(const page of ['properties','clients','work','billing','users','messages','storm','insurance','calendar','documents'])assert.equal(R.resolve({...R.blank(),page},data).fellBack,true,page);
 assert.equal(R.resolve({...R.blank(),page:'inspection',activeInspection:'i1'},data).fellBack,false);
 assert.equal(R.resolve({...R.blank(),page:'profile'},data).fellBack,false);
 const live=read('public/live.js'),shell=read('public/live.html'),srv=read('server.mjs'),sw=read('public/sw.js'),pkg=read('package.json');
 assert.match(live,/<option value="inspector">Field inspector \(free, no seat\)<\/option>/);
 assert.match(live,/if\(data\.user\.role==='inspector'&&window\.EAInspector\)/);
 for(const f of ['inspector.js','inspector.css']){assert.ok(shell.includes('/'+f+'?v='),f);assert.ok(srv.includes(`'/${f}':'${f}'`),f);assert.match(srv,new RegExp(`SHELL_FILES = \\[[^\\]]*'${f.replace('.','\\.')}'`));assert.ok(sw.includes(`'/${f}'`),f);}
 assert.match(shell,/<script src="\/inspector\.js\?v=[^"]+"><\/script><script src="\/overview\.js\?v=[^"]+"><\/script><script src="\/view-route\.js/);
 assert.match(pkg,/node --check public\/inspector\.js/);assert.match(pkg,/node --check inspector\.mjs/);
 assert.doesNotMatch(read('public/inspector.js'),/style=/);
});

test('plan panel and public pages mention field inspector logins', () => {
 const P=globalThis.EAPlan,catalog=Object.entries(PLANS).map(([key,p])=>({key,...p,freeInspectors:freeInspectors(key)}));
 const users=[{role:'admin',active:1},{role:'inspector',active:1},{role:'inspector',active:1},{role:'inspector',active:0}];
 const html=P.panel({user:{role:'admin'},users,billing:{status:'active',connected:true,enabled:true,catalog,quote:subscriptionQuote('growth',0,0,2),usage:{residences:3,seats:1,inspectors:2,bytes:0}}});
 assert.match(html,/Field inspectors<\/strong><small>20 free with your plan plus 2 extra\. Inspectors open only their assigned visits and never use an admin\/staff seat\.<\/small>/);
 assert.match(html,/2 of 22/);assert.match(html,/2 extra field inspectors \(\$5 each\/month\)/);
 const none=P.panel({user:{role:'admin'},users,billing:{status:'not_subscribed',catalog},subscription:{}});
 assert.match(none,/Field inspectors<\/strong><small>Field inspector logins never use an admin\/staff seat\.<\/small><\/div><div class="plan-row-value">2</);
 for(const file of ['public/marketing.html','public/signup.html']){const s=read(file);for(const n of [8,20,40])assert.ok(s.includes(`<li>Plus ${n} free field inspector logins</li>`),file+' '+n);}
 assert.match(read('public/faq.html'),/<h2>What is a field inspector login\?<\/h2>/);
 assert.match(read('public/marketing.html'),/Every plan also includes free field inspector logins \(8 on Essentials, 20 on Growth, 40 on Professional\)/);
 assert.match(read('public/signup.js'),/\$\{q\.seats\*2\} free field inspector logins/);
 assert.match(read('docs/features/field-inspectors.md'),/STRIPE_INSPECTOR_PRODUCT_ID/);
});

// ---------- end-to-end on a real server ----------
function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){const e={...process.env,PORT:'0',...env,...extra};delete e.DATABASE_URL;delete e.STRIPE_SECRET_KEY;delete e.STRIPE_INSPECTOR_PRODUCT_ID;Object.assign(e,extra);proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:e,windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={async call(method,endpoint,b){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,text};},
 async req(endpoint,b,expected){const r=await c.call(b===undefined?'GET':'POST',endpoint,b);if(expected===undefined)assert.ok(r.status>=200&&r.status<300,endpoint+': '+r.status+' '+r.text.slice(0,300));else assert.equal(r.status,expected,endpoint+': '+r.text.slice(0,300));return r.body;}};return c;}
const tokenOf=inv=>new URL('http://x'+inv.invitePath).searchParams.get('invite');

/** Every API path literal in the server code, plus dynamic routes (ids filled in). */
function allApiRoutes(){
 const out=new Set();
 for(const f of readdirSync(root).filter(f=>f.endsWith('.mjs'))){
  const src=read(f);
  for(const m of src.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/.]+)['"`]/g))if(!m[1].endsWith('/'))out.add(m[1]);
 }
 for(const p of ['/api/inspections/ID/pdf','/api/files/ID/delete','/api/messages/thread','/api/storm/ID','/api/insurance/ID','/api/checklist-templates/ID/publish','/api/work/ID','/api/properties/ID'])out.add(p);
 return [...out].sort();
}
// Public endpoints that run before sign-in is considered at all (signup, demo signup, public insurance links,
// client error reports, the Stripe webhook). They behave the same for an inspector as for anyone signed out.
const PUBLIC=/^\/api\/(signup|demo-signup|demo-request|demo\/start|client-error|stripe\/webhook|webhooks\/|internal\/cron\/|insurance\/public|public)/;

for(const [label,envFor] of engines)test('server on '+label+': inspectors reach only their assigned visits', async () => {
 const dir=tmp(),pw='Test-only-strong-password-928!';
 const srv=server({...envFor(dir),ESTATEOS_DATA_DIR:dir,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64'),RESEND_API_KEY:''});await srv.start();
 try{
  const admin=client(srv),sam=client(srv),riley=client(srv),staff=client(srv),rival=client(srv);
  const setup=await admin.req('setup',{company:'Harborline Home Watch',name:'Jordan Ellis',email:'jordan@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'jordan@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Sample Ocean family',email:'family-private@example.test'},201);
  const home=async name=>(await admin.req('properties',{clientId:fam.id,name,streetAddress:'1 '+name+' Dr',city:'Stuart',state:'FL',postalCode:'34996',country:'United States',timezone:'America/New_York'},201)).id;
  const A=await home('Ocean Palm Residence'),B=await home('Private Unassigned Estate'),C=await home('Seagrape Cottage');
  for(const p of [A,B,C])await admin.req('access-codes/save',{propertyId:p,version:0,details:{gate:'1234',door:'5678',alarm:'9012',lockbox:'',instructions:'Side door'}});
  const accept=async(c,role,email,name)=>{const inv=await admin.req('invitations',{role,email},201);return (await c.req('accept-invite',{token:tokenOf(inv),name,password:pw},201)).user;};
  const samUser=await accept(sam,'inspector','sam@example.test','Sam Rivera');
  const rileyUser=await accept(riley,'inspector','riley@example.test','Riley Brooks');
  await accept(staff,'employee','staff@example.test','Taylor Staff');
  assert.equal(samUser.role,'inspector');
  // Seats: two inspectors and one staff member; only admin + staff are seats.
  const status=await admin.req('billing/status');assert.equal(status.usage.seats,2);assert.equal(status.usage.inspectors,2);

  // Office assigns visits.
  const vToday=(await admin.req('inspectors/assign',{propertyId:A,inspectorId:samUser.id,date:today()},201)).id;
  const vLater=(await admin.req('inspectors/assign',{propertyId:C,inspectorId:samUser.id,date:today('America/New_York',5)},201)).id;
  const vRiley=(await admin.req('inspectors/assign',{propertyId:A,inspectorId:rileyUser.id,date:today()},201)).id;
  const vStaff=(await admin.req('inspections',{propertyId:B,date:today()},201)).id;
  await admin.req('inspectors/assign',{propertyId:A,inspectorId:setup.user.id,date:today()},422);
  assert.equal((await staff.call('POST','inspectors/assign',{propertyId:A,inspectorId:samUser.id,date:today()})).status,403,'only admins assign');
  const adminDoc=await admin.req('files',{propertyId:A,name:'manual.pdf',base64:Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),visibility:'internal'},201);
  const staffPhoto=await admin.req('files',{propertyId:B,inspectionId:vStaff,name:'b.jpg',base64:jpeg},201);

  // A second company, with its own residence, inspector visit, photo and codes.
  const inv=await admin.req('platform/invite',{company:'Gulf Breeze Home Watch',email:'rival@example.test'},201);
  await rival.req('workspace-register',{token:new URL('http://x'+inv.invitePath).searchParams.get('workspaceInvite'),name:'Rival Admin',password:pw},201);
  const rf=await rival.req('clients',{name:'Rival family'},201);
  const R=(await rival.req('properties',{clientId:rf.id,name:'Rival Bay House',streetAddress:'9 Bay Rd',city:'Naples',state:'FL',postalCode:'34102',country:'United States'},201)).id;
  await rival.req('access-codes/save',{propertyId:R,version:0,details:{gate:'0000',door:'1111',alarm:'',lockbox:'',instructions:''}});
  const vRival=(await rival.req('inspections',{propertyId:R,date:today()},201)).id;
  const rivalPhoto=await rival.req('files',{propertyId:R,inspectionId:vRival,name:'r.jpg',base64:jpeg},201);
  // The rival company's admin cannot assign to Harborline's inspector.
  await rival.req('inspectors/assign',{propertyId:R,inspectorId:samUser.id,date:today()},422);

  // ---- /api/data is the trimmed inspector payload ----
  const d=await sam.req('data'),S=JSON.stringify(d);
  assert.equal(d.user.role,'inspector');assert.equal(d.user.platformAccess,false);
  assert.deepEqual(d.inspections.map(i=>i.id).sort(),[vToday,vLater].sort());
  assert.deepEqual(d.properties.map(p=>p.id).sort(),[A,C].sort());
  for(const k of ['clients','users','invoices','work','requests','notes','audit','vendors','invitations','assets','arrivals','maintenance','shopping','checklists'])assert.deepEqual(d[k],[],k+' is empty');
  for(const p of d.properties)for(const k of ['client_id','client_name','client_profile','manual','account_manager_id','account_manager_name','inspection_report_email'])assert.ok(!(k in p),'residence field '+k+' hidden');
  for(const w of ['Sample Ocean family','family-private@example.test','Private Unassigned Estate','Riley Brooks','Taylor Staff','Gulf Breeze','Rival',vRiley,vStaff,adminDoc.id,staffPhoto.id,'1234','5678'])assert.ok(!S.includes(w),'inspector /api/data never includes '+w);
  assert.ok(d.inspections.every(i=>Array.isArray(i.answers)&&i.answers.length&&!('report_email' in i)),'checklist answers present, report recipient hidden');
  assert.ok(d.notifications.length===0||d.notifications.every(n=>n),'notifications list is present');
  const notes=await sam.req('notifications');assert.ok(JSON.stringify(notes).includes('Visit assigned: Ocean Palm Residence'),'the inspector is notified of assignments');

  // ---- every other API route is refused before any handler runs ----
  const routes=allApiRoutes();assert.ok(routes.length>120,'found '+routes.length+' API routes');
  const unexpected=[];
  for(const p of routes){if(PUBLIC.test(p))continue;for(const method of ['GET','POST']){
   if(inspectorRoute(method,p))continue;
   const r=await sam.call(method,p.slice(5),method==='POST'?{}:undefined);
   if(r.status!==403||!DENIED.test(r.body.error||''))unexpected.push(`${method} ${p} -> ${r.status} ${r.text.slice(0,80)}`);
  }}
  assert.deepEqual(unexpected,[],'every non-allow-listed route is refused for inspectors');
  for(const [method,p] of [['DELETE','files/'+adminDoc.id],['PUT','profile'],['PATCH','inspections/save'],['GET','inspections/'+vToday+'/pdf'],['POST','inspections/publish'],['POST','inspections/delete'],['POST','inspections/reopen'],['POST','access-codes/save'],['POST','inspections'],['POST','inspectors/assign'],['GET','messages'],['POST','messages'],['GET','owner/overview'],['GET','billing/status'],['GET','operations']]){
   const r=await sam.call(method,p,method==='GET'||method==='DELETE'?undefined:{id:vToday,propertyId:A});assert.equal(r.status,403,method+' '+p);
  }

  // ---- allowed routes still check ownership ----
  const saveBody=(id,version=1)=>({id,version,answers:d.inspections.find(i=>i.id===vToday).answers.map(a=>({...a,status:'pass'})),summary:'All secure',notes:'',internalNotes:'Checked garage'});
  for(const id of [vRiley,vStaff,vRival,'missing']){
   assert.equal((await sam.call('POST','inspections/save',saveBody(id))).status,404,'save '+id);
   assert.equal((await sam.call('POST','inspections/submit',{id,version:1})).status,404,'submit '+id);
   assert.equal((await sam.call('POST','inspections/'+id+'/check-in',{})).status,404,'check-in '+id);
   assert.equal((await sam.call('GET','offline/inspections/'+id)).status,404,'offline '+id);
  }
  await sam.req('inspections/save',saveBody(vToday));
  assert.equal((await sam.req('offline/inspections/'+vToday)).inspection.internal_notes,'Checked garage');
  const off=await sam.req('offline/visits?propertyIds='+[A,B,C,R].join(','));
  assert.deepEqual(off.properties.map(p=>p.id).sort(),[A,C].sort(),'offline copies only for assigned residences');
  assert.deepEqual(off.inspections.map(i=>i.id).sort(),[vToday,vLater].sort(),'no other inspector visits and no earlier reports');
  assert.ok(off.properties.every(p=>!('client_name' in p)&&!('inspection_report_email' in p)&&!('account_manager_name' in p)));

  // Photos: only on their own draft at that residence, stored staff-only.
  assert.equal((await sam.call('POST','files',{propertyId:A,inspectionId:vRiley,name:'x.jpg',base64:jpeg})).status,404);
  assert.equal((await sam.call('POST','files',{propertyId:C,inspectionId:vToday,name:'x.jpg',base64:jpeg})).status,422);
  assert.equal((await sam.call('POST','files',{propertyId:A,name:'x.jpg',base64:jpeg})).status,403,'no residence documents');
  assert.equal((await sam.call('POST','files',{propertyId:R,inspectionId:vRival,name:'x.jpg',base64:jpeg})).status,404);
  const mine=await sam.req('files',{propertyId:A,inspectionId:vToday,name:'kitchen.jpg',base64:jpeg,visibility:'client'},201);
  assert.equal((await fetch(srv.base+'/api/files/'+mine.id,{headers:{Cookie:''}})).status,401);
  const own=await sam.call('GET','files/'+mine.id);assert.equal(own.status,200);
  for(const f of [adminDoc,staffPhoto,rivalPhoto])assert.equal((await sam.call('GET','files/'+f.id)).status,404,'file '+f.id);
  const adminView=await admin.req('data');assert.equal(adminView.files.find(f=>f.id===mine.id).visibility,'internal','inspector photos are staff-only until published');

  // Door codes: only on the day of an assigned visit.
  const codes=await sam.req('access-codes/read',{propertyId:A});assert.equal(codes.details.door,'5678');
  const later=await sam.call('POST','access-codes/read',{propertyId:C});assert.equal(later.status,403);assert.match(later.body.error,/only on the day of a visit assigned to you/);
  assert.equal((await sam.call('POST','access-codes/read',{propertyId:B})).status,404);
  assert.equal((await sam.call('POST','access-codes/read',{propertyId:R})).status,404);
  assert.equal((await sam.call('POST','access-codes/save',{propertyId:A,version:1,details:{door:'0000'}})).status,403);
  assert.ok((await admin.req('data')).audit.some(a=>a.action==='access_codes.viewed'&&a.actor_name==='Sam Rivera'),'every code view is audited');

  // Mark complete: waits for the office; the inspector can no longer edit it.
  const fresh=(await sam.req('data')).inspections.find(i=>i.id===vToday);
  await sam.req('inspections/submit',{id:vToday,version:fresh.version});
  assert.equal((await admin.req('data')).inspections.find(i=>i.id===vToday).status,'submitted');
  assert.equal((await sam.call('POST','inspections/save',saveBody(vToday,fresh.version+1))).status,409);
  // Admin reassigns the remaining draft to Riley: it leaves Sam's list.
  await admin.req('inspectors/reassign',{inspectionId:vLater,inspectorId:rileyUser.id});
  assert.deepEqual((await sam.req('data')).inspections.map(i=>i.id),[vToday]);
  assert.equal((await admin.call('POST','inspectors/reassign',{inspectionId:vToday,inspectorId:rileyUser.id})).status,409,'completed visits are not reassigned');

  // Messaging: inspectors are not in the people list and can't be messaged.
  const people=(await admin.req('messages')).people;assert.ok(!people.some(p=>p.role==='inspector'));
  const sent=await admin.call('POST','messages/send',{recipientId:samUser.id,subject:'Hello',message:'hello',messageId:randomUUID()});assert.equal(sent.status,422);assert.match(sent.body.error,/Choose an active account/);

  // Suspended inspectors lose access; reactivation checks the inspector allowance, not seats.
  await admin.req('users/suspend',{userId:rileyUser.id},201);
  assert.equal((await riley.call('GET','data')).status,401);
  await admin.req('users/reactivate',{userId:rileyUser.id},201);
  // The admin's Team page data includes the inspectors with their role.
  assert.deepEqual((await admin.req('data')).users.filter(u=>u.role==='inspector').map(u=>u.name).sort(),['Riley Brooks','Sam Rivera']);
  // Platform owner view counts inspectors separately from seats.
  const harbor=(await admin.req('owner/overview')).companies.find(c=>c.name==='Harborline Home Watch');
  assert.equal(harbor.usage.inspectors,2);assert.equal(harbor.usage.seats,2);
  assert.doesNotMatch(srv.log,/TypeError|ReferenceError/);
 }finally{await srv.stop();}
});

test('server on SQLite: the 9th inspector on Essentials is refused with a clear message until the add-on exists', async () => {
 const dir=tmp(),pw='Test-only-strong-password-928!';
 const srv=server({ESTATEOS_DATA_DIR:dir});await srv.start();
 try{
  const admin=client(srv);
  const setup=await admin.req('setup',{company:'Harborline Home Watch',name:'Jordan Ellis',email:'jordan@example.test',password:pw},201);
  await srv.stop();
  const sql=new DatabaseSync(path.join(dir,'estateos.sqlite'));
  const org=sql.prepare('SELECT organization_id FROM users WHERE id=?').get(setup.user.id).organization_id;
  sql.prepare("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES(?,?,?,'active','essentials',0,0,?)").run(org,'cus_t','sub_t',new Date().toISOString());
  for(let i=0;i<8;i++)sql.prepare("INSERT INTO users VALUES(?,?,?,?,?,'inspector',NULL,NULL,1,?)").run(randomUUID(),org,'Sample Inspector '+i,`insp${i}@example.test`,'hash',new Date().toISOString());
  sql.close();
  await srv.start();await admin.req('login',{email:'jordan@example.test',password:pw});
  const blocked=await admin.call('POST','invitations',{role:'inspector',email:'ninth@example.test'});
  assert.equal(blocked.status,409);assert.match(blocked.body.error,/Your Essentials plan includes 8 free field inspector logins, and all are in use\. Extra field inspector logins \(\$5 each per month\) can't be added yet\./);
  // Staff seats are unaffected: an employee invitation still works (1 of 4 seats used).
  await admin.req('invitations',{role:'employee',email:'staff@example.test'},201);
  const st=await admin.req('billing/status');assert.equal(st.usage.seats,1);assert.equal(st.usage.inspectors,8);assert.equal(st.inspectorAddon.available,false);
  // With the product configured and one extra inspector on the subscription, the 9th is allowed.
  await srv.stop();
  const sql2=new DatabaseSync(path.join(dir,'estateos.sqlite'));sql2.prepare('UPDATE stripe_billing SET extra_inspectors=1 WHERE organization_id=?').run(org);sql2.close();
  await srv.start({STRIPE_INSPECTOR_PRODUCT_ID:PRODUCT});await admin.req('login',{email:'jordan@example.test',password:pw});
  await admin.req('invitations',{role:'inspector',email:'ninth@example.test'},201);
  assert.equal((await admin.req('billing/status')).inspectorAddon.available,true);
 }finally{await srv.stop();}
});
