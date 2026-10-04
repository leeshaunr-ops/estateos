// AI inspection summaries: a team member taps "Draft summary with AI" on a draft visit, reviews the suggestion, and
// either uses it (it lands in the summary box like typed text) or discards it. Off unless AI_FEATURES_ENABLED=true on
// the server AND the company turns it on in Company settings. Only allow-listed, redacted visit data is sent (see
// ai-core.mjs). A summary that came from a draft cannot be published until someone confirms they reviewed the saved text.
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROMPT_VERSION,knownTerms,buildInput,leakScan,coverage,parseAnswer,summaryHash,visitLabel} from './ai-core.mjs';
import {createAiProvider,AiError} from './ai-provider.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const PROMPT=fs.readFileSync(path.join(here,'prompts',`${PROMPT_VERSION}.md`),'utf8');
const GEN=/^\/api\/inspections\/([^/]+)\/ai-summary$/,ACT=/^\/api\/inspections\/([^/]+)\/ai-summary\/([^/]+)\/(discard|use)$/,REV=/^\/api\/inspections\/([^/]+)\/ai-summary\/review$/;
const parse=(s,f)=>{if(s==null||s==='')return f;if(typeof s!=='string')return s;try{return JSON.parse(s);}catch{return f;}};
const LIMITS={userPer10Min:10,visitPerHour:5};
const MESSAGES={
 timeout:[504,'The AI service took too long. Try again, or write the summary yourself.'],
 rate_limited:[503,'The AI service is busy right now. Try again in a minute.'],
 quota:[503,'AI drafting is paused for now. Please write the summary yourself.'],
 config:[503,'AI drafting is not set up on this server yet.'],
 unavailable:[502,'The AI service is not responding. Try again, or write the summary yourself.'],
 malformed:[502,'The AI service sent back something we could not use. Try again.'],
 refused:[422,'The AI service would not draft this summary. Please write it yourself.'],
};
export const PRIVACY_NOTE='When a team member asks for a draft summary, we send the visit\u2019s checklist results, notes to the client and weather at the visit, with names, addresses and access codes removed, to OpenAI, our AI subprocessor, to write the draft. OpenAI does not keep the data for training (API data, store off). A team member reviews every draft before it reaches a family.';

export function createAiSummaries({get,all,run,transaction,id,now,fail,json,body,roles,property,audit,platformOwner,visitVerification},{env=process.env,fetcher=globalThis.fetch,log=console,provider:injected}={}){
 const provider=injected||createAiProvider({env,fetcher,log});
 const serverEnabled=()=>String(env.AI_FEATURES_ENABLED||'').toLowerCase()==='true';
 const defaultCap=()=>{const n=Number(env.AI_MONTHLY_CAP_DEFAULT);return Number.isInteger(n)&&n>=0?n:300;};
 const month=()=>now().slice(0,7);
 const ago=ms=>new Date(Date.now()-ms).toISOString();

 // ---------- settings + usage ----------
 async function settingsFor(org){
  const r=await get('SELECT * FROM ai_settings WHERE organization_id=?',org)||{};
  const ceiling=r.platform_cap_override==null||r.platform_cap_override===''?defaultCap():Number(r.platform_cap_override);
  const own=r.monthly_cap==null||r.monthly_cap===''?null:Number(r.monthly_cap);
  return {enabled:Number(r.enabled||0)===1,label_reports:Number(r.label_reports||0)===1,monthly_cap:own,ceiling,cap:Math.min(own??ceiling,ceiling),platform_cap_override:r.platform_cap_override==null?null:Number(r.platform_cap_override),updated_at:r.updated_at||null};
 }
 async function used(org){return Number((await get('SELECT drafts FROM ai_usage_monthly WHERE organization_id=? AND month=?',org,month()))?.drafts||0);}
 async function status(user){
  const s=await settingsFor(user.organization_id),n=await used(user.organization_id);
  let reason='';
  if(!serverEnabled())reason='AI drafting is not available on this server.';
  else if(!provider.configured)reason='AI drafting is not set up on this server yet.';
  else if(!s.enabled)reason=user.role==='admin'?'Turn on AI summaries in Company settings to use this.':'An admin can turn on AI summaries in Company settings.';
  else if(n>=s.cap)reason=`Your company has used this month\u2019s AI drafts (${n} of ${s.cap}). Write the summary yourself, or ask an admin to raise the limit.`;
  return {serverEnabled:serverEnabled(),enabled:s.enabled,available:!reason,reason,used:n,cap:s.cap,labelReports:s.label_reports};
 }
 async function settingsOut(user){
  const s=await settingsFor(user.organization_id);
  return {settings:{enabled:s.enabled,label_reports:s.label_reports,monthly_cap:s.monthly_cap},cap:s.cap,ceiling:s.ceiling,used:await used(user.organization_id),month:month(),serverEnabled:serverEnabled(),configured:!!provider.configured,provider:provider.name,model:provider.model,privacy:PRIVACY_NOTE};
 }
 const bool=(v,label)=>{if(typeof v==='boolean')return v;if(v===1||v===0)return !!v;if(v==='true'||v==='false')return v==='true';fail(422,`${label} must be on or off.`);};
 async function saveSettings(user,b){
  roles(user,'admin');
  if(!b||typeof b!=='object')fail(422,'Send the AI settings.');
  const cur=await settingsFor(user.organization_id),next={enabled:cur.enabled,label_reports:cur.label_reports,monthly_cap:cur.monthly_cap};
  if(b.enabled!==undefined)next.enabled=bool(b.enabled,'AI summaries');
  if(b.label_reports!==undefined)next.label_reports=bool(b.label_reports,'The report label');
  if(b.monthly_cap!==undefined){
   if(b.monthly_cap===null||b.monthly_cap==='')next.monthly_cap=null;
   else{const n=Number(b.monthly_cap);if(!Number.isInteger(n)||n<0||n>cur.ceiling)fail(422,`Monthly drafts must be a whole number from 0 to ${cur.ceiling}.`);next.monthly_cap=n;}
  }
  if(next.enabled&&!serverEnabled())fail(409,'AI drafting is not available on this server yet.');
  await run('INSERT INTO ai_settings(organization_id,enabled,label_reports,monthly_cap,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,label_reports=excluded.label_reports,monthly_cap=excluded.monthly_cap,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
   user.organization_id,next.enabled?1:0,next.label_reports?1:0,next.monthly_cap,user.id,now());
  if(next.enabled!==cur.enabled)await audit(user,next.enabled?'ai.enabled':'ai.disabled',user.organization_id);
  else await audit(user,'ai.settings_updated',user.organization_id);
  return settingsOut(user);
 }
 async function usageOut(user){
  roles(user,'admin');
  const org=user.organization_id,m=month(),row=await get('SELECT * FROM ai_usage_monthly WHERE organization_id=? AND month=?',org,m)||{};
  const s=await settingsFor(org);
  const recent=await all("SELECT e.created_at,e.kind,e.status,e.latency_ms,u.name user_name FROM ai_usage_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.organization_id=? ORDER BY e.created_at DESC LIMIT 25",org);
  const byUser=await all("SELECT u.name,COUNT(*) n FROM ai_usage_events e JOIN users u ON u.id=e.user_id WHERE e.organization_id=? AND e.kind='generate' AND e.status='ok' AND e.created_at>=? GROUP BY u.name ORDER BY n DESC",org,m+'-01');
  return {month:m,used:Number(row.drafts||0),cap:s.cap,tokensIn:Number(row.tokens_in||0),tokensOut:Number(row.tokens_out||0),byUser:byUser.map(r=>({name:r.name,drafts:Number(r.n)})),recent};
 }
 async function setPlatformCap(user,b){
  if(!platformOwner(user))fail(403,'Only the platform owner can change this.');
  const org=String(b?.organizationId||'');if(!(await get('SELECT id FROM organizations WHERE id=?',org)))fail(404,'Company not found.');
  let cap=null;if(b.cap!==null&&b.cap!==undefined&&b.cap!==''){cap=Number(b.cap);if(!Number.isInteger(cap)||cap<0||cap>100000)fail(422,'The limit must be a whole number from 0 to 100000.');}
  await run('INSERT INTO ai_settings(organization_id,platform_cap_override,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET platform_cap_override=excluded.platform_cap_override,updated_by=excluded.updated_by,updated_at=excluded.updated_at',org,cap,user.id,now());
  await audit(user,'ai.platform_cap',org);
  const s=await settingsFor(org);return {organizationId:org,ceiling:s.ceiling,cap:s.cap};
 }

 // ---------- what we know is sensitive for this visit ----------
 async function termsFor(org,pRow){
  const people=[],places=[pRow.name],addresses=[pRow.address,pRow.street_address,[pRow.street_address,pRow.address_line2].filter(Boolean).join(' ')].filter(Boolean);
  const company=(await get('SELECT name FROM organizations WHERE id=?',org))?.name||'';
  for(const u of await all('SELECT name FROM users WHERE organization_id=?',org))people.push(u.name);
  const client=await get('SELECT name,profile FROM clients WHERE id=?',pRow.client_id);
  if(client){people.push(client.name);const walk=(v,k='')=>{if(typeof v==='string'){if(/street|address/i.test(k))addresses.push(v);else if(/name|spouse|partner|family|member|child|guest|owner/i.test(k))people.push(v);}else if(Array.isArray(v))v.forEach(x=>walk(x,k));else if(v&&typeof v==='object')for(const [kk,vv] of Object.entries(v))walk(vv,kk);};walk(parse(client.profile,{}));}
  for(const v of await all('SELECT name FROM vendors WHERE organization_id=?',org))places.push(v.name);
  for(const p of await all('SELECT name FROM properties WHERE organization_id=?',org))places.push(p.name);
  return knownTerms({company,people:people.filter(Boolean),places:places.filter(Boolean),addresses});
 }

 // ---------- drafting ----------
 async function inspectionFor(user,inspectionId){
  roles(user,'admin','employee');
  const row=await get('SELECT * FROM inspections WHERE id=?',inspectionId);
  if(!row)fail(404,'Inspection not found.');
  const pRow=await property(user,row.property_id,'operate');
  return {row,pRow};
 }
 function draftOut(d,replay=false){return {id:d.id,status:d.status,text:d.status==='ready'||d.status==='used'?d.text:null,missing:parse(d.missing_items,[]),mentioned:parse(d.mentioned_items,[]),model:d.model,createdAt:d.created_at,...(replay?{replay:true}:{})};}
 async function event(user,inspectionId,draftId,kind,st,extra={}){
  const eid=id();
  await run('INSERT INTO ai_usage_events(id,organization_id,user_id,inspection_id,draft_id,kind,status,model,tokens_in,tokens_out,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',eid,user.organization_id,user.id,inspectionId,draftId,kind,st,extra.model||null,extra.in||0,extra.out||0,extra.ms??null,now());
  return eid;
 }
 async function generate(user,inspectionId,req,b){
  const {row,pRow}=await inspectionFor(user,inspectionId);
  const st=await status(user);
  if(!st.serverEnabled)fail(403,st.reason);
  if(!provider.configured)fail(503,st.reason);
  if(!st.enabled)fail(403,st.reason);
  if(row.status!=='draft')fail(409,'AI drafts are only for visits that are still in draft.');
  const key=String(req.headers['idempotency-key']||b?.idempotencyKey||'').slice(0,100)||randomUUID();
  const prior=await get('SELECT * FROM ai_summary_drafts WHERE user_id=? AND idempotency_key=?',user.id,key);
  if(prior){
   if(prior.inspection_id!==row.id)fail(409,'This request key was already used for another visit.');
   if(prior.status==='pending')fail(409,'Still drafting \u2014 give it a moment.',{code:'ai_pending'});
   if(prior.status==='blocked')fail(422,'We discarded this draft because it included personal details. Try again, or write the summary yourself.',{code:'ai_blocked'});
   if(prior.status!=='failed')return {draft:draftOut(prior,true),usage:await status(user)};
   await run("DELETE FROM ai_summary_drafts WHERE id=? AND status='failed'",prior.id);
  }
  const terms=await termsFor(user.organization_id,pRow);
  const tz=(await visitVerification.settings(user.organization_id).catch(()=>({})))?.timezone||pRow.timezone||'';
  const {input,flagged,checked}=buildInput({inspection:row,answers:parse(row.answers,[]),weatherLine:parse(row.weather_snapshot,null)?.line||'',timezoneLabel:pRow.timezone||tz,terms});
  if(!checked)fail(422,'Check some items first, then ask for a draft.');
  if(Number((await get("SELECT COUNT(*) n FROM ai_usage_events WHERE inspection_id=? AND kind='generate' AND created_at>=?",row.id,ago(60*60000)))?.n||0)>=LIMITS.visitPerHour)fail(429,'This visit has had several drafts in the last hour. Edit the latest one, or try again later.',{code:'ai_rate_limited'});
  if(Number((await get("SELECT COUNT(*) n FROM ai_usage_events WHERE user_id=? AND kind='generate' AND created_at>=?",user.id,ago(10*60000)))?.n||0)>=LIMITS.userPer10Min)fail(429,'You have asked for a lot of drafts in the last few minutes. Try again in 10 minutes.',{code:'ai_rate_limited'});
  const draftId=id(),inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0,40);
  const ins=await run("INSERT INTO ai_summary_drafts(id,organization_id,inspection_id,user_id,idempotency_key,status,model,prompt_version,input_hash,created_at) VALUES(?,?,?,?,?,'pending',?,?,?,?) ON CONFLICT(user_id,idempotency_key) DO NOTHING",draftId,user.organization_id,row.id,user.id,key,provider.model,PROMPT_VERSION,inputHash,now());
  if(ins.changes!==1)fail(409,'Still drafting \u2014 give it a moment.',{code:'ai_pending'});
  // Monthly cap: one atomic increment; refunded if the provider never answered.
  const m=month();
  await run('INSERT INTO ai_usage_monthly(organization_id,month) VALUES(?,?) ON CONFLICT(organization_id,month) DO NOTHING',user.organization_id,m);
  const reserved=await run('UPDATE ai_usage_monthly SET drafts=drafts+1 WHERE organization_id=? AND month=? AND drafts<?',user.organization_id,m,st.cap);
  if(reserved.changes!==1){await run('DELETE FROM ai_summary_drafts WHERE id=?',draftId);fail(429,`Your company has used this month\u2019s AI drafts (${st.cap}). Write the summary yourself, or ask an admin to raise the limit.`,{code:'ai_cap_reached'});}
  const eventId=await event(user,row.id,draftId,'generate','started',{model:provider.model});
  const finish=async(dStatus,eStatus,extra={})=>{
   await run('UPDATE ai_summary_drafts SET status=?,text=?,mentioned_items=?,missing_items=?,model=?,tokens_in=?,tokens_out=?,latency_ms=?,error=? WHERE id=?',dStatus,extra.text??null,JSON.stringify(extra.mentioned||[]),JSON.stringify(extra.missing||[]),extra.model||provider.model,extra.in||0,extra.out||0,extra.ms??null,extra.error||null,draftId);
   await run('UPDATE ai_usage_events SET status=?,model=?,tokens_in=?,tokens_out=?,latency_ms=? WHERE id=?',eStatus,extra.model||provider.model,extra.in||0,extra.out||0,extra.ms??null,eventId);
   if(extra.in||extra.out)await run('UPDATE ai_usage_monthly SET tokens_in=tokens_in+?,tokens_out=tokens_out+? WHERE organization_id=? AND month=?',extra.in||0,extra.out||0,user.organization_id,m);
   log.info?.(`AI summary: ${eStatus} model=${extra.model||provider.model} tokens=${extra.in||0}/${extra.out||0} ms=${extra.ms??'-'}`);
  };
  let out;
  try{out=await provider.summarize({instructions:PROMPT,input});}
  catch(e){
   const code=e instanceof AiError?e.code:'unavailable';
   if(e?.beforeResponse)await run('UPDATE ai_usage_monthly SET drafts=drafts-1 WHERE organization_id=? AND month=? AND drafts>0',user.organization_id,m);
   await finish('failed',code,{in:e?.usage?.in,out:e?.usage?.out,ms:e?.latencyMs,model:e?.model,error:code});
   if(code==='config'||code==='quota')log.warn?.(`AI summary provider problem: ${code}${e?.status?` (HTTP ${e.status})`:''}`);
   const [httpStatus,msg]=MESSAGES[code]||MESSAGES.unavailable;
   fail(httpStatus,msg,{code:'ai_'+code});
  }
  let answer;
  try{answer=parseAnswer(out.parsed);}
  catch{await finish('failed','malformed',{in:out.usage.in,out:out.usage.out,ms:out.latencyMs,model:out.model,error:'malformed'});fail(...MESSAGES.malformed,{code:'ai_malformed'});}
  const leaks=leakScan(answer.summary,terms);
  if(leaks.length){
   await finish('blocked','blocked',{in:out.usage.in,out:out.usage.out,ms:out.latencyMs,model:out.model,error:'leak:'+leaks.join(',')});
   fail(422,'We discarded this draft because it included personal details. Try again, or write the summary yourself.',{code:'ai_blocked'});
  }
  const missing=coverage(answer.summary,answer.mentioned,flagged);
  await finish('ready','ok',{text:answer.summary,mentioned:answer.mentioned,missing,in:out.usage.in,out:out.usage.out,ms:out.latencyMs,model:out.model});
  await audit(user,'ai.summary_drafted',row.id);
  return {draft:draftOut(await get('SELECT * FROM ai_summary_drafts WHERE id=?',draftId)),usage:await status(user)};
 }
 async function draftFor(user,inspectionId,draftId){
  const {row}=await inspectionFor(user,inspectionId);
  const d=await get('SELECT * FROM ai_summary_drafts WHERE id=? AND inspection_id=? AND organization_id=?',draftId,row.id,user.organization_id);
  if(!d)fail(404,'Draft not found.');
  return {row,d};
 }
 async function useDraft(user,inspectionId,draftId){
  const {row,d}=await draftFor(user,inspectionId,draftId);
  if(row.status!=='draft')fail(409,'This visit is no longer a draft.');
  if(!['ready','used'].includes(d.status))fail(409,'This draft can no longer be used. Ask for a new one.');
  await transaction(async()=>{
   await run("UPDATE ai_summary_drafts SET status='used',used_at=COALESCE(used_at,?) WHERE id=?",now(),d.id);
   await run("UPDATE inspections SET summary_source='ai_draft',summary_ai_draft_id=?,summary_reviewed_by=NULL,summary_reviewed_at=NULL,summary_reviewed_hash=NULL WHERE id=?",d.id,row.id);
   await event(user,row.id,d.id,'use','ok');
  });
  await audit(user,'ai.summary_used',row.id);
  return {draftId:d.id,text:d.text,summarySource:'ai_draft',reviewCurrent:false};
 }
 async function discardDraft(user,inspectionId,draftId){
  const {row,d}=await draftFor(user,inspectionId,draftId);
  if(d.status==='ready')await run("UPDATE ai_summary_drafts SET status='discarded',discarded_at=?,text=NULL WHERE id=?",now(),d.id);
  await event(user,row.id,d.id,'discard','ok');
  return {draftId:d.id,status:d.status==='ready'?'discarded':d.status};
 }
 async function review(user,inspectionId){
  const {row}=await inspectionFor(user,inspectionId);
  if(!['draft','submitted'].includes(row.status))fail(409,'This report is already published.');
  if(row.summary_source!=='ai_draft')return {reviewRequired:false};
  if(!String(row.summary||'').trim())fail(422,'Add an inspection summary.');
  const at=now();
  await run('UPDATE inspections SET summary_reviewed_by=?,summary_reviewed_at=?,summary_reviewed_hash=? WHERE id=?',user.id,at,summaryHash(row.summary),row.id);
  await event(user,row.id,row.summary_ai_draft_id,'review','ok');
  await audit(user,'ai.summary_reviewed',row.id);
  return {reviewRequired:true,reviewedAt:at,reviewedBy:user.name,reviewCurrent:true};
 }

 // ---------- hooks ----------
 /** Publish gate: an AI-assisted summary needs a review of exactly the text being published. */
 const reviewPending=row=>row?.summary_source==='ai_draft'&&row.summary_reviewed_hash!==summaryHash(row.summary);
 function assertReviewed(row){
  if(reviewPending(row))fail(422,'Review the AI-assisted summary before publishing: read it, then confirm.',{code:'ai_review_required'});
 }
 function extendReports(vv){
  const base=vv.publishFields;
  vv.publishFields=async(user,row,pRow)=>{
   const out=await base(user,row,pRow);
   try{if(row.summary_source==='ai_draft'&&(await settingsFor(user.organization_id)).label_reports){const company=(await get('SELECT name FROM organizations WHERE id=?',user.organization_id))?.name||'our team';out.fields={...out.fields,aiNote:`Summary drafted with AI assistance and reviewed by ${company}.`};}}catch{}
   return out;
  };
  return vv;
 }
 async function decorate(user,data){
  const staff=['admin','employee'].includes(user?.role);
  for(const i of data?.inspections||[]){
   const current=i.summary_source==='ai_draft'&&i.summary_reviewed_hash===summaryHash(i.summary);
   if(staff){i.summary_review_current=current;delete i.summary_reviewed_hash;}
   else{delete i.summary_source;delete i.summary_ai_draft_id;delete i.summary_reviewed_by;delete i.summary_reviewed_at;delete i.summary_reviewed_hash;}
  }
  if(staff)data.ai=await status(user);
  return data;
 }
 async function handle(req,res,url,user){
  const p=url.pathname,method=req.method;
  const g=p.match(GEN),a=p.match(ACT),r=p.match(REV);
  if(!g&&!a&&!r&&p!=='/api/settings/ai'&&p!=='/api/ai/usage'&&p!=='/api/ai/platform-cap')return false;
  if(!user)fail(401,'Please sign in.');
  if(p==='/api/settings/ai'){roles(user,'admin');if(method==='GET')return json(res,200,await settingsOut(user)),true;if(method==='POST'||method==='PUT')return json(res,200,await saveSettings(user,await body(req))),true;return false;}
  if(p==='/api/ai/usage'&&method==='GET')return json(res,200,await usageOut(user)),true;
  if(method!=='POST')return false;
  if(p==='/api/ai/platform-cap')return json(res,200,await setPlatformCap(user,await body(req))),true;
  if(g)return json(res,200,await generate(user,decodeURIComponent(g[1]),req,await body(req).catch(()=>({})))),true;
  if(r)return json(res,200,await review(user,decodeURIComponent(r[1]))),true;
  if(a){const fn=a[3]==='use'?useDraft:discardDraft;return json(res,200,await fn(user,decodeURIComponent(a[1]),decodeURIComponent(a[2]))),true;}
  return false;
 }
 return {handle,decorate,assertReviewed,reviewPending,extendReports,settingsFor,status,provider,visitLabel};
}
