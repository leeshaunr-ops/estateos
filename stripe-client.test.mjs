import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {subscriptionQuote,PLANS,ADDONS} from './stripe-plans.mjs';
import {verifyStripeEvent,createStripeClient} from './stripe-client.mjs';
test('approved residence tiers and add-ons',()=>{
 assert.deepEqual(subscriptionQuote('growth',2,1),{plan:'growth',extraSeats:2,storagePacks:1,monthlyMinor:16400,residences:150,seats:7,storageGB:50});
 assert.equal(subscriptionQuote('essentials').monthlyMinor,7900);assert.equal(subscriptionQuote('professional').storageGB,50);
 for(const values of [['invalid'],['growth',-1],['growth',0,0.5],['growth',1001]])assert.throws(()=>subscriptionQuote(...values));
});
test('webhook signatures reject tampering and replay beyond tolerance',()=>{
 const raw=Buffer.from(JSON.stringify({id:'evt_test',type:'invoice.paid',data:{object:{id:'in_test'}}})),secret='whsec_test';
 const sig=createHmac('sha256',secret).update('1000.').update(raw).digest('hex'),header='t=1000,v1='+sig;
 assert.equal(verifyStripeEvent(raw,header,secret,1000).id,'evt_test');
 assert.throws(()=>verifyStripeEvent(Buffer.from('{}'),header,secret,1000));
 assert.throws(()=>verifyStripeEvent(raw,header,secret,1301));
 assert.throws(()=>verifyStripeEvent(raw,header,'wrong',1000));
 assert.throws(()=>verifyStripeEvent(raw,header+',t=1000',secret,1000));
});
test('checkout validates catalog prices and sends only approved quantities',async()=>{
 const calls=[];const items=[PLANS.growth,ADDONS.seats,ADDONS.storage];
 const fetcher=async(url,options)=>{calls.push({url,options});if(options.method==='GET'){const item=items.find(i=>url.includes(i.product));return {ok:true,json:async()=>({data:[{id:'price_'+item.product,active:true,currency:'usd',unit_amount:item.monthlyMinor,recurring:{interval:'month',interval_count:1},billing_scheme:'per_unit'}]})};}return {ok:true,json:async()=>({id:'cs_test',url:'https://checkout.stripe.com/c/pay/cs_test'})};};
 const client=createStripeClient({secret:'sk_test_fake',origin:'https://estateaegis.com',fetcher});
 const result=await client.checkout({organizationId:'org',email:'admin@example.invalid',plan:'growth',extraSeats:2,storagePacks:1,attemptId:'attempt'});
 assert.equal(result.quote.monthlyMinor,16400);const form=calls.at(-1).options.body;
 assert.equal(form.get('line_items[1][quantity]'),'2');assert.equal(form.get('client_reference_id'),'org');assert.equal(form.get('mode'),'subscription');
 assert.equal(calls.at(-1).options.headers['Idempotency-Key'],'estate-checkout-attempt');
});
test('billing portal isolates customer and permits cancellation without plan switching',async()=>{
 const calls=[];let wrong=false;
 const fetcher=async(url,options)=>{const b=options.body;calls.push({url,b});return {ok:true,json:async()=>url.endsWith('configurations')?{id:'bpc_test',livemode:false}:{customer:wrong?'cus_wrong':b.get('customer'),livemode:false,url:'https://billing.stripe.com/p/session/test'}};};
 const client=createStripeClient({secret:'sk_test_fixture',origin:'https://estateaegis.com',fetcher});
 await client.portal('cus_test');await client.portal('cus_test');
 assert.equal(calls.filter(c=>c.url.endsWith('configurations')).length,1);
 assert.equal(calls[0].b.get('features[subscription_cancel][mode]'),'at_period_end');
 assert.equal(calls[0].b.get('features[subscription_update][enabled]'),'false');
 wrong=true;await assert.rejects(client.portal('cus_test'),/Unexpected/);
});
