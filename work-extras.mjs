// Work order extras (audit batch 5): the "Export" CSV of the work orders currently shown on the board and the
// "Remind client" nudge for an estimate that is still waiting on the family. Both are staff-side only.
export const REMIND_EVERY_MS=24*3600000;
export const EXPORT_LIMIT=5000;
export const EXPORT_HEAD=['Title','Residence','Status','Priority','Assigned to','Due','Created','Completed'];
const DONE=['completed','cancelled'];

/** One CSV cell, always quoted. Cells starting with = + - @ (or a tab/CR) are prefixed with ' so spreadsheets never run them as formulas. */
export function csvCell(value){let v=value==null?'':String(value);if(/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';}
export const csvRow=cells=>cells.map(csvCell).join(',');

/** A due date (YYYY-MM-DD, already the residence's local day) as "Mon, Oct 5, 2026". */
export function readableDay(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))return '';const d=new Date(value+'T12:00:00Z');return Number.isNaN(d.getTime())?'':d.toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});}
/** A timestamp in the residence's time zone, e.g. "Oct 3, 2026, 2:15 PM EDT". */
export function readableStamp(value,timeZone){if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return '';const opts={month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'};
 try{return new Intl.DateTimeFormat('en-US',{...opts,timeZone:timeZone||'America/New_York'}).format(d);}catch{return new Intl.DateTimeFormat('en-US',{...opts,timeZone:'America/New_York'}).format(d);}}
/** The same status words the board shows staff. */
export function statusLabel(w,pending){if(w.status==='completed')return 'Completed';if(w.status==='cancelled')return 'Cancelled';if(w.status==='submitted')return 'Ready to check';if(pending)return 'Waiting on client';return {open:'Open',scheduled:'Scheduled',in_progress:'In progress'}[w.status]||String(w.status||'');}
export function exportCsv(rows){return [csvRow(EXPORT_HEAD),...rows.map(w=>csvRow([w.title,w.property_name,statusLabel(w,w.approval_pending),w.priority||'',w.staff_name||w.vendor_name||'Unassigned',w.due_date?readableDay(w.due_date):'No due date',readableStamp(w.created_at,w.timezone),readableStamp(w.completed_at,w.timezone)]))].join('\r\n')+'\r\n';}

export function createWorkExtras({get,all,run,transaction,id,now,fail,roles,work,property,audit,body,communications}){
 async function latestApproval(workId){return get('SELECT * FROM spending_approvals WHERE work_order_id=? ORDER BY created_at DESC,id DESC LIMIT 1',workId);}
 async function lastReminder(user,workId){return (await get("SELECT MAX(created_at) last_at FROM audit WHERE organization_id=? AND action='approval.reminder_sent' AND entity_id=?",user.organization_id,workId))?.last_at||null;}
 async function exportRows(user,ids){
  const wanted=[...new Set(ids.map(String))];if(!wanted.length)return [];const rows=[];
  // Chunked IN lists keep each query small; every row is re-checked against the user's company.
  for(let i=0;i<wanted.length;i+=200){const part=wanted.slice(i,i+200);
   rows.push(...await all(`SELECT w.id,w.title,w.status,w.priority,w.due_date,w.created_at,w.completed_at,p.name property_name,p.timezone,v.name vendor_name,u.name staff_name,
    (SELECT s.status FROM spending_approvals s WHERE s.work_order_id=w.id ORDER BY s.created_at DESC,s.id DESC LIMIT 1) approval_status
    FROM work_orders w JOIN properties p ON p.id=w.property_id LEFT JOIN vendors v ON v.id=w.vendor_id AND v.organization_id=p.organization_id LEFT JOIN work_staff a ON a.work_id=w.id LEFT JOIN users u ON u.id=a.user_id AND u.organization_id=p.organization_id
    WHERE p.organization_id=? AND w.id IN (${part.map(()=>'?').join(',')})`,user.organization_id,...part));}
  const order=new Map(wanted.map((k,i)=>[k,i]));
  return rows.map(r=>({...r,approval_pending:r.approval_status==='pending'&&!DONE.includes(r.status)})).sort((a,b)=>order.get(a.id)-order.get(b.id));
 }
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/work-orders/'))return false;if(!user)fail(401,'Please sign in.');
  if(req.method!=='POST')fail(405,'Use POST.');const b=await body(req);
  if(url.pathname==='/api/work-orders/export'){
   roles(user,'admin');
   if(!Array.isArray(b.ids)||b.ids.length>EXPORT_LIMIT||b.ids.some(x=>typeof x!=='string'||x.length>80))fail(422,`Choose up to ${EXPORT_LIMIT} work orders to export.`);
   const rows=await exportRows(user,b.ids);if(!rows.length)fail(422,'There are no work orders in this view to export.');
   await audit(user,'work.exported',user.organization_id);
   const view=String(b.view||'open').replace(/[^a-z-]/gi,'').slice(0,20)||'open',day=new Date().toISOString().slice(0,10);
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="Work-orders-${view}-${day}.csv"`,'Cache-Control':'no-store','X-Export-Count':String(rows.length)});
   res.end('\ufeff'+exportCsv(rows));return true;
  }
  if(url.pathname==='/api/work-orders/remind'){
   roles(user,'admin','employee');
   const result=await transaction(async()=>{
    const w=await work(user,b.workId);if(DONE.includes(w.status))fail(409,'This work order is already finished.');
    const a=await latestApproval(w.id);if(!a||a.status!=='pending')fail(409,'This work order is not waiting on client approval.');
    const last=await lastReminder(user,w.id);
    if(last&&Date.now()-Date.parse(last)<REMIND_EVERY_MS)fail(429,'The family was already reminded in the last 24 hours.',{remindedAt:last,nextAt:new Date(Date.parse(last)+REMIND_EVERY_MS).toISOString()});
    const prop=await property(user,w.property_id);
    const recipients=await all("SELECT id,email FROM users WHERE organization_id=? AND client_id=? AND role='client' AND active=1",user.organization_id,prop.client_id);
    if(!recipients.length)fail(422,'No one in this family has an account to remind.');
    // Same path as every other email: the outbox (sent by the Resend worker when a key is set) plus an in-app notification that opens Approvals.
    await communications.enqueue(user.organization_id,'approval-reminder:'+a.id+':'+id(),recipients,'Reminder: your approval is needed for '+w.title,'A repair estimate for "'+w.title+'" at '+prop.name+' is still waiting for your decision. Sign in and open Approvals to review the scope and amount, then approve or decline.',a.id);
    const at=now();await run('INSERT INTO audit VALUES(?,?,?,?,?,?)',id(),user.organization_id,user.id,'approval.reminder_sent',w.id,at);
    return {remindedAt:at,recipients:recipients.length};
   });
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(result));return true;
  }
  fail(404,'Endpoint not found.');
 }
 return {handle,exportRows,lastReminder};
}
