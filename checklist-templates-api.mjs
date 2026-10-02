import {normalizeTemplate,mergeChecklist} from './checklist-templates.mjs';

export function createChecklistTemplates({get,all,run,body,json,fail,roles,property,id,now,audit}){
 const handle=async function handle(req,res,url,user){
  const p=url.pathname, method=req.method;
  if(!p.startsWith('/api/checklist-templates')) return false;
  roles(user,'admin','employee');
  if(p==='/api/checklist-templates'&&method==='GET'){
   const rows=await all("SELECT t.*,v.id version_id,v.version,v.status FROM checklist_templates t LEFT JOIN checklist_template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE t.organization_id=? OR t.is_system=1 ORDER BY t.is_system DESC,t.name",user.organization_id);
   return json(res,200,{templates:rows});
  }
  if(p==='/api/checklist-templates'&&method==='POST'){
   roles(user,'admin');
   const b=await body(req), template=normalizeTemplate(b), key=id(), versionId=id(), timestamp=now();
   await run('INSERT INTO checklist_templates(id,organization_id,name,visit_type,description,is_system,is_default,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',key,user.organization_id,template.name,template.visit_type,template.description,0,b.isDefault?1:0,user.id,timestamp,timestamp);
   await run('INSERT INTO checklist_template_versions(id,template_id,version,status,created_at) VALUES(?,?,?,?,?)',versionId,key,1,'draft',timestamp);
   for(const item of template.items) await run('INSERT INTO checklist_template_items(id,template_version_id,section,label,help_text,response_type,options,required,photo_rule,scope,room_types,sort_order,stable_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),versionId,item.section,item.label,item.help_text,item.response_type,JSON.stringify(item.options),item.required?1:0,item.photo_rule,item.scope,JSON.stringify(item.room_types),item.sort_order,item.stable_key);
   await audit(user,'checklist_template.created',key); return json(res,201,{id:key,version:1});
  }
  const match=p.match(/^\/api\/checklist-templates\/([^/]+)\/(publish|items)$/); if(match){
   const template=await get('SELECT * FROM checklist_templates WHERE id=? AND organization_id=?',match[1],user.organization_id); if(!template)fail(404,'Checklist template not found.');
   if(match[2]==='items'&&method==='GET'){const version=await get('SELECT * FROM checklist_template_versions WHERE template_id=? AND version=?',template.id,template.current_version);const items=await all('SELECT * FROM checklist_template_items WHERE template_version_id=? ORDER BY sort_order,id',version?.id);return json(res,200,{template,items:items.map(i=>({...i,options:JSON.parse(i.options||'[]'),room_types:JSON.parse(i.room_types||'[]')}))});}
   if(match[2]==='publish'&&method==='POST'){roles(user,'admin');await run("UPDATE checklist_template_versions SET status='published',published_at=?,published_by=? WHERE template_id=? AND version=? ",now(),user.id,template.id,template.current_version);await run("UPDATE checklist_templates SET updated_at=? WHERE id=?",now(),template.id);await audit(user,'checklist_template.published',template.id);return json(res,200,{published:true});}
  }
  return false;
 };
 return {handle};
}
