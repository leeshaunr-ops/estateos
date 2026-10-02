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
