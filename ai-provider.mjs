// AI provider for inspection summaries. "openai" calls the Responses API with a strict JSON schema, store:false, a
// timeout and one retry on 429/5xx. "fake" returns a deterministic draft (local demos, screenshots, smoke tests).
// Error messages never include the API key or the provider's response body.
import {SCHEMA} from './ai-core.mjs';
export const DEFAULT_MODEL='gpt-5.4-mini';
export class AiError extends Error{constructor(code,message,extra={}){super(message||code);this.code=code;Object.assign(this,extra);}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function aiProviderName(env=process.env){return String(env.AI_PROVIDER||'openai').toLowerCase()==='fake'?'fake':'openai';}
export function aiModel(env=process.env){return String(env.OPENAI_MODEL||'').trim()||DEFAULT_MODEL;}
const reasoningModel=m=>/^(gpt-5|o\d)/i.test(m);

export function createAiProvider({env=process.env,fetcher=globalThis.fetch,log=console}={}){
 const name=aiProviderName(env);
 if(name==='fake')return {name,model:'fake-summary-v1',configured:true,summarize:fakeSummarize};
 const model=aiModel(env);
 const base=String(env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/+$/,'');
 const timeoutMs=Math.max(1000,Number(env.OPENAI_TIMEOUT_MS||20000));
 const configured=!!String(env.OPENAI_API_KEY||'').trim();
 async function once({instructions,input}){
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  const payload={model,instructions,input:[{role:'user',content:[{type:'input_text',text:'Visit data (JSON):\n'+JSON.stringify(input)}]}],
   text:{format:{type:'json_schema',name:'inspection_summary',strict:true,schema:SCHEMA}},store:false,max_output_tokens:800,...(reasoningModel(model)?{reasoning:{effort:'low'}}:{temperature:0.3})};
  let res;
  try{res=await fetcher(base+'/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+String(env.OPENAI_API_KEY||'').trim()},body:JSON.stringify(payload),signal:ctrl.signal});}
  catch(e){throw new AiError(e?.name==='AbortError'?'timeout':'unavailable',e?.name==='AbortError'?'Timed out':'Network error',{beforeResponse:true});}
  finally{clearTimeout(timer);}
  let data=null;try{data=await res.json();}catch{}
  if(res.status===429)throw new AiError(data?.error?.code==='insufficient_quota'?'quota':'rate_limited','Provider rate limit',{status:429,retryable:data?.error?.code!=='insufficient_quota',beforeResponse:true});
  if(res.status>=500)throw new AiError('unavailable','Provider error '+res.status,{status:res.status,retryable:true,beforeResponse:true});
  if(res.status===401||res.status===403)throw new AiError('config','Provider rejected the key',{status:res.status,beforeResponse:true});
  if(!res.ok)throw new AiError('unavailable','Provider error '+res.status,{status:res.status,beforeResponse:true,providerCode:String(data?.error?.code||data?.error?.type||'').slice(0,60)});
  if(!data||typeof data!=='object')throw new AiError('malformed','Unreadable provider response');
  const usage={in:Number(data.usage?.input_tokens||0),out:Number(data.usage?.output_tokens||0)};
  const parts=(data.output||[]).filter(o=>o?.type==='message').flatMap(o=>o.content||[]);
  const refusal=parts.find(c=>c?.type==='refusal');
  if(refusal)throw new AiError('refused','Provider declined',{usage,model:data.model||model});
  if(data.status&&data.status!=='completed')throw new AiError('malformed','Incomplete response',{usage,model:data.model||model,reason:String(data.incomplete_details?.reason||data.status).slice(0,60)});
  const text=parts.filter(c=>c?.type==='output_text').map(c=>c.text||'').join('');
  let parsed;try{parsed=JSON.parse(text);}catch{throw new AiError('malformed','Unreadable JSON',{usage,model:data.model||model});}
  return {parsed,usage,model:data.model||model};
 }
 async function summarize(args){
  if(!configured)throw new AiError('config','No API key',{beforeResponse:true});
  const started=Date.now();
  try{const out=await once(args);return {...out,latencyMs:Date.now()-started};}
  catch(e){
   if(!(e instanceof AiError)||!e.retryable)throw Object.assign(e,{latencyMs:Date.now()-started});
   await sleep(300+Math.floor(Math.random()*700));
   try{const out=await once(args);return {...out,latencyMs:Date.now()-started};}catch(e2){throw Object.assign(e2,{latencyMs:Date.now()-started});}
  }
 }
 return {name,model,configured,summarize};
}

/** Deterministic, offline draft built only from the allow-listed input. */
async function fakeSummarize({input}){
 const flagged=(input.items||[]).filter(i=>i.tone==='fail'||i.tone==='monitor');
 const visit=String(input.visit_type||'visit').toLowerCase();
 const sentences=[];
 if(!flagged.length)sentences.push(`Everything checked during this ${visit} visit was in good order.`);
 else{
  sentences.push(`During this ${visit} visit we checked ${(input.items||[]).length} items.`);
  for(const f of flagged.slice(0,6)){const note=String(f.note||'').replace(/\[[a-z]+\]/gi,'').trim().replace(/\.$/,'');sentences.push(f.tone==='fail'?`${f.label} needs attention${note?`: ${note}`:''}.`:`We are keeping an eye on ${f.label.charAt(0).toLowerCase()+f.label.slice(1)}${note?` (${note})`:''}.`);}
  sentences.push('Everything else checked was in good order.');
 }
 if(input.weather_at_visit)sentences.push(`Weather at the visit: ${input.weather_at_visit.replace(/\.$/,'')}.`);
 return {parsed:{summary:sentences.join(' '),mentioned_items:flagged.slice(0,6).map(f=>f.label)},usage:{in:0,out:0},model:'fake-summary-v1',latencyMs:1};
}
