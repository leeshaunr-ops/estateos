import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';import path from 'node:path';import {openDatabase} from './database.mjs';import {createPlatformGoogle} from './platform-google.mjs';
test('Google owner-only consent, state binding, replay rejection and private tokens',async()=>{
 const root=path.dirname(fileURLToPath(import.meta.url)),db=await openDatabase(root,{ESTATEOS_DATA_DIR:path.join(root,'google-test-'+randomUUID())});
 try{
  await db.run('INSERT INTO organizations VALUES(?,?,?)','org','Test','now');await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','owner','org','Owner','owner@test.invalid','hash','admin',null,null,1,'now');
  const scope='https://www.googleapis.com/auth/webmasters.readonly',env={GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',ESTATEOS_VAULT_KEY:'test-vault',APP_URL:'https://estateaegis.com'};let calls=0;
  const m=createPlatformGoogle({...db,body:async r=>r.body,json:(r,s,d)=>r.data=d,fail:(status,msg)=>{throw Object.assign(Error(msg),{status});},audit:async()=>{},permissions:async()=>['marketing'],platformOwner:u=>u.id==='owner'},env,async url=>{calls++;return {ok:true,json:async()=>url.includes('/token')?{access_token:'private-access',refresh_token:'private-refresh',scope}:{rows:[{clicks:3,impressions:40,ctr:.075,position:5,keys:['test']}]}};},{seal:v=>'encrypted:'+JSON.stringify(v),unseal:v=>JSON.parse(v.slice(10))});
  const owner={id:'owner'},other={id:'other'},call=async(u,p,b)=>{const r={};await m.handle({method:b?'POST':'GET',body:b},r,new URL('https://test/api/master/google'+p),u);return r.data;};
  await assert.rejects(call(null,''),e=>e.status===401);await assert.rejects(call(other,'/start',{}),e=>e.status===403);
  const u=new URL((await call(owner,'/start',{})).url);assert.equal(u.searchParams.get('scope'),scope);assert.equal(u.searchParams.get('redirect_uri'),'https://estateaegis.com/platform');
  await assert.rejects(call(owner,'/finish',{state:'x'.repeat(64),code:'test-code'}),e=>e.status===403);assert.equal(calls,0);
  const b={state:u.searchParams.get('state'),code:'test-code'};await call(owner,'/finish',b);await assert.rejects(call(owner,'/finish',b),e=>e.status===403);
  const data=await call(other,'');assert.equal(data.totals.clicks,3);assert.equal(JSON.stringify(data).includes('private-'),false);
  const before=calls;await call(other,'');assert.equal(calls,before);
  await call(owner,'/disconnect',{});assert.equal((await call(other,'')).connected,false);
 }finally{await db.close();}
});
