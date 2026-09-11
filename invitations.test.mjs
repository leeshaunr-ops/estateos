import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {invitationHistory} from './invitations.mjs';
test('history isolates workspaces, hides tokens and reports lifecycle accurately',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
 db.exec('CREATE TABLE invitations(token_hash TEXT,organization_id TEXT,email TEXT,role TEXT,expires_at INTEGER,used_at TEXT)');
 const insert=db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?)');
 insert.run('secret1','a','pending@example.com','client',2000,null);
 insert.run('secret2','a','expired@example.com','vendor',1000,null);
 insert.run('secret3','a','accepted@example.com','employee',900,'2026-09-11T12:00:00Z');
 insert.run('secret4','b','private@example.com','admin',3000,null);
 db.exec('ALTER TABLE invitations ADD COLUMN client_id TEXT');
 const all=async(sql,...args)=>db.prepare(sql).all(...args);
 const result=await invitationHistory(all,{role:'admin',organization_id:'a'},1000);
 assert.deepEqual(result.map(i=>i.status),['pending','expired','accepted']);
 assert.equal(result.length,3);
 assert.ok(result.every(i=>!('token_hash' in i)&&!('organization_id' in i)));
 assert.equal(result[2].acceptedAt,'2026-09-11T12:00:00Z');
 for(const role of ['employee','client','vendor'])assert.deepEqual(await invitationHistory(()=>{throw Error('must not query');},{role,organization_id:'a'}),[]);
 assert.deepEqual(await invitationHistory(all,{role:'admin',organization_id:'empty'}),[]);
 }finally{db.close();}
});
