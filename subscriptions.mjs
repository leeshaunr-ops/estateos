import {subscriptionQuote} from './stripe-plans.mjs';
export const GB=1000000000;
export function planPrice(seats,packs=0){return 5900+Math.max(0,seats-2)*1500+packs*500;}
export function createSubscriptions({get,all,run,transaction,id,now,fail,json,body,audit,platformOwner,communications}){
 async function summary(org){
  const stripe=await get('SELECT * FROM stripe_billing WHERE organization_id=?',org);
  const paidPlan=stripe?.plan?subscriptionQuote(stripe.plan,stripe.extra_seats,stripe.storage_packs):null;
  const packs=paidPlan?paidPlan.storagePacks:Number((await get('SELECT storage_packs FROM company_plans WHERE organization_id=?',org))?.storage_packs||0);
  // Linked evidence may have multiple file records pointing at one stored object.
  const used=Number((await get('SELECT COALESCE(SUM(bytes),0) bytes FROM (SELECT f.storage_key,MAX(f.bytes) bytes FROM files f JOIN properties p ON p.id=f.property_id WHERE p.organization_id=? GROUP BY f.storage_key) objects',org))?.bytes||0);
  const seats=Number((await get("SELECT COUNT(*) n FROM users WHERE organization_id=? AND active=1 AND role IN ('admin','employee')",org))?.n||0);
  const limit=(paidPlan?paidPlan.storageGB:10+20*packs)*GB,percent=used/limit*100;
  const prior=await get('SELECT bytes,day FROM storage_history WHERE organization_id=? AND day<=? ORDER BY day DESC LIMIT 1',org,new Date(Date.now()-30*86400000).toISOString().slice(0,10));
  return {stripeConnected:!!stripe?.subscription_id,stripeStatus:stripe?.status||null,paidPlan,used,limit,percent,packs,seats,extraSeats:paidPlan?paidPlan.extraSeats:Math.max(0,seats-2),monthlyMinor:paidPlan?paidPlan.monthlyMinor:planPrice(seats,packs),level:percent>=100?100:percent>=90?90:percent>=75?75:0,growthBytes:prior?used-Number(prior.bytes):null,growthSince:prior?.day||null,pending:await get("SELECT id,created_at FROM storage_requests WHERE organization_id=? AND status='pending' ORDER BY created_at LIMIT 1",org),invoices:await all('SELECT * FROM platform_invoices WHERE organization_id=? ORDER BY period DESC LIMIT 12',org)};
 }
 async function monitor(org){
  const s=await summary(org),day=now().slice(0,10);
  await run('INSERT INTO storage_history VALUES(?,?,?) ON CONFLICT(organization_id,day) DO UPDATE SET bytes=excluded.bytes',org,day,s.used);
  if(s.level){
   const owner=await get("SELECT id,email FROM users WHERE id=? AND role='admin' AND active=1",process.env.ESTATEOS_PLATFORM_OWNER_ID||'');
   // Owner alert is routed through their own organization to preserve email isolation.
   const name=(await get('SELECT name FROM organizations WHERE id=?',org))?.name||'Company';
   const subject=`Storage ${s.level===100?'limit reached':s.level+'% warning'}: ${name}`;
   const message=`${name} is using ${(s.used/GB).toFixed(2)} GB of ${s.limit/GB} GB. Review Plan & storage. Existing files remain available. Extra 20 GB costs $5/month and requires approval; no automatic charge.`;
   await communications.enqueue(org,`storage:${day.slice(0,7)}:${s.limit}:${s.level}`,[await communications.primary(org)],subject,message,org);
   if(owner){const o=await get('SELECT organization_id FROM users WHERE id=?',owner.id);await communications.enqueue(o.organization_id,`storage-owner:${org}:${day.slice(0,7)}:${s.limit}:${s.level}`,[owner],subject,message,org);}
  }
  return s;
 }
 async function ensureSpace(org,bytes){const s=await summary(org);if(s.stripeConnected&&s.stripeStatus!=='active')fail(409,'Resolve your subscription payment before uploading new files. Existing files remain available.');if(s.used+bytes>s.limit)fail(413,'Company storage is full or this file would exceed the allowance. Ask your administrator to request another 20 GB for $5/month in Company settings. Existing files remain available.');}
 async function handle(req,res,url,user){
  if(!['/api/subscription','/api/subscription/request','/api/platform/storage','/api/platform/storage/decide','/api/platform/subscription-invoice'].includes(url.pathname))return false;
  if(!user)fail(401,'Please sign in.');if(user.role!=='admin')fail(403,'Administrator access required.');
  const p=url.pathname;if(p.startsWith('/api/platform/')&&!platformOwner(user))fail(403,'Platform owner access required.');
  if(req.method==='GET'&&p==='/api/subscription'){json(res,200,await monitor(user.organization_id));return true;}
  if(req.method==='GET'&&p==='/api/platform/storage'){const companies=[];for(const c of await all('SELECT id,name FROM organizations ORDER BY name'))companies.push({...c,...await summary(c.id)});json(res,200,{companies});return true;}
  if(req.method!=='POST')fail(405,'Method not allowed.');const b=await body(req);
  if(p==='/api/subscription/request'){
   if((await summary(user.organization_id)).stripeConnected)fail(409,'Contact sales@estateaegis.com to confirm a Stripe storage upgrade.');
   if(b.acceptMonthlyMinor!==500)fail(422,'Confirm the additional $5/month for 20 GB.');
   await transaction(async()=>{if((await summary(user.organization_id)).pending)return;await run('INSERT INTO storage_requests(id,organization_id,requested_by,created_at) VALUES(?,?,?,?)',id(),user.organization_id,user.id,now());await audit(user,'storage.requested',user.organization_id);});
   const owner=await get("SELECT id,email,organization_id FROM users WHERE id=? AND active=1",process.env.ESTATEOS_PLATFORM_OWNER_ID||'');if(owner)await communications.enqueue(owner.organization_id,'storage-request:'+user.organization_id+':'+(await summary(user.organization_id)).pending.id,[owner],'Storage upgrade requested','A company requested 20 GB of additional storage for $5/month. Review Companies → Storage & invoices. No payment has been collected.',user.organization_id);
  }else if(p==='/api/platform/storage/decide'){
   if(!['approve','decline'].includes(b.decision))fail(422,'Choose approve or decline.');
   await transaction(async()=>{const r=await get("SELECT * FROM storage_requests WHERE id=? AND status='pending'",b.id);if(!r)fail(409,'Request already handled or not found.');if(b.decision==='approve')await run('INSERT INTO company_plans VALUES(?,1,?) ON CONFLICT(organization_id) DO UPDATE SET storage_packs=company_plans.storage_packs+1,updated_at=excluded.updated_at',r.organization_id,now());await run('UPDATE storage_requests SET status=?,decided_at=? WHERE id=?',b.decision==='approve'?'approved':'declined',now(),r.id);await audit(user,'storage.'+b.decision,r.organization_id);});
  }else if(p==='/api/platform/subscription-invoice'){
   if(b.action==='create'&&(await summary(b.organizationId)).stripeConnected)fail(409,'This company is billed through Stripe. Do not issue a duplicate manual invoice.');
   await transaction(async()=>{
    if(b.action==='paid'){const invoice=await get('SELECT * FROM platform_invoices WHERE id=?',b.id);if(!invoice)fail(404,'Invoice not found.');await run("UPDATE platform_invoices SET status='paid',paid_at=? WHERE id=?",now(),b.id);await audit(user,'subscription.invoice_paid',b.id);return;}
    if(b.action!=='create'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.period||''))fail(422,'Choose a billing month.');
    if(!await get('SELECT id FROM organizations WHERE id=?',b.organizationId))fail(404,'Company not found.');
    if(await get('SELECT id FROM platform_invoices WHERE organization_id=? AND period=?',b.organizationId,b.period))fail(409,'An invoice already exists for this company and month.');
    const s=await summary(b.organizationId);await run('INSERT INTO platform_invoices(id,organization_id,period,seats,storage_packs,total_minor,created_at) VALUES(?,?,?,?,?,?,?)',id(),b.organizationId,b.period,s.seats,s.packs,s.monthlyMinor,now());await audit(user,'subscription.invoice_created',b.organizationId);
   });
  }else fail(405,'Method not allowed.');json(res,200,{ok:true});return true;
 }
 let running=false;
 async function tick(){if(running)return;running=true;try{for(const o of await all('SELECT id FROM organizations'))await monitor(o.id);}finally{running=false;}}
 return {handle,summary,ensureSpace,monitor,tick};
}
