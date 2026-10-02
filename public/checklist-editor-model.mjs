// Pure, DOM-free helpers for the checklist template editor.
// Imported by public/checklist-editor.mjs in the browser and by tests in Node.

// Existing enum values (see checklist-templates.mjs RESPONSE_TYPES / PHOTO_RULES).
export const ANSWER_TYPES=[
 {value:'pass_fail_na',label:'Pass / Fail',icon:'checkCircle'},
 {value:'yes_no',label:'Yes / No',icon:'toggle'},
 {value:'number',label:'Number',icon:'hash'},
 {value:'text',label:'Text',icon:'type'},
 {value:'rating',label:'Rating',icon:'star'}
];
export const CHOICE_TYPES=[
 {value:'select',label:'Single choice',icon:'listOne'},
 {value:'multi_select',label:'Multiple choice',icon:'listChecks'}
];
export const ALL_TYPES=[...ANSWER_TYPES,...CHOICE_TYPES];
// "always" is in the reference design but has no backend enum value, so it is shown disabled.
export const PHOTO_RULES=[
 {value:'none',label:'No photo',desc:'Not needed',icon:'cameraOff',chip:''},
 {value:'optional',label:'Optional',desc:'Tech may attach one',icon:'imagePlus',chip:'Photo optional'},
 {value:'required_on_fail',label:'Required on fail',desc:'Only if marked Fail',icon:'alert',chip:'Photo on fail'},
 {value:'always',label:'Always required',desc:'Not available yet',icon:'camera',chip:'',unsupported:true}
];
// Visit types (same values as checklist-templates.mjs VISIT_TYPES). Icons are editor icon names.
export const VISIT_TYPES=[
 {value:'routine',label:'Routine',icon:'home'},
 {value:'arrival',label:'Arrival',icon:'logIn'},
 {value:'departure',label:'Departure',icon:'logOut'},
 {value:'seasonal',label:'Seasonal',icon:'trees'},
 {value:'maintenance',label:'Maintenance',icon:'wrench'},
 {value:'pre_storm',label:'Hurricane prep',icon:'storm'},
 {value:'post_storm',label:'Post-storm',icon:'cloudSun'},
 {value:'custom',label:'Custom',icon:'layers'}
];
export const visitType=value=>VISIT_TYPES.find(t=>t.value===value)||VISIT_TYPES.at(-1);
export const LABEL_MAX=160;
export const COMPARE_FIELDS=['section','label','help_text','response_type','options','required','photo_rule','scope','room_types','alert_on_fail'];

let uidCounter=0;
export const newUid=()=>'ce'+(++uidCounter).toString(36)+Math.random().toString(36).slice(2,7);
export const slug=text=>String(text||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

export function uniqueKey(label,existing){
 const taken=existing instanceof Set?existing:new Set(existing||[]);
 const base=(slug(label)||'item').slice(0,48);
 let key=base,n=2;
 while(taken.has(key))key=base+'-'+(n++);
 return key;
}

const list=v=>Array.isArray(v)?v.map(x=>String(x)):(typeof v==='string'&&v.trim()?(()=>{try{const p=JSON.parse(v);return Array.isArray(p)?p.map(String):[];}catch{return [];}})():[]);
const bool=v=>v===true||v===1||v==='1'||v==='true';

/** Normalize API rows into editor items (adds a client-only uid) and makes sections contiguous. */
export function fromApi(rows){
 const items=(rows||[]).slice().sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)).map((r,i)=>({
  uid:newUid(),
  stable_key:String(r.stable_key||''),
  section:String(r.section||'General').trim()||'General',
  label:String(r.label||''),
  help_text:String(r.help_text||''),
  response_type:String(r.response_type||'pass_fail_na'),
  options:list(r.options),
  required:bool(r.required),
  photo_rule:String(r.photo_rule||'optional'),
  scope:r.scope==='room'?'room':'property',
  room_types:list(r.room_types),
  alert_on_fail:bool(r.alert_on_fail),
  sort_order:i
 }));
 const keys=new Set();
 for(const item of items){if(!item.stable_key||keys.has(item.stable_key))item.stable_key=uniqueKey(item.label,keys);keys.add(item.stable_key);}
 return flatten(groupSections(items));
}

/** Sections in order of first appearance, each with all of its items. */
export function groupSections(items){
 const map=new Map();
 for(const item of items){const name=item.section||'General';if(!map.has(name))map.set(name,{name,items:[]});map.get(name).items.push(item);}
 return [...map.values()];
}
export function flatten(groups){
 const out=[];let i=0;
 for(const g of groups)for(const item of g.items)out.push({...item,section:g.name,sort_order:i++});
 return out;
}
export const sectionNames=items=>groupSections(items).map(g=>g.name);

/** Move an item to a section at a position (index within the destination section's items, after removal). */
export function moveItem(items,uid,toSection,toIndex){
 const item=items.find(x=>x.uid===uid);if(!item)return items;
 const groups=groupSections(items.filter(x=>x.uid!==uid));
 let g=groups.find(x=>x.name===toSection);
 if(!g){g={name:toSection,items:[]};groups.push(g);}
 const at=Math.max(0,Math.min(toIndex??g.items.length,g.items.length));
 g.items.splice(at,0,{...item,section:toSection});
 return flatten(groups);
}

/** Keyboard reordering: move up/down one slot, crossing into the neighbouring section at the edges. */
export function moveItemBy(items,uid,delta){
 const groups=groupSections(items);
 const gi=groups.findIndex(g=>g.items.some(x=>x.uid===uid));if(gi<0)return items;
 const g=groups[gi], idx=g.items.findIndex(x=>x.uid===uid), target=idx+delta;
 if(target>=0&&target<g.items.length)return moveItem(items,uid,g.name,target);
 const ng=groups[gi+(delta<0?-1:1)];if(!ng)return items;
 return moveItem(items,uid,ng.name,delta<0?ng.items.length:0);
}

export function moveSection(items,name,toIndex){
 const groups=groupSections(items), from=groups.findIndex(g=>g.name===name);if(from<0)return items;
 const [g]=groups.splice(from,1);groups.splice(Math.max(0,Math.min(toIndex,groups.length)),0,g);
 return flatten(groups);
}
export function moveSectionBy(items,name,delta){
 const idx=sectionNames(items).indexOf(name);if(idx<0)return items;
 return moveSection(items,name,idx+delta);
}
export function renameSection(items,from,to){
 const name=String(to||'').trim();
 if(!name)throw Error('Section name is required.');
 if(name!==from&&sectionNames(items).includes(name))throw Error('A section with that name already exists.');
 return items.map(x=>x.section===from?{...x,section:name}:x);
}
export const deleteSection=(items,name)=>flatten(groupSections(items.filter(x=>x.section!==name)));

export function blankItem(section,items){
 return {uid:newUid(),stable_key:uniqueKey('item-'+Math.random().toString(36).slice(2,8),new Set(items.map(x=>x.stable_key))),section,label:'',help_text:'',response_type:'pass_fail_na',options:[],required:false,photo_rule:'none',scope:'property',room_types:[],alert_on_fail:false,sort_order:0};
}
/** Append a blank item to a section (or after a given item). Returns {items, uid}. */
export function addItem(items,section,afterUid=null){
 const item=blankItem(section,items);
 const groups=groupSections(items);
 let g=groups.find(x=>x.name===section);if(!g){g={name:section,items:[]};groups.push(g);}
 const after=afterUid?g.items.findIndex(x=>x.uid===afterUid):-1;
 g.items.splice(after>=0?after+1:g.items.length,0,item);
 return {items:flatten(groups),uid:item.uid};
}
export function duplicateItem(items,uid){
 const src=items.find(x=>x.uid===uid);if(!src)return {items,uid:null};
 const keys=new Set(items.map(x=>x.stable_key));
 const copy={...src,uid:newUid(),stable_key:uniqueKey(src.label+'-copy',keys),options:[...src.options],room_types:[...src.room_types]};
 const groups=groupSections(items), g=groups.find(x=>x.name===src.section);
 g.items.splice(g.items.findIndex(x=>x.uid===uid)+1,0,copy);
 return {items:flatten(groups),uid:copy.uid};
}
export const deleteItem=(items,uid)=>flatten(groupSections(items.filter(x=>x.uid!==uid)));
export function updateItem(items,uid,patch){
 let changed=false;
 const next=items.map(x=>{if(x.uid!==uid)return x;changed=true;return {...x,...patch};});
 if(!changed)return items;
 // A section change moves the item to the end of its new section.
 if(patch.section!==undefined){const item=next.find(x=>x.uid===uid);return moveItem(next,uid,item.section,Infinity);}
 return next;
}
export function newSectionName(items,base='New section'){
 const names=new Set(sectionNames(items));let name=base,n=2;
 while(names.has(name))name=base+' '+(n++);
 return name;
}

/**
 * Starter items for "Load starter items". Converts a starter set's items (API rows) into editor
 * items with stable keys that don't collide with the current checklist.
 * mode 'replace' discards the current items; 'append' adds the starter items after them
 * (an item joins an existing section when the section names match).
 * Returns {items, added:[uid...]}.
 */
export function loadStarterItems(current,starterRows,mode='replace'){
 const keep=mode==='append'?current:[];
 const taken=new Set(keep.map(x=>x.stable_key));
 const fresh=fromApi(starterRows).map(item=>{const stable_key=taken.has(item.stable_key)?uniqueKey(item.stable_key,taken):item.stable_key;taken.add(stable_key);return {...item,stable_key};});
 return {items:flatten(groupSections([...keep,...fresh])),added:fresh.map(x=>x.uid)};
}

/**
 * Which starter set to pre-select: the template's own visit type when it is a storm type,
 * then a storm set when the name mentions a storm (e.g. "Hurricane checklist" saved as Seasonal),
 * then the template's own visit type, then the first set.
 */
export function suggestStarter(template,sets){
 const has=type=>sets.some(s=>s.visit_type===type);
 const type=template?.visit_type, name=String(template?.name||'');
 if((type==='pre_storm'||type==='post_storm')&&has(type))return type;
 if(/hurric|storm|tropical|cyclone|typhoon/i.test(name)){const post=/post|after|recover|damage/i.test(name)?'post_storm':'pre_storm';if(has(post))return post;}
 if(has(type))return type;
 return sets[0]?.visit_type||null;
}

/** API payload: blank-label items are held back (the API requires a label). */
export function toPayload(items){
 return items.filter(x=>x.label.trim()).map((x,i)=>({stable_key:x.stable_key,section:x.section.trim()||'General',label:x.label.trim(),help_text:x.help_text.trim(),response_type:x.response_type,options:x.options.map(o=>String(o).trim()).filter(Boolean),required:!!x.required,photo_rule:x.photo_rule,scope:x.scope==='room'?'room':'property',room_types:x.room_types.map(o=>String(o).trim()).filter(Boolean),alert_on_fail:!!x.alert_on_fail,sort_order:i}));
}
export const pendingLabelCount=items=>items.filter(x=>!x.label.trim()).length;

const norm=(item,field)=>{const v=item[field];if(field==='scope')return v==='room'?'room':'property';if(field==='options'||field==='room_types')return JSON.stringify(list(v).map(s=>s.trim()).filter(Boolean));if(typeof v==='boolean'||field==='required'||field==='alert_on_fail')return !!Number(v)||v===true;return String(v??'').trim();};
export const sameItem=(a,b)=>COMPARE_FIELDS.every(f=>norm(a,f)===norm(b,f));

/**
 * Compare the working items with the last published version.
 * Returns {edited:Set<uid>, removed:number, orderChanged:boolean, count:number, hasPublished:boolean}.
 */
export function diffPublished(items,publishedItems){
 if(!publishedItems)return {edited:new Set(),removed:0,orderChanged:false,count:0,hasPublished:false};
 const pub=new Map(publishedItems.map(p=>[String(p.stable_key),p]));
 const live=items.filter(x=>x.label.trim());
 const edited=new Set(live.filter(x=>!pub.has(x.stable_key)||!sameItem(x,pub.get(x.stable_key))).map(x=>x.uid));
 const keys=new Set(live.map(x=>x.stable_key));
 const removed=publishedItems.filter(p=>!keys.has(String(p.stable_key))).length;
 const pubOrder=publishedItems.slice().sort((a,b)=>a.sort_order-b.sort_order).map(p=>String(p.stable_key)).filter(k=>keys.has(k));
 const liveOrder=live.map(x=>x.stable_key).filter(k=>pub.has(k));
 const orderChanged=pubOrder.join('|')!==liveOrder.join('|');
 return {edited,removed,orderChanged,count:edited.size+removed,hasPublished:true};
}

export function stats(items){
 return {items:items.length,sections:groupSections(items).length,photos:items.filter(x=>x.photo_rule&&x.photo_rule!=='none').length};
}
export const sectionPhotoCount=section=>section.items.filter(x=>x.photo_rule&&x.photo_rule!=='none').length;
export function sectionSummary(section,max=3){
 const labels=section.items.map(x=>x.label.trim()||'Untitled item');
 return labels.slice(0,max).join(' · ')+(labels.length>max?' · +'+(labels.length-max)+' more':'');
}

/** What the field tech can choose for an answer type (only what the field app supports). */
export function answerChoices(type,options=[]){
 switch(type){
  case 'pass_fail_na':return [{label:'Pass',tone:'pass'},{label:'Fail',tone:'fail'},{label:'N/A',tone:'na'}];
  case 'yes_no':return [{label:'Yes',tone:'pass'},{label:'No',tone:'fail'}];
  case 'number':return [{label:'Any number',tone:'na'}];
  case 'rating':return [{label:'A numeric rating',tone:'na'}];
  case 'text':return [{label:'Written answer',tone:'na'}];
  case 'select':case 'multi_select':{const o=options.map(s=>String(s).trim()).filter(Boolean);return o.length?o.map(label=>({label,tone:'na'})):[{label:'Add choices below',tone:'empty'}];}
  default:return [];
 }
}
export const typeLabel=type=>(ALL_TYPES.find(t=>t.value===type)||{label:type}).label;
export const photoChip=rule=>(PHOTO_RULES.find(r=>r.value===rule)||{}).chip||'';
export function photoPrompt(item){
 if(item.photo_rule==='required_on_fail')return item.response_type==='pass_fail_na'?'A photo is required if you mark this item Fail.':item.response_type==='yes_no'?'A photo is required if you answer No.':'A photo is required if this item fails.';
 if(item.photo_rule==='optional')return 'You can attach a photo (optional).';
 return '';
}
export const parseList=text=>String(text||'').split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean);
export const parseLines=text=>String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

/** Height for the JS auto-grow fallback: content height plus vertical borders, never below the minimum. */
export function autosizeHeight({scrollHeight,borderTop=0,borderBottom=0,minHeight=0}){
 return Math.max(Math.ceil(Number(scrollHeight)||0)+Math.ceil(Number(borderTop)||0)+Math.ceil(Number(borderBottom)||0),Math.ceil(Number(minHeight)||0));
}

/** True when keyboard shortcuts must not fire (the user is typing). */
export function isTypingTarget(el){
 if(!el)return false;
 const tag=String(el.tagName||'').toUpperCase();
 if(el.isContentEditable)return true;
 if(tag==='TEXTAREA'||tag==='SELECT')return true;
 if(tag==='INPUT'){const type=String(el.type||'text').toLowerCase();return !['checkbox','radio','button','submit','reset','range','color','file'].includes(type);}
 return false;
}

/**
 * Debounced, serialized autosave. Only one save runs at a time; edits made during a save
 * trigger exactly one follow-up save. Status: idle | pending | saving | saved | error.
 */
export class Autosave{
 constructor({save,delay=800,onStatus=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,now=()=>Date.now()}){
  // Call the timer functions unbound: window.setTimeout throws "Illegal invocation" when called as a method of another object.
  Object.assign(this,{saveFn:save,delay,onStatus,now,setTimer:(fn,ms)=>setTimer(fn,ms),clearTimer:id=>clearTimer(id)});
  this.status='idle';this.dirty=false;this.timer=null;this.inflight=null;this.error=null;this.savedAt=null;this.revision=0;
 }
 set(status){this.status=status;this.onStatus(this);}
 schedule(){
  this.dirty=true;this.revision++;
  if(this.timer)this.clearTimer(this.timer);
  this.timer=this.setTimer(()=>{this.timer=null;this.run();},this.delay);
  if(this.status!=='saving')this.set('pending');
 }
 async run(){
  if(this.inflight)return this.inflight;
  if(!this.dirty){return;}
  this.dirty=false;this.error=null;this.set('saving');
  this.inflight=(async()=>{
   try{await this.saveFn();this.savedAt=this.now();}
   catch(error){this.error=error;this.dirty=true;}
  })();
  await this.inflight;this.inflight=null;
  if(this.error){this.set('error');return;}
  if(this.dirty&&!this.timer)return this.run();
  this.set(this.dirty?'pending':'saved');
 }
 /** Save now (e.g. before publish or leaving). Resolves when everything is saved; throws on failure. */
 async flush(){
  if(this.timer){this.clearTimer(this.timer);this.timer=null;}
  if(this.inflight)await this.inflight;
  if(this.dirty)await this.run();
  if(this.status==='error')throw this.error||Error('Save failed.');
 }
 retry(){this.dirty=true;return this.flush().catch(()=>{});}
 get busy(){return !!(this.timer||this.inflight||this.dirty);}
}

export function relativeTime(then,now=Date.now()){
 if(!then)return '';
 const s=Math.max(0,Math.round((now-then)/1000));
 if(s<45)return 'just now';
 const m=Math.round(s/60);if(m<60)return m+' min ago';
 const h=Math.round(m/60);if(h<24)return h+' hr ago';
 return new Date(then).toLocaleDateString();
}
