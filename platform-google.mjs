import {randomBytes,createHash} from 'node:crypto';
import {seal,unseal} from './vault.mjs';
export function createPlatformGoogle({get,run,transaction,body,json,fail,audit,platformOwner,permissions},env=process.env,fetcher=fetch,crypto={seal,unseal}){
 const property='sc-domain:estateaegis.com',scope='https://www.googleapis.com/auth/webmasters.readonly',context='platform:google';
 const configured=()=>!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.ESTATEOS_VAULT_KEY);
 const redirect=()=>{const u=new URL(env.APP_URL||'https://estateaegis.com');if(u.protocol!=='https:')fail(503,'Google requires the secure website address.');return u.origin+'/platform';};
 const hash=v=>createHash('sha256').update(String(v)).digest('hex');
 let cache=null,busy=null;
 async function token(fields){const r=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,...fields}),signal:AbortSignal.timeout(15000)});if(!r.ok)fail(502,'Google authorization failed. Reconnect the account or review the Google app configuration.');const d=await r.json();if(!d.access_token)fail(502,'Google did not provide an access token.');return d;}
 async function read(){
  if(cache&&Date.now()-cache.at<3600000)return cache.data;
  if(busy)return busy;
  busy=(async()=>{
   const row=await get("SELECT secrets FROM platform_connections WHERE provider='google'");
   if(!row)return {configured:configured(),connected:false,property};
   if(!configured())return {configured:false,connected:true,property,error:'Google server credentials need configuration.'};
   const saved=crypto.unseal(row.secrets,context),t=await token({grant_type:'refresh_token',refresh_token:saved.refresh_token});
   const end=new Date(Date.now()-3*86400000),start=new Date(end.getTime()-27*86400000),startDate=start.toISOString().slice(0,10),endDate=end.toISOString().slice(0,10);
   const query=async dimensions=>{const r=await fetcher('https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent(property)+'/searchAnalytics/query',{method:'POST',headers:{Authorization:'Bearer '+t.access_token,'Content-Type':'application/json'},body:JSON.stringify({startDate,endDate,type:'web',dataState:'final',dimensions,rowLimit:25}),signal:AbortSignal.timeout(15000)});if(!r.ok)fail(502,'Search Console data unavailable. Confirm property access and that the Search Console API is enabled.');return (await r.json()).rows||[];};
   const [totals,queries,pages]=await Promise.all([query([]),query(['query']),query(['page'])]);
   const data={configured:true,connected:true,property,startDate,endDate,updatedAt:new Date().toISOString(),totals:totals[0]||null,queries,pages};cache={at:Date.now(),data};return data;
  })();try{return await busy;}finally{busy=null;}
 }
 async function handle(req,res,url,user){
  if(!url.pathname.startsWith('/api/master/google'))return false;
  if(!user)fail(401,'Sign in before connecting Google.');
  if(!(await permissions(user)).includes('marketing'))fail(403,'Marketing access required.');
  const p=url.pathname;
  if(req.method==='GET'&&p==='/api/master/google'){json(res,200,await read());return true;}
  if(req.method!=='POST')fail(405,'Method not allowed.');
  if(!platformOwner(user))fail(403,'Only the owner may connect or disconnect Google.');
  if(!configured())fail(503,'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render first.');
  const b=await body(req);
  if(p==='/api/master/google/start'){
   const state=randomBytes(32).toString('hex');await run('DELETE FROM platform_oauth_states WHERE expires_at<?',Date.now());
   await run('INSERT INTO platform_oauth_states VALUES(?,?,?)',hash(state),user.id,Date.now()+600000);
   const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');u.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirect(),response_type:'code',scope,access_type:'offline',prompt:'consent',state,login_hint:'leeshaunr@gmail.com'}).toString();json(res,200,{url:u.href});return true;
  }
  if(p==='/api/master/google/finish'){
   if(typeof b.code!=='string'||b.code.length>4096||typeof b.state!=='string'||b.state.length!==64)fail(422,'Invalid Google response.');
   await transaction(async()=>{const state=await get('SELECT user_id,expires_at FROM platform_oauth_states WHERE state_hash=?',hash(b.state));if(!state||state.user_id!==user.id||Number(state.expires_at)<Date.now())fail(403,'Google authorization expired or belongs to another account. Reconnect.');await run('DELETE FROM platform_oauth_states WHERE state_hash=?',hash(b.state));});
   const t=await token({code:b.code,grant_type:'authorization_code',redirect_uri:redirect()});
   if(!t.refresh_token||!String(t.scope||'').split(' ').includes(scope))fail(422,'Read-only Search Console access was not granted. Reconnect and allow the requested permission.');
   await run('INSERT INTO platform_connections VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET secrets=excluded.secrets,updated_at=excluded.updated_at','google',crypto.seal({refresh_token:t.refresh_token},context),new Date().toISOString());cache=null;await audit(user,'platform.google_connected',property);json(res,200,{ok:true});return true;
  }
  if(p==='/api/master/google/disconnect'){
   // Remove local access immediately; Google account controls allow revoking the grant itself.
   await run("DELETE FROM platform_connections WHERE provider='google'");cache=null;await audit(user,'platform.google_disconnected',property);json(res,200,{ok:true});return true;
  }
  fail(404,'Not found.');
 }
 return {handle};
}
