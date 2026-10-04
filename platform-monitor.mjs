// Owner monitoring (platform owner only, read-only): every company with plan, signup date, trial, Stripe status,
// usage against plan limits, MRR, trials vs paid, recent signups, trials ending within 7 days, failed payments,
// cancellations and /demo requests. Stripe webhooks keep a monitoring copy of each subscription
// (stripe_subscription_sync); access decisions still come from stripe_billing via billing.reconcile, which each
// relevant webhook triggers. backfill() rebuilds the monitoring copy from stored billing rows (and from the Stripe API
// when live billing is configured). Nothing here is reachable by company admins, staff, clients or vendors, and
// nothing is added to /api/data.
import {PLANS,ADDONS,subscriptionQuote,SEAT_ROLE_SQL} from './stripe-plans.mjs';
import {verifyStripeEvent} from './stripe-client.mjs';

const DAY=86400000,GB=1e9;
// Whole calendar days in Eastern Time between two instants (a trial ending tomorrow afternoon is "1 day").
const etDay=ms=>Date.parse(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms))+'T00:00:00Z');
const daysBetween=(from,to)=>Math.round((etDay(to)-etDay(from))/DAY);
const iso=seconds=>Number.isFinite(Number(seconds))&&Number(seconds)>0?new Date(Number(seconds)*1000).toISOString():null;
const ref=v=>typeof v==='string'?v:v?.id||null;
export const SUBSCRIPTION_EVENTS=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','customer.subscription.trial_will_end'];
export const INVOICE_EVENTS=['invoice.payment_failed','invoice.paid','invoice.payment_succeeded'];

/** Monitoring fields from a Stripe subscription object. Lenient: unknown items still count toward the amount. */
export function subscriptionFields(sub){
 const items=Array.isArray(sub?.items?.data)?sub.items.data:[];let plan=null,extraSeats=0,storagePacks=0,amount=0;
 for(const item of items){
  const price=item.price||item.plan||{},product=ref(price.product),qty=Number.isSafeInteger(item.quantity)?item.quantity:1;
  const monthly=price.recurring?.interval==='year'?Math.round(Number(price.unit_amount||0)/12):Number(price.unit_amount||0);amount+=monthly*qty;
  const match=Object.entries(PLANS).find(([,p])=>p.product===product);
  if(match)plan=match[0];else if(product===ADDONS.seats.product)extraSeats=qty;else if(product===ADDONS.storage.product)storagePacks=qty;
 }
 const first=items[0]||{};
 return {subscription_id:sub.id,customer_id:ref(sub.customer),organization_id:sub.metadata?.organization_id||null,status:String(sub.status||'unknown'),plan,extra_seats:extraSeats,storage_packs:storagePacks,amount_minor:items.length?amount:null,currency:String(sub.currency||first.price?.currency||'usd'),
  current_period_start:iso(sub.current_period_start??first.current_period_start),current_period_end:iso(sub.current_period_end??first.current_period_end),trial_start:iso(sub.trial_start),trial_end:iso(sub.trial_end),
  cancel_at_period_end:sub.cancel_at_period_end?1:0,canceled_at:iso(sub.canceled_at),ended_at:iso(sub.ended_at),livemode:sub.livemode?1:0};
}

export function createPlatformMonitor({get,all,run,transaction,json,fail,now,platformOwner,audit,billing,env=process.env,clock=()=>Date.now(),stripeClient=null,log=console}){
 const liveBilling=()=>env.STRIPE_BILLING_ENABLED==='1'&&String(env.STRIPE_SECRET_KEY||'').startsWith('sk_live_');
 // Production (live key) accepts only live events; anything else (staging, local) accepts only test events.
 const expectLive=()=>String(env.STRIPE_SECRET_KEY||'').startsWith('sk_live_');
 const COLS=['organization_id','customer_id','status','plan','extra_seats','storage_packs','amount_minor','currency','current_period_start','current_period_end','trial_start','trial_end','cancel_at_period_end','canceled_at','ended_at','livemode'];
 async function orgFor(subscriptionId,customerId,hinted){
  if(hinted)return hinted;
  const row=(subscriptionId&&await get('SELECT organization_id FROM stripe_billing WHERE subscription_id=?',subscriptionId))||(customerId&&await get('SELECT organization_id FROM stripe_billing WHERE customer_id=?',customerId))||(subscriptionId&&await get('SELECT organization_id FROM stripe_subscription_sync WHERE subscription_id=?',subscriptionId));
  return row?.organization_id||null;
 }
 // Upsert unless a newer event already updated this subscription (Stripe does not guarantee delivery order).
 async function upsert(fields,source,created){
  const existing=await get('SELECT event_created FROM stripe_subscription_sync WHERE subscription_id=?',fields.subscription_id);
  if(existing&&Number(existing.event_created)>created)return false;
  const values=COLS.map(c=>fields[c]??(['extra_seats','storage_packs','cancel_at_period_end','livemode'].includes(c)?0:c==='currency'?'usd':null));
  await run(`INSERT INTO stripe_subscription_sync(subscription_id,${COLS.join(',')},source,event_created,updated_at) VALUES(?,${COLS.map(()=>'?').join(',')},?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET ${COLS.map(c=>`${c}=excluded.${c}`).join(',')},source=excluded.source,event_created=excluded.event_created,updated_at=excluded.updated_at`,fields.subscription_id,...values,source,created,now());
  return true;
 }
 async function readRaw(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>1048576)fail(413,'Webhook too large.');chunks.push(chunk);}return Buffer.concat(chunks);}
 /** Applies one verified Stripe event. Returns what happened, for logs and tests. */
 async function apply(event){
  if(!!event.livemode!==expectLive())return {ignored:'mode'};
  const object=event.data.object,created=Number(event.created)||0;
  let subscriptionId=null,orgId=null,amount=null,result='ignored';
  if(SUBSCRIPTION_EVENTS.includes(event.type)&&object.object==='subscription'){
   const fields=subscriptionFields(object);subscriptionId=fields.subscription_id;fields.organization_id=orgId=await orgFor(subscriptionId,fields.customer_id,fields.organization_id);
   result=await transaction(async()=>{
    if(!await claim(event,subscriptionId,orgId,fields.amount_minor))return 'duplicate';
    // Invoice fields (last payment failure) are not in COLS, so a subscription update keeps them.
    return await upsert(fields,'webhook',created)?'updated':'stale';
   });
  }else if(INVOICE_EVENTS.includes(event.type)&&object.object==='invoice'){
   subscriptionId=ref(object.subscription)||ref(object.parent?.subscription_details?.subscription)||null;
   const hinted=object.subscription_details?.metadata?.organization_id||object.parent?.subscription_details?.metadata?.organization_id||null;
   orgId=await orgFor(subscriptionId,ref(object.customer),hinted);amount=Number.isFinite(Number(object.amount_due))?Number(object.amount_due):null;
   result=await transaction(async()=>{
    if(!await claim(event,subscriptionId,orgId,amount))return 'duplicate';
    if(!subscriptionId)return 'recorded';
    if(!await get('SELECT subscription_id FROM stripe_subscription_sync WHERE subscription_id=?',subscriptionId))
     await run("INSERT INTO stripe_subscription_sync(subscription_id,organization_id,customer_id,status,source,event_created,updated_at,livemode) VALUES(?,?,?,'unknown','webhook',0,?,?)",subscriptionId,orgId,ref(object.customer),now(),event.livemode?1:0);
    if(event.type==='invoice.payment_failed')await run('UPDATE stripe_subscription_sync SET last_invoice_status=?,last_payment_failed_at=?,last_payment_failed_minor=?,organization_id=COALESCE(organization_id,?),updated_at=? WHERE subscription_id=?','payment_failed',iso(created)||now(),amount,orgId,now(),subscriptionId);
    else await run("UPDATE stripe_subscription_sync SET last_invoice_status='paid',organization_id=COALESCE(organization_id,?),updated_at=? WHERE subscription_id=?",orgId,now(),subscriptionId);
    return 'recorded';
   });
  }else return {ignored:'type'};
  // Access stays with the existing verification path: re-check this company against the Stripe API.
  if(result!=='duplicate'&&orgId&&billing?.reconcile&&liveBilling()&&await get('SELECT subscription_id FROM stripe_billing WHERE organization_id=? AND subscription_id IS NOT NULL',orgId))
   billing.reconcile(orgId).catch(()=>log.error('Billing sync after webhook needs retry.'));
  return {result,subscriptionId,organizationId:orgId};
 }
 async function claim(event,subscriptionId,orgId,amount){
  if(await get('SELECT id FROM stripe_webhook_events WHERE id=?',event.id))return false;
  await run('INSERT INTO stripe_webhook_events(id,type,subscription_id,organization_id,amount_minor,event_created,received_at) VALUES(?,?,?,?,?,?,?)',event.id,event.type,subscriptionId,orgId,amount,Number(event.created)||0,now());
  return true;
 }
 async function webhook(req,res){
  const secret=env.STRIPE_WEBHOOK_SECRET;
  if(!secret){json(res,503,{error:'Webhook not configured.'});return;}
  const raw=await readRaw(req);let event;
  try{event=verifyStripeEvent(raw,req.headers['stripe-signature'],secret,Math.floor(clock()/1000));}catch{json(res,400,{error:'Invalid webhook.'});return;}
  const outcome=await apply(event);json(res,200,{received:true,...(outcome.ignored?{ignored:outcome.ignored}:{result:outcome.result})});
 }
 /** Rebuilds monitoring rows from stored billing rows; with live billing configured, refreshes each from Stripe. */
 async function backfill({fromStripe=liveBilling()}={}){
  let local=0,stripe=0,failed=0;
  for(const b of await all('SELECT * FROM stripe_billing WHERE subscription_id IS NOT NULL')){
   let q=null;try{if(b.plan)q=subscriptionQuote(b.plan,Number(b.extra_seats||0),Number(b.storage_packs||0));}catch{}
   const existing=await get('SELECT source FROM stripe_subscription_sync WHERE subscription_id=?',b.subscription_id);
   if(!existing||existing.source==='backfill'){
    await upsert({subscription_id:b.subscription_id,organization_id:b.organization_id,customer_id:b.customer_id,status:b.status,plan:b.plan,extra_seats:Number(b.extra_seats||0),storage_packs:Number(b.storage_packs||0),amount_minor:q?q.monthlyMinor:null},'backfill',0);local++;
   }else await run('UPDATE stripe_subscription_sync SET organization_id=COALESCE(organization_id,?) WHERE subscription_id=?',b.organization_id,b.subscription_id);
   if(fromStripe&&stripeClient)try{
    const sub=await stripeClient.request('subscriptions/'+encodeURIComponent(b.subscription_id));
    if(!!sub.livemode===expectLive()&&ref(sub.customer)===b.customer_id){const f=subscriptionFields(sub);f.organization_id=b.organization_id;await upsert(f,'stripe',Math.floor(clock()/1000));stripe++;}
   }catch{failed++;}
  }
  return {local,stripe,failed};
 }
 async function overview(at=clock()){
  const nowIso=new Date(at).toISOString();
  const orgs=await all('SELECT o.id,o.name,o.created_at,s.status workspace_status,s.primary_admin_id FROM organizations o LEFT JOIN workspace_settings s ON s.organization_id=o.id ORDER BY o.created_at DESC');
  const byOrg=(rows,key='organization_id')=>new Map(rows.map(r=>[r[key],r]));
  const residences=byOrg(await all('SELECT organization_id,COUNT(*) n FROM properties WHERE archived_at IS NULL GROUP BY organization_id'));
  const seats=byOrg(await all(`SELECT organization_id,COUNT(*) n FROM users WHERE active=1 AND ${SEAT_ROLE_SQL} GROUP BY organization_id`));
  const portal=byOrg(await all("SELECT organization_id,COUNT(*) n FROM users WHERE active=1 AND role IN ('client','vendor') GROUP BY organization_id"));
  const storage=byOrg(await all('SELECT org organization_id,COALESCE(SUM(bytes),0) bytes FROM (SELECT f.storage_key,MAX(f.bytes) bytes,MAX(p.organization_id) org FROM files f JOIN properties p ON p.id=f.property_id GROUP BY f.storage_key) q GROUP BY org'));
  const packs=byOrg(await all('SELECT organization_id,storage_packs FROM company_plans'));
  const billingRows=byOrg(await all('SELECT * FROM stripe_billing'));
  const syncRows=new Map();for(const r of await all('SELECT * FROM stripe_subscription_sync ORDER BY event_created ASC'))if(r.organization_id)syncRows.set(r.organization_id,r);
  const demosByOrg=byOrg(await all('SELECT organization_id,expires_at FROM demo_workspaces'));
  const admins=byOrg(await all("SELECT id,organization_id,name,email FROM users WHERE role='admin'"),'id');
  const companies=orgs.map(o=>{
   const b=billingRows.get(o.id),s=syncRows.get(o.id),demo=demosByOrg.get(o.id);
   const plan=s?.plan||b?.plan||null,extraSeats=Number(s?.plan?s.extra_seats:b?.extra_seats||0),storagePacks=Number(s?.plan?s.storage_packs:b?.storage_packs||0);
   let q=null;try{if(plan)q=subscriptionQuote(plan,extraSeats,storagePacks);}catch{}
   const status=demo?'demo':(s&&s.status!=='unknown'?s.status:b?.subscription_id?b.status:'no_subscription');
   const legacyPacks=Number(packs.get(o.id)?.storage_packs||0);
   const trialEnd=s?.trial_end||(status==='trialing'?new Date(Date.parse(o.created_at)+30*DAY).toISOString():null);
   const admin=admins.get(o.primary_admin_id);
   return {id:o.id,name:o.name,signupAt:o.created_at,workspaceStatus:o.workspace_status||'active',admin:admin?{name:admin.name,email:admin.email}:null,
    kind:demo?'demo':status==='trialing'?'trial':['active','past_due','unpaid'].includes(status)?'paid':['canceled','incomplete_expired'].includes(status)?'canceled':'none',
    status,plan,planName:plan?PLANS[plan]?.name||plan:null,amountMinor:s?.amount_minor??(q?q.monthlyMinor:null),
    trialEnd,trialEndEstimated:!s?.trial_end&&!!trialEnd,trialDaysLeft:trialEnd?daysBetween(at,Date.parse(trialEnd)):null,
    periodEnd:s?.current_period_end||null,cancelAtPeriodEnd:!!Number(s?.cancel_at_period_end||0),canceledAt:s?.canceled_at||null,endedAt:s?.ended_at||null,
    lastPaymentFailedAt:s?.last_payment_failed_at||null,lastPaymentFailedMinor:s?.last_payment_failed_minor??null,lastInvoiceStatus:s?.last_invoice_status||null,
    demoExpiresAt:demo?new Date(Number(demo.expires_at)).toISOString():null,syncedAt:s?.updated_at||b?.verified_at||null,syncSource:s?.source||null,
    usage:{residences:Number(residences.get(o.id)?.n||0),seats:Number(seats.get(o.id)?.n||0),portalUsers:Number(portal.get(o.id)?.n||0),bytes:Number(storage.get(o.id)?.bytes||0)},
    limits:q?{residences:q.residences,seats:q.seats,storageBytes:q.storageGB*GB}:{residences:null,seats:null,storageBytes:(PLANS.essentials.storageGB+ADDONS.storage.gb*legacyPacks)*GB},
    addOns:{extraSeats:q?extraSeats:0,storagePacks:q?storagePacks:legacyPacks}};
  });
  const real=companies.filter(c=>c.kind!=='demo');
  const sum=list=>list.reduce((n,c)=>n+Number(c.amountMinor||0),0);
  const active=real.filter(c=>c.status==='active'),trials=real.filter(c=>c.status==='trialing'),pastDue=real.filter(c=>['past_due','unpaid'].includes(c.status));
  const failedEvents=await all("SELECT id,subscription_id,organization_id,amount_minor,event_created FROM stripe_webhook_events WHERE type='invoice.payment_failed' AND event_created>=? ORDER BY event_created DESC LIMIT 50",Math.floor((at-60*DAY)/1000));
  const nameOf=id=>companies.find(c=>c.id===id)?.name||'Unlinked Stripe subscription';
  const failedPayments=[...failedEvents.map(e=>({companyId:e.organization_id,company:nameOf(e.organization_id),at:iso(e.event_created),amountMinor:e.amount_minor,status:companies.find(c=>c.id===e.organization_id)?.status||null})),
   ...pastDue.filter(c=>!failedEvents.some(e=>e.organization_id===c.id)).map(c=>({companyId:c.id,company:c.name,at:c.lastPaymentFailedAt||c.syncedAt,amountMinor:c.lastPaymentFailedMinor??c.amountMinor,status:c.status}))];
  const demoRequests=(await all('SELECT r.email,r.name,r.company,r.residences,r.requested_at,r.verified_at,d.expires_at FROM demo_requests r LEFT JOIN users u ON LOWER(u.email)=r.email LEFT JOIN demo_workspaces d ON d.organization_id=u.organization_id ORDER BY r.requested_at DESC LIMIT 50'))
   .map(r=>({name:r.name,company:r.company,email:r.email,residences:r.residences,requestedAt:Number(r.requested_at)?new Date(Number(r.requested_at)).toISOString():null,acceptedAt:r.verified_at||null,demoEndsAt:r.expires_at?new Date(Number(r.expires_at)).toISOString():null,
    status:r.expires_at?(Number(r.expires_at)>at?'demo_active':'demo_ended'):r.verified_at?'accepted':Number(r.requested_at)?'invited':'delivery_failed'}));
  return {generatedAt:nowIso,
   metrics:{mrrMinor:sum(active),trialValueMinor:sum(trials),pastDueMinor:sum(pastDue),companies:real.length,paid:active.length,trialing:trials.length,pastDue:pastDue.length,
    canceled:real.filter(c=>c.kind==='canceled').length,noSubscription:real.filter(c=>c.kind==='none').length,demosActive:companies.filter(c=>c.kind==='demo'&&Date.parse(c.demoExpiresAt)>at).length,
    demoRequests30:demoRequests.filter(r=>r.requestedAt&&Date.parse(r.requestedAt)>=at-30*DAY).length,signups30:real.filter(c=>Date.parse(c.signupAt)>=at-30*DAY).length},
   recentSignups:real.filter(c=>Date.parse(c.signupAt)>=at-30*DAY).slice(0,12).map(c=>c.id),
   trialsEndingSoon:trials.filter(c=>c.trialEnd&&Date.parse(c.trialEnd)>=at-DAY&&Date.parse(c.trialEnd)<=at+7*DAY).sort((a,b)=>Date.parse(a.trialEnd)-Date.parse(b.trialEnd)).map(c=>c.id),
   cancellations:real.filter(c=>c.kind==='canceled'||c.cancelAtPeriodEnd).sort((a,b)=>Date.parse(b.canceledAt||b.syncedAt||0)-Date.parse(a.canceledAt||a.syncedAt||0)).map(c=>c.id),
   failedPayments,demoRequests,companies,
   webhook:{configured:!!env.STRIPE_WEBHOOK_SECRET,lastEventAt:iso((await get('SELECT MAX(event_created) t FROM stripe_webhook_events'))?.t),mode:expectLive()?'live':'test'}};
 }
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/owner/'))return false;
  if(!user)fail(401,'Please sign in.');
  // Hidden from everyone but the platform owner: same answer as an unknown endpoint.
  if(!platformOwner(user))fail(404,'Endpoint not found.');
  if(req.method==='GET'&&url.pathname==='/api/owner/overview'){json(res,200,await overview());return true;}
  if(req.method==='POST'&&url.pathname==='/api/owner/backfill'){const r=await backfill();await audit(user,'platform.billing_backfill',`${r.local}/${r.stripe}`);json(res,200,r);return true;}
  fail(404,'Endpoint not found.');
 }
 return {handle,webhook,apply,backfill,overview};
}
