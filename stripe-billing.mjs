import {PLANS,ADDONS,subscriptionQuote} from './stripe-plans.mjs';
import {createStripeClient} from './stripe-client.mjs';

// Stripe is the source of payment truth. Redirect query parameters never grant access.
// Polling reconciles pending checkouts and current subscriptions even if a browser closes.
export function createStripeBilling({get,all,run,transaction,id,now,fail,json,body,audit,client=createStripeClient({origin:process.env.ESTATEOS_PUBLIC_URL||'https://estateaegis.com'}),enabled=()=>process.env.STRIPE_BILLING_ENABLED==='1'&&String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_')}) {
 const busy=new Map();
 async function usage(org){return {residences:Number((await get('SELECT COUNT(*) n FROM properties WHERE organization_id=? AND archived_at IS NULL',org)).n),seats:Number((await get("SELECT COUNT(*) n FROM users WHERE organization_id=? AND active=1 AND role IN ('admin','employee')",org)).n),bytes:Number((await get('SELECT COALESCE(SUM(bytes),0) n FROM (SELECT f.storage_key,MAX(f.bytes) bytes FROM files f JOIN properties p ON p.id=f.property_id WHERE p.organization_id=? GROUP BY f.storage_key) q',org)).n)};}
 function parseSubscription(sub){
  if(sub.items?.has_more || !Array.isArray(sub.items?.data))throw Error('Subscription items require review.');
  let plan,extraSeats=0,storagePacks=0;const seen=new Set();
  for(const item of sub.items.data){const p=item.price,product=typeof p?.product==='string'?p.product:p?.product?.id;const match=Object.entries(PLANS).find(([,v])=>v.product===product);const expected=match?.[1]||Object.values(ADDONS).find(v=>v.product===product);
   if(!expected || seen.has(product) || p.currency!=='usd' || p.unit_amount!==expected.monthlyMinor || p.recurring?.interval!=='month' || p.recurring.interval_count!==1 || !Number.isSafeInteger(item.quantity) || item.quantity<1)throw Error('Subscription price requires review.');seen.add(product);
   if(match){if(plan || item.quantity!==1)throw Error('Invalid base plan.');plan=match[0];}else if(product===ADDONS.seats.product)extraSeats=item.quantity;else storagePacks=item.quantity;
  }
  return subscriptionQuote(plan,extraSeats,storagePacks);
 }
 async function reconcile(org){
  if(busy.has(org))return busy.get(org);
  const task=(async()=>{
   let record=await get('SELECT * FROM stripe_billing WHERE organization_id=?',org);
   if(!record?.subscription_id){
    const attempt=await get("SELECT * FROM stripe_checkout_attempts WHERE organization_id=? AND session_id IS NOT NULL AND status IN ('open','creating') ORDER BY created_at DESC LIMIT 1",org);
    if(!attempt)return;
    const session=await client.request('checkout/sessions/'+encodeURIComponent(attempt.session_id));
    if(session.livemode!==true)throw Error('Live billing cannot accept a test checkout.');
    if(session.client_reference_id!==org || session.metadata?.attempt_id!==attempt.id || session.mode!=='subscription')throw Error('Checkout ownership mismatch.');
    if(session.status==='expired'){await run("UPDATE stripe_checkout_attempts SET status='expired' WHERE id=?",attempt.id);return;}
    if(session.status!=='complete' || session.payment_status!=='paid')return;
    const sid=typeof session.subscription==='string'?session.subscription:session.subscription?.id,cid=typeof session.customer==='string'?session.customer:session.customer?.id;
    if(!sid||!cid)throw Error('Incomplete Stripe subscription.');
    await transaction(async()=>{const old=await get('SELECT * FROM stripe_billing WHERE organization_id=?',org);if(old?.subscription_id&&old.subscription_id!==sid)throw Error('Duplicate subscription requires review.');await run("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status) VALUES(?,?,?,'pending') ON CONFLICT(organization_id) DO UPDATE SET customer_id=excluded.customer_id,subscription_id=excluded.subscription_id",org,cid,sid);await run("UPDATE stripe_checkout_attempts SET status='complete' WHERE id=?",attempt.id);});
    record=await get('SELECT * FROM stripe_billing WHERE organization_id=?',org);
   }
   const sub=await client.request('subscriptions/'+encodeURIComponent(record.subscription_id)+'?expand%5B%5D=latest_invoice');
   if(sub.livemode!==true)throw Error('Live billing cannot accept a test subscription.');
   if(sub.metadata?.organization_id!==org || (typeof sub.customer==='string'?sub.customer:sub.customer?.id)!==record.customer_id)throw Error('Subscription ownership mismatch.');
   const q=parseSubscription(sub),paid=sub.latest_invoice?.status==='paid';
   await transaction(async()=>{
    if(sub.status==='active'&&paid)await run('UPDATE stripe_billing SET plan=?,extra_seats=?,storage_packs=?,status=?,verified_at=?,last_error=NULL WHERE organization_id=?',q.plan,q.extraSeats,q.storagePacks,sub.status,now(),org);
    else await run('UPDATE stripe_billing SET status=?,verified_at=?,last_error=NULL WHERE organization_id=?',sub.status==='active'?'payment_pending':sub.status,now(),org);
   });
  })();busy.set(org,task);try{await task;}finally{busy.delete(org);}
 }
 async function state(org){const row=await get('SELECT * FROM stripe_billing WHERE organization_id=?',org);return {enabled:enabled(),status:row?.status||'not_subscribed',plan:row?.plan||null,extraSeats:row?.extra_seats||0,storagePacks:row?.storage_packs||0,verifiedAt:row?.verified_at||null,connected:!!row?.subscription_id,quote:row?.plan?subscriptionQuote(row.plan,row.extra_seats,row.storage_packs):null,usage:await usage(org)};}
 async function assertCapacity(org,kind,increment=1){const row=await get('SELECT * FROM stripe_billing WHERE organization_id=?',org);if(!row?.subscription_id)return;if(row.status!=='active')fail(409,'Resolve your subscription payment in Company settings before adding records. Existing records remain available.');if(!row.plan)fail(409,'Subscription activation is pending.');const q=subscriptionQuote(row.plan,row.extra_seats,row.storage_packs),u=await usage(org);if(u[kind]+increment>q[kind])fail(409,'Your subscription allowance is full. Contact sales@estateaegis.com to confirm an upgrade before adding more '+kind+'.');}
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/billing/'))return false;
  if(!user)fail(401,'Please sign in.');if(user.role!=='admin')fail(403,'Administrator access required.');const org=user.organization_id;
  if(req.method==='GET'&&url.pathname==='/api/billing/status'){json(res,200,await state(org));return true;}
  if(req.method!=='POST')fail(405,'Use POST.');if(!enabled())fail(503,'Online subscriptions are being configured. Contact sales@estateaegis.com.');const b=await body(req);
  if(url.pathname==='/api/billing/refresh'){await reconcile(org);json(res,200,await state(org));return true;}
  if(url.pathname==='/api/billing/portal'){await reconcile(org);const row=await get('SELECT customer_id,subscription_id FROM stripe_billing WHERE organization_id=?',org);if(!row?.customer_id||!row.subscription_id)fail(409,'Subscribe before opening billing management.');json(res,200,await client.portal(row.customer_id));return true;}
  if(url.pathname!=='/api/billing/checkout')fail(404,'Billing action not found.');
  await reconcile(org);
  let q;try{q=subscriptionQuote(b.plan,b.extraSeats,b.storagePacks);}catch{fail(422,'Select a valid plan and add-ons.');}
  if(b.acceptMonthlyMinor!==q.monthlyMinor)fail(422,'Confirm the monthly subscription amount.');
  const u=await usage(org);if(u.residences>q.residences || u.seats>q.seats || u.bytes>q.storageGB*1e9)fail(422,'Choose a plan and add-ons that cover your current residences, users, and storage.');
  const selection=JSON.stringify(q);let attempt;
  await transaction(async()=>{
   if((await get('SELECT subscription_id FROM stripe_billing WHERE organization_id=?',org))?.subscription_id)fail(409,'A subscription already exists. Contact sales to change your plan; do not create a second subscription.');
   attempt=await get("SELECT * FROM stripe_checkout_attempts WHERE organization_id=? AND status IN ('creating','open') AND expires_at>? ORDER BY created_at DESC LIMIT 1",org,now());
   if(attempt&&attempt.selection!==selection)fail(409,'A checkout is already pending. Finish that selection or wait for it to expire before changing plans.');
   if(!attempt){attempt={id:id(),organization_id:org,selection,created_at:now(),expires_at:new Date(Date.now()+25*3600000).toISOString()};await run('INSERT INTO stripe_checkout_attempts(id,organization_id,selection,created_at,expires_at) VALUES(?,?,?,?,?)',attempt.id,org,selection,attempt.created_at,attempt.expires_at);}
  });
  if(!attempt.checkout_url){const session=await client.checkout({organizationId:org,email:user.email,...q,attemptId:attempt.id});await run("UPDATE stripe_checkout_attempts SET session_id=?,checkout_url=?,status='open' WHERE id=?",session.id,session.url,attempt.id);attempt.checkout_url=session.url;await audit(user,'billing.checkout_created',attempt.id);}
  json(res,200,{url:attempt.checkout_url});return true;
 }
 async function tick(){if(!enabled())return;const orgs=await all("SELECT organization_id FROM stripe_billing WHERE subscription_id IS NOT NULL UNION SELECT organization_id FROM stripe_checkout_attempts WHERE status IN ('creating','open') AND session_id IS NOT NULL");for(const row of orgs)try{await reconcile(row.organization_id);}catch{await run('UPDATE stripe_billing SET last_error=? WHERE organization_id=?','Payment sync needs retry',row.organization_id);}}
 return {handle,state,reconcile,assertCapacity,tick,parseSubscription};
}
