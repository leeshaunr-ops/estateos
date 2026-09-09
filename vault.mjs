import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
function key(){
 const value=process.env.ESTATEOS_VAULT_KEY||'';
 const decoded=Buffer.from(value,'base64');
 if(decoded.length!==32||decoded.toString('base64')!==value)throw Object.assign(Error('Access & codes needs its encryption key configured by the administrator.'),{status:503});
 return decoded;
}
export function seal(value,context){
 return encrypt(value,context);
}
function encrypt(value,context){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),nonce);
 cipher.setAAD(Buffer.from(context));
 const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return JSON.stringify({v:1,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:bytes.toString('base64')});
}
export function unseal(value,context){
 const secret=key();if(!value)return {};
 try{
  const row=JSON.parse(value);
  if(row.v!==1)throw Error();
  const cipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(row.nonce,'base64'));
  cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(row.tag,'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.data,'base64')),cipher.final()]).toString('utf8'));
 }catch{throw Object.assign(Error('Could not unlock access details. Ask the administrator to verify the original encryption key.'),{status:503});}
}
