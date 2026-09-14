import {createStripeClient} from './stripe-client.mjs';
import {PLANS} from './stripe-plans.mjs';

// Owner-only smoke test. This module never writes live subscription or quota tables.
export function createStripeSandbox({get,run,transaction,id,now,fail,json,body,platformOwner,secret=()=>process.env.STRIPE_TEST_SECRET_KEY,clientFactory=createStripeClient}) {
 const configured=()=>String(secret()||'').startsWith('sk_test_');
 const client=()=>clientFactory({secret:secret(),origin:process.env.ESTATEOS_PUBLIC_URL||'https://estateaegis.com'});
 const testObject=value=>{if(value.livemode!==false)throw Error('Expected a Stripe test-mode response.');return value;};
 async function latest(user){return get('SELECT * FROM stripe_sandbox_attempts WHERE owner_id=? ORDER BY created_at DESC LIMIT 1',user.id);}
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/billing-sandbox/'))return false;
  if(!platformOwner(user))fail(403,'Platform owner access required.');
  const route=url.pathname.slice('/api/billing-sandbox/'.length);
  if(req.method==='GET'&&route==='status'){const a=await latest(user);json(res,200,{configured:configured(),status:a?.status||'not_started',verifiedAt:a?.verified_at||null});return true;}
  if(req.method!=='POST')fail(405,'Use POST.');
  if(!configured())fail(503,'Add STRIPE_TEST_SECRET_KEY to the server environment and deploy. It must be a test key.');
  await body(req);
  const api=client();
  if(route==='checkout'){
   let a;
   await transaction(async()=>{a=await latest(user);if(!a||['paid','expired'].includes(a.status)){a={id:id(),owner_id:user.id,organization_id:user.organization_id,created_at:now()};await run('INSERT INTO stripe_sandbox_attempts(id,owner_id,organization_id,created_at) VALUES(?,?,?,?)',a.id,a.owner_id,a.organization_id,a.created_at);}});
   if(!a.checkout_url){
    // Test catalog items are separate from the production product IDs.
    const product=testObject(await api.request('products',{name:'EstateAegis Essentials — sandbox test','metadata[estate_sandbox_attempt]':a.id},'estate-test-product-'+a.id));
    testObject(await api.request('prices',{product:product.id,currency:'usd',unit_amount:'7900','recurring[interval]':'month'},'estate-test-price-'+a.id));
    const checkoutClient=clientFactory({secret:secret(),origin:process.env.ESTATEOS_PUBLIC_URL||'https://estateaegis.com',plans:{essentials:{...PLANS.essentials,product:product.id}}});
    const session=await checkoutClient.checkout({organizationId:user.organization_id,email:user.email,plan:'essentials',attemptId:'sandbox-'+a.id});
    const verified=testObject(await api.request('checkout/sessions/'+encodeURIComponent(session.id)));
    if(verified.client_reference_id!==user.organization_id||verified.metadata?.attempt_id!=='sandbox-'+a.id)throw Error('Test checkout ownership mismatch.');
    await run("UPDATE stripe_sandbox_attempts SET session_id=?,checkout_url=?,status='open' WHERE id=?",session.id,session.url,a.id);a.checkout_url=session.url;
   }
   json(res,200,{url:a.checkout_url});return true;
  }
  if(route==='refresh'||route==='portal'){
   const a=await latest(user);if(!a?.session_id)fail(409,'Start a test checkout first.');
   const s=testObject(await api.request('checkout/sessions/'+encodeURIComponent(a.session_id)+'?expand%5B%5D=subscription&expand%5B%5D=subscription.latest_invoice'));
   if(s.client_reference_id!==user.organization_id||s.metadata?.attempt_id!=='sandbox-'+a.id||s.mode!=='subscription')throw Error('Test checkout ownership mismatch.');
   let status=s.status==='expired'?'expired':'open';
   if(s.status==='complete'&&s.payment_status==='paid'){
    const sub=testObject(s.subscription);
    if(s.amount_total!==7900||s.currency!=='usd'||sub.status!=='active'||sub.metadata?.organization_id!==user.organization_id||sub.latest_invoice?.status!=='paid')throw Error('Test payment needs review.');
    status='paid';
    if(sub.cancel_at_period_end)status='cancellation_scheduled';
   }
   if(route==='portal'){if(!['paid','cancellation_scheduled'].includes(status))fail(409,'Complete the test payment first.');json(res,200,await api.portal(typeof s.customer==='string'?s.customer:s.customer.id));return true;}
   await run('UPDATE stripe_sandbox_attempts SET status=?,verified_at=? WHERE id=?',status,now(),a.id);
   json(res,200,{status});return true;
  }
  fail(404,'Test action not found.');
 }
 return {handle};
}
