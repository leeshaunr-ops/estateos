// Owner monitoring ("Platform" screen): Stripe webhook sync (signature, idempotency, ordering, test/live mode),
// backfill from stored billing rows, the overview numbers (MRR, trials vs paid, usage vs limits, recent signups,
// trials ending in 7 days, failed payments, cancellations, /demo requests), trials treated as good standing, the
// browser view (Eastern Time dates, no inline styles, no scrolling boxes), and strict owner-only access: other
// companies' admins, staff, clients and vendors get 404, signed-out gets 401, and /api/data never leaks another
// company. Module scenarios run on SQLite and Postgres (PGlite); the server scenario runs on both too.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID,createHmac,createHash,randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../database.mjs';
import {createPlatformMonitor,subscriptionFields} from '../platform-monitor.mjs';
import {createStripeBilling} from '../stripe-billing.mjs';
import {createPaidSignup} from '../paid-signup.mjs';
import {PLANS,ADDONS} from '../stripe-plans.mjs';
import '../public/platform-owner.js';
import '../public/sidebar-core.js';
import '../public/view-route.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-owner-'));dirs.push(d);return d;};
const NOW=Date.parse('2026-10-04T13:25:00Z'),DAY=86400000,sec=ms=>Math.floor(ms/1000);
const item=(p,quantity=1,extra={})=>({quantity,price:{product:p.product,currency:'usd',unit_amount:p.monthlyMinor,recurring:{interval:'month',interval_count:1}},...extra});
const sub=(id,org,status,items,extra={})=>({id,object:'subscription',customer:'cus_'+id,status,livemode:false,currency:'usd',metadata:org?{organization_id:org}:{},items:{data:items},current_period_start:sec(NOW-10*DAY),current_period_end:sec(NOW+20*DAY),...extra});
let evt=0;const event=(type,object,createdMs=NOW,livemode=false)=>({id:'evt_'+(++evt),type,created:sec(createdMs),livemode,data:{object}});
const engines=[['SQLite',d=>({ESTATEOS_DATA_DIR:d})],['Postgres (PGlite)',d=>({NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')})]];

test('subscriptionFields: plan, add-ons, monthly amount, trial and periods (old and new Stripe API shapes)', () => {
 const f=subscriptionFields(sub('sub_1','org1','trialing',[item(PLANS.growth),item(ADDONS.seats,2),item(ADDONS.storage,1)],{trial_end:sec(NOW+5*DAY)}));
 assert.equal(f.plan,'growth');assert.equal(f.extra_seats,2);assert.equal(f.storage_packs,1);assert.equal(f.amount_minor,10900+3000+500);
 assert.equal(f.organization_id,'org1');assert.equal(f.trial_end,new Date(sec(NOW+5*DAY)*1000).toISOString());
 const newer=subscriptionFields({id:'sub_2',status:'active',customer:{id:'cus_2'},metadata:{},items:{data:[item(PLANS.essentials,1,{current_period_start:sec(NOW),current_period_end:sec(NOW+30*DAY)})]}});
 assert.equal(newer.customer_id,'cus_2');assert.equal(newer.current_period_end,new Date(sec(NOW+30*DAY)*1000).toISOString());assert.equal(newer.amount_minor,5900);
});

for(const [label,envFor] of engines)test('webhook sync, backfill and overview numbers on '+label, async () => {
 const db=await openDatabase(root,envFor(tmp()));
 const now=()=>new Date(NOW).toISOString(),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 const reconciled=[];
 const monitor=createPlatformMonitor({...db,json:(res,code,data)=>{res.code=code;res.data=data;},fail,now,platformOwner:u=>u?.id==='owner',audit:async()=>{},billing:{reconcile:async org=>reconciled.push(org)},env:{STRIPE_WEBHOOK_SECRET:'whsec_test'},clock:()=>NOW});
 const iso=ms=>new Date(ms).toISOString();
 try{
  const orgs=[['harbor','Harborline Home Watch',NOW-3*DAY],['coastal','Coastal Estate Care',NOW-40*DAY],['palm','Palm Key Residences',NOW-10*DAY],['gulf','Gulf Breeze Home Watch',NOW-60*DAY],['legacy','Seaside Legacy Co',NOW-90*DAY],['demo1','Bayview · Private demo',NOW-2*DAY]];
  for(const [id,name,at] of orgs){await db.run('INSERT INTO organizations VALUES(?,?,?)',id,name,iso(at));await db.run('INSERT INTO workspace_settings(organization_id) VALUES(?)',id);}
  const user=async(org,role,active=1,name=role,email=null)=>{const id=randomUUID();await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',id,org,name,email||id+'@example.invalid','hash',role,null,null,active,now());return id;};
  const jordan=await user('harbor','admin',1,'Jordan Ellis','jordan@harborline.example');await db.run('UPDATE workspace_settings SET primary_admin_id=? WHERE organization_id=?',jordan,'harbor');
  for(let i=0;i<3;i++)await user('harbor','employee');for(let i=0;i<5;i++){await user('harbor','client');await user('harbor','vendor');}await user('harbor','employee',0);
  const client=await db.get("SELECT id FROM users WHERE organization_id='harbor' AND role='admin'");
  await db.run('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)','fam','harbor','Sample family',now());
  for(let i=0;i<12;i++)await db.run('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,manual,created_at) VALUES(?,?,?,?,?,?,?,?)','p'+i,'harbor','fam','Home '+i,'1 Road','America/New_York','',now());
  await db.run("UPDATE properties SET archived_at=? WHERE id='p11'",now());
  // Existing billing rows (as stored before webhooks): Coastal active Growth, Gulf past due Essentials.
  await db.run("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES('coastal','cus_c','sub_c','active','growth',1,0,?)",now());
  await db.run("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES('gulf','cus_g','sub_g','past_due','essentials',0,0,?)",now());
  await db.run('INSERT INTO demo_workspaces VALUES(?,?,?,?)','demo1',await user('demo1','admin',1,'Pat Demo','pat@bayview.example'),NOW+5*DAY,now());
  const ownerId=await user('legacy','admin',1,'Platform Owner','owner@example.invalid');
  await db.run('INSERT INTO workspace_invites VALUES(?,?,?,?,?,?)','tok1','Bayview · Private demo','pat@bayview.example',ownerId,NOW,null);
  await db.run('INSERT INTO workspace_invites VALUES(?,?,?,?,?,?)','tok2','Dune Road · Private demo','sam@dune.example',ownerId,NOW,null);
  await db.run('INSERT INTO demo_requests(email,name,company,phone,residences,token_hash,requested_at,verified_at) VALUES(?,?,?,?,?,?,?,?)','pat@bayview.example','Pat Demo','Bayview Home Watch','','11–50','tok1',NOW-2*DAY,iso(NOW-2*DAY));
  await db.run('INSERT INTO demo_requests(email,name,company,phone,residences,token_hash,requested_at) VALUES(?,?,?,?,?,?,?)','sam@dune.example','Sam Rivers','Dune Road Watch','','1–10','tok2',NOW-DAY);

  // Backfill copies stored billing rows (no Stripe key: local only).
  assert.deepEqual(await monitor.backfill(),{local:2,stripe:0,failed:0});
  assert.equal(Number((await db.get("SELECT amount_minor FROM stripe_subscription_sync WHERE subscription_id='sub_c'")).amount_minor),12400);

  // Webhooks: Harborline starts a Growth trial ending in 5 days; Palm is active Professional, then cancels at period end.
  const r1=await monitor.apply(event('customer.subscription.created',sub('sub_h','harbor','trialing',[item(PLANS.growth)],{trial_end:sec(NOW+5*DAY),trial_start:sec(NOW-3*DAY)})));
  assert.equal(r1.result,'updated');assert.equal(r1.organizationId,'harbor');
  await monitor.apply(event('customer.subscription.created',sub('sub_p','palm','active',[item(PLANS.professional),item(ADDONS.storage,2)]),NOW-9*DAY));
  const update=event('customer.subscription.updated',sub('sub_p','palm','active',[item(PLANS.professional),item(ADDONS.storage,2)],{cancel_at_period_end:true}),NOW-DAY);
  assert.equal((await monitor.apply(update)).result,'updated');
  assert.equal((await monitor.apply(update)).result,'duplicate','same event id is applied once');
  // An older event arriving late never overwrites newer data.
  assert.equal((await monitor.apply(event('customer.subscription.updated',sub('sub_p','palm','incomplete',[item(PLANS.professional)]),NOW-8*DAY))).result,'stale');
  // Gulf: payment failed (no metadata on the invoice; matched through stripe_billing), then the subscription is deleted.
  assert.equal((await monitor.apply(event('invoice.payment_failed',{object:'invoice',subscription:'sub_g',customer:'cus_g',amount_due:5900},NOW-2*DAY))).organizationId,'gulf');
  // Backfill again: webhook-sourced rows are never overwritten by stored rows.
  await monitor.backfill();
  // Test-mode servers ignore live events (and vice versa).
  assert.deepEqual(await monitor.apply(event('customer.subscription.deleted',sub('sub_c','coastal','canceled',[item(PLANS.growth)]),NOW,true)),{ignored:'mode'});
  assert.deepEqual(await monitor.apply(event('charge.refunded',{object:'charge'})),{ignored:'type'});
  assert.equal(reconciled.length,0,'access re-checks only run with live billing configured');

  const o=await monitor.overview();
  const c=id=>o.companies.find(x=>x.id===id);
  assert.equal(o.metrics.companies,5,'demo workspaces are not counted as companies');
  assert.equal(o.metrics.paid,2,'Coastal and Palm are active');
  assert.equal(o.metrics.mrrMinor,12400+17900+1000,'MRR = active subscriptions only');
  assert.equal(o.metrics.trialing,1);assert.equal(o.metrics.trialValueMinor,10900);
  assert.equal(o.metrics.pastDue,1);assert.equal(o.metrics.noSubscription,1);assert.equal(o.metrics.demosActive,1);assert.equal(o.metrics.demoRequests30,2);
  assert.equal(o.metrics.signups30,2,'Harborline and Palm signed up in the last 30 days');
  assert.deepEqual(o.trialsEndingSoon,['harbor']);assert.deepEqual(o.cancellations,['palm']);
  assert.equal(o.failedPayments.length,1);assert.equal(o.failedPayments[0].company,'Gulf Breeze Home Watch');assert.equal(o.failedPayments[0].amountMinor,5900);
  const h=c('harbor');
  assert.equal(h.status,'trialing');assert.equal(h.kind,'trial');assert.equal(h.planName,'Growth');assert.equal(h.trialDaysLeft,5);assert.equal(h.trialEndEstimated,false);
  assert.deepEqual(h.usage,{residences:11,seats:4,portalUsers:10,bytes:0},'archived homes, suspended staff and client/vendor logins are not counted as seats');
  assert.deepEqual(h.limits,{residences:150,seats:10,storageBytes:30e9});assert.deepEqual(h.admin,{name:'Jordan Ellis',email:'jordan@harborline.example'});
  assert.equal(c('palm').cancelAtPeriodEnd,true);assert.equal(c('palm').addOns.storagePacks,2);assert.equal(c('palm').limits.storageBytes,90e9);
  assert.equal(c('coastal').limits.seats,11,'Growth 10 + 1 extra user');assert.equal(c('coastal').syncSource,'backfill');
  assert.equal(c('gulf').lastPaymentFailedMinor,5900);assert.equal(c('gulf').status,'past_due');
  assert.equal(c('legacy').status,'no_subscription');assert.equal(c('legacy').limits.seats,null);assert.equal(c('legacy').limits.storageBytes,10e9);
  assert.equal(c('demo1').kind,'demo');
  const bay=o.demoRequests.find(r=>r.email==='pat@bayview.example'),dune=o.demoRequests.find(r=>r.email==='sam@dune.example');
  assert.equal(bay.status,'demo_active');assert.equal(dune.status,'invited');
  assert.equal(JSON.stringify(o).includes('access_code'),false);assert.equal(JSON.stringify(o).includes('Sample family'),false,'no client records');

  // Cancellation via webhook moves Gulf to canceled.
  await monitor.apply(event('customer.subscription.deleted',sub('sub_g','gulf','canceled',[item(PLANS.essentials)],{canceled_at:sec(NOW-3600000),ended_at:sec(NOW-3600000)})));
  const o2=await monitor.overview();assert.deepEqual(o2.cancellations.sort(),['gulf','palm']);assert.equal(o2.metrics.canceled,1);assert.equal(o2.metrics.pastDue,0);
  assert.equal(o2.companies.find(x=>x.id==='gulf').lastPaymentFailedMinor,5900,'the failed-payment record survives the subscription update');

  // Access control inside the handler.
  const call=async(user,p,method='GET')=>{const res={};await monitor.handle({method},res,new URL('https://test'+p),user);return res;};
  await assert.rejects(call(null,'/api/owner/overview'),e=>e.status===401);
  await assert.rejects(call({id:jordan,role:'admin'},'/api/owner/overview'),e=>e.status===404);
  assert.equal((await call({id:'owner',role:'admin'},'/api/owner/overview')).code,200);
  assert.equal(await monitor.handle({method:'GET'},{},new URL('https://test/api/data'),{id:'owner'}),false);
 }finally{await db.close();}
});

test('trials are good standing: a 30-day-trial checkout verifies, creates the company and allows adding records', async () => {
 const db=await openDatabase(root,{ESTATEOS_DATA_DIR:tmp()});
 const now=()=>new Date().toISOString(),hash=s=>createHash('sha256').update(s).digest('hex'),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 const deps={...db,id:randomUUID,now,hash,randomBytes,body:async req=>req.body,json:(res,code,data)=>res.data=data,fail,rate:()=>{},audit:async()=>{}};
 try{
  await db.run('INSERT INTO organizations VALUES(?,?,?)','platform','Platform',now());
  await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','owner','platform','Owner','owner@example.invalid','hash','admin',null,null,1,now());
  let session,status='trialing';
  const client={checkout:async b=>{session={id:'cs_t',mode:'subscription',client_reference_id:b.organizationId,metadata:{attempt_id:b.attemptId},subscription:'sub_t',customer:'cus_t'};return {id:'cs_t',url:'https://checkout.stripe.com/c/pay/cs_t'};},
   request:async route=>route.startsWith('checkout/')?{...session,livemode:true,status:'complete',payment_status:'no_payment_required'}:{livemode:true,id:'sub_t',customer:'cus_t',metadata:{organization_id:session.client_reference_id},status,trial_end:sec(Date.now()+30*DAY),latest_invoice:{status:'paid',amount_paid:0},items:{data:[item(PLANS.essentials)]}}};
  const billing=createStripeBilling({...deps,client,enabled:()=>true});
  const signup=createPaidSignup({...deps,client,parseSubscription:billing.parseSubscription,ownerId:()=>'owner',enabled:()=>true,encrypt:JSON.stringify,decrypt:JSON.parse,send:async()=>({emailStatus:'sent'})});
  await signup.handle({method:'POST',body:{company:'Harborline Home Watch',email:'jordan@example.invalid',confirmEmail:'jordan@example.invalid',plan:'essentials',extraSeats:0,storagePacks:0,acceptMonthlyMinor:5900,acceptTerms:'on',acceptBilling:'on',acceptedLegalVersion:'2026-09-14'}},{},new URL('https://test/api/signup/start'));
  const row=await db.get('SELECT * FROM paid_signups');await signup.reconcile(row.id);
  assert.equal((await db.get('SELECT status FROM paid_signups')).status,'invited','a trial checkout is verified');
  const b=await db.get('SELECT * FROM stripe_billing WHERE organization_id=?',row.organization_id);assert.equal(b.status,'trialing');assert.equal(b.plan,'essentials');
  await billing.assertCapacity(row.organization_id,'residences');
  await billing.reconcile(row.organization_id);assert.equal((await billing.state(row.organization_id)).status,'trialing');
  status='past_due';await billing.reconcile(row.organization_id);await assert.rejects(billing.assertCapacity(row.organization_id,'residences'),e=>e.status===409);
 }finally{await db.close();}
});

test('Platform view: ET dates, lists, usage meters, phone-safe markup and no inline styles', () => {
 const O=globalThis.EAOwner;
 assert.equal(O.fmtDate('2026-10-04T02:30:00Z'),'Oct 3, 2026','Eastern Time, not UTC');
 assert.equal(O.fmtDateTime('2026-10-04T13:25:00Z'),'Oct 4, 2026, 9:25 AM ET');
 assert.equal(O.fmtDate(null),'—');
 const company=(id,name,extra={})=>({id,name,signupAt:'2026-10-01T14:00:00Z',workspaceStatus:'active',admin:{name:'Jordan Ellis',email:'jordan@harborline.example'},kind:'trial',status:'trialing',plan:'growth',planName:'Growth',amountMinor:10900,trialEnd:'2026-10-09T14:00:00Z',trialEndEstimated:false,periodEnd:null,cancelAtPeriodEnd:false,canceledAt:null,endedAt:null,lastPaymentFailedAt:null,lastPaymentFailedMinor:null,demoExpiresAt:null,usage:{residences:11,seats:4,portalUsers:10,bytes:2.5e9},limits:{residences:150,seats:10,storageBytes:30e9},addOns:{extraSeats:0,storagePacks:0},...extra});
 const m={generatedAt:'2026-10-04T13:25:00Z',metrics:{mrrMinor:31300,trialValueMinor:10900,pastDueMinor:5900,companies:4,paid:2,trialing:1,pastDue:1,canceled:0,noSubscription:0,demosActive:1,demoRequests30:2,signups30:1},
  recentSignups:['h'],trialsEndingSoon:['h'],cancellations:[],failedPayments:[{companyId:'g',company:'Gulf Breeze Home Watch',at:'2026-10-02T15:00:00Z',amountMinor:5900,status:'past_due'}],
  demoRequests:[{name:'Pat Demo',company:'Bayview Home Watch',email:'pat@bayview.example',residences:'11–50',requestedAt:'2026-10-02T12:00:00Z',status:'demo_active',demoEndsAt:'2026-10-09T12:00:00Z'}],
  companies:[company('h','Harborline Home Watch'),company('g','Gulf Breeze Home Watch',{status:'past_due',kind:'paid',plan:'essentials',planName:'Essentials',amountMinor:5900,trialEnd:null,lastPaymentFailedAt:'2026-10-02T15:00:00Z',lastPaymentFailedMinor:5900,usage:{residences:52,seats:4,portalUsers:3,bytes:0},limits:{residences:50,seats:4,storageBytes:10e9}})],webhook:{configured:true,mode:'test',lastEventAt:'2026-10-04T13:00:00Z'}};
 const html=O.html(m,Date.parse('2026-10-04T13:25:00Z'));
 assert.match(html,/Monthly recurring revenue<\/span><b>\$313<\/b>/);assert.match(html,/On free trial<\/span><b>1<\/b><small>\$109\/month after trials<\/small>/);
 assert.match(html,/Trials ending in 7 days/);assert.match(html,/Oct 9, 2026 · 5 days left/);
 assert.match(html,/Gulf Breeze Home Watch<\/strong><small>Oct 2, 2026, 11:00 AM ET<\/small>/);
 assert.match(html,/Residences<\/span><span class="owner-usage-value">52 of 50 · over limit/);
 assert.match(html,/Client and vendor logins<\/span><span class="owner-usage-value">10 · unlimited/);
 assert.match(html,/Bayview Home Watch<\/strong><small>Pat Demo · pat@bayview\.example · 11–50 residences · Requested Oct 2, 2026<\/small><\/div><span class="owner-li-end">Demo active · ends Oct 9, 2026/);
 assert.match(html,/Stripe webhook connected \(test mode\) · last event Oct 4, 2026, 9:00 AM ET/);
 assert.doesNotMatch(html,/style=|<script|table-wrap|overflow/);
 const css=read('public/platform-owner.css');assert.doesNotMatch(css,/overflow(-x|-y)?:\s*(auto|scroll)/,'no scrolling boxes');assert.match(css,/@media\(max-width:760px\)/);
 assert.match(css,/Georgia/);assert.match(css,/#8b242b/);
});

test('menu and routing: only the platform owner gets the Platform screen; scripts ship with the app shell', () => {
 const S=globalThis.EASidebar,R=globalThis.EARoute;
 const ids=(role,platformOwner)=>S.navFor({role,platformOwner}).map(n=>n[0]);
 assert.ok(ids('admin',true).includes('platform-owner'));
 for(const [role,owner] of [['admin',false],['employee',false],['employee',true],['client',false],['client',true],['vendor',false],['vendor',true]])assert.ok(!ids(role,owner).includes('platform-owner'),role+(owner?' (flag)':''));
 assert.equal(S.menu(S.navFor({role:'admin',platformOwner:true}),'admin').sections.find(s=>s.title==='Company').items.some(i=>i.id==='platform-owner'&&i.label==='Platform'),true);
 const owner={user:{id:'o',role:'admin',platformOwner:true}},admin={user:{id:'a',role:'admin',platformOwner:false}};
 assert.equal(R.resolve(R.parse('#/platform-owner'),owner).state.page,'platform-owner');
 assert.equal(R.resolve(R.parse('#/platform-owner'),admin).fellBack,true);
 const html=read('public/live.html'),server=read('server.mjs'),sw=read('public/sw.js'),pkg=read('package.json'),live=read('public/live.js');
 for(const f of ['platform-owner.js','platform-owner.css']){assert.ok(html.includes('/'+f+'?v='));assert.ok(server.includes(`'/${f}':'${f}'`));assert.match(server,new RegExp(`SHELL_FILES = \\[[^\\]]*'${f.replace('.','\\.')}'`));assert.ok(sw.includes(`'/${f}'`));}
 assert.match(pkg,/node --check public\/platform-owner\.js/);assert.match(pkg,/node --check platform-monitor\.mjs/);
 assert.match(live,/if\(page==='platform-owner'&&data\.user\.platformOwner&&window\.EAOwner\)return window\.EAOwner\.page\(\);/);
 assert.match(html,/<script src="\/overview\.js\?v=[^"]+"><\/script><script src="\/view-route\.js/);
});

function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){const e={...process.env,PORT:'0',...env,...extra};delete e.DATABASE_URL;delete e.STRIPE_SECRET_KEY;proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:e,windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={async call(method,endpoint,b){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,text};},
 async req(endpoint,b,expected=200){const r=await c.call(b===undefined?'GET':'POST',endpoint,b);assert.equal(r.status,expected,endpoint+': '+r.text.slice(0,300));return r.body;}};return c;}
const sign=(payload,secret,t=Math.floor(Date.now()/1000))=>`t=${t},v1=${createHmac('sha256',secret).update(t+'.'+payload).digest('hex')}`;

for(const [label,envFor] of engines)test('server: owner-only Platform endpoints, signed webhook, and no cross-company data in /api/data on '+label, async () => {
 const dir=tmp(),pw='Test-only-strong-password-928!',secret='whsec_test_'+randomUUID();
 const srv=server({...envFor(dir),ESTATEOS_DATA_DIR:dir,STRIPE_WEBHOOK_SECRET:secret});await srv.start();
 try{
  const owner=client(srv),rivalAdmin=client(srv),staff=client(srv),family=client(srv),vendor=client(srv),secondAdmin=client(srv),anon=client(srv);
  const setup=await owner.req('setup',{company:'EstateAegis Platform',name:'Platform Owner',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await owner.req('login',{email:'owner@example.test',password:pw});
  // A second company with its own admin, staff, client and vendor.
  const invite=await owner.req('platform/invite',{company:'Harborline Home Watch',email:'jordan@example.test'},201);
  await rivalAdmin.req('workspace-register',{token:new URL('http://x'+invite.invitePath).searchParams.get('workspaceInvite'),name:'Jordan Ellis',password:pw},201);
  const fam=await rivalAdmin.req('clients',{name:'Sample family'},201),vend=await rivalAdmin.req('vendors',{name:'Sample Pool Service'},201);
  await rivalAdmin.req('properties',{clientId:fam.id,name:'Ocean Palm Residence',streetAddress:'1 Ocean Palm Dr',city:'Stuart',state:'FL',postalCode:'34996',country:'United States'},201);
  const accept=async(c,role,email,extra={})=>{const inv=await rivalAdmin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email.split('@')[0],password:pw},201);};
  await accept(staff,'employee','staff@example.test');await accept(family,'client','family@example.test',{clientId:fam.id});await accept(vendor,'vendor','vendor@example.test',{vendorId:vend.id});
  // A second admin in the owner's own company is not the owner either.
  const inv2=await owner.req('invitations',{role:'admin',email:'second@example.test'},201);await secondAdmin.req('accept-invite',{token:new URL('http://x'+inv2.invitePath).searchParams.get('invite'),name:'Second Admin',password:pw},201);

  assert.equal((await anon.call('GET','owner/overview')).status,401);
  for(const [who,c] of [['other company admin',rivalAdmin],['staff',staff],['client',family],['vendor',vendor],['second admin in the owner company',secondAdmin]]){
   const r=await c.call('GET','owner/overview');assert.equal(r.status,404,who+' cannot see the Platform overview');assert.doesNotMatch(r.text,/Harborline|EstateAegis Platform|mrr/i,who);
   assert.equal((await c.call('POST','owner/backfill',{})).status,404,who+' cannot run backfill');
   const d=await c.req('data');assert.equal(d.user.platformOwner,false);
   assert.ok(!(await c.req('data').then(x=>S(x))).includes('EstateAegis Platform')||who==='second admin in the owner company',who+': /api/data has no other company');
  }
  function S(x){return JSON.stringify(x);}
  // (The owner's own audit log names the company they invited; that is their own record.) No other company's data:
  const ownerData=S(await owner.req('data'));for(const w of ['Ocean Palm Residence','Sample family','Sample Pool Service','staff@example.test','family@example.test','Jordan Ellis'])assert.ok(!ownerData.includes(w),'owner /api/data is still only their own company: '+w);
  assert.ok(!S(await rivalAdmin.req('data')).match(/EstateAegis Platform|owner@example\.test|Second Admin/),'other company /api/data never includes the owner company');
  for(const p of ['owner/overview']){const html=await (await fetch(srv.base+'/api/'+p)).text();assert.doesNotMatch(html,/Harborline/);}

  const overview=await owner.req('owner/overview');
  const harbor=overview.companies.find(c=>c.name==='Harborline Home Watch');assert.ok(harbor);
  assert.deepEqual(harbor.usage,{residences:1,seats:2,portalUsers:2,bytes:0});assert.equal(harbor.status,'no_subscription');
  assert.equal(S(overview).includes('Sample family'),false,'no client records in the overview');

  // Signed webhook: wrong signature 400, correct one applied once.
  const payload=JSON.stringify({id:'evt_server_1',type:'customer.subscription.created',created:Math.floor(Date.now()/1000),livemode:false,data:{object:{id:'sub_srv',object:'subscription',customer:'cus_srv',status:'trialing',metadata:{organization_id:harbor.id},trial_end:Math.floor(Date.now()/1000)+4*86400,items:{data:[item(PLANS.growth)]}}}});
  const post=(sig,body=payload)=>fetch(srv.base+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8','Stripe-Signature':sig},body});
  assert.equal((await post(sign(payload,'whsec_wrong'))).status,400);
  assert.equal((await post('t=1,v1='+'0'.repeat(64))).status,400);
  const ok=await post(sign(payload,secret));assert.equal(ok.status,200);assert.equal((await ok.json()).result,'updated');
  assert.equal((await (await post(sign(payload,secret))).json()).result,'duplicate');
  const after=await owner.req('owner/overview');const h2=after.companies.find(c=>c.id===harbor.id);
  assert.equal(h2.status,'trialing');assert.equal(h2.planName,'Growth');assert.equal(h2.limits.seats,10);assert.deepEqual(after.trialsEndingSoon,[harbor.id]);assert.equal(after.webhook.configured,true);
  assert.equal(after.metrics.trialing,1);
  // The webhook never grants access by itself: the company's own billing status is unchanged.
  assert.equal((await rivalAdmin.req('billing/status')).status,'not_subscribed');
  assert.equal((await owner.req('owner/backfill',{})).local,0);
 }finally{await srv.stop();}
});
