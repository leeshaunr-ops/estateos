export function createPlatformDashboard({get,all,run,transaction,body,json,fail,id,now,audit,platformOwner,subscriptions}){
 const scopes=['operations','billing','marketing'];
 async function permissions(user){
  if(!user||user.active===0)return [];
  if(platformOwner(user))return scopes;
  const row=await get('SELECT permissions FROM platform_access WHERE user_id=?',user.id);
  try{return JSON.parse(row?.permissions||'[]').filter(p=>scopes.includes(p));}catch{return [];}
 }
 const clean=(v,max=200)=>{if(typeof v!=='string'||v.length>max)fail(422,'Invalid or too long field.');return v.trim();};
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/master/'))return false;
  if(!user)fail(401,'Sign in to your assigned account.');
  const access=await permissions(user),owner=platformOwner(user),p=url.pathname;
  if(!access.length)fail(403,'Platform access has not been assigned to this account.');
  const requireScope=s=>{if(!access.includes(s))fail(403,'This section is not included in your platform access.');};
  if(req.method==='GET'){
   let result;
   if(p==='/api/master/session')result={name:user.name,owner,permissions:access};
   else if(p==='/api/master/companies'){
    requireScope('operations');result=[];
    for(const c of await all('SELECT id,name,created_at FROM organizations ORDER BY name')){
     const s=await subscriptions.summary(c.id);
     result.push({...c,used:s.used,limit:s.limit,percent:s.percent,growthBytes:s.growthBytes,growthSince:s.growthSince,seats:s.seats,plan:s.paidPlan?.plan||'Legacy / not subscribed',residences:Number((await get('SELECT COUNT(*) n FROM properties WHERE organization_id=? AND archived_at IS NULL',c.id)).n),members:await all('SELECT name,email,role,active FROM users WHERE organization_id=? ORDER BY name',c.id)});
    }
   }else if(p==='/api/master/billing'){
    requireScope('billing');const companies=[];
    for(const c of await all('SELECT o.id,o.name,b.status,b.verified_at,b.customer_id,b.subscription_id,b.plan FROM organizations o LEFT JOIN stripe_billing b ON b.organization_id=o.id ORDER BY o.name')){
     const s=await subscriptions.summary(c.id);companies.push({...c,monthlyMinor:c.subscription_id?s.monthlyMinor:null});
    }
    result={companies,activeMonthlyMinor:companies.filter(c=>c.status==='active'&&c.subscription_id).reduce((sum,c)=>sum+c.monthlyMinor,0),signups:await all('SELECT company,email,status,email_status,created_at FROM paid_signups ORDER BY created_at DESC LIMIT 50')};
   }else if(p==='/api/master/health'){
    requireScope('operations');result={backups:await all('SELECT day,status,completed_at FROM backup_runs ORDER BY day DESC LIMIT 7'),email:await all('SELECT status,COUNT(*) total FROM email_outbox GROUP BY status')};
   }else if(p==='/api/master/access'){
    if(!owner)fail(403,'Only the owner can assign access.');result=await all('SELECT u.id,u.name,u.email,u.role,a.permissions FROM users u LEFT JOIN platform_access a ON a.user_id=u.id WHERE u.active=1 ORDER BY u.name');
   }else if(p==='/api/master/leads'){requireScope('marketing');result=await all('SELECT * FROM platform_leads ORDER BY updated_at DESC');}
   else if(p==='/api/master/posts'){requireScope('marketing');result=await all('SELECT * FROM platform_posts ORDER BY updated_at DESC');}
   else fail(404,'Not found.');
   json(res,200,result);return true;
  }
  if(req.method!=='POST')fail(405,'Method not allowed.');
  const b=await body(req);
  await transaction(async()=>{
   if(p==='/api/master/access'){
    if(!owner)fail(403,'Only the owner can assign access.');
    const target=await get('SELECT id,role,active FROM users WHERE id=?',b.userId);
    if(!target||!target.active)fail(422,'Choose an active account.');
    if(platformOwner(target))fail(422,'The owner retains access.');
    if(!Array.isArray(b.permissions)||b.permissions.some(s=>!scopes.includes(s)))fail(422,'Invalid permissions.');
    await run('INSERT INTO platform_access VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET permissions=excluded.permissions,granted_by=excluded.granted_by,updated_at=excluded.updated_at',target.id,JSON.stringify([...new Set(b.permissions)]),user.id,now());
    await audit(user,'platform.access_changed',target.id+':'+b.permissions.join(','));
   }else if(p==='/api/master/leads'){
    requireScope('marketing');const company=clean(b.company),email=clean(b.email||''),phone=clean(b.phone||'',60),notes=clean(b.notes||'',4000),follow=clean(b.follow_up||'',10);
    if(!company||!['new','contacted','demo','customer','not_interested'].includes(b.stage))fail(422,'Company and valid stage required.');
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(422,'Invalid email.');
    if(follow&&!/^\d{4}-\d{2}-\d{2}$/.test(follow))fail(422,'Invalid follow-up date.');
    const key=b.id||id();if(b.id&&!await get('SELECT id FROM platform_leads WHERE id=?',b.id))fail(404,'Lead not found.');
    await run('INSERT INTO platform_leads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET company=excluded.company,email=excluded.email,phone=excluded.phone,stage=excluded.stage,notes=excluded.notes,follow_up=excluded.follow_up,updated_at=excluded.updated_at',key,company,email,phone,b.stage,notes,follow,now());await audit(user,'platform.lead_saved',key);
   }else if(p==='/api/master/posts'){
    requireScope('marketing');const content=clean(b.content,10000),schedule=clean(b.scheduled_at||'',40);
    if(!content||!['facebook','instagram','linkedin','youtube'].includes(b.channel)||!['draft','ready'].includes(b.status))fail(422,'Choose a channel, draft status and content.');
    if(schedule&&!Number.isFinite(Date.parse(schedule)))fail(422,'Invalid planned date.');
    const key=b.id||id();if(b.id&&!await get('SELECT id FROM platform_posts WHERE id=?',b.id))fail(404,'Draft not found.');
    await run('INSERT INTO platform_posts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET channel=excluded.channel,content=excluded.content,status=excluded.status,scheduled_at=excluded.scheduled_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at',key,b.channel,content,b.status,schedule,user.id,now());await audit(user,'platform.post_saved',key);
   }else fail(404,'Not found.');
  });json(res,200,{ok:true});return true;
 }
 return {handle,permissions};
}
