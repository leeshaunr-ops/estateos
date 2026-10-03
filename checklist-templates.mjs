import {readFileSync} from 'node:fs';
export const RESPONSE_TYPES = new Set(['pass_fail_na','yes_no','rating','text','number','select','multi_select']);
export const PHOTO_RULES = new Set(['none','optional','required_on_fail']);
export const VISIT_TYPES = new Set(['routine','arrival','departure','seasonal','maintenance','pre_storm','post_storm','custom']);
// Display names for visit types (kept in sync with public/checklist-editor-model.mjs VISIT_TYPES).
export const VISIT_TYPE_LABELS={routine:'Routine',arrival:'Arrival',departure:'Departure',seasonal:'Seasonal',maintenance:'Maintenance',pre_storm:'Hurricane prep',post_storm:'Post-storm',custom:'Custom'};

// Storm starter sets. Object form so each item can carry help text, required and alert flags.
// Only existing enums are used: photo rules none | optional | required_on_fail (there is no
// "always required" photo rule, so documentation items ask for photos with an optional photo
// and say so in the help text).
const pf=(section,label,help_text,extra={})=>({section,label,help_text,response_type:'pass_fail_na',photo_rule:'required_on_fail',required:true,alert_on_fail:false,...extra});
const STORM_PREP=[
 pf('Exterior & yard','Outdoor furniture, planters, grills and decor brought in or tied down','Anything that could become airborne goes inside the garage or house, or is strapped down. Photograph anything left outside.'),
 pf('Exterior & yard','Loose debris, branches and yard items cleared','Check the yard, driveway, roof edges and lanai for anything loose.'),
 pf('Exterior & yard','Trees and limbs near the house or lines checked','Mark Fail and photograph any limb overhanging the roof, pool enclosure or power lines so the office can arrange trimming.'),
 pf('Exterior & yard','Gutters, downspouts and yard drains clear','Clear leaves and debris so water can drain away from the house.'),
 pf('Exterior & yard','Trash and recycling bins secured','Bring bins into the garage or strap them down.'),
 pf('Openings & protection','Shutters or panels installed on all openings','Check every window, door and skylight on the protection plan. Photograph any opening that is not protected.',{alert_on_fail:true}),
 pf('Openings & protection','Impact windows and doors closed and latched','Confirm every impact window and door is fully closed and locked.'),
 pf('Openings & protection','Garage door secured or braced','Lock the door and install the brace if the residence has one.'),
 pf('Openings & protection','Gates, sheds and pool equipment rooms locked',''),
 pf('Pool','Pool water level lowered per policy','Follow the residence\'s pool policy. Never drain the pool completely.'),
 pf('Pool','Pool pump and heater breakers turned off',''),
 pf('Pool','Pool cover and pool furniture secured','Secure or remove a loose cover. Store or sink pool furniture per owner instructions.'),
 pf('Interior','Valuables, electronics and documents off the floor and away from windows','Move items to an interior room or upper shelves.'),
 pf('Interior','Interior doors closed and blinds lowered','',{photo_rule:'none'}),
 pf('Interior','Towels or sandbags placed at leak-prone doors','Focus on doors and sliders that have leaked before.'),
 pf('Interior','Refrigerator and freezer set per owner instructions','Coldest setting, emptied, or left as is, as the owner has asked.'),
 pf('Utilities & systems','Main water and water heater turned off if the residence is vacant','Mark N/A only if the residence will be occupied through the storm.',{alert_on_fail:true}),
 pf('Utilities & systems','Non-essential electronics unplugged','',{photo_rule:'none'}),
 pf('Utilities & systems','Sump pump tested','Pour water into the pit and confirm the pump starts and drains it.'),
 pf('Utilities & systems','Generator tested','Run the generator and confirm it starts and transfers power.',{alert_on_fail:true}),
 {section:'Utilities & systems',label:'Generator fuel level (% of tank)',help_text:'Enter the fuel or propane level as a percentage. Use 0 if there is no generator.',response_type:'number',photo_rule:'none',required:true,alert_on_fail:false},
 pf('Utilities & systems','HVAC and dehumidifier set to the agreed setting',''),
 pf('Utilities & systems','Gas or propane turned off if required','Follow the owner\'s or utility\'s instructions. Mark N/A if it should stay on.'),
 pf('Vehicles & boats','Vehicles and boats secured or moved','Garage vehicles, move boats to the agreed location or double the lines. Note where each one is.'),
 {section:'Documentation',label:'Full photo walk-through of every room and the exterior',help_text:'Photograph every room, each side of the exterior and the shutters in place. This is the before-storm record for insurance.',response_type:'yes_no',photo_rule:'optional',required:true,alert_on_fail:false},
 pf('Documentation','Alarm set and monitoring company has an emergency contact','Confirm the monitoring company has a reachable contact for the storm.',{alert_on_fail:true}),
 {section:'Documentation',label:'Owner notes',help_text:'Anything the owner or office should know before the storm.',response_type:'text',photo_rule:'none',required:false,alert_on_fail:false}
];
const POST_STORM=[
 pf('Safety first','Safe to enter: no downed lines, gas smell or structural danger','If you see downed power lines, smell gas or see structural damage, do not enter. Mark Fail, move to safety and call the office and 911 or the utility.',{alert_on_fail:true}),
 pf('Exterior damage','Roof intact: no missing shingles or tiles','Check from the ground. Photograph any damage.',{alert_on_fail:true}),
 pf('Exterior damage','Siding, soffits and fascia intact',''),
 pf('Exterior damage','Windows and doors intact: no broken glass or forced openings','',{alert_on_fail:true}),
 pf('Exterior damage','Fences and gates intact',''),
 pf('Exterior damage','No fallen trees or limbs on structures','Photograph any tree or limb touching the house, pool enclosure or lines.',{alert_on_fail:true}),
 pf('Exterior damage','Pool and screen enclosure intact','Check the screens, frame and pool for debris or damage.'),
 pf('Exterior damage','No flooding or standing water around the residence','',{alert_on_fail:true}),
 pf('Interior','No water intrusion at windows, doors or walls','',{alert_on_fail:true}),
 pf('Interior','No new ceiling stains or leaks',''),
 pf('Interior','Flooring dry and undamaged',''),
 pf('Interior','No mold or musty odor',''),
 {section:'Utilities',label:'Power restored',help_text:'Answer No if the residence is still without utility power.',response_type:'yes_no',photo_rule:'none',required:true,alert_on_fail:false},
 pf('Utilities','Main water and water heater turned back on','Turn water back on only after checking for leaks. Mark N/A if they were left on.'),
 pf('Utilities','HVAC running and holding temperature',''),
 pf('Utilities','Refrigerator and freezer checked for spoilage','Discard spoiled food per owner instructions and photograph it.'),
 pf('Utilities','Generator running normally or shut down safely','Mark N/A if the residence has no generator.'),
 {section:'Utilities',label:'Generator fuel level (% of tank)',help_text:'Enter the fuel or propane level as a percentage. Use 0 if there is no generator.',response_type:'number',photo_rule:'none',required:true,alert_on_fail:false},
 pf('Storm protection','Shutters or panels removed if instructed','Only remove protection when the owner or office asks. Mark N/A if it stays up.'),
 {section:'Documentation',label:'Full photo walk-through of every room and the exterior',help_text:'Photograph every room and each side of the exterior, including any damage, before anything is cleaned up.',response_type:'yes_no',photo_rule:'optional',required:true,alert_on_fail:false},
 {section:'Documentation',label:'Insurance-ready damage notes',help_text:'Describe each damaged area, where it is and roughly how big it is. Reference the photos you took.',response_type:'text',photo_rule:'optional',required:false,alert_on_fail:false},
 {section:'Documentation',label:'Owner notes',help_text:'Anything the owner or office should know after the storm.',response_type:'text',photo_rule:'none',required:false,alert_on_fail:false}
];
export const PRESET_ITEMS={
 routine:[['Exterior','Walk the exterior for visible damage or hazards.','pass_fail_na','required_on_fail','property'],['Interior','Confirm the residence is clean and orderly.','pass_fail_na','required_on_fail','property'],['Systems','Check that essential systems appear operational.','pass_fail_na','required_on_fail','property'],['Safety','Check doors, windows, alarms, and visible safety concerns.','pass_fail_na','required_on_fail','property'],['Notes','Record anything the team should follow up on.','text','optional','property']],
 arrival:[['Arrival','Confirm the residence is ready for the client arrival.','pass_fail_na','required_on_fail','property'],['Climate','Confirm temperature and climate settings are comfortable.','number','optional','property'],['Supplies','Confirm requested groceries and supplies are in place.','pass_fail_na','required_on_fail','property'],['Rooms','Confirm assigned rooms are prepared.','pass_fail_na','required_on_fail','room'],['Welcome','Record any arrival notes for the team.','text','optional','property']],
 departure:[['Departure','Confirm the residence has been vacated and secured.','pass_fail_na','required_on_fail','property'],['Damage','Check for new damage or unusual conditions.','pass_fail_na','required_on_fail','property'],['Utilities','Confirm lights, water, climate, and appliances are set appropriately.','pass_fail_na','required_on_fail','property'],['Security','Confirm doors, windows, gates, and alarms are secured.','pass_fail_na','required_on_fail','property'],['Notes','Record departure follow-up items.','text','optional','property']],
 seasonal:[['Exterior','Check exterior surfaces, landscaping, and drainage.','pass_fail_na','required_on_fail','property'],['Weather','Check weather-related risks and protection measures.','pass_fail_na','required_on_fail','property'],['Equipment','Check seasonal equipment and service needs.','pass_fail_na','required_on_fail','property'],['Interior','Check for humidity, leaks, pests, or other seasonal concerns.','pass_fail_na','required_on_fail','property'],['Notes','Record seasonal recommendations.','text','optional','property']],
 maintenance:[['Inspection','Check the condition of the scheduled maintenance area.','pass_fail_na','required_on_fail','property'],['Reading','Record the relevant meter or equipment reading.','number','optional','property'],['Service','Confirm the service was completed as expected.','pass_fail_na','required_on_fail','property'],['Photo evidence','Add a photo when the work needs documentation.','pass_fail_na','required_on_fail','property'],['Follow-up','Record parts, recommendations, or next steps.','text','optional','property']],
 pre_storm:STORM_PREP,
 post_storm:POST_STORM,
 custom:[]
};
// Legacy tuple keys keep their original format so templates created before stay comparable.
const presetKey=(section,label,trim)=>{const key=String(section+'-'+label).toLowerCase().replace(/[^a-z0-9]+/g,'-');return trim?key.replace(/^-|-$/g,''):key;};
// Starter items for a visit type. Legacy presets are tuples; storm presets are objects.
export function presetItems(visitType){return (PRESET_ITEMS[visitType]||[]).map((entry,index)=>{
 const item=Array.isArray(entry)?(([section,label,response_type,photo_rule,scope])=>({section,label,response_type,photo_rule,scope,required:response_type!=='text'}))(entry):{...entry};
 return normalizeItem({...item,stable_key:presetKey(item.section,item.label,!Array.isArray(entry)),sort_order:index});
});}
// The built-in standard checklist (inspection-template.json) as an editable "Routine visit" starter. It is the
// same checklist a visit falls back to when the company has no published template for the visit type. Item keys
// are the built-in keys (and condition / readiness / fixtures for the per-room checks), so a template made from it
// lines up with past built-in visits ("Last visit" hints, follow-ups). Template pass/fail items answer
// Pass / Monitor / Fail / N/A, the built-in Pass / Monitor / Attention / N/A scale with Fail for Attention.
const BUILT_IN_CHECKLIST=JSON.parse(readFileSync(new URL('./inspection-template.json',import.meta.url),'utf8'));
const ROOM_CHECKS=[['condition','Overall condition'],['readiness','Cleanliness and readiness'],['fixtures','Fixtures and equipment']];
export function standardRoutineItems(){
 const items=BUILT_IN_CHECKLIST.map(a=>({stable_key:a.key,section:a.section,label:a.label,help_text:'',response_type:'pass_fail_na',photo_rule:'optional',required:true,alert_on_fail:false,scope:'property'}));
 items.push(...ROOM_CHECKS.map(([stable_key,label])=>({stable_key,section:'Rooms & spaces',label,help_text:'Checked once for every room on the residence profile.',response_type:'pass_fail_na',photo_rule:'optional',required:true,alert_on_fail:false,scope:'room'})));
 return items.map((item,index)=>normalizeItem({...item,sort_order:index}));
}
// Starter sets for the editor's "Load starter items", in display order: the standard Routine visit checklist first,
// then every visit type that has starter items. `key` identifies a set; `visit_type` is the type it suits.
export function starterSets(){return [{key:'routine_standard',visit_type:'routine',label:'Routine visit',description:'The standard built-in checklist',items:standardRoutineItems()},...[...VISIT_TYPES].filter(type=>(PRESET_ITEMS[type]||[]).length).map(visit_type=>({key:visit_type,visit_type,label:visit_type==='routine'?'Routine (short)':VISIT_TYPE_LABELS[visit_type],items:presetItems(visit_type)}))];}


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
 item.alert_on_fail=!!item.alert_on_fail;
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
 if(item.response_type==='pass_fail_na'&&!['pass','monitor','fail','na'].includes(value))return{ok:false,error:'Expected pass, monitor, fail, or na'};
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
