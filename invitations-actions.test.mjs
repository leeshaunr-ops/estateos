import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {invitationHistory,cancelInvitation,claimInvitation} from './invitations.mjs';
test('cancellation is scoped and prevents acceptance, while accepted invitations cannot be cancelled',async()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE invitations(token_hash TEXT,organization_id TEXT,email TEXT,role TEXT,expires_at INTEGER,used_at TEXT)');
 const add=db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?)');
 for(const id of ['cancel','accept','foreign','expired'])add.run(id,id==='foreign'?'b':'a',id+'@example.com','client',id==='expired'?1000:2000,null);
 db.exec('ALTER TABLE invitations ADD COLUMN client_id TEXT');
 const all=async(sql,...args)=>db.prepare(sql).all(...args);
 const run=async(sql,...args)=>db.prepare(sql).run(...args);
 const admin={role:'admin',organization_id:'a'};
 assert.equal(await cancelInvitation(run,admin,'foreign',1000),false);
 assert.equal(await cancelInvitation(run,{...admin,role:'client'},'cancel',1000),false);
 assert.equal(await cancelInvitation(run,admin,'expired',1000),false);
 assert.equal(await cancelInvitation(run,admin,'cancel',1000),true);
 assert.equal(await claimInvitation(run,'cancel','accepted',1000),false);
 assert.equal(await claimInvitation(run,'accept','accepted',1000),true);
 assert.equal(await cancelInvitation(run,admin,'accept',1000),false);
 assert.equal(await claimInvitation(run,'accept','accepted',1000),false);
 const rows=await invitationHistory(all,admin,1000);
 assert.equal(rows.find(i=>i.id==='cancel').status,'cancelled');
 assert.equal(rows.find(i=>i.id==='accept').status,'accepted');
 assert.equal(rows.find(i=>i.id==='expired').status,'expired');
 assert.equal(rows.length,3);
 assert.deepEqual(await invitationHistory(all,{...admin,role:'employee'},1000),[]);
 }finally{db.close();}
});
