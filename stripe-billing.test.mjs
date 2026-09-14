import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from './database.mjs';
import {createStripeBilling} from './stripe-billing.mjs';
import {PLANS} from './stripe-plans.mjs';
for(const engine of ['sqlite','postgres'])test('company checkout, paid activation, retry and capacity: '+engine,async()=>{
 const root=path.resolve('outputs/EstateAegis-Proactive'),dir=path.join(root,'billing-test-'+randomUUID());
 const db=await openDatabase(root,engine==='postgres'?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:dir}:{ESTATEOS_DATA_DIR:dir}),{get,run}=db;
 const now=()=>new Date().toISOString(),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 try{
  for(const org of ['a','b']){await run('INSERT INTO organizations VALUES(?,?,?)',org,org,now());await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',org+'admin',org,'Admin',org+'@example.invalid','hash','admin',null,null,1,now());await run('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)',org+'family',org,'Family',now());}
  let session,paid=false,status='active',creates=0;
  const client={checkout:async b=>{creates++;session={id:'cs_test',client_reference_id:b.organizationId,metadata:{attempt_id:b.attemptId},mode:'subscription',customer:'cus_a',subscription:'sub_a'};return {id:'cs_test',url:'https://checkout.stripe.com/c/pay/cs_test'};},request:async url=>url.startsWith('checkout/')?{...session,status:paid?'complete':'open',payment_status:paid?'paid':'unpaid'}:{id:'sub_a',customer:'cus_a',metadata:{organization_id:'a'},status,latest_invoice:{status:paid?'paid':'open'},items:{data:[{quantity:1,price:{product:PLANS.essentials.product,currency:'usd',unit_amount:7900,recurring:{interval:'month',interval_count:1}}}]}}};
  const billing=createStripeBilling({...db,id:randomUUID,now,fail,json:(res,code,data)=>res.data=data,body:async req=>req.body,audit:async()=>{},client,enabled:()=>true});
  const admin={id:'aadmin',organization_id:'a',role:'admin',email:'a@example.invalid'};
  const request=async(user,route,b,method='POST')=>{const res={};await billing.handle({method,body:b},res,new URL('https://test/api/billing/'+route),user);return res.data;};
  const selection={plan:'essentials',extraSeats:0,storagePacks:0,acceptMonthlyMinor:7900};
  await assert.rejects(request({...admin,role:'client'},'checkout',selection),e=>e.status===403);
  await assert.rejects(request(admin,'checkout',{...selection,acceptMonthlyMinor:1}),e=>e.status===422);
  const link=await request(admin,'checkout',selection);assert.match(link.url,/checkout.stripe.com/);
  await request(admin,'checkout',selection);assert.equal(creates,1);
  assert.equal((await billing.state('a')).connected,false);assert.equal((await billing.state('b')).connected,false);
  await billing.reconcile('a');assert.equal((await billing.state('a')).quote,null);
  paid=true;await billing.reconcile('a');assert.equal((await billing.state('a')).quote.storageGB,10);assert.equal((await billing.state('a')).status,'active');
  await billing.reconcile('a');assert.equal(Number((await get('SELECT COUNT(*) n FROM stripe_billing')).n),1);
  await assert.rejects(request(admin,'checkout',selection),e=>e.status===409);
  await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','staff','a','Staff','staff@example.invalid','hash','employee',null,null,1,now());
  await assert.rejects(billing.assertCapacity('a','seats'),e=>e.status===409);
  await billing.assertCapacity('b','seats');
  status='past_due';paid=false;await billing.reconcile('a');assert.equal((await billing.state('a')).quote.storageGB,10);await assert.rejects(billing.assertCapacity('a','residences'),e=>e.status===409);
  status='canceled';await billing.reconcile('a');assert.equal((await billing.state('a')).status,'canceled');
 }finally{await db.close();}
});
