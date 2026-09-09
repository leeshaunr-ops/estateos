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
  if(p==='/api/platform/demo'){
   const existing=await get("SELECT id FROM organizations WHERE name='EstateOS Demo Company'");
   if(existing)fail(409,'The demo company already exists.');
   const org=id(),admin=id(),client=id(),prop1=id(),prop2=id(),asset=id(),job=id(),inspection=id(),shopping=id(),arrival=id(),member=id();
   const demoEmail='demo@estateos.example',demoPassword=process.env.ESTATEOS_DEMO_PASSWORD||'EstateOS-Demo-2026!';
   await transaction(async()=>{
    await run('INSERT INTO organizations VALUES(?,?,?)',org,'EstateOS Demo Company',now());await run('INSERT INTO workspace_settings(organization_id) VALUES(?)',org);
    await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',admin,org,'Demo Administrator',demoEmail,passwordHash(demoPassword),'admin',null,null,1,now());
    const profile=JSON.stringify({firstName:'Alex',lastName:'Rivera',preferredContact:'Email',members:[{id:member,firstName:'Jordan',lastName:'Rivera',relationship:'Guest',email:'',phone:'',preferredContact:'Text message'}]});
    await run('INSERT INTO clients(id,organization_id,name,email,phone,created_at,profile) VALUES(?,?,?,?,?,?,?)',client,org,'Rivera Family','demo-client@estateos.example','(555) 010-2026',now(),profile);
    const rooms1=JSON.stringify({bedrooms:3,fullBathrooms:3,halfBathrooms:1,rooms:[{key:'master',type:'Bedroom',name:'Ocean Master Suite',floor:'Second floor',assignment:'other',assignedName:'Alex Rivera',notes:'King bed; blackout curtains'},{key:'guest',type:'Bedroom',name:'Palm Guest Suite',floor:'First floor',assignment:'member:'+member,assignedName:'Jordan Rivera',notes:'Extra towels'},{key:'kitchen',type:'Kitchen',name:'Chef Kitchen',floor:'First floor',assignment:'',assignedName:'',notes:'Island and outdoor service door'}]});
    const rooms2=JSON.stringify({bedrooms:2,fullBathrooms:2,halfBathrooms:0,rooms:[{key:'suite',type:'Bedroom',name:'Guest Suite',floor:'Second floor',assignment:'guest',assignedName:'',notes:''},{key:'pool',type:'Pool house',name:'Pool House',floor:'Ground level',assignment:'',assignedName:'',notes:'Keep towels stocked'}]});
    const a1={street_address:'100 Ocean Palm Drive',address_line2:'',city:'Palm Beach',state:'FL',postal_code:'33480',country:'United States'};const a2={street_address:'48 Harbor View Lane',address_line2:'',city:'Jupiter',state:'FL',postal_code:'33477',country:'United States'};
    await run('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,manual,created_at,street_address,address_line2,city,state,postal_code,country,room_profile) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',prop1,org,client,'Ocean Palm Residence',[a1.street_address,a1.city,a1.state,a1.postal_code].join(', '),'America/New_York','Welcome to the demo residence.',now(),a1.street_address,'',a1.city,a1.state,a1.postal_code,a1.country,rooms1);
    await run('INSERT INTO properties(id,organization_id,client_id,name,address,timezone,manual,created_at,street_address,address_line2,city,state,postal_code,country,room_profile) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',prop2,org,client,'Harbor View Retreat',[a2.street_address,a2.city,a2.state,a2.postal_code].join(', '),'America/New_York','Demo retreat house manual.',now(),a2.street_address,'',a2.city,a2.state,a2.postal_code,a2.country,rooms2);
    await run('INSERT INTO assets(id,property_id,name,category,model,serial,location,warranty,created_at,mileage,hours,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',asset,prop1,'Sea Ray 310','Boat','310 Sundancer','DEMO-310','Dock A','2028-06',now(),'','126','Demo asset for inspection walkthrough.');
    await run('INSERT INTO work_orders(id,property_id,asset_id,title,description,priority,due_date,status,created_by,service_notes,created_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',job,prop1,asset,'Schedule annual boat service','Review engines, batteries and safety gear.','Normal','2026-10-15','open',admin,'',now(),1);
    const template=[{key:'arrival',section:'Exterior',label:'Exterior condition',status:'pass',note:''},{key:'systems',section:'Systems',label:'Systems and safety equipment',status:'monitor',note:'Demo result for walkthrough.'}];
    await run('INSERT INTO inspections(id,property_id,inspector_id,inspection_date,status,answers,summary,notes,created_at,frequency,next_due) VALUES(?,?,?,?,?,?,?,?,?,?,?)',inspection,prop1,admin,'2026-09-09','draft',JSON.stringify(template),'Demo inspection in progress.','Review the checklist and save a draft.',now(),'30 days','2026-10-09');
    await run('INSERT INTO shopping_items VALUES(?,?,?,?,?,?,?)',shopping,prop1,'Sparkling water','4 case','Beverages','Brand: LaCroix\nDemo preferred item.',now());
    const items=JSON.stringify([{id:shopping,name:'Sparkling water',quantity:'4 case',category:'Beverages',notes:'Brand: LaCroix',status:'needed',substitutionNeeded:false,substitution:''}]);
    await run('INSERT INTO arrivals(id,property_id,created_by,arrival_at,needs,status,items,created_at,version,room_status,guests) VALUES(?,?,?,?,?,?,?,?,?,?,?)',arrival,prop1,admin,'2026-10-01T15:00','Prepare the guest suite and stock the kitchen.','submitted',items,now(),1,JSON.stringify([]),JSON.stringify([member]));
    await audit({id:admin,organization_id:org},'workspace.demo_created',org);
   });
   json(res,201,{company:'EstateOS Demo Company',email:demoEmail,password:demoPassword});return true;
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
