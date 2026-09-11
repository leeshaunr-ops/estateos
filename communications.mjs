import {createHash} from 'node:crypto';
export function createCommunications({get,all,run,transaction,id,now,fail,text,json,body,rate,audit}, {env=process.env,fetcher=fetch}={}){
 async function primary(org){const setting=await get('SELECT primary_admin_id FROM workspace_settings WHERE organization_id=?',org);return await get("SELECT id,name,email FROM users WHERE organization_id=? AND role='admin' AND active=1 ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,created_at,id LIMIT 1",org,setting?.primary_admin_id||'');}
 async function enqueue(org,event,recipients,subject,content,entity){
  const unique=new Map(recipients.filter(Boolean).filter(u=>u.email).map(u=>[u.email.toLowerCase(),u]));
  for(const u of unique.values()){
   const key=createHash('sha256').update(org+':'+event+':'+u.email.toLowerCase()).digest('hex');
   const inserted=await run('INSERT INTO email_outbox(id,organization_id,user_id,email,subject,body,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',key,org,u.id||null,u.email,subject,content,now(),now());
   if(inserted.changes&&u.id)await run('INSERT INTO notifications VALUES(?,?,?,?,?,?)',id(),u.id,subject,entity||'',null,now());
  }
 }
 async function work(user,key,event='work'){
  const w=await get('SELECT w.*,p.organization_id FROM work_orders w JOIN properties p ON p.id=w.property_id WHERE w.id=? AND p.organization_id=?',key,user.organization_id);if(!w)return;
  const recipients=[await primary(user.organization_id),...await all('SELECT u.id,u.email FROM users u JOIN work_staff a ON a.user_id=u.id WHERE a.work_id=? AND u.active=1 AND u.organization_id=?',key,user.organization_id)];
  if(w.vendor_id){const users=await all("SELECT id,email FROM users WHERE vendor_id=? AND organization_id=? AND role='vendor' AND active=1",w.vendor_id,user.organization_id);recipients.push(...users);if(!users.length&&!await get("SELECT id FROM users WHERE vendor_id=? AND organization_id=? AND role='vendor'",w.vendor_id,user.organization_id))recipients.push(await get('SELECT email FROM vendors WHERE id=? AND organization_id=?',w.vendor_id,user.organization_id));}
  await enqueue(user.organization_id,event+':'+key+':'+w.version,recipients,'Work order: '+w.title,'A work order has been created or assigned. Sign in to review the details and assignment.',key);
 }
 async function request(user,key){const r=await get('SELECT r.* FROM requests r JOIN properties p ON p.id=r.property_id WHERE r.id=? AND p.organization_id=?',key,user.organization_id);if(r)await enqueue(user.organization_id,'request:'+key,[await primary(user.organization_id)],'Service request: '+r.title,'A service request has been created. Sign in to review and assign the work.',key);}
 async function schedule(user,key){const s=await get('SELECT * FROM staff_schedules WHERE id=? AND organization_id=?',key,user.organization_id);if(!s)return;await enqueue(user.organization_id,'schedule:'+key+':'+id(),[await primary(user.organization_id),await get('SELECT id,email FROM users WHERE id=? AND organization_id=? AND active=1',s.user_id,user.organization_id)],'Schedule: '+s.title,'A schedule has been created or updated for you or your team. Sign in to review the dates, times and assigned work.',key);}
 async function membership(user,key){const t=await get('SELECT t.* FROM message_threads t JOIN message_members m ON m.thread_id=t.id WHERE t.id=? AND t.organization_id=? AND m.user_id=?',key,user.organization_id,user.id);if(!t)fail(404,'Conversation not found.');return t;}
 async function unread(user){return Number((await get('SELECT COUNT(*) total FROM messages x JOIN message_members m ON m.thread_id=x.thread_id JOIN message_threads t ON t.id=x.thread_id WHERE m.user_id=? AND t.organization_id=? AND x.sender_id<>? AND (m.read_at IS NULL OR x.created_at>m.read_at)',user.id,user.organization_id,user.id))?.total||0);}
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/messages'))return false;if(!user)fail(401,'Please sign in.');
  if(url.pathname==='/api/messages'&&req.method==='GET'){
   const threads=await all('SELECT t.*, (SELECT MAX(x.created_at) FROM messages x WHERE x.thread_id=t.id) updated_at,(SELECT COUNT(*) FROM messages x WHERE x.thread_id=t.id AND x.sender_id<>? AND (m.read_at IS NULL OR x.created_at>m.read_at)) unread FROM message_threads t JOIN message_members m ON m.thread_id=t.id WHERE m.user_id=? AND t.organization_id=? ORDER BY updated_at DESC',user.id,user.id,user.organization_id);
   for(const t of threads)t.people=await all('SELECT u.id,u.name FROM users u JOIN message_members m ON m.user_id=u.id WHERE m.thread_id=?',t.id);
   json(res,200,{threads,people:await all('SELECT id,name,role FROM users WHERE organization_id=? AND active=1 AND id<>? ORDER BY name',user.organization_id,user.id)});return true;
  }
  if(url.pathname==='/api/messages/thread'&&req.method==='GET'){
   const t=await membership(user,url.searchParams.get('id'));
   const before=url.searchParams.get('before')||'9999';
   const items=(await all('SELECT x.*,u.name sender_name FROM messages x JOIN users u ON u.id=x.sender_id WHERE x.thread_id=? AND x.created_at<? ORDER BY x.created_at DESC LIMIT 100',t.id,before)).reverse();
   json(res,200,{thread:t,messages:items,hasOlder:items.length===100});return true;
  }
  if(req.method!=='POST')fail(404,'Endpoint not found.');const b=await body(req);
  if(url.pathname==='/api/messages/read'){await membership(user,b.threadId);const seen=text(b.seenAt,'Read time',40);if(!await get('SELECT id FROM messages WHERE thread_id=? AND created_at=?',b.threadId,seen))fail(422,'Invalid read time.');await run('UPDATE message_members SET read_at=? WHERE thread_id=? AND user_id=? AND (read_at IS NULL OR read_at<?)',seen,b.threadId,user.id,seen);json(res,200,{saved:true});return true;}
  if(url.pathname!=='/api/messages/send')fail(404,'Endpoint not found.');rate(req,'message-send',30);
  const content=text(b.message,'Message',8000),key=text(b.messageId,'Message reference',80);if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))fail(422,'Invalid message reference.');let threadId=b.threadId;
  await transaction(async()=>{
   const previous=await get('SELECT x.*,t.organization_id FROM messages x JOIN message_threads t ON t.id=x.thread_id WHERE x.id=?',key);
   if(previous){if(previous.sender_id!==user.id||previous.organization_id!==user.organization_id||previous.body!==content||(threadId&&threadId!==previous.thread_id))fail(409,'Message reference already used.');threadId=previous.thread_id;return;}
   if(threadId)await membership(user,threadId);
   else{
    const subject=text(b.subject,'Subject',160);let targets;
    if(b.recipientId==='everyone')targets=await all('SELECT id,email FROM users WHERE organization_id=? AND active=1 AND id<>?',user.organization_id,user.id);
    else{const u=await get('SELECT id,email FROM users WHERE id=? AND organization_id=? AND active=1 AND id<>?',b.recipientId,user.organization_id,user.id);if(!u)fail(422,'Choose an active account in your company.');targets=[u];}
    if(!targets.length)fail(422,'There are no other active accounts to message.');
    threadId=id();await run('INSERT INTO message_threads VALUES(?,?,?,?,?,?)',threadId,user.organization_id,subject,b.recipientId==='everyone'?'announcement':'direct',user.id,now());
    for(const uid of [user.id,...targets.map(u=>u.id)])await run('INSERT INTO message_members(thread_id,user_id) VALUES(?,?)',threadId,uid);
   }
   // A monotonic timestamp prevents a same-millisecond read receipt from hiding a new reply.
   const latest=await get('SELECT MAX(created_at) latest FROM messages WHERE thread_id=?',threadId);const stamp=new Date(Math.max(Date.now(),Date.parse(latest?.latest||'1970-01-01')+1)).toISOString();
   await run('INSERT INTO messages VALUES(?,?,?,?,?)',key,threadId,user.id,content,stamp);
   const recipients=await all('SELECT u.id,u.email FROM users u JOIN message_members m ON m.user_id=u.id WHERE m.thread_id=? AND u.id<>? AND u.active=1 AND u.organization_id=?',threadId,user.id,user.organization_id);
   await enqueue(user.organization_id,'message:'+key,recipients,'New message in your company workspace','You have a new message. Sign in and open Messages to read it and reply.',threadId);
   await audit(user,'message.sent',threadId);
  });json(res,201,{threadId});return true;
 }
 let busy=false;
 async function drain(){if(busy||!env.RESEND_API_KEY)return;busy=true;try{
  const rows=await all("SELECT * FROM email_outbox WHERE status IN ('pending','retry','sending') AND next_attempt_at<=? AND attempts<5 ORDER BY created_at LIMIT 10",now());
  for(const row of rows){
   if((await get('SELECT status FROM workspace_settings WHERE organization_id=?',row.organization_id))?.status==='suspended'||row.user_id&&!await get('SELECT id FROM users WHERE id=? AND organization_id=? AND active=1 AND LOWER(email)=?',row.user_id,row.organization_id,row.email.toLowerCase())){await run("UPDATE email_outbox SET status='cancelled' WHERE id=?",row.id);continue;}
   const claim=await run("UPDATE email_outbox SET status='sending',attempts=attempts+1,next_attempt_at=? WHERE id=? AND attempts=? AND next_attempt_at<=?",new Date(Date.now()+120000).toISOString(),row.id,row.attempts,now());if(!claim.changes)continue;
   let ok=false;try{const base=new URL(env.APP_URL||'https://estateaegis.com');if(base.protocol!=='https:')throw Error();const company=(await get('SELECT name FROM organizations WHERE id=?',row.organization_id))?.name||'Your company';const r=await fetcher('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':row.id},body:JSON.stringify({from:env.EMAIL_FROM||'EstateAegis <notifications@estateaegis.com>',to:[row.email],subject:row.subject,text:company+'\n\n'+row.body+'\n\n'+base.origin+'/\n\nPowered by EstateAegis'})});ok=r.ok&&!!(await r.json()).id;}catch{}
   await run('UPDATE email_outbox SET status=?,next_attempt_at=? WHERE id=?',ok?'sent':row.attempts>=4?'failed':'retry',new Date(Date.now()+Math.min(3600000,60000*2**row.attempts)).toISOString(),row.id);
  }
 }finally{busy=false;}}
 return {handle,unread,work,request,schedule,drain,primary};
}
