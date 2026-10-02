export const RESPONSE_TYPES = new Set(['pass_fail_na','yes_no','rating','text','number','select','multi_select']);
export const PHOTO_RULES = new Set(['none','optional','required_on_fail']);
export const VISIT_TYPES = new Set(['routine','arrival','departure','seasonal','maintenance','custom']);

export function normalizeItem(input, index=0){
 const item={...input};
 if(!item.stable_key) item.stable_key=String(item.label||'item-'+index).toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'item-'+index;
 item.section=String(item.section||'General').trim();
 item.label=String(item.label||'').trim();
 item.help_text=String(item.help_text||'').trim();
 item.response_type=RESPONSE_TYPES.has(item.response_type)?item.response_type:'pass_fail_na';
 item.photo_rule=PHOTO_RULES.has(item.photo_rule)?item.photo_rule:'optional';
 item.options=Array.isArray(item.options)?item.options.map(String):[];
 item.room_types=Array.isArray(item.room_types)?item.room_types.map(String):[];
 item.required=!!item.required;
 item.scope=item.scope==='room'?'room':'property';
 item.sort_order=Number.isFinite(Number(item.sort_order))?Number(item.sort_order):index;
 if(!item.label) throw new Error('Checklist item label is required');
 return item;
}
export function normalizeTemplate(input){
 const template={...input};
 template.name=String(template.name||'').trim();
 if(!template.name) throw new Error('Template name is required');
 template.visit_type=VISIT_TYPES.has(template.visit_type)?template.visit_type:'custom';
 template.description=String(template.description||'').trim();
 template.items=(Array.isArray(template.items)?template.items:[]).map(normalizeItem);
 const seen=new Set();
 for(const item of template.items){if(seen.has(item.stable_key))throw new Error('Duplicate checklist item key: '+item.stable_key);seen.add(item.stable_key);}
 return template;
}
export function mergeChecklist(template, settings={}){
 const hidden=new Set(Array.isArray(settings.hidden_item_keys)?settings.hidden_item_keys:[]);
 const additions=Array.isArray(settings.added_items)?settings.added_items.map(normalizeItem):[];
 const base=(template.items||[]).map(normalizeItem).filter(item=>!hidden.has(item.stable_key));
 return [...base,...additions].sort((a,b)=>a.sort_order-b.sort_order||a.section.localeCompare(b.section));
}
export function validateAnswer(item, value){
 if(value===null||value===undefined||value==='') return item.required?{ok:false,error:'Answer is required'}:{ok:true};
 if(item.response_type==='pass_fail_na'&&!['pass','fail','na'].includes(value))return{ok:false,error:'Expected pass, fail, or na'};
 if(item.response_type==='yes_no'&&!['yes','no'].includes(value))return{ok:false,error:'Expected yes or no'};
 if(['rating','number'].includes(item.response_type)&&(!Number.isFinite(Number(value))))return{ok:false,error:'Expected a number'};
 if(['select','multi_select'].includes(item.response_type)){const values=item.response_type==='multi_select'?(Array.isArray(value)?value:[value]):[value];if(values.some(v=>!item.options.includes(String(v))))return{ok:false,error:'Answer is not an available option'};}
 return{ok:true};
}
export function validateSubmission(items, answers={}){
 const errors=[];
 for(const item of items){const result=validateAnswer(item,answers[item.stable_key]);if(!result.ok)errors.push({stable_key:item.stable_key,error:result.error});}
 return {ok:errors.length===0,errors};
}
