import {normalizeTemplate,presetItems} from './checklist-templates.mjs';

const ITEM_COLUMNS='id,template_version_id,section,label,help_text,response_type,options,required,photo_rule,scope,room_types,sort_order,stable_key,alert_on_fail';
const parseItem=i=>({...i,options:JSON.parse(i.options||'[]'),room_types:JSON.parse(i.room_types||'[]'),required:!!Number(i.required),alert_on_fail:!!Number(i.alert_on_fail)});

export function createChecklistTemplates({get,all,run,transaction,body,json,fail,roles,property,id,now,audit}){
 // Run a group of writes atomically when the server provides a transaction helper.
 const atomic=fn=>transaction?transaction(fn):fn();
 const insertItem=(versionId,item,index)=>run(`INSERT INTO checklist_template_items(${ITEM_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),versionId,item.section,item.label,item.help_text,item.response_type,JSON.stringify(item.options),item.required?1:0,item.photo_rule,item.scope,JSON.stringify(item.room_types),index,item.stable_key,item.alert_on_fail?1:0);
 const versionItems=async versionId=>versionId?(await all('SELECT * FROM checklist_template_items WHERE template_version_id=? ORDER BY sort_order,id',versionId)).map(parseItem):[];
 const currentVersion=template=>get('SELECT * FROM checklist_template_versions WHERE template_id=? AND version=?',template.id,template.current_version);
 const latestPublished=template=>get("SELECT * FROM checklist_template_versions WHERE template_id=? AND status='published' ORDER BY version DESC LIMIT 1",template.id);
 const versionInfo=v=>v?{id:v.id,version:v.version,status:v.status,published_at:v.published_at||null}:null;

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
   const b=await body(req), template=normalizeTemplate({...b,items:Array.isArray(b.items)&&b.items.length?b.items:presetItems(b.visit_type)}), key=id(), versionId=id(), timestamp=now();
   await atomic(async()=>{
    await run('INSERT INTO checklist_templates(id,organization_id,name,visit_type,description,is_system,is_default,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',key,user.organization_id,template.name,template.visit_type,template.description,0,b.isDefault?1:0,user.id,timestamp,timestamp);
    await run('INSERT INTO checklist_template_versions(id,template_id,version,status,created_at) VALUES(?,?,?,?,?)',versionId,key,1,'draft',timestamp);
    for(const [index,item] of template.items.entries()) await insertItem(versionId,item,item.sort_order??index);
   });
   await audit(user,'checklist_template.created',key); return json(res,201,{id:key,version:1});
  }
  const match=p.match(/^\/api\/checklist-templates\/([^/]+)\/(publish|items|published|versions)$/); if(match){
   const template=await get('SELECT * FROM checklist_templates WHERE id=? AND organization_id=?',match[1],user.organization_id); if(!template)fail(404,'Checklist template not found.');
   // Editor read: the working (current) version plus the last published version, so the
   // editor can show the Draft/Published state and which items have unpublished edits.
   if(match[2]==='items'&&method==='GET'){
    const version=await currentVersion(template), published=await latestPublished(template);
    return json(res,200,{template,version:versionInfo(version),items:await versionItems(version?.id),published:published?{...versionInfo(published),items:await versionItems(published.id)}:null});
   }
   // Field-facing read: always the last published version, never the draft.
   if(match[2]==='published'&&method==='GET'){
    const published=await latestPublished(template); if(!published)fail(404,'This checklist has not been published yet.');
    return json(res,200,{template:{id:template.id,name:template.name,visit_type:template.visit_type,description:template.description},version:versionInfo(published),items:await versionItems(published.id)});
   }
   if(match[2]==='versions'&&method==='GET'){
    const versions=await all("SELECT v.version,v.status,v.published_at,v.created_at,u.name published_by_name,(SELECT COUNT(*) FROM checklist_template_items i WHERE i.template_version_id=v.id) item_count FROM checklist_template_versions v LEFT JOIN users u ON u.id=v.published_by WHERE v.template_id=? ORDER BY v.version DESC",template.id);
    return json(res,200,{current_version:template.current_version,versions:versions.map(v=>({...v,item_count:Number(v.item_count)}))});
   }
   if(match[2]==='items'&&method==='POST'){
    roles(user,'admin');
    const b=await body(req);let items;
    try{items=Array.isArray(b.items)?b.items:JSON.parse(String(b.itemsJson||'[]'));}catch{fail(422,'Items must be valid JSON.');}
    if(!Array.isArray(items))fail(422,'Items must be an array.');
    // Validate every item (labels, enums, duplicate keys) before touching stored rows.
    let normalized;try{normalized=normalizeTemplate({name:template.name,items}).items;}catch(error){fail(422,error.message);}
    const result=await atomic(async()=>{
     let version=await currentVersion(template);if(!version)fail(404,'Template version not found.');
     if(version.status==='published'){
      // Never edit a published version in place: field staff keep using it until the
      // next publish. Start a new draft version instead.
      const next=Number(template.current_version)+1, versionId=id();
      await run('INSERT INTO checklist_template_versions(id,template_id,version,status,created_at) VALUES(?,?,?,?,?)',versionId,template.id,next,'draft',now());
      await run('UPDATE checklist_templates SET current_version=? WHERE id=?',next,template.id);
      version={id:versionId,version:next,status:'draft'};
     }else{
      await run("UPDATE checklist_template_versions SET status='draft',published_at=NULL,published_by=NULL WHERE id=?",version.id);
      await run('DELETE FROM checklist_template_items WHERE template_version_id=?',version.id);
     }
     for(const [index,item] of normalized.entries()) await insertItem(version.id,item,index);
     await run('UPDATE checklist_templates SET updated_at=? WHERE id=?',now(),template.id);
     return version;
    });
    await audit(user,'checklist_template.updated',template.id);return json(res,200,{saved:true,version:result.version,status:'draft'});
   }
   if(match[2]==='publish'&&method==='POST'){
    roles(user,'admin');
    await run("UPDATE checklist_template_versions SET status='published',published_at=?,published_by=? WHERE template_id=? AND version=? ",now(),user.id,template.id,template.current_version);
    await run("UPDATE checklist_templates SET updated_at=? WHERE id=?",now(),template.id);
    await audit(user,'checklist_template.published',template.id);return json(res,200,{published:true,version:template.current_version});
   }
  }
  return false;
 };
 return {handle};
}
