// Regression: Checkout starts every new company on a 30-day Stripe trial (subscription status 'trialing',
// Checkout payment_status 'no_payment_required'). A trialing company must be able to finish signup and add
// residences, users and files exactly like a paid company; past_due and canceled subscriptions stay blocked.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../database.mjs';
import {createStripeBilling} from '../stripe-billing.mjs';
import {createPaidSignup} from '../paid-signup.mjs';
import {createSubscriptions} from '../subscriptions.mjs';
import {createSaas} from '../saas.mjs';
import {PLANS} from '../stripe-plans.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-trial-'));dirs.push(d);return d;};
const engines=[['SQLite',d=>({ESTATEOS_DATA_DIR:d})],['Postgres (PGlite)',d=>({NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')})]];
const item=p=>({quantity:1,price:{product:p.product,currency:'usd',unit_amount:p.monthlyMinor,recurring:{interval:'month',interval_count:1}}});

for(const [label,envFor] of engines)test('trialing company completes signup and can add residences/users; past_due and canceled stay blocked on '+label, async () => {
 const db=await openDatabase(root,envFor(tmp()));
 const now=()=>new Date().toISOString(),hash=s=>createHash('sha256').update(s).digest('hex'),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 const deps={...db,id:randomUUID,now,hash,randomBytes,body:async req=>req.body,json:(res,code,data)=>{res.status=code;res.data=data;},fail,rate:()=>{},audit:async()=>{}};
 try{
  await db.run('INSERT INTO organizations VALUES(?,?,?)','platform','Platform',now());
  await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','owner','platform','Owner','owner@example.invalid','hash','admin',null,null,1,now());
  // Fake Stripe: one checkout session + subscription per signup. Trial checkouts complete with no payment due.
  const sessions=new Map(),subs=new Map();let next=0;
  const client={
   checkout:async b=>{const n=++next,s={id:'cs_'+n,mode:'subscription',client_reference_id:b.organizationId,metadata:{attempt_id:b.attemptId},subscription:'sub_'+n,customer:'cus_'+n,status:'complete',payment_status:'no_payment_required'};sessions.set(s.id,s);subs.set(s.subscription,{status:'trialing',invoice:'paid',org:b.organizationId,customer:s.customer});return {id:s.id,url:'https://checkout.stripe.com/c/pay/'+s.id};},
   request:async route=>{
    if(route.startsWith('checkout/sessions/'))return {...sessions.get(decodeURIComponent(route.split('/')[2])),livemode:true};
    const sid=decodeURIComponent(route.split('/')[1].split('?')[0]),s=subs.get(sid);
    return {livemode:true,id:sid,customer:s.customer,metadata:{organization_id:s.org},status:s.status,trial_end:Math.floor(Date.now()/1000)+30*86400,latest_invoice:{status:s.invoice,amount_paid:0},items:{data:[item(PLANS.essentials)]}};
   }};
  const billing=createStripeBilling({...deps,client,enabled:()=>true});
  const signup=createPaidSignup({...deps,client,parseSubscription:billing.parseSubscription,ownerId:()=>'owner',enabled:()=>true,encrypt:JSON.stringify,decrypt:JSON.parse,send:async()=>({emailStatus:'sent'})});
  const subscriptions=createSubscriptions({...deps,platformOwner:()=>false,communications:{}});
  const saas=createSaas({...deps,text:(v,label,max)=>{const t=String(v??'').trim();if(!t||t.length>max)fail(422,label+' is required.');return t;},note:v=>String(v||''),passwordHash:p=>'hash:'+p,session:async()=>{},demos:{activate:async()=>{}}});
  const start=async email=>{await signup.handle({method:'POST',body:{company:'Co '+email,email,confirmEmail:email,plan:'essentials',extraSeats:0,storagePacks:0,acceptMonthlyMinor:PLANS.essentials.monthlyMinor,acceptTerms:'on',acceptBilling:'on',acceptedLegalVersion:'2026-09-14'}},{},new URL('https://test/api/signup/start'));return db.get('SELECT * FROM paid_signups WHERE email=?',email);};
  const register=async row=>{const res={};await saas({method:'POST',body:{token:JSON.parse(row.secrets).inviteToken,name:'Jordan Ellis',password:'Correct-Horse-9'}},res,new URL('https://test/api/workspace-register'));return res;};
  const subOf=async org=>subs.get((await db.get('SELECT subscription_id FROM stripe_billing WHERE organization_id=?',org)).subscription_id);
  const blocked=e=>e.status===409;

  // 1) Trial checkout is verified and the company is created with status 'trialing'.
  const row=await start('jordan@example.invalid'),org=row.organization_id;
  await signup.reconcile(row.id);
  assert.equal((await db.get('SELECT status FROM paid_signups WHERE id=?',row.id)).status,'invited','a trial checkout is verified');
  const b=await db.get('SELECT * FROM stripe_billing WHERE organization_id=?',org);assert.equal(b.status,'trialing');assert.equal(b.plan,'essentials');

  // 2) The invited admin completes signup (previously 409 "This paid invitation needs review").
  const res=await register(await db.get('SELECT * FROM paid_signups WHERE id=?',row.id));
  assert.equal(res.status,201);assert.deepEqual(res.data,{created:true});
  const admin=await db.get('SELECT * FROM users WHERE organization_id=?',org);assert.equal(admin.role,'admin');assert.equal(admin.email,'jordan@example.invalid');
  assert.equal((await db.get('SELECT status FROM paid_signups WHERE id=?',row.id)).status,'accepted');

  // 3) A trialing company can add residences, staff users and files; a re-sync keeps it trialing.
  await billing.assertCapacity(org,'residences');
  await billing.assertCapacity(org,'seats');
  await subscriptions.ensureSpace(org,1000);
  await billing.reconcile(org);assert.equal((await billing.state(org)).status,'trialing');assert.equal((await billing.state(org)).plan,'essentials');
  await billing.assertCapacity(org,'residences');await billing.assertCapacity(org,'seats');
  // Plan allowances still apply during a trial.
  for(let n=1;n<PLANS.essentials.seats;n++)await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','staff'+n,org,'Staff '+n,'staff'+n+'@example.invalid','hash','employee',null,null,1,now());
  await assert.rejects(billing.assertCapacity(org,'seats'),blocked);
  for(let n=1;n<PLANS.essentials.seats;n++)await db.run('DELETE FROM users WHERE id=?','staff'+n);

  // 4) past_due and canceled are blocked exactly as before.
  for(const status of ['past_due','canceled','unpaid']){
   Object.assign(await subOf(org),{status,invoice:'open'});await billing.reconcile(org);
   assert.equal((await billing.state(org)).status,status);
   await assert.rejects(billing.assertCapacity(org,'residences'),blocked,status+' blocks residences');
   await assert.rejects(billing.assertCapacity(org,'seats'),blocked,status+' blocks users');
   await assert.rejects(subscriptions.ensureSpace(org,1000),blocked,status+' blocks uploads');
  }
  // An active subscription whose invoice is unpaid is still payment_pending (blocked); paid active is allowed.
  Object.assign(await subOf(org),{status:'active',invoice:'open'});await billing.reconcile(org);
  assert.equal((await billing.state(org)).status,'payment_pending');await assert.rejects(billing.assertCapacity(org,'residences'),blocked);
  Object.assign(await subOf(org),{status:'active',invoice:'paid'});await billing.reconcile(org);
  assert.equal((await billing.state(org)).status,'active');await billing.assertCapacity(org,'residences');

  // 5) Signup is still refused when the subscription is not in good standing.
  const pastDue=await start('pastdue@example.invalid');subs.get('sub_'+next).status='past_due';
  await assert.rejects(signup.reconcile(pastDue.id),/not verified/);
  assert.equal((await db.get('SELECT status FROM paid_signups WHERE id=?',pastDue.id)).status,'pending','a past_due subscription never creates a company');
  const canceled=await start('canceled@example.invalid');await signup.reconcile(canceled.id);
  assert.equal((await db.get('SELECT status FROM paid_signups WHERE id=?',canceled.id)).status,'invited');
  await db.run("UPDATE stripe_billing SET status='canceled' WHERE organization_id=?",canceled.organization_id);
  await assert.rejects(register(await db.get('SELECT * FROM paid_signups WHERE id=?',canceled.id)),blocked,'a canceled subscription cannot complete signup');
  assert.equal(await db.get('SELECT id FROM users WHERE organization_id=?',canceled.organization_id),undefined);
  // An unsettled checkout (payment still due) is not treated as complete.
  const unpaid=await start('unpaid@example.invalid');sessions.get('cs_'+next).payment_status='unpaid';
  await signup.reconcile(unpaid.id);assert.equal((await db.get('SELECT status FROM paid_signups WHERE id=?',unpaid.id)).status,'pending');
 }finally{await db.close();}
});
