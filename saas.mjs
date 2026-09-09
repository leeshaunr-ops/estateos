// Platform privileges are granted by an operator-owned user ID, never an editable email.
export function platformOwner(user){return !!user && user.role==='admin' && !!process.env.ESTATEOS_PLATFORM_OWNER_ID && user.id===process.env.ESTATEOS_PLATFORM_OWNER_ID;}
export function createSaas({get,all,run,transaction,fail,text,note,id,hash,now,passwordHash,session,json,body,rate,audit,randomBytes}){
 const owner=user=>{if(!platformOwner(user))fail(403,'Platform owner access required.');};
 const email=value=>{const e=text(value,'Email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))fail(422,'Enter a valid email.');return e;};
 return async function handle(req,res,url,user){
  const p=url.pathname;
  if(p==='/api/workspace-invite'&&req.method==='GET'){
   rate(req,'workspace-invite',60);
   const row=await get('SELECT company,email FROM workspace_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?',hash(url.searchParams.get('token')||''),Date.now());
   if(!row)fail(404,'Company invitation expired or already used.');json(res,200,row);return true;
  }
  if(p==='/api/workspace-register'&&req.method==='POST'){
   rate(req,'workspace-register');const b=await body(req),name=text(b.name,'Your name',160),pw=passwordHash(b.password),uid=id(),org=id();
   await transaction(async()=>{
    const row=await get('SELECT * FROM workspace_invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?',hash(String(b.token||'')),Date.now());
    if(!row)fail(422,'Company invitation expired or already used.');
    if(await get('SELECT id FROM users WHERE LOWER(email)=?',row.email))fail(409,'This email already has an account. Use a different email for this company.');
    await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)',org,row.company,now());
    await run('INSERT INTO workspace_settings(organization_id) VALUES(?)',org);
    await run('INSERT INTO users(id,organization_id,name,email,password_hash,role,client_id,vendor_id,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',uid,org,name,row.email,pw,'admin',null,null,1,now());
    await run('UPDATE workspace_invites SET used_at=? WHERE token_hash=?',now(),row.token_hash);
    await audit({id:uid,organization_id:org},'workspace.created',org);
   });
   await session(res,req,{id:uid});json(res,201,{created:true});return true;
  }
  if(!p.startsWith('/api/platform/')&&p!=='/api/workspace/settings')return false;
  if(!user)fail(401,'Please sign in.');
  if(p.startsWith('/api/platform/'))owner(user);
  if(p==='/api/platform/companies'&&req.method==='GET'){
   json(res,200,{companies:await all("SELECT o.id,o.name,o.created_at,COALESCE(s.status,'active') status,(SELECT COUNT(*) FROM users u WHERE u.organization_id=o.id) users,(SELECT COUNT(*) FROM properties p WHERE p.organization_id=o.id AND p.archived_at IS NULL) residences FROM organizations o LEFT JOIN workspace_settings s ON s.organization_id=o.id ORDER BY o.created_at DESC")});return true;
  }
  if(req.method!=='POST')fail(404,'Endpoint not found.');const b=await body(req);
  if(p==='/api/platform/invite'){
   const company=text(b.company,'Company name',160),address=email(b.email),token=randomBytes(32).toString('hex');
   if(await get('SELECT id FROM users WHERE LOWER(email)=?',address))fail(409,'That email already has an account.');
   await run('INSERT INTO workspace_invites VALUES(?,?,?,?,?,?)',hash(token),company,address,user.id,Date.now()+48*3600000,null);
   await audit(user,'workspace.invited',company);json(res,201,{invitePath:'/?workspaceInvite='+token});return true;
  }
  if(p==='/api/platform/status'){
   if(b.organizationId===user.organization_id)fail(422,'You cannot suspend your own company.');
   if(!['active','suspended'].includes(b.status))fail(422,'Invalid company status.');
   if(!await get('SELECT id FROM organizations WHERE id=?',b.organizationId))fail(404,'Company not found.');
   await transaction(async()=>{await run('INSERT INTO workspace_settings(organization_id,status) VALUES(?,?) ON CONFLICT(organization_id) DO UPDATE SET status=excluded.status',b.organizationId,b.status);if(b.status==='suspended')await run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id=?)',b.organizationId);await audit(user,'workspace.'+b.status,b.organizationId);});json(res,201,{saved:true});return true;
  }
  if(p==='/api/workspace/settings'){
   if(user.role!=='admin')fail(403,'Company administrator access required.');
   const name=text(b.name,'Company name',160),support=b.supportEmail?email(b.supportEmail):'';
   await transaction(async()=>{await run('UPDATE organizations SET name=? WHERE id=?',name,user.organization_id);await run('INSERT INTO workspace_settings(organization_id,support_email) VALUES(?,?) ON CONFLICT(organization_id) DO UPDATE SET support_email=excluded.support_email',user.organization_id,support);await audit(user,'workspace.settings_updated',user.organization_id);});json(res,201,{saved:true});return true;
  }
  fail(404,'Endpoint not found.');
 };
}
