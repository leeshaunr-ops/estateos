import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {lockFamily,linkAcceptedMember,revokeMemberAccess} from './family-access.mjs';
test('removal revokes only linked family clients and invitations, including changed account emails',async()=>{
 const sql=new DatabaseSync(':memory:');try{
 sql.exec('CREATE TABLE clients(id TEXT,organization_id TEXT,profile TEXT);CREATE TABLE users(id TEXT,organization_id TEXT,client_id TEXT,role TEXT,email TEXT,active INTEGER);CREATE TABLE sessions(user_id TEXT);CREATE TABLE invitations(token_hash TEXT,organization_id TEXT,client_id TEXT,role TEXT,email TEXT,used_at TEXT,expires_at INTEGER)');
 const member={id:'m',email:'person@example.com',invitationIds:['inv']};
 sql.prepare('INSERT INTO clients VALUES(?,?,?)').run('family','org',JSON.stringify({members:[member]}));
 const u=sql.prepare('INSERT INTO users VALUES(?,?,?,?,?,1)');
 u.run('linked','org','family','client','changed@example.com');u.run('other-family','org','other','client','person@example.com');u.run('admin','org','family','admin','person@example.com');u.run('other-org','other','family','client','person@example.com');
 sql.exec("INSERT INTO sessions VALUES('linked'),('other-family'),('admin'),('other-org')");
 const i=sql.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,NULL,999999)');i.run('inv','org','family','client','old@example.com');i.run('other','org','other','client','person@example.com');i.run('staff','org','family','admin','person@example.com');
 const db={run:async(q,...a)=>sql.prepare(q).run(...a),get:async(q,...a)=>sql.prepare(q).get(...a),all:async(q,...a)=>sql.prepare(q).all(...a)};
 assert.equal(await lockFamily(db,'bad','family'),undefined);
 let family=await lockFamily(db,'org','family');
 await linkAcceptedMember(db,{role:'client',token_hash:'inv',email:'old@example.com',organization_id:'org'},'linked',family);
 family=await lockFamily(db,'org','family');const saved=JSON.parse(family.profile).members[0];assert.deepEqual(saved.accessUserIds,['linked']);
 assert.equal(await revokeMemberAccess(db,'org',family,saved),1);
 assert.equal(sql.prepare("SELECT active FROM users WHERE id='linked'").get().active,0);
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id='linked'").get().n,0);
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM users WHERE active=1").get().n,3);
 assert.equal(sql.prepare("SELECT expires_at FROM invitations WHERE token_hash='inv'").get().expires_at,0);
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM invitations WHERE expires_at>0").get().n,2);
 }finally{sql.close();}
});
