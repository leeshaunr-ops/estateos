// Overview refresh: the attention list, visits, numbers and residence rules (public/overview-core.js), the shell wiring,
// and the server's last-message snippet, which must only ever describe threads the user belongs to.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
import '../public/overview-core.js';
const O=globalThis.EAOverview;
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});

const T='2026-10-03';
const ans=(key,label,status,note='')=>({key,label,status,note});
function sample(role='admin',userId='u-admin'){
 return {user:{id:userId,role,name:role==='admin'?'Jordan Ellis':'Maya Torres'},company:'Harborline Home Watch',
  properties:[{id:'p1',name:'Marsh Point Cottage',city:'Hilton Head Island',state:'SC',client_id:'c1'},{id:'p2',name:'Desert Villa',city:'Scottsdale',state:'AZ',client_id:'c2'},{id:'p3',name:'Canyon View House',city:'Palm Springs',state:'CA',client_id:'c2'}],
  clients:[{id:'c1',name:'Brennan Family'},{id:'c2',name:'Okafor Family'}],
  users:[{id:'u-admin',role:'admin',name:'Jordan Ellis'},{id:'u-maya',role:'employee',name:'Maya Torres'},{id:'u-ben',role:'employee',name:'Ben Carter'}],
  vendors:[{id:'v1',name:'Desert Air HVAC'}],
  inspections:[
   {id:'i-sub',property_id:'p1',inspector_id:'u-maya',inspector_name:'Maya Torres',inspection_date:'2026-10-02',status:'submitted',visit:{status:'verified',check_in:{status:'verified',distance_m:33}},answers:[ans('leaks','Check under sinks for leaks','fail','Slow drip under kitchen sink; shutoff closed'),ans('screens','Walk exterior','monitor','Screen torn'),ans('doors','Doors locked','pass')]},
   {id:'i-pub',property_id:'p2',inspector_id:'u-ben',inspector_name:'Ben Carter',inspection_date:'2026-09-28',status:'published',answers:[ans('hvac','Thermostat in range','fail','Upstairs unit not cooling'),ans('pests','Signs of pests','monitor','')]},
   {id:'i-fixed',property_id:'p3',inspector_id:'u-ben',inspector_name:'Ben Carter',inspection_date:'2026-09-29',status:'published',answers:[ans('pool','Pool equipment','fail','Pump off')]},
   {id:'i-late-maya',property_id:'p1',inspector_id:'u-maya',inspector_name:'Maya Torres',inspection_date:'2026-09-30',status:'draft',answers:[ans('leaks','Check under sinks','unchecked')]},
   {id:'i-late-ben',property_id:'p2',inspector_id:'u-ben',inspector_name:'Ben Carter',inspection_date:'2026-10-01',status:'draft',answers:[]},
   {id:'i-today',property_id:'p3',inspector_id:'u-maya',inspector_name:'Maya Torres',inspection_date:T,status:'draft',answers:[]},
   {id:'i-storm',property_id:'p1',inspector_id:'u-maya',inspector_name:'Maya Torres',inspection_date:'2026-10-05',status:'draft',storm_event_id:'s1',answers:[]}],
  work:[{id:'w-late',property_id:'p2',title:'Repair upstairs AC',priority:'Urgent',due_date:'2026-10-02',status:'open',vendor_id:'v1'},
   {id:'w-free',property_id:'p1',title:'Fix sink drain',priority:'High',due_date:'2026-10-04',status:'open'},
   {id:'w-done',property_id:'p3',title:'Pump repair',priority:'Normal',due_date:'2026-09-30',status:'completed'},
   {id:'w-sub',property_id:'p3',title:'Clean filter',priority:'Normal',due_date:'2026-10-05',status:'submitted'}],
  requests:[{id:'r1',property_id:'p1',title:'Check hot tub cover',priority:'High',status:'new'},{id:'r2',property_id:'p2',title:'Old request',status:'completed'}],
  arrivals:[{id:'a1',property_id:'p1',arrival_at:'2026-10-08T15:00:00.000Z',status:'submitted',items:[{status:'purchased'},{status:'needed'}]},{id:'a-old',property_id:'p2',arrival_at:'2026-09-01T15:00:00.000Z',status:'submitted'}],
  operations:{followups:[{inspection_id:'i-fixed',answer_key:'pool',work_order_id:'w-done',status:'completed'}],plans:[{id:'pl1',property_id:'p2',assigned_to:'u-ben',assigned_name:'Ben Carter',next_due:'2026-10-06',active:1}]},
  staff:{assignments:[{work_id:'w-free',user_id:'u-maya'}]},
  storm:{events:[{id:'s1',name:'Coast storm watch',type_label:'Tropical storm',status:'preparing',status_label:'Preparing',prep_deadline_at:'2026-10-06T22:00:00.000Z',expected_impact_at:'2026-10-07T18:00:00.000Z',counts:{total:2,secured:1},residences:[{property_id:'p1',prep_status:'scheduled',assigned_user_id:'u-maya',pre:{status:'draft'}},{property_id:'p3',prep_status:'secured'}]}]},
  messaging:{threads:[{id:'t-old',subject:'Gate code',updated_at:'2026-10-01T10:00:00Z',unread:0,people:[{id:'u-admin'},{id:'u-ben',name:'Ben Carter'}],last:{body:'Thanks',sender_id:'u-admin',sender_name:'Jordan Ellis',created_at:'2026-10-01T10:00:00Z'}},{id:'t-new',subject:'Marsh Point leak',updated_at:'2026-10-03T09:00:00Z',unread:2,people:[{id:'u-maya',name:'Maya Torres'}],last:{body:'Water is shut off.',sender_id:'u-maya',sender_name:'Maya Torres',created_at:'2026-10-03T09:00:00Z'}}]},
  visitVerification:{enabled:true}};
}

test('dates read like people write them',()=>{
 assert.equal(O.niceDate('2026-10-08',T),'Thu, Oct 8');
 assert.equal(O.niceDate('2026-10-08T15:00:00.000Z',T),'Thu, Oct 8');
 assert.equal(O.niceDate('2027-01-04',T),'Mon, Jan 4, 2027');
 assert.equal(O.relativeDay('2026-10-03',T),'Today');assert.equal(O.relativeDay('2026-10-04',T),'Tomorrow');assert.equal(O.relativeDay('2026-10-02',T),'Yesterday');
 assert.equal(O.longDate(T),'Saturday, October 3');
 assert.equal(O.greeting(8),'Good morning');assert.equal(O.greeting(13),'Good afternoon');assert.equal(O.greeting(19),'Good evening');
 assert.equal(O.daysBetween('2026-09-30',T),3);assert.equal(O.addDays('2026-12-31',1),'2027-01-01');
});

test('attention (admin): failed items say what was found, then reports to sign, overdue, new from clients',()=>{
 const att=O.attention(sample(),{today:T});
 const failed=att.items.filter(i=>i.group==='failed');
 assert.deepEqual(failed.map(i=>i.title),['Slow drip under kitchen sink; shutoff closed','Upstairs unit not cooling'],'the inspector note is the title; resolved follow-ups drop out');
 assert.equal(failed[0].place,'Marsh Point Cottage');assert.match(failed[0].detail,/Hilton Head Island, SC · Maya Torres, yesterday · Check under sinks for leaks/);
 assert.deepEqual(failed[0].action,{label:'Review report',name:'inspection',key:'i-sub'},'a submitted visit opens the report');
 assert.deepEqual(failed[1].action,{label:'Create work order',name:'finding-work',key:'i-pub|hvac'},'a published finding becomes a work order');
 const sign=att.items.filter(i=>i.group==='sign');
 assert.deepEqual(sign.map(i=>i.id),['sign:i-sub','work-review:w-sub']);
 assert.match(sign[0].detail,/Maya Torres · 1 fail, 1 monitor item · GPS verified on site/);
 const overdue=att.items.filter(i=>i.group==='overdue');
 assert.deepEqual(overdue.map(i=>[i.id,i.pill]),[['visit:i-late-maya','3 days late'],['visit:i-late-ben','2 days late'],['work:w-late','1 day late']],'most late first');
 assert.equal(overdue[2].tone,'fail','urgent work is red');assert.match(overdue[2].detail,/Desert Air HVAC/);
 assert.deepEqual(att.items.filter(i=>i.group==='clients').map(i=>i.title),['Check hot tub cover']);
 assert.equal(att.counts.monitor,2,'monitor findings only count toward "more"');
 assert.equal(att.counts.unassigned,0,'w-free has a staff assignment');
 assert.equal(att.primary.length,8);
 assert.deepEqual([...new Set(att.items.map(i=>i.group))],['failed','sign','overdue','clients','monitor']);
 for(const i of att.items)assert.ok(i.action&&i.action.name&&i.action.label,'one action each: '+i.id);
});

test('attention (staff): only their own visits, no sign-off, work assigned to them or to no one',()=>{
 const d=sample('employee','u-maya');
 const att=O.attention(d,{today:T});
 assert.equal(att.counts.sign,0,'only admins publish reports');
 assert.deepEqual(att.items.filter(i=>i.group==='overdue').map(i=>i.id),['visit:i-late-maya'],"Ben's late visit and the vendor's job are not Maya's");
 assert.ok(!att.items.some(i=>i.group==='unassigned'));
 assert.deepEqual(att.items.find(i=>i.id==='finding:i-sub:leaks').action,{label:'Open report',name:'inspection',key:'i-sub'});
});

test('attention view: three per group, ten at most, and a plain "N more"',()=>{
 const d=sample();for(let n=0;n<6;n++)d.requests.push({id:'rx'+n,property_id:'p2',title:'Request '+n,status:'new'});
 const att=O.attention(d,{today:T}),v=O.attentionView(att);
 const shown=v.groups.flatMap(g=>g.items);
 assert.ok(shown.length<=10);for(const g of v.groups)assert.ok(g.items.length<=3,g.key);
 assert.deepEqual(v.groups.map(g=>g.title),['Failed items','Reports to sign off','Overdue','New from clients']);
 assert.equal(v.hidden,att.items.length-shown.length);
 assert.equal(v.moreText,'4 client requests, 2 monitor items');
 assert.equal(O.attentionView(att,{showAll:true}).hidden,0);
});

test('summary line, numbers, visits, storms, residences, arrivals and messages',()=>{
 const d=sample(),ctx=O.context(d,{today:T});
 const att=O.attention(d,{ctx}),storms=O.storms(d,{ctx});
 assert.equal(O.summary(att,storms,{today:T}).line,'2 failed items, 2 reports to sign, 3 overdue items and 1 new client request need you today. Storm prep is due Tuesday.');
 assert.equal(O.summary({counts:{failed:1,sign:0,overdue:0,clients:0}},[],{today:T}).line,'1 failed item needs you today.');
 assert.equal(O.summary({counts:{failed:0,sign:0,overdue:0,clients:0}},[],{today:T}).line,'Nothing needs you right now.');
 assert.deepEqual(storms.map(s=>[s.secured,s.total,s.mine]),[[1,2,0]]);
 assert.equal(O.storms(sample('employee','u-maya'),{today:T})[0].mine,1,'staff see their own storm visits');
 const v=O.visits(d,{ctx});
 assert.deepEqual(v.today.map(x=>x.id),['i-today']);
 assert.deepEqual(v.days.map(x=>[x.label,x.storm,x.items.map(i=>i.id)]),[['Mon, Oct 5',true,['i-storm']],['Tue, Oct 6',false,['plan:pl1']]],'storm visits and recurring plans in the next 7 days');
 assert.deepEqual(v.done.map(x=>x.id),['i-sub','i-fixed','i-pub']);
 const mine=O.visits(sample('employee','u-maya'),{today:T});
 assert.deepEqual([mine.today.length,mine.days.length,mine.done.map(x=>x.id)],[1,1,['i-sub']],'staff see their own visits');
 const k=O.kpis(d,{ctx});
 assert.deepEqual(k.map(x=>[x.label,x.value]),[['Residences','3'],['Visits done, last 7 days','3 / 6'],['Visits GPS-verified','1 of 3'],['Failed items open','2'],['Open work orders','3']]);
 for(const x of k)assert.ok(x.action.name,'clickable: '+x.label);
 assert.equal(O.kpis(sample('employee','u-maya'),{today:T})[0].label,'My visits today');
 const r=O.residences(d,{ctx});
 assert.deepEqual(r.map(x=>[x.name,x.state,x.text]),[['Desert Villa','fail','1 failed item'],['Marsh Point Cottage','fail','1 failed item'],['Canyon View House','ok','All clear']]);
 assert.deepEqual(r[1].last,{date:'2026-10-02',label:'Fri, Oct 2',who:'Maya',gps:true});
 assert.deepEqual(r[1].next,{date:'2026-09-30',label:'Overdue',late:true});
 assert.deepEqual(O.arrivals(d,{ctx}).map(a=>[a.property,a.client,a.label,a.detail]),[['Marsh Point Cottage','Brennan Family','Thu, Oct 8','1 of 2 items stocked']]);
 const m=O.messages(d);
 assert.equal(m.unread,2);assert.deepEqual(m.threads.map(t=>[t.id,t.from,t.snippet]),[['t-new','Maya Torres','Water is shut off.'],['t-old','You','Thanks']],'unread first; my own last message reads "You"');
});

test('setup checklist for a new company',()=>{
 const s=O.setupSteps({company:'Coastal Keys',users:[{role:'admin'}],properties:[],clients:[],inspections:[],checklistTemplates:{templates:[{is_system:1,status:'published'}]}});
 assert.equal(s.total,6);assert.equal(s.done,0,'the built-in system checklist does not count as picked');
 assert.deepEqual(s.steps.map(x=>x.action.name),['navigate','new-client','navigate','navigate','navigate','navigate']);
 const t=O.setupSteps({company:'Coastal Keys',workspaceSupport:{email:'a@b.c'},users:[{role:'admin'},{role:'employee'}],properties:[{id:'p'}],clients:[{id:'c'}],inspections:[{id:'i'}]});
 assert.equal(t.done,5);assert.equal(t.steps.find(x=>!x.done).key,'invite-client');
});

test('the shell ships the Overview files and the quick fixes',()=>{
 const html=read('public/live.html'),sw=read('public/sw.js'),server=read('server.mjs'),live=read('public/live.js'),css=read('public/overview.css'),js=read('public/overview.js');
 assert.match(html,/<script src="\/overview-core\.js\?v=[^"]+"><\/script><script src="\/live\.js/,'rules load before live.js');
 assert.match(html,/<script src="\/overview\.js\?v=[^"]+"><\/script><script src="\/view-route\.js/);
 assert.match(html,/<link rel="stylesheet" href="\/overview\.css\?v=[^"]+">/);
 for(const f of ['overview-core.js','overview.js','overview.css']){assert.ok(sw.includes(`'/${f}'`),'service worker caches '+f);assert.match(server,new RegExp(`SHELL_FILES = \\[[^\\]]*'${f.replace('.','\\.')}'`),'shell version covers '+f);assert.ok(server.includes(`'/${f}':'${f}'`),'served: '+f);}
 assert.doesNotMatch(js+read('public/overview-core.js'),/style=/,'no inline styles (CSP)');
 assert.match(css,/body\.signed-in #siteFooter/,'no marketing footer inside the app');
 assert.match(live,/function workspaceLogoSrc\(\)\{return data\?\(data\.companyLogo\|\|data\.workspaceLogo/,'sidebar logo reads companyLogo');
 assert.doesNotMatch(live,/\['Upcoming inspections',0,/,'no hard-coded zero');
 assert.doesNotMatch(live,/\['Submitted arrivals',data\.arrivals\?\.length/,'no duplicate arrivals tile');
 assert.match(live,/<div class="powered-by">/);assert.doesNotMatch(live,/<span>Powered by EstateAegis<\/span>\$\{data\.unreadMessages/,'Powered by left the top bar');
 assert.match(live,/class="nav-backdrop" data-action="menu"/);
 assert.match(js,/ovButton\("Plan today's route",'navigate','routes'/);
 for(const f of ['live.css','refresh.css'])assert.doesNotMatch(read('public/'+f),/font-family:Inter,/,f+' uses EA Inter');
});

// ---------- server: last-message snippet ----------
function server(env){let proc,base,log='';return {get base(){return base;},get log(){return log;},
 async start(){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',RESEND_API_KEY:'',ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64'),...env},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
 async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};}
function client(srv){let cookie='';return async(endpoint,b,expected=200)=>{const res=await fetch(srv.base+'/api/'+endpoint,{method:b===undefined?'GET':'POST',headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const j=await res.json();assert.equal(res.status,expected,endpoint+': '+JSON.stringify(j));return j;};}

test('messages list: each thread carries a last-message snippet, only for threads the user belongs to',{timeout:60000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-overview-'));dirs.push(dir);
 const env={ESTATEOS_DATA_DIR:dir};delete process.env.DATABASE_URL;
 const srv=server(env);await srv.start();
 try{
  const pw='Test-only-strong-password-928!',admin=client(srv),maya=client(srv),ben=client(srv),fam=client(srv);
  await admin('setup',{company:'Harborline',name:'Jordan Ellis',email:'owner@example.test',password:pw},201);
  const c=await admin('clients',{name:'Brennan Family'},201);
  const tok=inv=>new URL('http://x'+inv.invitePath).searchParams.get('invite');
  const join=async(cl,role,email,name,extra={})=>(await cl('accept-invite',{token:tok(await admin('invitations',{role,email,...extra},201)),name,password:pw},201)).user;
  const mayaU=await join(maya,'employee','maya@example.test','Maya Torres'),benU=await join(ben,'employee','ben@example.test','Ben Carter');await join(fam,'client','fam@example.test','Claire Brennan',{clientId:c.id});
  const owner=(await admin('data')).user;
  const send=(cl,b)=>cl('messages/send',{messageId:randomUUID(),...b},201);
  const first=await send(maya,{recipientId:owner.id,subject:'Marsh Point leak',message:'First note'});
  const long='Water is shut off under the kitchen sink.   Plumber can come Monday. '+'x'.repeat(300);
  await new Promise(r=>setTimeout(r,15));
  await send(maya,{threadId:first.threadId||undefined,recipientId:owner.id,subject:'Marsh Point leak',message:long});
  await send(admin,{recipientId:'everyone',subject:'Storm prep',message:'Please check shutters today.'});
  const mine=await admin('messages');
  const leak=mine.threads.find(t=>t.subject==='Marsh Point leak');
  assert.ok(leak&&leak.last,'admin sees the leak thread with a snippet');
  assert.equal(leak.last.sender_name,'Maya Torres');assert.equal(leak.last.sender_id,mayaU.id);
  assert.ok(leak.last.body.startsWith('Water is shut off under the kitchen sink. Plumber can come Monday.'),'whitespace collapsed: '+leak.last.body.slice(0,80));
  assert.ok(leak.last.body.length<=160&&leak.last.body.endsWith('…'),'clipped to 160 characters');
  const storm=mine.threads.find(t=>t.subject==='Storm prep');assert.equal(storm.last.body,'Please check shutters today.');
  const benList=await ben('messages');
  assert.ok(!benList.threads.some(t=>t.subject==='Marsh Point leak'),'Ben is not in the leak thread');
  assert.ok(!JSON.stringify(benList).includes('Plumber can come Monday'),'and never sees its text');
  assert.equal(benList.threads.find(t=>t.subject==='Storm prep').last.body,'Please check shutters today.','announcements reach everyone');
  const famList=await fam('messages');assert.ok(!JSON.stringify(famList).includes('kitchen sink'),'clients never see staff threads');
  assert.equal(benU.role,'employee');
 }finally{await srv.stop();}
});
