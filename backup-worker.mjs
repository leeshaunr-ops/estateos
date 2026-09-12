import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {backup} from './recovery.mjs';
export function createBackupWorker({get,run,transaction,putBytes,readBytes,deleteBytes},env=process.env,archive=backup){let busy=false;
 async function tick(){if(busy||!env.DATABASE_URL||!env.ESTATEOS_VAULT_KEY)return;busy=true;let temp;const day=new Date().toISOString().slice(0,10),stamp=new Date().toISOString(),key='instance-backup-'+day+'-'+randomUUID();try{
  const claimed=await transaction(async()=>{const old=await get('SELECT * FROM backup_runs WHERE day=?',day);if(old?.status==='complete'||old&&Date.now()-Date.parse(old.started_at)<3600000)return false;await run("INSERT INTO backup_runs(day,status,started_at) VALUES(?,'running',?) ON CONFLICT(day) DO UPDATE SET status='running',started_at=excluded.started_at,error=''",day,stamp);return true;});if(!claimed)return;
  temp=path.join(os.tmpdir(),'estateaegis-backup-'+randomUUID()+'.eab');await archive(temp,env);const stat=await fs.stat(temp);if(stat.size>64*1024*1024)throw Error('Archive exceeds the 64 MB in-process limit; configure a dedicated backup job.');const bytes=await fs.readFile(temp);await putBytes(key,bytes,'application/octet-stream');
  await run("UPDATE backup_runs SET status='complete',completed_at=?,storage_key=?,error='' WHERE day=?",new Date().toISOString(),key,day);
  try{if(deleteBytes){const cutoff=new Date(Date.now()-7*86400000).toISOString().slice(0,10);const expired=await get("SELECT day,storage_key FROM backup_runs WHERE day<? AND status='complete' ORDER BY day LIMIT 1",cutoff);if(expired?.storage_key?.startsWith('instance-backup-')){await deleteBytes(expired.storage_key);await run("UPDATE backup_runs SET status='expired' WHERE day=?",expired.day);}}}catch(error){console.error('Backup retention:',error.message);}
 }catch(error){await run("UPDATE backup_runs SET status='failed',error=? WHERE day=?",String(error.message).slice(0,300),day).catch(()=>{});console.error('Encrypted backup:',error.message);}finally{if(temp)await fs.unlink(temp).catch(()=>{});busy=false;}}
 return {tick};
}
