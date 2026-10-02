import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/checklist-editor-model.mjs';
import {RESPONSE_TYPES,PHOTO_RULES} from '../checklist-templates.mjs';

const rows=()=>[
 {stable_key:'a1',section:'Arrival',label:'Note arrival time',response_type:'text',photo_rule:'none',required:0,sort_order:0},
 {stable_key:'a2',section:'Arrival',label:'Disarm the alarm',response_type:'pass_fail_na',photo_rule:'required_on_fail',required:1,sort_order:1},
 {stable_key:'e1',section:'Exterior',label:'Walk the perimeter',response_type:'pass_fail_na',photo_rule:'required_on_fail',required:true,sort_order:2},
 {stable_key:'d1',section:'Departure',label:'Lock up',response_type:'yes_no',photo_rule:'optional',required:false,alert_on_fail:1,sort_order:3,options:'[]',room_types:'["Kitchen"]'}
];
const labels=items=>items.map(x=>x.label);
const sections=items=>M.sectionNames(items);

test('answer and photo options only use values the backend accepts',()=>{
 for(const t of M.ALL_TYPES)assert.ok(RESPONSE_TYPES.has(t.value),t.value);
 for(const r of M.PHOTO_RULES.filter(r=>!r.unsupported))assert.ok(PHOTO_RULES.has(r.value),r.value);
 assert.deepEqual(M.PHOTO_RULES.filter(r=>r.unsupported).map(r=>r.value),['always'],'"Always" is shown disabled because no enum value exists');
});

test('fromApi normalizes rows, keeps every field and makes sections contiguous',()=>{
 const items=M.fromApi([...rows(),{stable_key:'a3',section:'Arrival',label:'Collect packages',sort_order:9}]);
 assert.deepEqual(sections(items),['Arrival','Exterior','Departure']);
 assert.deepEqual(labels(items).slice(0,3),['Note arrival time','Disarm the alarm','Collect packages']);
 const d=items.find(x=>x.stable_key==='d1');
 assert.equal(d.alert_on_fail,true);assert.equal(d.required,false);assert.deepEqual(d.room_types,['Kitchen']);
 assert.deepEqual(items.map(x=>x.sort_order),[0,1,2,3,4]);
});

test('fromApi repairs missing or duplicate stable keys',()=>{
 const items=M.fromApi([{stable_key:'x',label:'Door'},{stable_key:'x',label:'Door'},{label:'Window'}]);
 assert.equal(new Set(items.map(x=>x.stable_key)).size,3);
});

test('reorders within a section and across sections',()=>{
 let items=M.fromApi(rows());
 const a1=items[0].uid;
 items=M.moveItem(items,a1,'Arrival',1);
 assert.deepEqual(labels(items).slice(0,2),['Disarm the alarm','Note arrival time']);
 items=M.moveItem(items,a1,'Departure',0);
 assert.deepEqual(items.filter(x=>x.section==='Departure').map(x=>x.label),['Note arrival time','Lock up']);
 assert.deepEqual(items.map(x=>x.sort_order),[0,1,2,3]);
});

test('keyboard moves cross section boundaries and stop at the ends',()=>{
 let items=M.fromApi(rows());
 const a2=items[1].uid,d1=items[3].uid;
 items=M.moveItemBy(items,a2,1);
 assert.equal(items.find(x=>x.uid===a2).section,'Exterior');
 assert.equal(items.filter(x=>x.section==='Exterior')[0].uid,a2,'enters the next section at the top');
 assert.equal(M.moveItemBy(items,d1,1),items,'last item cannot move down');
 assert.equal(M.moveItemBy(items,items[0].uid,-1),items,'first item cannot move up');
});

test('moving the last item out of a section removes the empty section',()=>{
 let items=M.fromApi(rows());
 items=M.moveItem(items,items.find(x=>x.stable_key==='e1').uid,'Arrival',0);
 assert.deepEqual(sections(items),['Arrival','Departure']);
});

test('moves, renames and deletes sections',()=>{
 let items=M.fromApi(rows());
 items=M.moveSection(items,'Departure',0);
 assert.deepEqual(sections(items),['Departure','Arrival','Exterior']);
 items=M.moveSectionBy(items,'Departure',1);
 assert.deepEqual(sections(items),['Arrival','Departure','Exterior']);
 items=M.renameSection(items,'Exterior','Outside');
 assert.deepEqual(sections(items),['Arrival','Departure','Outside']);
 assert.throws(()=>M.renameSection(items,'Outside','Arrival'),/already exists/);
 assert.throws(()=>M.renameSection(items,'Outside','  '),/required/);
 items=M.deleteSection(items,'Arrival');
 assert.deepEqual(labels(items),['Lock up','Walk the perimeter']);
 assert.deepEqual(items.map(x=>x.sort_order),[0,1]);
});

test('adds, duplicates, updates and deletes items with unique stable keys',()=>{
 let items=M.fromApi(rows());
 const added=M.addItem(items,'Arrival');
 items=added.items;
 assert.equal(items[2].uid,added.uid,'new item is appended to its section');
 assert.equal(items[2].label,'');
 const dup=M.duplicateItem(items,items[1].uid);
 items=dup.items;
 assert.equal(items[2].uid,dup.uid);assert.equal(items[2].label,'Disarm the alarm');
 assert.equal(new Set(items.map(x=>x.stable_key)).size,items.length);
 items=M.updateItem(items,dup.uid,{section:'Departure'});
 assert.equal(items.filter(x=>x.section==='Departure').at(-1).uid,dup.uid,'changing section moves the item to the end of that section');
 items=M.deleteItem(items,dup.uid);
 assert.equal(items.some(x=>x.uid===dup.uid),false);
 assert.equal(M.newSectionName([{section:'New section'},{section:'New section 2'}].map((x,i)=>({...x,uid:String(i),label:'x'}))),'New section 3');
});

test('toPayload holds back blank labels and sends every existing field',()=>{
 let items=M.fromApi(rows());
 items=M.addItem(items,'Arrival').items;
 assert.equal(M.pendingLabelCount(items),1);
 const payload=M.toPayload(items);
 assert.equal(payload.length,4);
 assert.deepEqual(Object.keys(payload[0]).sort(),['alert_on_fail','help_text','label','options','photo_rule','required','response_type','room_types','scope','section','sort_order','stable_key'].sort());
 assert.deepEqual(payload.map(x=>x.sort_order),[0,1,2,3]);
 assert.equal(payload.find(x=>x.stable_key==='d1').alert_on_fail,true);
});

test('diffPublished reports edited, removed and reordered items',()=>{
 const published=rows();
 let items=M.fromApi(published);
 let d=M.diffPublished(items,published);
 assert.equal(d.count,0);assert.equal(d.orderChanged,false);
 items=M.updateItem(items,items[0].uid,{label:'Note arrival time and weather'});
 items=M.deleteItem(items,items.find(x=>x.stable_key==='e1').uid);
 d=M.diffPublished(items,published);
 assert.deepEqual([...d.edited],[items[0].uid]);assert.equal(d.removed,1);
 items=M.moveSection(M.fromApi(published),'Departure',0);
 assert.equal(M.diffPublished(items,published).orderChanged,true);
 assert.equal(M.diffPublished(items,null).hasPublished,false);
});

test('autosizeHeight grows with content and never below the minimum',()=>{
 assert.equal(M.autosizeHeight({scrollHeight:120.4,borderTop:1,borderBottom:1,minHeight:48}),123);
 assert.equal(M.autosizeHeight({scrollHeight:10,borderTop:1,borderBottom:1,minHeight:48}),48);
});

test('isTypingTarget ignores shortcuts only while typing',()=>{
 assert.equal(M.isTypingTarget({tagName:'TEXTAREA'}),true);
 assert.equal(M.isTypingTarget({tagName:'INPUT',type:'text'}),true);
 assert.equal(M.isTypingTarget({tagName:'INPUT',type:'checkbox'}),false);
 assert.equal(M.isTypingTarget({tagName:'DIV',isContentEditable:true}),true);
 assert.equal(M.isTypingTarget({tagName:'BUTTON'}),false);
 assert.equal(M.isTypingTarget(null),false);
});

test('answer choices and photo prompts only describe supported behaviour',()=>{
 assert.deepEqual(M.answerChoices('pass_fail_na').map(x=>x.label),['Pass','Fail','N/A']);
 assert.deepEqual(M.answerChoices('select',['Good',' ','Poor']).map(x=>x.label),['Good','Poor']);
 assert.match(M.photoPrompt({photo_rule:'required_on_fail',response_type:'pass_fail_na'}),/Fail/);
 assert.equal(M.photoPrompt({photo_rule:'none'}),'');
});

const tick=()=>new Promise(r=>setImmediate(r));
function fakeTimers(){let t=null;return {set:(fn)=>{t=fn;return 1;},clear:()=>{t=null;},fire:()=>{const f=t;t=null;f&&f();},get pending(){return !!t;}};}

test('Autosave debounces, runs one save at a time and coalesces edits made during a save',async()=>{
 const timers=fakeTimers();let calls=0,release;const statuses=[];
 const a=new M.Autosave({save:()=>{calls++;return new Promise(r=>{release=r;});},setTimer:timers.set,clearTimer:timers.clear,onStatus:s=>statuses.push(s.status)});
 a.schedule();a.schedule();
 assert.equal(a.status,'pending');assert.equal(calls,0);
 timers.fire();await tick();
 assert.equal(calls,1);assert.equal(a.status,'saving');
 a.schedule();a.schedule();
 timers.fire();await tick();
 assert.equal(calls,1,'no second save while one is in flight');
 release();await tick();await tick();
 assert.equal(calls,2,'exactly one follow-up save');
 release();await tick();await tick();
 assert.equal(a.status,'saved');assert.equal(a.busy,false);
});

test('Autosave reports errors, keeps changes dirty and retries',async()=>{
 const timers=fakeTimers();let fail=true,calls=0;
 const a=new M.Autosave({save:async()=>{calls++;if(fail)throw Error('offline');},setTimer:timers.set,clearTimer:timers.clear});
 a.schedule();
 await assert.rejects(a.flush(),/offline/);
 assert.equal(a.status,'error');assert.equal(a.busy,true);
 fail=false;await a.retry();
 assert.equal(a.status,'saved');assert.equal(calls,2);
});

test('Autosave works with the real global timers (called unbound)',async()=>{
 let calls=0;
 const a=new M.Autosave({save:async()=>{calls++;},delay:5});
 a.schedule();
 await new Promise(r=>setTimeout(r,40));
 assert.equal(calls,1);assert.equal(a.status,'saved');
});

test('relativeTime',()=>{
 assert.equal(M.relativeTime(1000,2000),'just now');
 assert.equal(M.relativeTime(0,0),'');
 assert.equal(M.relativeTime(1,1+5*60000),'5 min ago');
});
