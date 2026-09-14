import {createStripeClient} from './stripe-client.mjs';
import {PLANS,subscriptionQuote} from './stripe-plans.mjs';
import {sendInvitation} from './email.mjs';
import {seal,unseal} from './vault.mjs';

// Payment reservations are not workspaces. Only trusted Stripe verification creates access.
export function createPaidSignup({get,all,run,transaction,id,now,hash,randomBytes,body,json,fail,rate,parseSubscription,
 client=createStripeClient({origin:process.env.APP_URL||'https://estateaegis.com'}),send=sendInvitation,encrypt=seal,decrypt=unseal,
 enabled=()=>process.env.STRIPE_BILLING_ENABLED==='1'&&String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_')&&!!process.env.RESEND_API_KEY,
 ownerId=()=>process.env.ESTATEOS_PLATFORM_OWNER_ID}){
 const busy=new Map();
 const token=()=>randomBytes(32).toString('hex');
 const ref=v=>typeof v==='string'?v:v?.id;
 async function deliver(row){
  row=await get('SELECT * FROM paid_signups WHERE id=?',row.id);
  if(row.status!=='invited'||row.email_status==='sent'||Number(row.next_email_at)>Date.now())return;
  const secrets=decrypt(row.secrets,'signup:'+row.id);
  await run('UPDATE workspace_invites SET expires_at=? WHERE token_hash=? AND used_at IS NULL',Date.now()+48*3600000,row.invite_hash);
  await run('UPDATE paid_signups SET next_email_at=? WHERE id=? AND invite_hash=?',Date.now()+300000,row.id,row.invite_hash);
  const q=JSON.parse(row.selection);
  const result=await send({to:row.email,company:row.company,invitePath:'/?workspaceInvite='+secrets.inviteToken,planDescription:`${PLANS[q.plan].name}, $${(q.monthlyMinor/100).toFixed(2)} USD/month, up to ${q.residences} active residences, ${q.seats} admin/staff users, ${q.storageGB} GB shared storage`});
  await run('UPDATE paid_signups SET email_status=? WHERE id=? AND invite_hash=?',result.emailStatus==='sent'?'sent':'pending',row.id,row.invite_hash);
 }
 async function reconcile(signupId){
  if(busy.has(signupId))return busy.get(signupId);
  const task=(async()=>{
   let row=await get('SELECT * FROM paid_signups WHERE id=?',signupId);
   if(!row||row.status==='accepted')return;
   if(row.status==='invited'){await deliver(row);return;}
   if(!row.session_id)return;
   const s=await client.request('checkout/sessions/'+encodeURIComponent(row.session_id));
   if(s.livemode!==true||s.mode!=='subscription'||s.client_reference_id!==row.organization_id||s.metadata?.attempt_id!=='signup-'+row.id)throw Error('Signup payment ownership mismatch.');
   if(s.status==='expired'){await run("UPDATE paid_signups SET status='expired' WHERE id=?",row.id);return;}
   if(s.status!=='complete'||s.payment_status!=='paid')return;
   const sid=ref(s.subscription),cid=ref(s.customer);if(!sid||!cid)throw Error('Missing paid subscription.');
   const sub=await client.request('subscriptions/'+encodeURIComponent(sid)+'?expand%5B%5D=latest_invoice');
   if(sub.livemode!==true||sub.metadata?.organization_id!==row.organization_id||ref(sub.customer)!==cid||sub.status!=='active'||sub.latest_invoice?.status!=='paid')throw Error('Subscription payment is not verified.');
   const q=parseSubscription(sub),expected=JSON.parse(row.selection);
   if(JSON.stringify(q)!==JSON.stringify(expected))throw Error('Paid plan does not match the selected plan.');
   const secrets=decrypt(row.secrets,'signup:'+row.id),inviteHash=hash(secrets.inviteToken);
   await transaction(async()=>{
    row=await get('SELECT * FROM paid_signups WHERE id=?',row.id);if(row.status==='invited'||row.status==='accepted')return;
    if(await get('SELECT id FROM users WHERE LOWER(email)=?',row.email))throw Error('Paid signup email requires support review.');
    await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)',row.organization_id,row.company,now());
    await run('INSERT INTO workspace_settings(organization_id) VALUES(?)',row.organization_id);
    await run('INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES(?,?,?,?,?,?,?,?)',row.organization_id,cid,sid,'active',q.plan,q.extraSeats,q.storagePacks,now());
    await run('INSERT INTO workspace_invites(token_hash,company,email,created_by,expires_at,used_at) VALUES(?,?,?,?,?,NULL)',inviteHash,row.company,row.email,ownerId(),Date.now()+48*3600000);
    await run("UPDATE paid_signups SET status='invited',invite_hash=? WHERE id=?",inviteHash,row.id);
   });
   await deliver(row);
  })();busy.set(signupId,task);try{return await task;}finally{busy.delete(signupId);}
 }
 async function handle(req,res,url){
  if(!url.pathname.startsWith('/api/signup/'))return false;
  if(url.pathname==='/api/signup/status'&&req.method==='GET'){
   rate(req,'signup-status',120);const row=await get('SELECT * FROM paid_signups WHERE access_hash=?',hash(url.searchParams.get('token')||''));if(!row)fail(404,'Checkout not found. Contact help@estateaegis.com if you have already paid.');
   if(enabled())try{await reconcile(row.id);}catch{ /* Durable worker retries; no account details leak. */ }
   const current=await get('SELECT status,email_status,checkout_url FROM paid_signups WHERE id=?',row.id);json(res,200,{status:current.status,emailStatus:current.email_status,checkoutUrl:current.status==='pending'?current.checkout_url:null});return true;
  }
  if(url.pathname==='/api/signup/resend'&&req.method==='POST'){
   rate(req,'signup-resend',3);if(!enabled())fail(503,'Email delivery is temporarily unavailable. Contact Help.');const b=await body(req);let row;
   await transaction(async()=>{
    row=await get("SELECT * FROM paid_signups WHERE access_hash=? AND status='invited'",hash(String(b.token||'')));if(!row)fail(409,'No unclaimed paid invitation was found.');
    const original=await get('SELECT used_at FROM workspace_invites WHERE token_hash=?',row.invite_hash);if(!original||original.used_at)fail(409,'This invitation has already been accepted.');
    const secrets=decrypt(row.secrets,'signup:'+row.id);secrets.inviteToken=token();const nextHash=hash(secrets.inviteToken);
    await run('UPDATE workspace_invites SET token_hash=?,expires_at=? WHERE token_hash=?',nextHash,Date.now()+48*3600000,row.invite_hash);
    await run("UPDATE paid_signups SET secrets=?,invite_hash=?,email_status='pending',next_email_at=0 WHERE id=?",encrypt(secrets,'signup:'+row.id),nextHash,row.id);
   });
   await deliver(row);json(res,200,{queued:true});return true;
  }
  if(url.pathname!=='/api/signup/start'||req.method!=='POST')fail(404,'Signup action not found.');
  rate(req,'signup-start',10);if(!enabled()||!await get('SELECT id FROM users WHERE id=?',ownerId()))fail(503,'Online signup is temporarily unavailable. Contact sales@estateaegis.com.');
  const b=await body(req),email=String(b.email||'').trim().toLowerCase(),company=String(b.company||'').trim();
  if(!company||company.length>160||email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||email.split('@').length!==2||email!==String(b.confirmEmail||'').trim().toLowerCase())fail(422,'Enter your company name and matching email addresses.');
  let q;try{q=subscriptionQuote(b.plan,b.extraSeats,b.storagePacks);}catch{fail(422,'Choose a valid plan and whole-number add-ons.');}
  if(b.acceptMonthlyMinor!==q.monthlyMinor)fail(422,'Confirm your monthly total.');if(b.acceptTerms!=='on'||b.acceptBilling!=='on'||b.acceptedLegalVersion!=='2026-09-14')fail(422,'Accept the Terms, Privacy Policy, and recurring billing authorization to continue.');
  let row;
  await transaction(async()=>{
   if(await get('SELECT id FROM users WHERE LOWER(email)=?',email))fail(409,'This email already has an account. Log in and subscribe in Company settings.');
   row=await get('SELECT * FROM paid_signups WHERE email=?',email);
   if(row&&row.status==='expired'){await run('DELETE FROM paid_signups WHERE id=?',row.id);row=null;}
   if(row&&(row.company!==company||row.selection!==JSON.stringify(q)||row.status!=='pending'))fail(409,'A signup already exists for this email. Check your invitation or contact help@estateaegis.com before starting another payment.');
   if(!row){const signupId=id(),secrets={statusToken:token(),inviteToken:token(),legal:{version:'2026-09-14',acceptedAt:now(),terms:true,privacy:true,recurringBilling:true}};row={id:signupId,email,company,organization_id:id(),selection:JSON.stringify(q),access_hash:hash(secrets.statusToken),secrets:encrypt(secrets,'signup:'+signupId),created_at:now()};await run('INSERT INTO paid_signups(id,email,company,organization_id,selection,access_hash,secrets,created_at) VALUES(?,?,?,?,?,?,?,?)',row.id,email,company,row.organization_id,row.selection,row.access_hash,row.secrets,row.created_at);}
  });
  if(!row.checkout_url){const secrets=decrypt(row.secrets,'signup:'+row.id),path='/signup?status='+secrets.statusToken;const s=await client.checkout({organizationId:row.organization_id,email,...q,attemptId:'signup-'+row.id,successPath:path,cancelPath:path+'&canceled=1'});await run('UPDATE paid_signups SET session_id=?,checkout_url=? WHERE id=?',s.id,s.url,row.id);row.checkout_url=s.url;}
  json(res,200,{url:row.checkout_url});return true;
 }
 async function tick(){if(!enabled())return;const rows=await all("SELECT id FROM paid_signups WHERE (status='pending' AND session_id IS NOT NULL) OR (status='invited' AND email_status!='sent')");for(const r of rows)try{await reconcile(r.id);}catch{console.error('Paid signup requires another verification attempt.');}}
 return {handle,tick,reconcile};
}
