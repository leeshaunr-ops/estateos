import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-checklist-'));
let proc,base,log='';
async function start(){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',ESTATEOS_DATA_DIR:dir},windowsHide:true});proc.stderr.on('data',chunk=>{log+=chunk;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});proc.once('exit',code=>reject(Error('Server exited: '+code+' '+log)));setTimeout(()=>reject(Error('Startup timeout')),10000).unref();});}
after(async()=>{if(proc&&!proc.killed){proc.kill();await new Promise(resolve=>proc.once('exit',resolve));}rmSync(dir,{recursive:true,force:true});});
function client(){let cookie='';return {async req(endpoint,b,expected=200){const res=await fetch(base+'/api/'+endpoint,{method:b===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=await res.json();assert.equal(res.status,expected,endpoint+': '+JSON.stringify(result)+' '+log);return result;}};}
const pw='Test-only-strong-password-928!';
const item=(stable_key,section,label,extra={})=>({stable_key,section,label,help_text:'',response_type:'pass_fail_na',options:[],required:false,photo_rule:'none',scope:'property',room_types:[],alert_on_fail:false,...extra});

test('checklist editor API: atomic saves, draft versions and publishing',async()=>{
 await start();
 const admin=client(),employee=client();
 await admin.req('setup',{company:'Checklist test company',name:'Owner',email:'owner@example.test',password:pw},201);
 const inv=await admin.req('invitations',{role:'employee',email:'tech@example.test'},201);
 await employee.req('accept-invite',{token:new URL('http://test'+inv.invitePath).searchParams.get('invite'),name:'Tech',password:pw},201);
 const items=[item('arrive','Arrival','Note arrival time',{response_type:'text'}),item('vacated','Departure','Confirm the residence has been vacated',{required:true,photo_rule:'required_on_fail',help_text:'Walk through every room.'})];
 const {id}=await admin.req('checklist-templates',{name:'Standard visit',visit_type:'routine',items},201);
 const T='checklist-templates/'+id;

 let editor=await admin.req(T+'/items');
 assert.equal(editor.version.status,'draft');assert.equal(editor.published,null);
 await admin.req(T+'/published',undefined,404);

 // Saving a draft edits it in place and keeps every field, including alert_on_fail.
 items[1].alert_on_fail=true;items[1].room_types=['Bedroom'];items[1].scope='room';
 let saved=await admin.req(T+'/items',{items});
 assert.deepEqual(saved,{saved:true,version:1,status:'draft'});
 editor=await admin.req(T+'/items');
 const v=editor.items.find(x=>x.stable_key==='vacated');
 assert.equal(v.alert_on_fail,true);assert.equal(v.required,true);assert.equal(v.photo_rule,'required_on_fail');assert.equal(v.help_text,'Walk through every room.');assert.equal(v.scope,'room');assert.deepEqual(v.room_types,['Bedroom']);

 assert.deepEqual(await admin.req(T+'/publish',{}),{published:true,version:1});
 let pub=await employee.req(T+'/published');
 assert.equal(pub.version.version,1);assert.equal(pub.items.length,2);

 // Editing a published template starts version 2 as a draft; field staff still get version 1.
 const edited=[item('vacated','Departure','Confirm the residence has been vacated and locked',{alert_on_fail:true}),items[0],item('new','Departure','Set the alarm')];
 saved=await admin.req(T+'/items',{items:edited});
 assert.deepEqual(saved,{saved:true,version:2,status:'draft'});
 pub=await employee.req(T+'/published');
 assert.equal(pub.version.version,1);
 assert.deepEqual(pub.items.map(x=>x.label),['Note arrival time','Confirm the residence has been vacated']);
 editor=await admin.req(T+'/items');
 assert.equal(editor.version.version,2);assert.equal(editor.version.status,'draft');
 assert.equal(editor.published.version,1);assert.equal(editor.published.items.length,2);
 assert.deepEqual(editor.items.map(x=>[x.stable_key,x.sort_order]),[['vacated',0],['arrive',1],['new',2]]);

 // Further saves keep editing version 2 instead of creating more versions.
 assert.equal((await admin.req(T+'/items',{items:edited})).version,2);

 // A bad save is rejected before anything is written: no data loss.
 await admin.req(T+'/items',{items:[item('x','A','Fine'),item('y','A','  ')]},422);
 await admin.req(T+'/items',{items:[item('x','A','One'),item('x','A','Two')]},422);
 editor=await admin.req(T+'/items');
 assert.equal(editor.items.length,3,'draft items survive a rejected save');

 // Only admins can change templates.
 await employee.req(T+'/items',{items:edited},403);
 await employee.req(T+'/publish',{},403);

 const history=await admin.req(T+'/versions');
 assert.equal(history.current_version,2);
 assert.deepEqual(history.versions.map(x=>[x.version,x.status,x.item_count]),[[2,'draft',3],[1,'published',2]]);

 assert.deepEqual(await admin.req(T+'/publish',{}),{published:true,version:2});
 pub=await employee.req(T+'/published');
 assert.equal(pub.version.version,2);assert.equal(pub.items.length,3);
 assert.equal(pub.items[0].label,'Confirm the residence has been vacated and locked');

 // Legacy itemsJson payloads are still accepted.
 assert.equal((await admin.req(T+'/items',{itemsJson:JSON.stringify(edited)})).version,3);

 // Signed-out requests are rejected.
 const other=client();
 await other.req('checklist-templates/'+id+'/items',undefined,401);
});
