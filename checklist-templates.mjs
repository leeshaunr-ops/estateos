export const RESPONSE_TYPES = new Set(['pass_fail_na','yes_no','rating','text','number','select','multi_select']);
export const PHOTO_RULES = new Set(['none','optional','required_on_fail']);
export const VISIT_TYPES = new Set(['routine','arrival','departure','seasonal','maintenance','custom']);
export const PRESET_ITEMS={
 routine:[['Exterior','Walk the exterior for visible damage or hazards.','pass_fail_na','required_on_fail','property'],['Interior','Confirm the residence is clean and orderly.','pass_fail_na','required_on_fail','property'],['Systems','Check that essential systems appear operational.','pass_fail_na','required_on_fail','property'],['Safety','Check doors, windows, alarms, and visible safety concerns.','pass_fail_na','required_on_fail','property'],['Notes','Record anything the team should follow up on.','text','optional','property']],
 arrival:[['Arrival','Confirm the residence is ready for the client arrival.','pass_fail_na','required_on_fail','property'],['Climate','Confirm temperature and climate settings are comfortable.','number','optional','property'],['Supplies','Confirm requested groceries and supplies are in place.','pass_fail_na','required_on_fail','property'],['Rooms','Confirm assigned rooms are prepared.','pass_fail_na','required_on_fail','room'],['Welcome','Record any arrival notes for the team.','text','optional','property']],
 departure:[['Departure','Confirm the residence has been vacated and secured.','pass_fail_na','required_on_fail','property'],['Damage','Check for new damage or unusual conditions.','pass_fail_na','required_on_fail','property'],['Utilities','Confirm lights, water, climate, and appliances are set appropriately.','pass_fail_na','required_on_fail','property'],['Security','Confirm doors, windows, gates, and alarms are secured.','pass_fail_na','required_on_fail','property'],['Notes','Record departure follow-up items.','text','optional','property']],
 seasonal:[['Exterior','Check exterior surfaces, landscaping, and drainage.','pass_fail_na','required_on_fail','property'],['Weather','Check weather-related risks and protection measures.','pass_fail_na','required_on_fail','property'],['Equipment','Check seasonal equipment and service needs.','pass_fail_na','required_on_fail','property'],['Interior','Check for humidity, leaks, pests, or other seasonal concerns.','pass_fail_na','required_on_fail','property'],['Notes','Record seasonal recommendations.','text','optional','property']],
 maintenance:[['Inspection','Check the condition of the scheduled maintenance area.','pass_fail_na','required_on_fail','property'],['Reading','Record the relevant meter or equipment reading.','number','optional','property'],['Service','Confirm the service was completed as expected.','pass_fail_na','required_on_fail','property'],['Photo evidence','Add a photo when the work needs documentation.','pass_fail_na','required_on_fail','property'],['Follow-up','Record parts, recommendations, or next steps.','text','optional','property']],
 custom:[]
};
export function presetItems(visitType){return (PRESET_ITEMS[visitType]||[]).map(([section,label,response_type,photo_rule,scope],index)=>normalizeItem({section,label,response_type,photo_rule,scope,required:response_type!=='text',stable_key:String(section+'-'+label).toLowerCase().replace(/[^a-z0-9]+/g,'-'),sort_order:index}));}


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
