import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeItem,normalizeTemplate,mergeChecklist,validateSubmission} from '../checklist-templates.mjs';

test('normalizes stable keys and safe defaults',()=>{
 const item=normalizeItem({label:'Kitchen / Plumbing',response_type:'bad'},2);
 assert.equal(item.stable_key,'kitchen-plumbing');
 assert.equal(item.response_type,'pass_fail_na');
});
test('rejects duplicate keys',()=>assert.throws(()=>normalizeTemplate({name:'Routine',items:[{label:'Door',stable_key:'door'},{label:'Window',stable_key:'door'}]}),/Duplicate/));
test('merges and hides property items',()=>{
 const result=mergeChecklist({items:[{label:'Door',stable_key:'door',sort_order:1},{label:'Window',stable_key:'window',sort_order:2}]},{hidden_item_keys:['window'],added_items:[{label:'Pool',stable_key:'pool',sort_order:3}]});
 assert.deepEqual(result.map(x=>x.stable_key),['door','pool']);
});
test('validates required and enumerated responses',()=>{
 const items=[normalizeItem({label:'Door',stable_key:'door',required:true}),normalizeItem({label:'Rating',stable_key:'rating',response_type:'rating',required:true})];
 assert.equal(validateSubmission(items,{door:'fail',rating:'high'}).ok,false);
 assert.equal(validateSubmission(items,{door:'pass',rating:4}).ok,true);
});

import {VISIT_TYPES,VISIT_TYPE_LABELS,RESPONSE_TYPES,PHOTO_RULES,PRESET_ITEMS,presetItems,starterSets} from '../checklist-templates.mjs';

test('storm visit types are valid and labelled',()=>{
 assert.ok(VISIT_TYPES.has('pre_storm'));assert.ok(VISIT_TYPES.has('post_storm'));
 for(const type of VISIT_TYPES)assert.ok(VISIT_TYPE_LABELS[type],type);
 assert.equal(VISIT_TYPE_LABELS.pre_storm,'Hurricane prep');assert.equal(VISIT_TYPE_LABELS.post_storm,'Post-storm');
 assert.equal(normalizeTemplate({name:'Storm',visit_type:'pre_storm'}).visit_type,'pre_storm');
 assert.equal(normalizeTemplate({name:'Storm',visit_type:'post_storm'}).visit_type,'post_storm');
});
test('storm starter items use only supported enums and unique keys',()=>{
 for(const type of ['pre_storm','post_storm']){
  const items=presetItems(type);
  assert.ok(items.length>=18,type+' has real starter items');
  assert.equal(new Set(items.map(i=>i.stable_key)).size,items.length,type+' keys are unique');
  for(const raw of PRESET_ITEMS[type]){assert.ok(RESPONSE_TYPES.has(raw.response_type),raw.label);assert.ok(PHOTO_RULES.has(raw.photo_rule),raw.label);assert.ok(raw.label.length<=160,raw.label);}
  assert.doesNotThrow(()=>normalizeTemplate({name:type,visit_type:type,items}));
  assert.deepEqual(items.map(i=>i.sort_order),items.map((_,i)=>i));
 }
});
test('hurricane prep starter covers the storm plan',()=>{
 const items=presetItems('pre_storm'), sections=[...new Set(items.map(i=>i.section))];
 assert.deepEqual(sections,['Exterior & yard','Openings & protection','Pool','Interior','Utilities & systems','Vehicles & boats','Documentation']);
 const find=re=>{const item=items.find(i=>re.test(i.label));assert.ok(item,String(re));return item;};
 const shutters=find(/^Shutters/);assert.equal(shutters.photo_rule,'required_on_fail');assert.equal(shutters.alert_on_fail,true);assert.equal(shutters.required,true);
 assert.equal(find(/Main water/).alert_on_fail,true);
 assert.equal(find(/Generator fuel/).response_type,'number');
 assert.equal(find(/^Owner notes/).response_type,'text');assert.equal(find(/^Owner notes/).required,false);
 const walk=find(/photo walk-through/);assert.equal(walk.required,true);assert.equal(walk.photo_rule,'optional');
});
test('post-storm starter puts safety first and alerts on critical damage',()=>{
 const items=presetItems('post_storm');
 assert.equal(items[0].section,'Safety first');assert.equal(items[0].alert_on_fail,true);assert.match(items[0].help_text,/do not enter/i);
 assert.deepEqual([...new Set(items.map(i=>i.section))],['Safety first','Exterior damage','Interior','Utilities','Storm protection','Documentation']);
 assert.ok(items.filter(i=>i.section==='Exterior damage').every(i=>i.photo_rule==='required_on_fail'));
 assert.ok(items.some(i=>/Insurance/.test(i.label)&&i.response_type==='text'));
});
test('starter sets list every visit type with items, and legacy keys are unchanged',()=>{
 const sets=starterSets();
 assert.deepEqual(sets.map(s=>s.visit_type),['routine','arrival','departure','seasonal','maintenance','pre_storm','post_storm']);
 assert.equal(sets.find(s=>s.visit_type==='pre_storm').label,'Hurricane prep');
 assert.equal(presetItems('routine')[0].stable_key,'exterior-walk-the-exterior-for-visible-damage-or-hazards-');
 assert.deepEqual(presetItems('custom'),[]);
});
