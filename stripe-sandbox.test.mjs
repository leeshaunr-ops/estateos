import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from './database.mjs';
import {createStripeSandbox} from './stripe-sandbox.mjs';
for(const engine of ['sqlite','postgres'])test('sandbox payment stays isolated and rejects live responses: '+engine,async()=>{
 const root=path.resolve('outputs/EstateAegis-Proactive'),dir=path.join(root,'billing-test-'+randomUUID());
 const db=await openDatabase(root,engine==='postgres'?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:dir}:{ESTATEOS_DATA_DIR:dir});
 const now=()=>new Date().toISOString(),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 try{
  await db.run('INSERT INTO organizations VALUES(?,?,?)','org','Test',now());
  await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','owner','org','Owner','owner@example.invalid','hash','admin',null,null,1,now());
  const owner={id:'owner',organization_id:'org',email:'owner@example.invalid'};
  let key='sk_test_fixture',live=false,paid=false,session,creates=0;
  const factory=opts=>({request:async route=>{
   if(route==='products')return {id:'prod_test',livemode:live};
   if(route==='prices')return {id:'price_test',livemode:live};
   return {...session,livemode:live,status:paid?'complete':'open',payment_status:paid?'paid':'unpaid',amount_total:7900,currency:'usd',subscription:{livemode:live,status:'active',metadata:{organization_id:'org'},latest_invoice:{status:'paid'}}};
  },checkout:async b=>{assert.equal(opts.plans.essentials.product,'prod_test');creates++;session={id:'cs_test',mode:'subscription',client_reference_id:b.organizationId,metadata:{attempt_id:b.attemptId}};return {id:'cs_test',url:'https://checkout.stripe.com/c/pay/cs_test'};}});
  const sandbox=createStripeSandbox({...db,id:randomUUID,now,fail,json:(res,code,data)=>res.data=data,body:async()=>({}),platformOwner:u=>u?.id==='owner',secret:()=>key,clientFactory:factory});
  const call=async(route,user=owner,method='POST')=>{const res={};await sandbox.handle({method},res,new URL('https://test/api/billing-sandbox/'+route),user);return res.data;};
  await assert.rejects(call('checkout',{id:'other'}),e=>e.status===403);
  key='sk_live_fixture';await assert.rejects(call('checkout'),e=>e.status===503);key='sk_test_fixture';
  live=true;await assert.rejects(call('checkout'),/test-mode/);live=false;
  await call('checkout');await call('checkout');assert.equal(creates,1);
  assert.equal((await call('refresh')).status,'open');paid=true;live=true;
  await assert.rejects(call('refresh'),/test-mode/);live=false;
  assert.equal((await call('refresh')).status,'paid');
  assert.equal((await call('status',owner,'GET')).status,'paid');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM stripe_billing')).n),0);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM stripe_checkout_attempts')).n),0);
 }finally{await db.close();}
});
