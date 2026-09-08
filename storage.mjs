import fs from 'node:fs/promises';
import path from 'node:path';

export async function openStorage(root,env=process.env,fetcher=fetch){
 const cloud=!!env.DATABASE_URL;
 if(cloud){
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_STORAGE_BUCKET)throw Error('Supabase URL, service role key and storage bucket are required with DATABASE_URL.');
  const origin=new URL(env.SUPABASE_URL);if(origin.protocol!=='https:'||origin.username||origin.password)throw Error('SUPABASE_URL must be an HTTPS project URL.');
  const base=origin.origin+'/storage/v1',bucket=encodeURIComponent(env.SUPABASE_STORAGE_BUCKET);
  const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY};
  async function request(url,options={}){const res=await fetcher(base+url,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(30000)});if(!res.ok)throw Object.assign(Error('Private file storage request failed ('+res.status+').'),{status:502});return res;}
  const metadata=await (await request('/bucket/'+bucket)).json();if(metadata.public!==false)throw Error('The EstateOS storage bucket must be private.');
  const object=key=>'/object/'+bucket+'/'+encodeURIComponent(key);
  return {kind:'supabase',async read(key){return Buffer.from(await (await request(object(key))).arrayBuffer());},async write(key,bytes,mime){await request(object(key),{method:'POST',headers:{'Content-Type':mime,'x-upsert':'false'},body:bytes});},async remove(key){await request('/object/'+bucket,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[key]})});}};
 }
 const directory=path.join(path.resolve(env.ESTATEOS_DATA_DIR||path.join(root,'data')),'files');await fs.mkdir(directory,{recursive:true});
 function filename(key){if(!/^[a-zA-Z0-9-]+$/.test(key))throw Error('Invalid storage key');return path.join(directory,key);}
 return {kind:'local',read:key=>fs.readFile(filename(key)),write:(key,bytes)=>fs.writeFile(filename(key),bytes,{flag:'wx'}),remove:key=>fs.unlink(filename(key))};
}
