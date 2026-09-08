import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';

// EstateOS uses a private schema, accessed only by the server's connection.
export function postgresSql(sql){
 let n=0;let quoted=false;let result='';
 for(let i=0;i<sql.length;i++){const c=sql[i];if(c==="'"){result+=c;if(quoted&&sql[i+1]==="'"){result+=sql[++i];continue;}quoted=!quoted;}else result+=c==='?'&&!quoted?'$'+(++n):c;}
 if(/^INSERT OR IGNORE /i.test(result))result=result.replace(/^INSERT OR IGNORE /i,'INSERT ')+' ON CONFLICT DO NOTHING';
 return result;
}
export async function openDatabase(root,env=process.env){
 const context=new AsyncLocalStorage();let pool,sqlite,pglite;
 const remote=!!env.DATABASE_URL;
 if(env.RENDER&&!remote)throw Error('DATABASE_URL is required on Render. Refusing to create a temporary database.');
 if(remote){
  const {Pool,types}=await import('pg');
  types.setTypeParser(20,value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw Error('Database integer exceeds safe range');return n;});
  let url;try{url=new URL(env.DATABASE_URL);}catch{throw Error('DATABASE_URL is not a valid PostgreSQL URL.');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.password)throw Error('DATABASE_URL requires a host and database password.');
  // Connection-string SSL options must not override certificate validation.
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
  pool=new Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:15000,idleTimeoutMillis:30000,statement_timeout:30000,ssl:{rejectUnauthorized:true,...(env.DATABASE_CA_CERT?{ca:env.DATABASE_CA_CERT.replaceAll('\\n','\n')}:{})},options:'-c search_path=estateos,pg_catalog'});
  pool.on('error',()=>console.error('Database connection interrupted.'));
 }else if(env.ESTATEOS_TEST_POSTGRES_DIR&&env.NODE_ENV==='test'){
  const {PGlite}=await import('@electric-sql/pglite');pglite=new PGlite(env.ESTATEOS_TEST_POSTGRES_DIR);await pglite.waitReady;
 }else{
  const {DatabaseSync}=await import('node:sqlite');const dir=path.resolve(env.ESTATEOS_DATA_DIR||path.join(root,'data'));fs.mkdirSync(dir,{recursive:true});sqlite=new DatabaseSync(path.join(dir,'estateos.sqlite'));sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 }
 const pg=remote||!!pglite;
 let tail=Promise.resolve();
 async function exclusive(fn){const previous=tail;let release;tail=new Promise(resolve=>release=resolve);await previous;try{return await fn();}finally{release();}}
 async function raw(sql,args=[]){
  const connection=context.getStore();
  if(pg)return (connection||pglite||pool).query(sql,args);
  const statement=sqlite.prepare(sql);return /^\s*(SELECT|WITH)/i.test(sql)?{rows:statement.all(...args)}:{rowCount:statement.run(...args).changes,rows:[]};
 }
 async function transaction(fn){
  if(context.getStore())return fn();
  const perform=async()=>{
   const connection=pool?await pool.connect():pglite||{};
   const execute=sql=>pg?connection.query(sql):sqlite.exec(sql);
   try{await execute(pg?'BEGIN':'BEGIN IMMEDIATE');
    // Serialize business writes across app instances, preserving version checks,
    // first-admin setup and idempotency. Reads do not take this lock.
    if(pool)await execute('SELECT pg_advisory_xact_lock(174902381)');
    const result=await context.run(connection,fn);await execute('COMMIT');return result;
   }catch(error){try{await execute('ROLLBACK');}catch{}throw error;}finally{if(pool)connection.release();}
  };
  return pool?perform():exclusive(perform);
 }
 const query=async(sql,args)=>{
  const perform=()=>raw(pg?postgresSql(sql):sql,args);
  return !pool&&!context.getStore()?exclusive(perform):perform();
 };
 const api={
  kind:pg?'postgres':'sqlite',transaction,
  async get(sql,...args){return (await query(sql,args)).rows[0];},
  async all(sql,...args){return (await query(sql,args)).rows;},
  async run(sql,...args){const r=await query(sql,args);return {changes:r.rowCount||0};},
  async close(){if(pool)await pool.end();if(pglite)await pglite.close();if(sqlite)sqlite.close();}
 };
 try{
 if(pg){
  await transaction(async()=>{
   const conn=context.getStore();
   const exec=sql=>pglite?conn.exec(sql):conn.query(sql);
   await exec('CREATE SCHEMA IF NOT EXISTS estateos; REVOKE ALL ON SCHEMA estateos FROM PUBLIC; SET search_path TO estateos,pg_catalog;');
   await exec(fs.readFileSync(path.join(root,'postgres.sql'),'utf8'));
   for(const migration of fs.readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')).sort()){
    if(!await api.get('SELECT name FROM schema_migrations WHERE name=?',migration)){
     await exec(fs.readFileSync(path.join(root,'migrations',migration),'utf8'));
     await api.run('INSERT INTO schema_migrations VALUES(?,?)',migration,new Date().toISOString());
    }
   }
   await exec('REVOKE ALL ON ALL TABLES IN SCHEMA estateos FROM PUBLIC;');
  });
 }else{
  sqlite.exec(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for(const name of fs.readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')).sort()){
   if(!await api.get('SELECT name FROM schema_migrations WHERE name=?',name))await transaction(async()=>{sqlite.exec(fs.readFileSync(path.join(root,'migrations',name),'utf8'));await api.run('INSERT INTO schema_migrations VALUES(?,?)',name,new Date().toISOString());});
  }
 }
 return api;
 }catch(error){await api.close();throw error;}
}
