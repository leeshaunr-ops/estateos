import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes,createHash} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';import {openDatabase} from './database.mjs';import {createDemoSignup} from './demo-signup.mjs';
for(const engine of ['sqlite','postgres'])test('public demo verification, deduplication and sales lead capture '+engine,async()=>{
 const root=path.dirname(fileURLToPath(import.meta.url)),dir=path.join(root,'demo-signup-test-'+randomUUID()),db=await openDatabase(root,engine==='postgres'?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:dir}:{ESTATEOS_DATA_DIR:dir});
 try{const now=()=>new Date().toISOString(),sent=[],deps={...db,now,id:randomUUID,randomBytes,hash:s=>createHash('sha256').update(s).digest('hex'),rate:()=>{},body:async r=>r.body,json:(r,s,d)=>r.data=d,fail:(status,msg)=>{throw Object.assign(Error(msg),{status});}};
 await db.run('INSERT INTO organizations VALUES(?,?,?)','org','Owner',now());await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)','owner','org','Owner','owner@test.invalid','hash','admin',null,null,1,now());
 const m=createDemoSignup(deps,{env:{ESTATEOS_PLATFORM_OWNER_ID:'owner',RESEND_API_KEY:'fake'},send:async args=>{sent.push(args);return {emailStatus:'sent'};}}),b={name:'Alex',company:'Example Care',email:'demo@test.invalid',phone:'555-0100',residences:'11–50',contactConsent:true};
 const call=async data=>{const r={};await m.handle({method:'POST',body:data},r,new URL('https://test/api/demo-request'));return r.data;};
 await assert.rejects(call({...b,contactConsent:false}),e=>e.status===422);
 await call({...b,website:'bot'});assert.equal(sent.length,0);
 const response=await call(b);assert.equal(sent.length,1);assert.ok(!JSON.stringify(response).includes('workspaceInvite='));
 assert.equal((await db.get('SELECT COUNT(*) n FROM platform_leads')).n,0);
 await call(b);assert.equal(sent.length,1);
 const request=await db.get('SELECT * FROM demo_requests WHERE email=?',b.email);assert.ok(await db.get('SELECT token_hash FROM demo_invites WHERE token_hash=?',request.token_hash));
 await db.transaction(()=>m.accepted(request.token_hash));await db.transaction(()=>m.accepted(request.token_hash));
 const leads=await db.all('SELECT * FROM platform_leads');assert.equal(leads.length,1);assert.equal(leads[0].stage,'demo');assert.match(leads[0].notes,/11–50/);assert.match(leads[0].notes,/website/);
 await call(b);assert.equal(sent.length,1);
 }finally{await db.close();}
});
