import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from './database.mjs';
import {createPlatformDashboard} from './platform-dashboard.mjs';
for(const engine of ['sqlite','postgres'])test('master role isolation, grants, revocation and drafts: '+engine,async()=>{
 const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1')),dir=path.join(root,'platform-test-'+randomUUID());
 const db=await openDatabase(root,engine==='postgres'?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:dir}:{ESTATEOS_DATA_DIR:dir});
 try{
  const now=()=>new Date().toISOString();await db.run('INSERT INTO organizations VALUES(?,?,?)','org','Test',now());
  for(const id of ['owner','marketing','ordinary'])await db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',id,'org',id,id+'@test.invalid','hash','admin',null,null,1,now());
  const owner={id:'owner',role:'admin',active:1},marketing={id:'marketing',role:'admin',active:1};
  const m=createPlatformDashboard({...db,now,id:randomUUID,platformOwner:u=>u.id==='owner',body:async r=>r.body,json:(r,s,d)=>r.data=d,fail:(status,msg)=>{throw Object.assign(Error(msg),{status});},audit:async()=>{},subscriptions:{summary:async()=>({used:0,limit:1e10,percent:0,seats:1,monthlyMinor:7900})}});
  const call=async(user,p,b)=>{const r={};await m.handle({method:b?'POST':'GET',body:b},r,new URL('https://test/api/master/'+p),user);return r.data;};
  await assert.rejects(call(null,'companies'),e=>e.status===401);
  await assert.rejects(call(marketing,'companies'),e=>e.status===403);
  await call(owner,'access',{userId:'marketing',permissions:['marketing']});
  assert.deepEqual((await call(marketing,'session')).permissions,['marketing']);
  for(const p of ['companies','billing','health','access'])await assert.rejects(call(marketing,p),e=>e.status===403);
  await assert.rejects(call(marketing,'access',{userId:'marketing',permissions:['billing']}),e=>e.status===403);
  await call(marketing,'leads',{company:'Prospect',email:'info@example.com',stage:'new'});
  assert.equal((await call(marketing,'leads')).length,1);
  await call(marketing,'posts',{channel:'facebook',content:'Draft only',status:'ready'});
  assert.equal((await call(marketing,'posts'))[0].status,'ready');
  await assert.rejects(call(marketing,'posts',{channel:'facebook',content:'x',status:'published'}),e=>e.status===422);
  await call(owner,'access',{userId:'marketing',permissions:['operations']});
  assert.equal((await call(marketing,'companies')).length,1);
  await assert.rejects(call(marketing,'leads'),e=>e.status===403);
  await call(owner,'access',{userId:'marketing',permissions:[]});
  await assert.rejects(call(marketing,'companies'),e=>e.status===403);
  await assert.rejects(call(owner,'access',{userId:'owner',permissions:[]}),e=>e.status===422);
  await assert.rejects(call(owner,'access',{userId:'ordinary',permissions:['owner']}),e=>e.status===422);
  assert.equal((await call(owner,'billing')).activeMonthlyMinor,0);
 }finally{await db.close();}
});
