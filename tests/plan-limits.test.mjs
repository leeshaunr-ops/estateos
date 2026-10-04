// Plan limits (Oct 4 2026): Essentials 4, Growth 10, Professional 20 admin/staff users at unchanged prices; client and
// vendor logins unlimited on every plan. Covers the catalog, every public page that states limits, the signup
// calculator, the in-app plan panel, seat enforcement (clients/vendors never counted; reactivation takes a seat),
// existing subscribers picking up new limits with no stored per-company limits, and checkouts started before the
// change still verifying. Server scenarios run on SQLite.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLANS,ADDONS,SEAT_ROLES,UNLIMITED_ROLES,subscriptionQuote,sameSelection} from '../stripe-plans.mjs';
import {openDatabase} from '../database.mjs';
import {createStripeBilling} from '../stripe-billing.mjs';
import {createPaidSignup} from '../paid-signup.mjs';
import {planPrice} from '../subscriptions.mjs';
import '../public/plan-panel.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-plans-'));dirs.push(d);return d;};
const EXPECTED={essentials:{price:59,regular:79,residences:50,seats:4,gb:10},growth:{price:109,regular:129,residences:150,seats:10,gb:30},professional:{price:179,regular:199,residences:300,seats:20,gb:50}};

test('plan catalog: new user limits, unchanged prices, add-on prices and seat roles', () => {
 for(const [key,e] of Object.entries(EXPECTED)){
  const p=PLANS[key];assert.equal(p.monthlyMinor,e.price*100,key+' price');assert.equal(p.regularMinor,e.regular*100,key+' regular price');
  assert.equal(p.residences,e.residences);assert.equal(p.seats,e.seats,key+' seats');assert.equal(p.storageGB,e.gb);
 }
 // Stripe product IDs are unchanged: existing subscriptions keep matching their plan.
 assert.deepEqual(Object.values(PLANS).map(p=>p.product),['prod_VFtm9ebEAmXkPc','prod_VFtn294ZmM6pd4','prod_VFtoQSXsffoRnV']);
 assert.equal(ADDONS.seats.monthlyMinor,1500);assert.equal(ADDONS.storage.monthlyMinor,500);assert.equal(ADDONS.storage.gb,20);
 assert.deepEqual(subscriptionQuote('growth',2,1),{plan:'growth',extraSeats:2,storagePacks:1,extraInspectors:0,monthlyMinor:10900+3000+500,residences:150,seats:12,freeInspectors:20,inspectors:20,storageGB:50});
 assert.deepEqual([...SEAT_ROLES],['admin','employee']);assert.deepEqual([...UNLIMITED_ROLES],['client','vendor']);
 // Manual (non-Stripe) invoices: Essentials price plus $15 for each admin/staff user beyond 4.
 assert.equal(planPrice(4),5900);assert.equal(planPrice(6,1),5900+3000+500);
});

test('stored selections from before the limit change still match the same purchase', () => {
 const before=JSON.stringify({plan:'growth',extraSeats:1,storagePacks:0,monthlyMinor:12400,residences:150,seats:6,storageGB:30});
 assert.equal(sameSelection(before,subscriptionQuote('growth',1,0)),true);
 assert.equal(sameSelection(before,subscriptionQuote('growth',2,0)),false,'different add-on quantity');
 assert.equal(sameSelection(before,subscriptionQuote('professional',1,0)),false,'different plan');
 assert.equal(sameSelection('not json',subscriptionQuote('growth',1,0)),false);
});

test('pricing page, homepage cards, signup calculator and FAQ state the new limits and unlimited client/vendor logins', () => {
 const money=n=>'$'+n;
 for(const file of ['public/marketing.html','public/signup.html']){
  const html=read(file);
  for(const [key,e] of Object.entries(EXPECTED)){
   const card=html.match(new RegExp(`<article class="price-card[^"]*">(?:<span[^>]*>[^<]*</span>)?<h3>${PLANS[key].name}</h3>[\\s\\S]*?</article>`))?.[0];
   assert.ok(card,file+': '+key+' card');
   assert.ok(card.includes(`Up to ${e.residences} active residences`),file+' '+key+' residences');
   assert.ok(card.includes(`<li>${e.seats} admin/staff users</li>`),file+' '+key+' users');
   assert.ok(card.includes(`<li>${e.gb} GB shared storage</li>`),file+' '+key+' storage');
   assert.ok(card.includes('<li>Unlimited client and vendor logins</li>'),file+' '+key+' unlimited logins');
   assert.ok(card.includes(`${money(e.regular)}</del>`)&&card.includes(`</span>${money(e.price)} <small>/month</small>`),file+' '+key+' prices unchanged');
  }
  assert.doesNotMatch(html,/<li>(2|5) admin\/staff users<\/li>|include 2 admin\/staff|two team accounts/,file+' has no old limits');
  assert.match(html,/unlimited client and vendor logins<\/strong>\. Only your admin and staff accounts count toward a plan’s users\./,file+' pricing intro');
 }
 assert.match(read('public/marketing.html'),/Additional admin\/staff users: \$15 each\/month\. Additional storage: \$5 per 20 GB\/month\. Client and vendor logins are unlimited on every plan and never cost extra\./);
 assert.match(read('public/signup.html'),/Client and vendor logins are unlimited on every plan; only admin and staff accounts count toward your users\./);
 assert.match(read('public/signup.html'),/Extra admin\/staff users · \$15 each\/month/);
 const faq=read('public/faq.html');
 assert.match(faq,/include 4 admin\/staff users and 10 GB of storage\. Growth includes 10 admin\/staff users and Professional includes 20\./);
 assert.match(faq,/<h2>Do clients and vendors count as users\?<\/h2><p>No\. Client and vendor logins are unlimited on every plan/);
 // The signup calculator carries the same numbers as the server catalog.
 const js=read('public/signup.js'),plans=Function('return '+js.match(/const plans=(\{[\s\S]*?\}\});/)[1])();
 for(const [key,p] of Object.entries(PLANS))assert.deepEqual(plans[key],{price:p.monthlyMinor,residences:p.residences,seats:p.seats,gb:p.storageGB},'signup.js '+key);
 assert.match(js,/plus unlimited client and vendor logins\./);
});

test('in-app plan panel: allowances vs usage, add-ons, unlimited client/vendor logins, no inline styles', () => {
 const P=globalThis.EAPlan,catalog=Object.entries(PLANS).map(([key,p])=>({key,...p}));
 const users=[{role:'admin',active:1},{role:'employee',active:1},{role:'client',active:1},{role:'client',active:1},{role:'vendor',active:1},{role:'vendor',active:0}];
 const html=P.panel({user:{role:'admin'},users,billing:{status:'active',connected:true,enabled:true,catalog,quote:subscriptionQuote('growth',2,1),usage:{residences:37,seats:9,bytes:4.2e9}}});
 assert.match(html,/Your EstateAegis plan/);assert.match(html,/Growth<\/strong> · \$144\/month/);
 assert.match(html,/37 of 150/);assert.match(html,/9 of 12/);assert.match(html,/4\.2 GB of 50 GB/);
 assert.match(html,/Client and vendor logins<\/strong><small>3 active · never counted toward your admin\/staff users<\/small><\/div><div class="plan-row-value"><span class="plan-unlimited">Unlimited<\/span>/);
 assert.match(html,/2 extra admin\/staff users \(\$15 each\/month\)/);assert.match(html,/1 extra 20 GB storage pack \(\$5 each\/month\)/);
 assert.match(html,/data-plan-action="portal"/);assert.doesNotMatch(html,/style=|<script/);
 const none=P.panel({user:{role:'admin'},users,billing:{status:'not_subscribed',catalog,usage:{residences:2,seats:2,bytes:0}},subscription:{limit:10e9}});
 assert.match(none,/No paid subscription is connected/);assert.match(none,/Essentials<\/strong> \$59\/month · up to 50 residences · 4 admin\/staff users · 8 free field inspector logins · 10 GB/);
 assert.match(none,/Professional<\/strong> \$179\/month · up to 300 residences · 20 admin\/staff users · 40 free field inspector logins · 50 GB/);assert.doesNotMatch(none,/data-plan-action/);
 assert.equal(P.panel({user:{role:'employee'}}),'','staff never see the plan panel');
 const live=read('public/live.js'),shell=read('public/live.html'),server=read('server.mjs'),sw=read('public/sw.js'),pkg=read('package.json');
 assert.match(live,/window\.EAPlan\?window\.EAPlan\.panel\(data\):''/);
 for(const f of ['plan-panel.js','plan-panel.css']){assert.ok(shell.includes('/'+f+'?v='),'live.html loads '+f);assert.ok(server.includes(`'/${f}':'${f}'`),'static route '+f);assert.match(server,new RegExp(`SHELL_FILES = \\[[^\\]]*'${f.replace('.','\\.')}'`));assert.ok(sw.includes(`'/${f}'`),'service worker caches '+f);}
 assert.match(pkg,/node --check public\/plan-panel\.js/);
});

async function billingDb(){
 const db=await openDatabase(root,{ESTATEOS_DATA_DIR:tmp()});
 const now=()=>new Date().toISOString(),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 const billing=createStripeBilling({...db,id:randomUUID,now,fail,json:(res,code,data)=>res.data=data,body:async req=>req.body,audit:async()=>{},client:{},enabled:()=>false});
 const user=async(org,role,active=1)=>{const id=randomUUID();await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',id,org,role+' user',id+'@example.invalid','hash',role,null,null,active,now());return id;};
 return {db,billing,now,user};
}

test('seat limits count only active admins and staff; client and vendor logins never count; existing subscribers get new limits', async () => {
 const {db,billing,now,user}=await billingDb();
 try{
  for(const [org,plan] of [['ess','essentials'],['gro','growth'],['pro','professional']]){
   await db.run('INSERT INTO organizations VALUES(?,?,?)',org,org,now());
   // An existing subscriber row stores only the plan and add-on quantities, exactly as before the change.
   await db.run("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES(?,?,?,'active',?,0,0,?)",org,'cus_'+org,'sub_'+org,plan,now());
  }
  const cols=(await db.all("SELECT * FROM stripe_billing LIMIT 1"))[0];
  assert.ok(!Object.keys(cols).some(k=>/seat_limit|max_|residence_limit|storage_gb|limit/i.test(k)),'no per-company limit columns are stored');
  assert.equal((await billing.state('ess')).quote.seats,4);assert.equal((await billing.state('gro')).quote.seats,10);assert.equal((await billing.state('pro')).quote.seats,20);
  await user('ess','admin');for(let i=0;i<3;i++)await user('ess','employee');
  // Fifty clients and fifty vendors: still room for nothing more than the 4 seats, and never blocked themselves.
  for(let i=0;i<50;i++){await user('ess','client');await user('ess','vendor');}
  await user('ess','employee',0);
  const state=await billing.state('ess');assert.equal(state.usage.seats,4,'only active admins and staff use seats');
  await assert.rejects(billing.assertCapacity('ess','seats'),e=>e.status===409&&/includes 4 admin\/staff users/.test(e.message)&&/Client and vendor logins are unlimited/.test(e.message));
  // One extra-user add-on lifts the allowance to 5.
  await db.run("UPDATE stripe_billing SET extra_seats=1 WHERE organization_id='ess'");await billing.assertCapacity('ess','seats');
  for(let i=0;i<9;i++)await user('gro',i?'employee':'admin');await billing.assertCapacity('gro','seats');await user('gro','employee');await assert.rejects(billing.assertCapacity('gro','seats'),e=>e.status===409);
 }finally{await db.close();}
});

test('a paid signup started before the limit change verifies and its invitation email states the new limits', async () => {
 const db=await openDatabase(root,{ESTATEOS_DATA_DIR:tmp()});
 const now=()=>new Date().toISOString(),hash=s=>createHash('sha256').update(s).digest('hex'),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 const deps={...db,id:randomUUID,now,hash,randomBytes,body:async req=>req.body,json:(res,code,data)=>res.data=data,fail,rate:()=>{},audit:async()=>{}};
 try{
  await db.run('INSERT INTO organizations VALUES(?,?,?)','platform','Platform',now());
  await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','owner','platform','Owner','owner@example.invalid','hash','admin',null,null,1,now());
  let session,paid=false;const sent=[];
  const price=(item,quantity)=>({quantity,price:{product:item.product,currency:'usd',unit_amount:item.monthlyMinor,recurring:{interval:'month',interval_count:1}}});
  const client={checkout:async b=>{session={id:'cs_1',mode:'subscription',client_reference_id:b.organizationId,metadata:{attempt_id:b.attemptId},subscription:'sub_1',customer:'cus_1'};return {id:'cs_1',url:'https://checkout.stripe.com/c/pay/cs_1'};},
   request:async route=>route.startsWith('checkout/')?{...session,livemode:true,status:paid?'complete':'open',payment_status:paid?'paid':'unpaid'}:{livemode:true,id:'sub_1',customer:'cus_1',metadata:{organization_id:session.client_reference_id},status:'active',latest_invoice:{status:'paid'},items:{data:[price(PLANS.growth,1),price(ADDONS.seats,1)]}}};
  const billing=createStripeBilling({...deps,client,enabled:()=>true});
  const signup=createPaidSignup({...deps,client,parseSubscription:billing.parseSubscription,ownerId:()=>'owner',enabled:()=>true,encrypt:JSON.stringify,decrypt:JSON.parse,send:async m=>{sent.push(m);return {emailStatus:'sent'};}});
  const body={company:'Harborline Home Watch',email:'jordan@example.invalid',confirmEmail:'jordan@example.invalid',plan:'growth',extraSeats:1,storagePacks:0,acceptMonthlyMinor:12400,acceptTerms:'on',acceptBilling:'on',acceptedLegalVersion:'2026-09-14'};
  await signup.handle({method:'POST',body},{},new URL('https://test/api/signup/start'));
  let row=await db.get('SELECT * FROM paid_signups WHERE email=?',body.email);
  // Rewrite the stored selection the way it looked before the change (Growth used to include 5 users).
  await db.run('UPDATE paid_signups SET selection=? WHERE id=?',JSON.stringify({plan:'growth',extraSeats:1,storagePacks:0,monthlyMinor:12400,residences:150,seats:6,storageGB:30}),row.id);
  // Starting again with the same purchase is the same signup, not a conflict.
  await signup.handle({method:'POST',body},{},new URL('https://test/api/signup/start'));
  paid=true;await signup.reconcile(row.id);
  row=await db.get('SELECT * FROM paid_signups WHERE id=?',row.id);assert.equal(row.status,'invited');
  assert.equal((await billing.state(row.organization_id)).quote.seats,11,'Growth 10 + 1 extra user');
  assert.match(sent.at(-1).planDescription,/Growth, \$124\.00 USD\/month, up to 150 active residences, 11 admin\/staff users, 20 free field inspector logins, 30 GB shared storage, unlimited client and vendor logins/);
 }finally{await db.close();}
});

function server(env){
 let proc,base,log='';
 return {get base(){return base;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';return {async req(endpoint,b,expected=200){const res=await fetch(srv.base+'/api/'+endpoint,{method:b===undefined?'GET':'POST',headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let r={};try{r=JSON.parse(text);}catch{r={raw:text};}assert.equal(res.status,expected,endpoint+': '+text.slice(0,300));return r;}};}

test('server: invitations for clients and vendors never hit the seat limit; staff do; reactivation takes a seat', async () => {
 const dir=tmp(),pw='Test-only-strong-password-928!',env={ESTATEOS_DATA_DIR:dir};
 delete process.env.DATABASE_URL;
 const srv=server(env);await srv.start();
 try{
  const admin=client(srv);
  const setup=await admin.req('setup',{company:'Harborline Home Watch',name:'Jordan Ellis',email:'jordan@example.test',password:pw},201);
  await srv.stop();
  // Mark the company as an existing Essentials subscriber (as stored before this change: plan only, no limits).
  const sql=new DatabaseSync(path.join(dir,'estateos.sqlite'));
  const org=sql.prepare('SELECT organization_id FROM users WHERE id=?').get(setup.user.id).organization_id;
  sql.prepare("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES(?,?,?,'active','essentials',0,0,?)").run(org,'cus_test','sub_test',new Date().toISOString());sql.close();
  await srv.start();await admin.req('login',{email:'jordan@example.test',password:pw});
  const status=await admin.req('billing/status');assert.equal(status.quote.seats,4);assert.equal(status.catalog.find(p=>p.key==='growth').seats,10);
  const family=await admin.req('clients',{name:'Sample family'},201),vend=await admin.req('vendors',{name:'Sample Pool Service'},201);
  const accept=async(role,email,extra={},expected=201)=>{const inv=await admin.req('invitations',{role,email,...extra},201);return client(srv).req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name:email.split('@')[0],password:pw},expected);};
  const staff=[];for(let i=1;i<=3;i++)staff.push((await accept('employee',`staff${i}@example.test`)).user);
  const blocked=await accept('employee','staff4@example.test',{},409);assert.match(blocked.error,/includes 4 admin\/staff users/);
  for(let i=1;i<=6;i++){await accept('client',`family${i}@example.test`,{clientId:family.id});await accept('vendor',`vendor${i}@example.test`,{vendorId:vend.id});}
  assert.equal((await admin.req('billing/status')).usage.seats,4,'12 client and vendor logins use no seats');
  await admin.req('users/suspend',{userId:staff[0].id},201);
  await accept('employee','staff5@example.test');
  const again=await admin.req('users/reactivate',{userId:staff[0].id},409);assert.match(again.error,/admin\/staff users/);
  const users=(await admin.req('data')).users,aClient=users.find(u=>u.role==='client');
  await admin.req('users/suspend',{userId:aClient.id},201);await admin.req('users/reactivate',{userId:aClient.id},201);
 }finally{await srv.stop();}
});
