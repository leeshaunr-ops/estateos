// Demo status is explicit metadata, never inferred from a company name.
export function createDemos({get,all,run,transaction,id,now,hash,randomBytes,body,json,fail,audit,platformOwner,deleteBytes}){
 const day=86400000;
 const lookup=org=>get('SELECT * FROM demo_workspaces WHERE organization_id=?',org);
 async function seed(org,admin){
  const client=id(),property=id(),inspection=id();
  const date=n=>new Date(Date.now()+n*day).toISOString().slice(0,10);
  await run('INSERT INTO clients(id,organization_id,name,email,phone,created_at,profile) VALUES(?,?,?,?,?,?,?)',client,org,'Rivera Family','','',now(),JSON.stringify({firstName:'Alex',lastName:'Rivera',members:[]}));
  await run('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,manual,created_at,room_profile) VALUES(?,?,?,?,?,?,?,?,?)',property,org,client,'Ocean Palm Residence','Sample residence · Palm Beach, Florida','America/New_York','Practice here with fictional information. Demo changes are temporary.',now(),JSON.stringify({bedrooms:2,fullBathrooms:2,halfBathrooms:0,rooms:[{key:'suite',type:'Bedroom',name:'Guest Suite',floor:'Second floor',assignment:'guest',assignedName:'',notes:'Prepare fresh linens'},{key:'kitchen',type:'Kitchen',name:'Kitchen',floor:'First floor',assignment:'',assignedName:'',notes:'Stock before arrival'}]}));
  await run('INSERT INTO work_orders(id,property_id,title,description,priority,due_date,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id(),property,'Check pool equipment','Example service work for your team.','Normal',date(2),'open',admin,now());
  await run('INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,created_at,frequency,next_due) VALUES(?,?,?,?,?,?,?,?,?,?)',inspection,property,admin,date(0),'draft',JSON.stringify([{key:'exterior',section:'Exterior',label:'Exterior condition',status:'pass',note:''},{key:'systems',section:'Systems',label:'Pool equipment',status:'monitor',note:'Example finding. Practice creating linked work.'}]),'Sample inspection draft',now(),'7 days',date(7));
  await run('INSERT INTO shopping_items VALUES(?,?,?,?,?,?,?)',id(),property,'Sparkling water','2 cases','Beverages','Sample arrival preference',now());
  await run('INSERT INTO arrivals(id,property_id,created_by,arrival_at,needs,status,items,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),property,admin,date(3)+'T15:00','Prepare the guest suite and stock the kitchen.','submitted','[]',now());
 }
 async function activate(org,admin){
  await run('INSERT INTO demo_workspaces VALUES(?,?,?,?)',org,admin,Date.now()+7*day,now());
  await seed(org,admin);
 }
 async function reset(org,user){
  await transaction(async()=>{
   const demo=await lookup(org);
   if(!demo)fail(404,'This is not a private demo workspace.');
   if(!platformOwner(user)&&user.id!==demo.admin_id)fail(403,'Only the demo administrator can reset this workspace.');
   if(!platformOwner(user)&&Number(demo.expires_at)<=Date.now())fail(403,'This demo has expired. Contact sales@estateaegis.com for more time.');
   // Every deletion is restricted to the explicitly marked demo organization.
   const props='SELECT id FROM properties WHERE organization_id=?';
   const works=`SELECT id FROM work_orders WHERE property_id IN (${props})`;
   const inspections=`SELECT id FROM inspections WHERE property_id IN (${props})`;
   const assets=`SELECT id FROM assets WHERE property_id IN (${props})`;
   const plans=`SELECT id FROM maintenance_plans WHERE property_id IN (${props})`;
   const threads='SELECT id FROM message_threads WHERE organization_id=?';
   for(const f of await all(`SELECT storage_key FROM files WHERE property_id IN (${props})`,org))await run('INSERT INTO demo_file_cleanup VALUES(?,?) ON CONFLICT(storage_key) DO NOTHING',f.storage_key,now());
   const remove=(table,where)=>run(`DELETE FROM ${table} WHERE ${where}`,org);
   for(const [table,where]of [
    ['work_evidence_sources',`file_id IN (SELECT id FROM files WHERE property_id IN (${props}))`],
    ['files',`property_id IN (${props})`],['work_updates',`work_order_id IN (${works})`],
    ['inspection_followups',`inspection_id IN (${inspections})`],['inspection_email_delivery',`inspection_id IN (${inspections})`],
    ['inspection_occurrences',`inspection_id IN (${inspections})`],
    ['inspection_occurrences',`plan_id IN (SELECT id FROM inspection_plans WHERE property_id IN (${props}))`],
    ['inspection_plans',`property_id IN (${props})`],
    ['maintenance_occurrences',`plan_id IN (${plans})`],['maintenance_assignments',`plan_id IN (${plans})`],
    ['spending_approvals','organization_id=?'],['work_staff',`work_id IN (${works})`],['scheduled_work_types',`work_id IN (${works})`],
    ['staff_schedules','organization_id=?'],['requests',`property_id IN (${props})`],['work_orders',`property_id IN (${props})`],
    ['asset_inspections',`asset_id IN (${assets})`],['assets',`property_id IN (${props})`],['inspections',`property_id IN (${props})`],
    ['maintenance_plans',`property_id IN (${props})`],['shopping_items',`property_id IN (${props})`],['arrivals',`property_id IN (${props})`],
    ['notes',`property_id IN (${props})`],['property_vault',`property_id IN (${props})`],['property_access',`property_id IN (${props})`],
    ['payments','invoice_id IN (SELECT id FROM invoices WHERE organization_id=?)'],['invoices','organization_id=?'],
    ['messages',`thread_id IN (${threads})`],['message_members',`thread_id IN (${threads})`],['message_threads','organization_id=?'],
    ['email_outbox','organization_id=?'],['invitations','organization_id=?'],['properties','organization_id=?'],['clients','organization_id=?'],['vendors','organization_id=?'],
    ['notifications','user_id IN (SELECT id FROM users WHERE organization_id=?)'],['idempotency','user_id IN (SELECT id FROM users WHERE organization_id=?)']
   ])await remove(table,where);
   await run('UPDATE users SET client_id=NULL,vendor_id=NULL WHERE organization_id=?',org);
   await run('UPDATE users SET active=0 WHERE organization_id=? AND id<>?',org,demo.admin_id);
   await run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id=? AND id<>?)',org,demo.admin_id);
   await run('UPDATE automation_settings SET enabled=0 WHERE organization_id=?',org);
   await seed(org,demo.admin_id);
   await run('UPDATE demo_workspaces SET reset_at=? WHERE organization_id=?',now(),org);
   await audit(user,'demo.reset',org);
  });
 }
 async function handle(req,res,url,user){
  const p=url.pathname;
  if(!p.startsWith('/api/master/demos')&&!p.startsWith('/api/demo/'))return false;
  if(!user)fail(401,'Please sign in.');
  const owner=platformOwner(user);
  if(p.startsWith('/api/master/')&&!owner)fail(403,'Platform owner access required.');
  if(req.method==='GET'&&p==='/api/demo/status'){const d=await lookup(user.organization_id);json(res,200,d?{demo:true,expiresAt:Number(d.expires_at),canReset:user.id===d.admin_id}:{demo:false});return true;}
  if(req.method==='GET'&&p==='/api/master/demos'){
   json(res,200,{demos:await all('SELECT d.*,o.name,u.email FROM demo_workspaces d JOIN organizations o ON o.id=d.organization_id JOIN users u ON u.id=d.admin_id ORDER BY d.expires_at DESC'),pending:await all('SELECT w.company,w.email,w.expires_at FROM demo_invites d JOIN workspace_invites w ON w.token_hash=d.token_hash WHERE w.used_at IS NULL AND w.expires_at>?',Date.now())});return true;
  }
  if(req.method!=='POST')fail(404,'Demo action not found.');
  const b=await body(req);
  if(p==='/api/master/demos/invite'){
   const company=String(b.company||'').trim(),email=String(b.email||'').trim().toLowerCase();
   if(!company||company.length>160||email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(422,'Enter a company name and valid email.');
   const token=randomBytes(32).toString('hex');
   await transaction(async()=>{
    if(await get('SELECT id FROM users WHERE LOWER(email)=?',email))fail(409,'This email already has an account. Use a separate demo email.');
    if(await get('SELECT token_hash FROM workspace_invites WHERE email=? AND used_at IS NULL AND expires_at>?',email,Date.now())||await get("SELECT id FROM paid_signups WHERE email=? AND status IN ('pending','invited')",email))fail(409,'This email already has a pending signup or invitation.');
    await run('INSERT INTO workspace_invites VALUES(?,?,?,?,?,?)',hash(token),company+' · Private demo',email,user.id,Date.now()+48*3600000,null);
    await run('INSERT INTO demo_invites VALUES(?)',hash(token));await audit(user,'demo.invited',company);
   });
   json(res,201,{invitePath:'/?workspaceInvite='+token});return true;
  }
  if(p==='/api/master/demos/extend'){
   if(!await lookup(b.organizationId))fail(404,'Private demo not found.');
   await run('UPDATE demo_workspaces SET expires_at=? WHERE organization_id=?',Date.now()+7*day,b.organizationId);
   await audit(user,'demo.extended',b.organizationId);json(res,200,{saved:true});return true;
  }
  if(p==='/api/master/demos/reset'||p==='/api/demo/reset'){
   if(b.confirm!=='RESET')fail(422,'Confirm the demo reset.');
   await reset(owner&&p.startsWith('/api/master/')?b.organizationId:user.organization_id,user);json(res,200,{saved:true});return true;
  }
  fail(404,'Demo action not found.');
 }
 async function cleanup(){for(const f of await all('SELECT storage_key FROM demo_file_cleanup LIMIT 20')){await deleteBytes(f.storage_key);await run('DELETE FROM demo_file_cleanup WHERE storage_key=?',f.storage_key);}}
 return {lookup,activate,reset,handle,cleanup};
}
