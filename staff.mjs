export function createStaff({get,all,run,transaction,fail,text,note,id,now,passwordHash,json,body,audit}) {
 async function member(user,uid) {
  const row=await get("SELECT id,name FROM users WHERE id=? AND organization_id=? AND role IN ('employee','admin') AND active=1",uid,user.organization_id);
  if(!row)fail(422,'Choose an active staff member from this company.');return row;
 }
 async function assignment(user,workId,b) {
  const job=await get('SELECT w.* FROM work_orders w JOIN properties p ON p.id=w.property_id WHERE w.id=? AND p.organization_id=?',workId,user.organization_id);
  if(!job)fail(404,'Work order not found.');
  if(user.role!=='admin')fail(403,'Only administrators can change staff assignments.');
  if(b.staffId&&b.vendorId)fail(422,'Choose either staff or a vendor.');
  if(b.staffId)await member(user,b.staffId);
  if(b.vendorId&&!await get('SELECT id FROM vendors WHERE id=? AND organization_id=?',b.vendorId,user.organization_id))fail(422,'Unknown vendor.');
  if(b.scheduleId){const s=await get('SELECT * FROM staff_schedules WHERE id=? AND organization_id=?',b.scheduleId,user.organization_id);if(!s||s.user_id!==b.staffId||(s.property_id&&s.property_id!==job.property_id))fail(422,'Choose a schedule for this staff member and residence.');}
  await run('INSERT INTO work_staff(work_id,user_id,schedule_id) VALUES(?,?,?) ON CONFLICT(work_id) DO UPDATE SET user_id=excluded.user_id,schedule_id=excluded.schedule_id',workId,b.staffId||null,b.scheduleId||null);
  await run('UPDATE work_orders SET vendor_id=?,version=version+1 WHERE id=?',b.vendorId||null,workId);
  await audit(user,'work.assignment_updated',workId);
 }
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/staff/'))return false;
  if(!user)fail(401,'Please sign in.');
  if(!['admin','employee'].includes(user.role))fail(403,'Staff access required.');
  const admin=user.role==='admin';
  if(url.pathname==='/api/staff/data'&&req.method==='GET'){
   const people=await all("SELECT id,name,email,active FROM users WHERE organization_id=? AND role IN ('employee','admin')"+(admin?'':' AND id=?'),...admin?[user.organization_id]:[user.organization_id,user.id]);
   const schedules=await all('SELECT s.*,u.name staff_name,p.name property_name FROM staff_schedules s JOIN users u ON u.id=s.user_id LEFT JOIN properties p ON p.id=s.property_id WHERE s.organization_id=?'+(admin?'':' AND s.user_id=?')+' ORDER BY s.starts_at',...admin?[user.organization_id]:[user.organization_id,user.id]);
   const assignments=await all('SELECT a.*,u.name staff_name,s.starts_at,s.ends_at FROM work_staff a JOIN work_orders w ON w.id=a.work_id JOIN properties p ON p.id=w.property_id LEFT JOIN users u ON u.id=a.user_id LEFT JOIN staff_schedules s ON s.id=a.schedule_id WHERE p.organization_id=?'+(admin?'':' AND a.user_id=?'),...admin?[user.organization_id]:[user.organization_id,user.id]);
   const profiles=admin?await all('SELECT sp.* FROM staff_profiles sp JOIN users u ON u.id=sp.user_id WHERE u.organization_id=?',user.organization_id):[];
   json(res,200,{people,schedules,assignments,profiles:profiles.map(p=>({...p,details:JSON.parse(p.details)}))});return true;
  }
  if(!admin)fail(403,'Only administrators can edit staff and schedules.');
  if(req.method!=='POST')fail(405,'Use POST.');const b=await body(req);
  if(url.pathname==='/api/staff/profile'){
   const name=text(b.name,'Staff name',160),email=text(b.email,'Email',254).toLowerCase();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(422,'Enter a valid email.');
   const rate=b.payRate===''||b.payRate==null?null:Number(b.payRate);if(rate!==null&&(!Number.isFinite(rate)||rate<0||rate>10000000))fail(422,'Enter a valid nonnegative pay rate.');
   const details={};for(const k of ['phone','address','jobTitle','employmentType','startDate','endDate','emergencyName','emergencyPhone','notes'])details[k]=note(b[k],k==='notes'?2000:500);
   for(const k of ['startDate','endDate'])if(details[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(details[k]))fail(422,'Use a valid employment date.');
   details.payRate=rate;details.payBasis=['hour','day','week','year'].includes(b.payBasis)?b.payBasis:'hour';details.currency=text(b.currency||'USD','Currency',3).toUpperCase();
   let uid=b.userId;
   await transaction(async()=>{
    if(uid){await member(user,uid);if(await get('SELECT id FROM users WHERE LOWER(email)=? AND id<>?',email,uid))fail(409,'Email already in use.');await run('UPDATE users SET name=?,email=? WHERE id=?',name,email,uid);}
    else {if(await get('SELECT id FROM users WHERE LOWER(email)=?',email))fail(409,'Email already in use.');const pw=passwordHash(b.password);uid=id();await run('INSERT INTO users(id,organization_id,name,email,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?,?)',uid,user.organization_id,name,email,pw,'employee',1,now());}
    await run('INSERT INTO staff_profiles(user_id,details) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET details=excluded.details',uid,JSON.stringify(details));await audit(user,'staff.profile_updated',uid);
   });json(res,200,{id:uid});return true;
  }
  if(url.pathname==='/api/staff/schedule'){
   await member(user,b.staffId);const start=Date.parse(b.startsAt),end=Date.parse(b.endsAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)fail(422,'End time must be after start time.');
   if(b.propertyId&&!await get('SELECT id FROM properties WHERE id=? AND organization_id=? AND archived_at IS NULL',b.propertyId,user.organization_id))fail(422,'Unknown residence.');
   const sid=b.id||id();await transaction(async()=>{
    if(b.id&&!await get('SELECT id FROM staff_schedules WHERE id=? AND organization_id=?',sid,user.organization_id))fail(404,'Schedule not found.');
    const conflict=await get('SELECT id FROM staff_schedules WHERE user_id=? AND id<>? AND starts_at<? AND ends_at>?',b.staffId,sid,new Date(end).toISOString(),new Date(start).toISOString());if(conflict)fail(409,'This staff member already has a schedule during these hours.');
    const linked=await all('SELECT w.property_id FROM work_staff a JOIN work_orders w ON w.id=a.work_id WHERE a.schedule_id=?',sid);if(b.propertyId&&linked.some(w=>w.property_id!==b.propertyId))fail(422,'Linked work belongs to another residence.');
    await run('INSERT INTO staff_schedules(id,organization_id,user_id,property_id,title,starts_at,ends_at,notes) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,property_id=excluded.property_id,title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,notes=excluded.notes',sid,user.organization_id,b.staffId,b.propertyId||null,text(b.title,'Schedule title',200),new Date(start).toISOString(),new Date(end).toISOString(),note(b.notes));
    await run('UPDATE work_staff SET user_id=? WHERE schedule_id=?',b.staffId,sid);
    if(b.workId)await assignment(user,b.workId,{staffId:b.staffId,scheduleId:sid});await audit(user,'staff.schedule_saved',sid);
   });json(res,200,{id:sid});return true;
  }
  if(url.pathname==='/api/staff/schedule/remove'){
   await transaction(async()=>{if(!await get('SELECT id FROM staff_schedules WHERE id=? AND organization_id=?',b.id,user.organization_id))fail(404,'Schedule not found.');await run('UPDATE work_staff SET schedule_id=NULL WHERE schedule_id=?',b.id);await run('DELETE FROM staff_schedules WHERE id=?',b.id);await audit(user,'staff.schedule_removed',b.id);});json(res,200,{ok:true});return true;
  }
  if(url.pathname==='/api/staff/task'){
   const kinds={inspection:'Residence inspection',arrival:'Arrival preparation',asset:'Asset inspection',other:'Other'};
   if(!kinds[b.kind])fail(422,'Choose a work type.');
   const key=id();await transaction(async()=>{
    const s=await get('SELECT * FROM staff_schedules WHERE id=? AND organization_id=?',b.scheduleId,user.organization_id);if(!s)fail(404,'Schedule not found.');
    const prop=await get('SELECT * FROM properties WHERE id=? AND organization_id=? AND archived_at IS NULL',b.propertyId,user.organization_id);if(!prop)fail(422,'Choose a residence.');
    if(s.property_id&&s.property_id!==prop.id)fail(422,'Choose the scheduled residence.');
    let reference=null,detail='';
    if(b.kind==='arrival'){reference=await get('SELECT id,arrival_at FROM arrivals WHERE id=? AND property_id=?',b.referenceId,prop.id);if(!reference)fail(422,'Choose an arrival at this residence.');detail=' · '+reference.arrival_at;}
    if(b.kind==='asset'){reference=await get('SELECT id,name FROM assets WHERE id=? AND property_id=?',b.referenceId,prop.id);if(!reference)fail(422,'Choose an asset at this residence.');detail=' · '+reference.name;}
    const title=b.kind==='other'?text(b.title,'Task title',200):kinds[b.kind]+detail;
    const description=b.kind==='other'?text(b.instructions,'What needs to be done',4000):note(b.instructions,4000);
    await run('INSERT INTO work_orders(id,property_id,asset_id,title,description,priority,due_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',key,prop.id,b.kind==='asset'?reference.id:null,title,description,'Normal',s.starts_at.slice(0,10),user.id,now());
    await run('INSERT INTO scheduled_work_types(work_id,kind,reference_id) VALUES(?,?,?)',key,b.kind,reference?.id||prop.id);
    await assignment(user,key,{staffId:s.user_id,scheduleId:s.id});await audit(user,'schedule.task_created',key);
   });json(res,200,{id:key});return true;
  }
  if(url.pathname==='/api/staff/assign'){await transaction(()=>assignment(user,b.workId,b));json(res,200,{ok:true});return true;}
  fail(404,'Endpoint not found.');
 }
 return {handle,assignment};
}
