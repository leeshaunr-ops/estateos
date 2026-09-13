import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from './database.mjs';
import {createSubscriptions,planPrice,GB} from './subscriptions.mjs';
import {createCommunications} from './communications.mjs';
for(const engine of ['sqlite','postgres'])test('subscription pricing, isolation, quota concurrency and approvals: '+engine,async()=>{
 const root=path.resolve('outputs/EstateAegis-Proactive'),dir=path.join(root,'subscription-test-'+randomUUID());
 const db=await openDatabase(root,engine==='postgres'?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:dir}:{ESTATEOS_DATA_DIR:dir});
 const {get,run,transaction}=db,now=()=>new Date().toISOString(),fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 try{
  for(const org of ['one','two']){
   await run('INSERT INTO organizations VALUES(?,?,?)',org,org,now());
   await run('INSERT INTO workspace_settings(organization_id) VALUES(?)',org);
   await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',org+'admin',org,'Admin',org+'@test.invalid','hash','admin',null,null,1,now());
   await run('INSERT INTO clients(id,organization_id,name,created_at) VALUES(?,?,?,?)',org+'family',org,'Family',now());
   await run('INSERT INTO properties(id,organization_id,client_id,name,created_at) VALUES(?,?,?,?,?)',org+'home',org,org+'family','Home',now());
  }
  for(const [uid,role,active] of [['staff','employee',1],['staff2','employee',1],['inactive','employee',0],['client','client',1],['vendor','vendor',1]])await run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',uid,'one',uid,uid+'@test.invalid','hash',role,null,null,active,now());
  const deps={...db,id:randomUUID,now,fail,audit:async()=>{},body:async r=>r.body,json:(res,status,data)=>{res.status=status;res.data=data;},platformOwner:u=>u.id==='twoadmin'};
  const communications=createCommunications(deps),s=createSubscriptions({...deps,communications});
  const admin={id:'oneadmin',organization_id:'one',role:'admin'},owner={id:'twoadmin',organization_id:'two',role:'admin'};
  const request=async(user,p,body,method='POST')=>{const res={};await s.handle({method,body},res,new URL('https://test'+p),user);return res.data;};
  assert.equal(planPrice(2),7900);assert.equal(planPrice(5,2),13400);assert.equal((await s.summary('one')).monthlyMinor,9400);
  const insert=(key,bytes)=>run('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?)',key,'onehome',null,null,key+'.pdf','application/pdf',bytes,key,'internal','oneadmin',now());
  for(let n=0;n<10;n++)await insert('initial'+n,GB-(n===0?100:0));
  const jobs=await Promise.allSettled([1,2].map(n=>transaction(async()=>{await s.ensureSpace('one',80);await insert('race'+n,80);})));assert.equal(jobs.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await s.summary('one')).used,10*GB-20);assert.equal((await s.summary('two')).used,0);
  await s.monitor('one');await s.monitor('one');assert.equal(Number((await get('SELECT COUNT(*) n FROM email_outbox')).n),1);
  await assert.rejects(request({...admin,role:'client'},'/api/subscription',null,'GET'),e=>e.status===403);
  await assert.rejects(request(admin,'/api/platform/storage',null,'GET'),e=>e.status===403);
  await assert.rejects(request(admin,'/api/subscription/request',{}),e=>e.status===422);
  await request(admin,'/api/subscription/request',{acceptMonthlyMinor:500});await request(admin,'/api/subscription/request',{acceptMonthlyMinor:500});
  let state=await s.summary('one');assert.equal(state.limit,10*GB);assert.equal(Number((await get('SELECT COUNT(*) n FROM storage_requests')).n),1);
  await assert.rejects(request(admin,'/api/platform/storage/decide',{id:state.pending.id,decision:'approve'}),e=>e.status===403);
  await request(owner,'/api/platform/storage/decide',{id:state.pending.id,decision:'approve'});
  await assert.rejects(request(owner,'/api/platform/storage/decide',{id:state.pending.id,decision:'approve'}),e=>e.status===409);
  state=await s.summary('one');assert.equal(state.limit,30*GB);assert.equal(state.monthlyMinor,9900);assert.equal(state.pending,undefined);
  await request(owner,'/api/platform/subscription-invoice',{action:'create',organizationId:'one',period:'2026-09'});
  await assert.rejects(request(owner,'/api/platform/subscription-invoice',{action:'create',organizationId:'one',period:'2026-09'}),e=>e.status===409);
  const invoice=(await s.summary('one')).invoices[0];await run("UPDATE users SET active=0 WHERE id='staff2'");assert.equal((await s.summary('one')).monthlyMinor,8400);assert.equal((await s.summary('one')).invoices[0].total_minor,9900);
  assert.equal((await request(owner,'/api/subscription',null,'GET')).invoices.length,0);
  await request(owner,'/api/platform/subscription-invoice',{action:'paid',id:invoice.id});assert.equal((await s.summary('one')).invoices[0].status,'paid');
 }finally{await db.close();}
});
