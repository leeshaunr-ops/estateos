import {sendInvitation} from './email.mjs';
export function createDemoSignup({get,run,transaction,body,json,fail,rate,id,now,hash,randomBytes},{env=process.env,send=sendInvitation}={}){
 const message='If this email is eligible, your demo invitation is on its way. Check your inbox and spam folder. Already have an account? Log in or contact sales@estateaegis.com.';
 async function handle(req,res,url){
  if(url.pathname!=='/api/demo-request')return false;
  if(req.method!=='POST')fail(405,'Use the demo signup form.');
  rate(req,'public-demo',10);const b=await body(req);
  if(b.website){json(res,200,{message});return true;}
  const clean=(v,max)=>typeof v==='string'&&v.trim().length<=max?v.trim():'';
  const name=clean(b.name,160),company=clean(b.company,160),email=clean(b.email,254).toLowerCase(),phone=clean(b.phone,40),residences=clean(b.residences,30);
  if(!name||!company||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['1–10','11–50','51–150','151–300','300+'].includes(residences)||b.contactConsent!==true)fail(422,'Complete the required fields and acknowledge the demo contact notice.');
  const owner=await get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1",env.ESTATEOS_PLATFORM_OWNER_ID||'');
  if(!owner||!env.RESEND_API_KEY)fail(503,'Online demo signup is temporarily unavailable. Contact sales@estateaegis.com.');
  const token=randomBytes(32).toString('hex'),tokenHash=hash(token);let eligible=false;
  await transaction(async()=>{
   if(await get('SELECT id FROM users WHERE LOWER(email)=?',email)||await get("SELECT id FROM paid_signups WHERE email=? AND status IN ('pending','invited')",email))return;
   const existing=await get('SELECT * FROM demo_requests WHERE email=?',email);
   if(existing&&(existing.verified_at||Number(existing.requested_at)>Date.now()-15*60000))return;
   // Persistent global cap supplements the request-rate limit across restarts.
   if(Number((await get('SELECT COUNT(*) n FROM demo_requests WHERE requested_at>?',Date.now()-86400000)).n)>=100)fail(429,'Demo signup is busy. Contact sales@estateaegis.com for access.');
   const pending=await get('SELECT token_hash FROM workspace_invites WHERE email=? AND used_at IS NULL AND expires_at>?',email,Date.now());
   if(pending&&pending.token_hash!==existing?.token_hash)return;
   if(existing)await run('UPDATE workspace_invites SET expires_at=0 WHERE token_hash=? AND used_at IS NULL',existing.token_hash);
   await run('INSERT INTO workspace_invites VALUES(?,?,?,?,?,?)',tokenHash,company+' · Private demo',email,owner.id,Date.now()+48*3600000,null);
   await run('INSERT INTO demo_invites VALUES(?)',tokenHash);
   await run('INSERT INTO demo_requests(email,name,company,phone,residences,token_hash,requested_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,company=excluded.company,phone=excluded.phone,residences=excluded.residences,token_hash=excluded.token_hash,requested_at=excluded.requested_at',email,name,company,phone,residences,tokenHash,Date.now());
   eligible=true;
  });
  if(eligible){const result=await send({demoGuide:true,to:email,invitePath:'/?workspaceInvite='+token,company:company+' — your free seven-day private demo'},{env});if(result.emailStatus!=='sent'){await run('UPDATE demo_requests SET requested_at=0 WHERE email=? AND token_hash=?',email,tokenHash);fail(503,'Your invitation could not be delivered. Please try again or contact sales@estateaegis.com.');}}
  json(res,200,{message});return true;
 }
 // Called in the registration transaction: only a verified, accepted invitation becomes a lead.
 async function accepted(tokenHash){
  const r=await get('SELECT * FROM demo_requests WHERE token_hash=?',tokenHash);if(!r||r.verified_at)return;
  let lead=await get('SELECT id FROM platform_leads WHERE LOWER(email)=? ORDER BY updated_at DESC LIMIT 1',r.email);
  if(!lead){lead={id:id()};await run('INSERT INTO platform_leads(id,company,email,phone,stage,notes,follow_up,updated_at) VALUES(?,?,?,?,?,?,?,?)',lead.id,r.company,r.email,r.phone,'demo',`Contact: ${r.name}\nResidences managed: ${r.residences}\nSource: website private demo signup\nEmail verified by invitation acceptance.\nAgreed to demo access and related sales follow-up on ${new Date(Number(r.requested_at)).toISOString()}.`,'',now());}
  else await run("UPDATE platform_leads SET stage=CASE WHEN stage IN ('new','contacted') THEN 'demo' ELSE stage END,notes=notes||?,updated_at=? WHERE id=?",`\nWebsite demo accepted ${now()}. Contact: ${r.name}; residences: ${r.residences}; phone: ${r.phone}. Email verified; demo-related follow-up consent recorded.`,now(),lead.id);
  await run('UPDATE demo_requests SET lead_id=?,verified_at=? WHERE token_hash=?',lead.id,now(),tokenHash);
 }
 return {handle,accepted};
}
