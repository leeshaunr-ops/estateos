/* EstateAegis inspection checklist answers.
   Visits started from a company's published checklist template carry a snapshot of that template version, and
   every answer carries its item settings (response type, options, required, photo rule, alert on fail).
   Visits on the built-in checklist (answers without response_type) keep the original pass / monitor / attention / N/A
   behaviour unchanged. Pure logic, shared by the page, the offline flow, the server (validation, completion rules,
   PDF) and Node tests. Exposed as globalThis.EAChecklist.

   Every answer value is stored in answer.status as a string so the offline merge (which compares status and note)
   works for every type: pass_fail_na pass|monitor|fail|na (Monitor added later; visits answered before it simply never
   used it), yes_no yes|no, yes_no yes|no, rating "1".."5", number "12.5", text, select
   (the option), multi_select (a JSON array of options). "unchecked" means not answered yet. */
(function(root){
 'use strict';
 const TYPES=['pass_fail_na','yes_no','rating','number','text','select','multi_select'];
 const PHOTO_RULES=['none','optional','required_on_fail'];
 const OPEN='unchecked',RATING_MAX=5,MAX_TEXT=4000;
 /** Pass / Monitor / Fail / N/A, in display order. Monitor matches the built-in checklist: no alert, no note required. */
 const PASS_FAIL_VALUES=['pass','monitor','fail','na'];
 const TYPE_LABELS={pass_fail_na:'Pass / Monitor / Fail / N/A',yes_no:'Yes / No',rating:'Rating 1–5',number:'Number',text:'Text',select:'Choose one',multi_select:'Choose any'};
 const str=v=>String(v??'');
 /** True for answers that came from a checklist template (they carry a response type). */
 const isTemplateAnswer=a=>!!(a&&TYPES.includes(a.response_type));
 const answered=a=>!!a&&a.status!==OPEN&&str(a.status).trim()!=='';
 function multiValues(value){if(Array.isArray(value))return value.map(String);try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed.map(String):[];}catch{return [];}}
 /** Normalise one snapshot item (from checklist_template_items rows or editor items). */
 function snapshotItem(item,index=0){
  const type=TYPES.includes(item.response_type)?item.response_type:'pass_fail_na';
  const parse=v=>{if(Array.isArray(v))return v.map(String);try{const x=JSON.parse(v||'[]');return Array.isArray(x)?x.map(String):[];}catch{return [];}};
  return {stable_key:str(item.stable_key)||'item-'+index,section:str(item.section).trim()||'General',label:str(item.label).trim(),help_text:str(item.help_text).trim(),response_type:type,options:parse(item.options),required:!!Number(item.required)||item.required===true,photo_rule:PHOTO_RULES.includes(item.photo_rule)?item.photo_rule:'optional',scope:item.scope==='room'?'room':'property',room_types:parse(item.room_types),alert_on_fail:!!Number(item.alert_on_fail)||item.alert_on_fail===true,sort_order:Number.isFinite(Number(item.sort_order))?Number(item.sort_order):index};
 }
 /** Does a room-scoped item apply to this room? Items with no room types apply to every room. */
 function roomItemApplies(item,room){const types=(item.room_types||[]).map(t=>str(t).trim().toLowerCase()).filter(Boolean);return !types.length||types.includes(str(room?.type).trim().toLowerCase());}
 const roomAnswerKey=(roomKey,itemKey)=>`space-${encodeURIComponent(roomKey)}-${itemKey}`;
 function answerFor(item,room){
  const a={key:room?roomAnswerKey(room.key,item.stable_key):item.stable_key,item_key:item.stable_key,section:room?str(room.name):item.section,label:item.label,help_text:item.help_text||'',response_type:item.response_type,options:[...(item.options||[])],required:!!item.required,photo_rule:item.photo_rule||'optional',alert_on_fail:!!item.alert_on_fail,status:OPEN,note:''};
  if(room)Object.assign(a,{room_key:str(room.key),room_name:str(room.name),room_type:str(room.type)});
  return a;
 }
 /** Unanswered answers for the residence-wide items of a template snapshot, in template order. */
 function propertyAnswers(snapshot){return (snapshot?.items||[]).filter(i=>i.scope!=='room').map(i=>answerFor(i));}
 /** Unanswered answers for the room-scoped items, one set per matching room (room types filter which rooms). */
 function roomAnswers(snapshot,rooms){const out=[],items=(snapshot?.items||[]).filter(i=>i.scope==='room');for(const room of rooms||[])for(const item of items)if(roomItemApplies(item,room))out.push(answerFor(item,room));return out;}
 /** Why a value is not valid for an item, or '' when it is. "unchecked" (not answered) is always valid in a draft. */
 function valueProblem(item,value){
  const v=str(value);if(v===OPEN)return '';
  switch(item.response_type){
   case 'pass_fail_na':return PASS_FAIL_VALUES.includes(v)?'':'Choose Pass, Monitor, Fail or N/A.';
   case 'yes_no':return ['yes','no'].includes(v)?'':'Choose Yes or No.';
   case 'rating':return /^[1-9]\d*$/.test(v)&&Number(v)<=RATING_MAX?'':`Choose a rating from 1 to ${RATING_MAX}.`;
   case 'number':return v.trim()!==''&&v.length<=40&&Number.isFinite(Number(v))?'':'Enter a number.';
   case 'text':return v.length<=MAX_TEXT?'':`Keep answers under ${MAX_TEXT} characters.`;
   case 'select':return (item.options||[]).includes(v)?'':'Choose one of the listed options.';
   case 'multi_select':{const values=multiValues(v);return values.length&&values.every(x=>(item.options||[]).includes(x))&&new Set(values).size===values.length?'':'Choose from the listed options.';}
   default:return 'Unknown answer type.';
  }
 }
 /** True for a failed answer: Fail on a template item, Attention on the built-in checklist. */
 const isFailed=a=>!!a&&(a.status==='fail'||a.status==='attention');
 /** Display text for an answer value. */
 function displayValue(a){
  const v=str(a?.status);
  if(v===OPEN||v.trim()==='')return isTemplateAnswer(a)&&!a.required?'Not answered':'Not checked';
  if(!isTemplateAnswer(a))return v==='na'?'Not applicable':v.charAt(0).toUpperCase()+v.slice(1);
  switch(a.response_type){
   case 'pass_fail_na':return {pass:'Pass',monitor:'Monitor',fail:'Fail',na:'Not applicable'}[v]||v;
   case 'yes_no':return {yes:'Yes',no:'No'}[v]||v;
   case 'rating':return `${v} of ${RATING_MAX}`;
   case 'multi_select':return multiValues(v).join(', ');
   default:return v;
  }
 }
 /** Visual tone: pass | fail | monitor | na | open | value. */
 function tone(a){
  const v=str(a?.status);if(v===OPEN||v.trim()==='')return 'open';
  if(!isTemplateAnswer(a))return v==='attention'?'fail':v;
  if(a.response_type==='pass_fail_na')return v;
  if(a.response_type==='yes_no')return v==='yes'?'pass':'monitor';
  return 'value';
 }
 /** Note placeholder for a template row. Monitor, like on the built-in checklist, never requires a note, but the
   field asks for one so the office knows what to watch. */
 function notePrompt(type,status){return type==='text'?'Extra note (optional)':type==='pass_fail_na'&&str(status)==='monitor'?'What to watch (recommended)':'Reading, observation or N/A reason';}
/** Pass / Monitor / Fail / N/A counts over a template visit's pass/fail items (reports, PDF, portal). */
 function totals(answers){const out={pass:0,monitor:0,fail:0,na:0};for(const a of answers||[])if(isTemplateAnswer(a)&&a.response_type==='pass_fail_na'&&Object.hasOwn(out,a.status))out[a.status]++;return out;}
/** Items that still block completion: built-in items not checked, template items marked Required not answered. */
 const stillOpen=answers=>(answers||[]).filter(a=>isTemplateAnswer(a)?a.required&&!answered(a):a.status===OPEN);
 /** Failed template items whose photo rule requires a photo on fail. */
 const photoRequired=answers=>(answers||[]).filter(a=>isTemplateAnswer(a)&&a.photo_rule==='required_on_fail'&&a.status==='fail');
 /**
  * What must be fixed before a visit can be marked complete. Built-in visits get exactly the original rules and
  * messages. Template visits follow the template: optional items may stay blank, and a failed item set to
  * "Photo required on fail" needs a photo on the visit (photos attach to the visit, not to one item).
  */
 function completionProblems(answers,{summary='',photoCount=null}={}){
  const problems=[],open=stillOpen(answers).length,na=(answers||[]).filter(a=>a.status==='na'&&!str(a.note).trim()).length;
  if(open)problems.push(`${open} checklist item${open===1?'':'s'} still need a result.`);
  if(na)problems.push(`Add a note to ${na} item${na===1?'':'s'} marked Not applicable.`);
  const photos=photoRequired(answers);
  if(photoCount!==null&&photos.length&&!Number(photoCount))problems.push(`Add a photo for ${photos.length===1?'the failed item':photos.length+' failed items'} that require${photos.length===1?'s':''} one: ${photos.map(a=>a.label).join('; ')}.`);
  if(!str(summary).trim())problems.push('Add an inspection summary.');
  return problems;
 }
 root.EAChecklist={TYPES,TYPE_LABELS,PASS_FAIL_VALUES,totals,notePrompt,PHOTO_RULES,OPEN,RATING_MAX,MAX_TEXT,isTemplateAnswer,answered,multiValues,snapshotItem,roomItemApplies,roomAnswerKey,answerFor,propertyAnswers,roomAnswers,valueProblem,isFailed,displayValue,tone,stillOpen,photoRequired,completionProblems};
})(typeof self!=='undefined'?self:globalThis);
