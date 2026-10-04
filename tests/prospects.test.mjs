// Prospects (sales leads): stages, the public quote request form (honeypot, rate limits, validation, same-origin and
// JSON rules), notifications, follow-up reminders, quotes with online acceptance, conversion into a client family +
// residence (plan limit), permissions and company isolation. Server scenarios run on SQLite and on Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProspects,slugOf,followUpState,renderQuoteEmail,renderLeadEmail,renderAcceptedEmail,dollars,splitName,quoteTokenHash,addDays,localDay,isDay} from '../prospects.mjs';
import {openDatabase} from '../database.mjs';
import '../public/overview-core.js';
import '../public/sidebar-core.js';
import '../public/view-route.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-prospects-'));dirs.push(d);return d;};

// ---------- pure helpers ----------
test('helpers: company slug, follow-up state, money, names and days',()=>{
 assert.equal(slugOf('Harborline Home Watch, LLC'),'harborline-home-watch-llc');assert.equal(slugOf('  Ébène & Co '),'b-ne-co');
 assert.equal(followUpState({next_follow_up:'2026-10-03',stage:'contacted'},'2026-10-04'),'overdue');
 assert.equal(followUpState({next_follow_up:'2026-10-04',stage:'new'},'2026-10-04'),'today');
 assert.equal(followUpState({next_follow_up:'2026-10-09',stage:'quote_sent'},'2026-10-04'),'upcoming');
 assert.equal(followUpState({next_follow_up:'2026-10-01',stage:'won'},'2026-10-04'),null,'closed prospects never show as overdue');
 assert.equal(followUpState({next_follow_up:null,stage:'new'},'2026-10-04'),null);
 assert.equal(dollars(42000),'$420');assert.equal(dollars(42050),'$420.50');assert.equal(dollars(1234500),'$12,345');
 assert.deepEqual(splitName('Eleanor  Whitcombe'),{firstName:'Eleanor',lastName:'Whitcombe'});assert.deepEqual(splitName('Ashby'),{firstName:'',lastName:'Ashby'});
 assert.equal(addDays('2026-10-30',3),'2026-11-02');assert.equal(isDay('2026-02-30'),false);assert.equal(isDay('2026-02-28'),true);
 assert.equal(localDay('2026-10-05T02:30:00Z','America/Los_Angeles'),'2026-10-04');assert.equal(localDay('2026-10-05T02:30:00Z','America/New_York'),'2026-10-04');assert.equal(localDay('2026-10-05T05:30:00Z','America/New_York'),'2026-10-05');
 assert.notEqual(quoteTokenHash('a'.repeat(43)),'a'.repeat(43));
});

test('emails: the quote email carries the company name, not EstateAegis sales wording',()=>{
 const q=renderQuoteEmail({company:'Harborline Home Watch',name:'Eleanor Whitcombe',address:'14 Seagrape Ln, Naples, FL 34102',plan:'Seasonal Watch',frequency:'Weekly',monthly_minor:42000,valid_label:'Nov 3, 2026',link:'https://estateaegis.com/quotes/x',supportEmail:'office@harborline.example'});
 assert.equal(q.subject,'Your home watch quote from Harborline Home Watch');
 assert.match(q.text,/\$420 per month/);assert.match(q.text,/https:\/\/estateaegis.com\/quotes\/x/);assert.match(q.html,/Harborline Home Watch/);
 assert.doesNotMatch((q.text+q.html).replaceAll('https://estateaegis.com/quotes/x',''),/EstateAegis|free trial|sign up|pricing/i,'no EstateAegis sales wording in what the prospect receives');
 assert.match(q.html,/#8b242b/);assert.doesNotMatch(q.html,/<script/i);
 const evil=renderLeadEmail({company:'Harborline',name:'<img src=x onerror=alert(1)>',email:'a@b.co',phone:'',address:'',message:'<b>hi</b>',link:'https://estateaegis.com/login#/prospects'});
 assert.doesNotMatch(evil.html,/<img src=x/);assert.match(evil.html,/&lt;img/);
 const acc=renderAcceptedEmail({company:'Harborline',name:'Eleanor Whitcombe',accepted_name:'Eleanor Whitcombe',when:'Oct 4, 2026, 6:00 PM',address:'',monthly_minor:42000,link:'https://x'});
 assert.match(acc.subject,/Quote accepted: Eleanor Whitcombe/);
});

// ---------- menu, routes and Overview ----------
test('sidebar, routes and Overview: Prospects for admins and staff with access only',()=>{
 const S=globalThis.EASidebar,R=globalThis.EARoute,O=globalThis.EAOverview||globalThis.EAOverviewCore;
 const ids=(role,opts)=>S.navFor({role},opts).map(n=>n[0]);
 assert.ok(ids('admin').includes('prospects'),'admins always see Prospects');
 assert.ok(!ids('employee').includes('prospects'),'staff without access do not');
 assert.ok(ids('employee',{prospects:true}).includes('prospects'),'staff with access do');
 for(const role of ['client','vendor','inspector'])assert.ok(!ids(role,{prospects:true}).includes('prospects'),role+' never sees Prospects');
 const res=S.menu(S.navFor({role:'admin'}),'admin').sections.find(s=>s.title==='Residences');
 assert.deepEqual(res.items.map(i=>i.id).slice(0,4),['properties','insurance','clients','prospects'],'in the Residences group, next to Client families');
 assert.equal(S.groupCount(res,{prospects:3}),3,'overdue follow-ups count on the collapsed group');
 assert.equal(R.toHash({page:'prospects'}),'#/prospects');assert.equal(R.toHash({page:'prospects',prospectId:'abc'}),'#/prospects/abc');
 assert.deepEqual([R.parse('#/prospects/abc').page,R.parse('#/prospects/abc').prospectId],['prospects','abc']);
 const req=R.parse('#/prospects');
 assert.equal(R.resolve(req,{user:{role:'admin'},prospects:{access:true}}).fellBack,false);
 assert.equal(R.resolve(req,{user:{role:'employee'},prospects:{access:true}}).fellBack,false);
 assert.equal(R.resolve(req,{user:{role:'employee'}}).fellBack,true);
 for(const role of ['client','vendor','inspector'])assert.equal(R.resolve(req,{user:{role},prospects:{access:true}}).fellBack,true,role);
 const core=globalThis.EAOverviewCore||globalThis.EAOverview;
 if(core?.attention){
  const att=core.attention({user:{id:'u1',role:'admin'},properties:[],inspections:[],work:[],requests:[],prospects:{access:true,due:[{id:'p1',name:'Eleanor Whitcombe',stage:'contacted',stage_label:'Contacted',next_follow_up:'2026-10-01',follow_up:'overdue',mine:true}]}},{today:'2026-10-04'});
  const item=att.items.find(i=>i.group==='prospects');assert.ok(item,'follow-ups appear in Needs your attention');assert.equal(item.action.name,'prospect-open');assert.match(item.pill,/3 days late/);
  assert.ok(att.primary.some(i=>i.group==='prospects'));assert.equal(core.GROUP_TITLES.prospects,'Prospect follow-ups');
  assert.match(core.summary(att,[],{today:'2026-10-04'}).line,/1 prospect follow-up/);
 }
});

test('assets: Prospects files are wired into the app shell, offline cache, check script and public pages',()=>{
 const live=read('public/live.html'),sw=read('public/sw.js'),server=read('server.mjs'),pkg=read('package.json');
 for(const f of ['prospects.js','prospects.css']){assert.match(live,new RegExp('/'+f.replace('.','\\.')+'\\?v='));assert.ok(sw.includes("'/"+f+"'"));assert.ok(server.includes("'"+f+"'"));}
 assert.ok(live.indexOf('/prospects.js')<live.indexOf('/view-route.js'),'prospects.js loads before view-route.js');
 for(const f of ['prospects.mjs','public/prospects.js','public/quote-form.js','public/quote-view.js'])assert.ok(pkg.includes('node --check '+f),f);
 const form=read('public/quote-form.html')+read('public/quote-form.js'),view=read('public/quote-view.html')+read('public/quote-view.js');
 for(const page of [form,view]){assert.doesNotMatch(page,/<script>[^<]|style="/,'no inline scripts or styles (CSP)');assert.match(page,/Powered by EstateAegis/);assert.doesNotMatch(page,/free trial|start your|pricing|home watch software/i);}
 assert.match(read('public/quote-form.js'),/name="website"[^>]*tabindex="-1"/,'honeypot field is out of the tab order');
 const css=read('public/prospects.css')+read('public/quote-public.css');assert.doesNotMatch(css,/overflow(-x|-y)?:\s*(auto|scroll)/,'no scrolling boxes');assert.match(css,/#8b242b/);
 assert.doesNotMatch(read('migrations/047_prospects.sql'),/SERIAL|AUTOINCREMENT|BOOLEAN|JSONB|TIMESTAMP/i,'portable column types only');
});

// ---------- follow-up reminders and company cap (module, SQLite + PGlite) ----------
async function moduleScenario(env){
 const db=await openDatabase(root,env);
 try{
  const at='2026-10-04T15:00:00.000Z',ids={n:0};const id=()=>'id-'+(++ids.n);
  for(const [org,name] of [['o1','Harborline Home Watch'],['o2','Rival Watch']]){await db.run('INSERT INTO organizations VALUES(?,?,?)',org,name,at);}
  const user=(uid,org,role,active=1)=>db.run('INSERT INTO users(id,organization_id,name,email,password_hash,role,created_at,active) VALUES(?,?,?,?,?,?,?,?)',uid,org,uid,uid+'@example.test','x',role,at,active);
  await user('admin1','o1','admin');await user('admin2','o1','admin');await user('casey','o1','employee');await user('rival','o2','admin');
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  const P=createProspects({get:db.get,all:db.all,run:db.run,transaction:db.transaction,id,now:()=>at,fail,json:()=>{},body:async r=>r.body,audit:async()=>{},insertClient:async()=>'c',insertProperty:async()=>'p',afterAddressSave:async()=>{}},{env:{},limits:{formPerIp:100,formPerCompany:2}});
  const ins=(pid,org,f)=>db.run("INSERT INTO prospects(id,organization_id,name,stage,next_follow_up,assigned_to,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",pid,org,pid,f.stage||'contacted',f.due||null,f.to||null,at,at);
  await ins('due-today','o1',{due:'2026-10-04'});await ins('late','o1',{due:'2026-10-01',to:'casey'});await ins('mine','o1',{due:'2026-10-02',to:'admin2'});
  await ins('future','o1',{due:'2026-10-06'});await ins('won','o1',{due:'2026-10-01',stage:'won'});await ins('rival-late','o2',{due:'2026-10-02'});
  const r1=await P.tick(at);
  const notes=await db.all("SELECT user_id,entity_id,title FROM notifications WHERE kind='prospect_followup' ORDER BY entity_id,user_id");
  const by=e=>notes.filter(n=>n.entity_id===e).map(n=>n.user_id).sort();
  assert.deepEqual(by('due-today'),['admin1','admin2'],'unassigned: every administrator');
  assert.deepEqual(by('late'),['admin1','admin2'],'assigned to staff without Prospects access: administrators instead');
  assert.deepEqual(by('mine'),['admin2'],'assigned: only the assignee');
  assert.deepEqual(by('future'),[]);assert.deepEqual(by('won'),[],'closed prospects never remind');assert.deepEqual(by('rival-late'),['rival'],'each company only alerts its own people');
  assert.match(notes.find(n=>n.entity_id==='late').title,/Follow-up overdue: late/);assert.match(notes.find(n=>n.entity_id==='due-today').title,/Follow up today/);
  assert.equal(r1.sent,6);
  assert.equal((await P.tick(at)).sent,0,'once per prospect per follow-up date');
  await db.run("INSERT INTO prospect_staff(organization_id,user_id,granted_at) VALUES('o1','casey',?)",at);
  await db.run("UPDATE prospects SET next_follow_up='2026-10-03' WHERE id='late'");
  assert.equal((await P.tick(at)).sent,1,'a new follow-up date reminds again, now to the assignee who has access');
  assert.deepEqual((await db.all("SELECT user_id FROM notifications WHERE entity_id='late' AND body LIKE '%Oct 3, 2026%'")).map(r=>r.user_id),['casey']);
  // Overview/bell summary for one user only covers their company.
  const d=await P.decorate({id:'admin1',organization_id:'o1',role:'admin'},{});
  assert.equal(d.prospects.access,true);assert.equal(d.prospects.overdue,2);assert.equal(d.prospects.dueToday,1);assert.ok(!d.prospects.due.some(p=>p.id==='rival-late'));
  assert.equal((await P.decorate({id:'casey',organization_id:'o1',role:'employee'},{})).prospects.access,true);
  assert.equal((await P.decorate({id:'rival',organization_id:'o2',role:'client'},{})).prospects,undefined,'families get nothing');
  // Per-company cap on the public form (limits.formPerCompany=2 here); honeypot hits do not use up the company's quota.
  const post=async(slug,b,ip)=>{const out={status:0,body:null};try{await P.handlePublic({method:'POST',headers:{'x-forwarded-for':ip},socket:{},body:b},out,new URL('http://x/api/public/quote-form/'+slug));}catch(e){out.status=e.status;out.error=e.message;}return out;};
  P2:{
   const sent=[];const P2=createProspects({get:db.get,all:db.all,run:db.run,transaction:db.transaction,id,now:()=>at,fail,json:(res,status,body)=>{res.status=status;res.body=body;sent.push(status);},body:async r=>r.body,audit:async()=>{}},{env:{},limits:{formPerIp:100,formPerCompany:2}});
   const post2=async(slug,b,ip)=>{const out={status:0,body:null};try{await P2.handlePublic({method:'POST',headers:{'x-forwarded-for':ip},socket:{},body:b},out,new URL('http://x/api/public/quote-form/'+slug));}catch(e){out.status=e.status;out.error=e.message;}return out;};
   assert.equal((await post2('harborline-home-watch',{name:'Bot',email:'b@x.co',website:'x'},'1.1.1.1')).status,201);
   assert.equal((await post2('harborline-home-watch',{name:'Ann Lead',email:'a@x.co'},'1.1.1.2')).status,201);
   assert.equal((await post2('harborline-home-watch',{name:'Ben Lead',phone:'239 555 0100'},'1.1.1.3')).status,201);
   const capped=await post2('harborline-home-watch',{name:'Cy Lead',email:'c@x.co'},'1.1.1.4');assert.equal(capped.status,429);assert.match(capped.error,/a lot of requests/);
   assert.equal((await post2('rival-watch',{name:'Dee Lead',email:'d@x.co'},'1.1.1.5')).status,201,'the cap is per company');
   assert.equal((await db.get("SELECT COUNT(*) n FROM prospects WHERE organization_id='o1' AND source='website'")).n,2);
   const emails=await db.all("SELECT email FROM email_outbox WHERE organization_id='o1' ORDER BY email");assert.deepEqual([...new Set(emails.map(e=>e.email))],['admin1@example.test','admin2@example.test'],'active administrators get the lead email');
   void post;
  }
 }finally{await db.close();}
}
test('follow-up reminders (once per date, assignee or administrators) and the per-company form cap (SQLite)',()=>moduleScenario({ESTATEOS_DATA_DIR:tmp()}));
test('follow-up reminders (once per date, assignee or administrators) and the per-company form cap (Postgres/PGlite)',()=>{const d=tmp();return moduleScenario({ESTATEOS_DATA_DIR:d,NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')});});

// ---------- API scenario (SQLite and PGlite) ----------
function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',RESEND_API_KEY:'',DATABASE_URL:'',RENDER:'',ESTATEOS_SECURE_COOKIES:'',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv,ip){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...(ip?{'X-Forwarded-For':ip}:{}),...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];let body={};try{body=await res.json();}catch{}return {status:res.status,body,headers:res.headers};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body).slice(0,300)}`);return r.body;}};return c;}

async function apiScenario(label,env){
 const dir=tmp();
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});
 await srv.start();
 try{
  const admin=client(srv),staff=client(srv),other=client(srv),family=client(srv),vendor=client(srv),rival=client(srv),anon=client(srv,'203.0.113.10');
  const company='Harborline Home Watch '+label,slug=slugOf(company);
  await admin.req('setup',{company,name:'Jordan Ellis',email:'jordan@harborline.example',password:pw},201);
  const setup=await admin.req('login',{email:'jordan@harborline.example',password:pw});
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});await admin.req('login',{email:'jordan@harborline.example',password:pw});
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const fam=await admin.req('clients',{name:'Marchetti family'},201);
  const casey=(await accept(staff,'employee','casey@harborline.example','Casey Morgan')).user;const otto=(await accept(other,'employee','otto@harborline.example','Otto Reyes')).user;
  await accept(family,'client','marchetti@family.example','Lucia Marchetti',{clientId:fam.id});
  const vend=await admin.req('vendors',{name:'Gulf Pool Care'},201);await accept(vendor,'vendor','pool@vendor.example','Pat Pool',{vendorId:vend.id});
  const inviteB=await admin.req('platform/invite',{company:'Rival Watch Co',email:'rival@example.test'},201);
  await rival.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);

  // ---- permissions: signed out 401; families, vendors and staff without access 403.
  await anon.req('prospects',undefined,401);await anon.req('prospects',{name:'X'},401);
  await family.req('prospects',undefined,403);await vendor.req('prospects',undefined,403);await staff.req('prospects',undefined,403);
  assert.equal((await staff.req('data')).prospects,undefined,'staff without access get no Prospects data');
  assert.equal((await family.req('data')).prospects,undefined);assert.equal((await vendor.req('data')).prospects,undefined);
  await staff.req('prospects/staff',{userId:casey.id,access:true},403);
  await admin.req('prospects/staff',{userId:casey.id,access:true});
  assert.equal((await staff.req('data')).prospects.access,true);
  const list0=await staff.req('prospects');assert.equal(list0.admin,false);assert.equal(list0.employees,undefined,'only admins see the staff access list');
  assert.equal((await admin.req('prospects')).employees.find(u=>u.id===casey.id).access,true);
  assert.equal((await admin.req('prospects')).settings.path,'/quote/'+slug);

  // ---- create + validation
  await admin.req('prospects',{name:''},422);await admin.req('prospects',{name:'A',email:'nope'},422);
  await admin.req('prospects',{name:'A',postalCode:'123'},422);await admin.req('prospects',{name:'A',stage:'won'},422);
  await admin.req('prospects',{name:'A',source:'billboard'},422);await admin.req('prospects',{name:'A',monthlyValue:'-5'},422);
  await admin.req('prospects',{name:'A',assignedTo:otto.id},422,undefined);
  const ashby=await staff.req('prospects',{name:'Margaret Ashby',email:'ashby@family.example',phone:'(239) 555-0144',streetAddress:'8 Heron Way',city:'Sarasota',state:'FL',postalCode:'34236',source:'referral',monthlyValue:'385',nextFollowUp:'2026-10-02',assignedTo:casey.id,note:'Referred by the Pembertons.'},201);
  let d=await admin.req('prospects/'+ashby.id);
  assert.equal(d.prospect.stage,'new');assert.equal(d.prospect.monthly_value_minor,38500);assert.equal(d.prospect.assigned_name,'Casey Morgan');assert.equal(d.prospect.follow_up,'overdue');
  assert.ok(d.notes.some(n=>n.body==='Referred by the Pembertons.'));assert.equal(d.canConvert,false);
  // ---- stages
  await staff.req('prospects/'+ashby.id+'/stage',{stage:'nope'},422);
  await staff.req('prospects/'+ashby.id+'/stage',{stage:'contacted',version:d.prospect.version});
  await staff.req('prospects/'+ashby.id+'/stage',{stage:'walkthrough',version:d.prospect.version},409,);
  d=await staff.req('prospects/'+ashby.id);assert.equal(d.prospect.stage,'contacted');assert.ok(d.notes.some(n=>n.kind==='stage'&&/New to Contacted/.test(n.body)));
  await staff.req('prospects/'+ashby.id+'/stage',{stage:'lost',lostReason:'Chose to stay year-round'});
  d=await staff.req('prospects/'+ashby.id);assert.equal(d.prospect.stage,'lost');assert.equal(d.prospect.lost_reason,'Chose to stay year-round');assert.equal(d.prospect.follow_up,null,'lost prospects have no overdue follow-up');
  await staff.req('prospects/'+ashby.id+'/stage',{stage:'walkthrough'});
  await staff.req('prospects/'+ashby.id,{nextFollowUp:'2026-02-30'},422);
  await staff.req('prospects/'+ashby.id,{nextFollowUp:addDays(localDay(new Date().toISOString(),'America/New_York'),2)});
  await staff.req('prospects/'+ashby.id+'/notes',{body:''},422);await staff.req('prospects/'+ashby.id+'/notes',{body:'Walkthrough booked for Thursday.'},201);
  d=await staff.req('prospects/'+ashby.id);assert.equal(d.prospect.stage,'walkthrough');assert.equal(d.prospect.follow_up,'upcoming');assert.ok(d.notes.some(n=>n.body==='Walkthrough booked for Thursday.'&&n.author_name==='Casey Morgan'));
  const caseyBell=(await staff.req('data')).notifications||[];assert.equal(caseyBell.some(n=>n.kind==='prospect_assigned'),false,'no notification for assigning yourself');
  await admin.req('prospects/'+ashby.id,{assignedTo:''});await admin.req('prospects/'+ashby.id,{assignedTo:casey.id});
  assert.ok(((await staff.req('data')).notifications||[]).some(n=>n.kind==='prospect_assigned'&&n.entity_id===ashby.id),'the assignee is notified');

  // ---- public quote request form
  const page=await fetch(srv.base+'/quote/'+slug);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('x-frame-options'),'DENY');assert.match(page.headers.get('x-robots-tag')||'',/noindex/);
  const embed=await fetch(srv.base+'/quote/'+slug+'?embed=1');assert.match(embed.headers.get('content-security-policy'),/frame-ancestors \*/);assert.equal(embed.headers.get('x-frame-options'),null,'only the embed form can be framed');
  assert.equal((await fetch(srv.base+'/quotes/'+'a'.repeat(43))).status,200);
  const info=await anon.req('public/quote-form/'+slug);assert.equal(info.company,company);assert.equal(info.enabled,true);assert.equal(info.logo,'');
  await anon.req('public/quote-form/no-such-company',undefined,404);
  const ip=n=>client(srv,'198.51.100.'+n);
  const visitor=ip(1);
  await visitor.req('public/quote-form/'+slug,{name:'',email:'x@y.co'},422);
  await visitor.req('public/quote-form/'+slug,{name:'Only Name'},422);
  await visitor.req('public/quote-form/'+slug,{name:'Bad Zip',email:'z@y.co',postalCode:'ABCDE'},422);
  const before=(await admin.req('prospects')).prospects.length;
  assert.deepEqual(await ip(2).req('public/quote-form/'+slug,{name:'Spam Bot',email:'bot@spam.example',website:'http://spam.example'},201),{received:true},'honeypot: same thank-you');
  assert.equal((await admin.req('prospects')).prospects.length,before,'honeypot submissions are not stored');
  // Same-origin and JSON rules apply to the public form like every other write.
  assert.equal((await ip(3).call('POST','public/quote-form/'+slug,{name:'X',email:'x@y.co'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await ip(3).call('POST','public/quote-form/'+slug,{name:'X',email:'x@y.co'},{'Content-Type':'text/plain'})).status,415);
  await ip(4).req('public/quote-form/'+slug,{name:'Eleanor Whitcombe',email:'eleanor@family.example',phone:'239-555-0101',streetAddress:'14 Seagrape Lane',city:'Naples',state:'FL',postalCode:'34102',message:'Away November to April. Weekly checks please.'},201);
  let all=(await admin.req('prospects')).prospects;const ele=all.find(p=>p.name==='Eleanor Whitcombe');
  assert.equal(ele.stage,'new');assert.equal(ele.source,'website');assert.equal(ele.message,'Away November to April. Weekly checks please.');
  assert.equal((await rival.req('prospects')).prospects.length,0,'leads land only in the company whose form was used');
  const bell=(await admin.req('data')).notifications;assert.ok(bell.some(n=>n.kind==='prospect_new'&&n.entity_id===ele.id&&/New quote request: Eleanor Whitcombe/.test(n.title)),'admins get an in-app notification');
  assert.equal(((await staff.req('data')).notifications||[]).some(n=>n.kind==='prospect_new'),false,'staff are not emailed or notified about new leads');
  // Rate limit: 5 requests per connection in 10 minutes (validation failures count too).
  const flood=ip(9);for(let i=0;i<5;i++)await flood.req('public/quote-form/'+slug,{name:'Flood '+i,email:`f${i}@x.co`},201);
  const blocked=await flood.call('POST','public/quote-form/'+slug,{name:'Flood 6',email:'f6@x.co'});assert.equal(blocked.status,429);
  await ip(10).req('public/quote-form/'+slug,{name:'Different Connection',phone:'941 555 0199'},201);
  // Form off: the page says so and posts are refused.
  await staff.req('prospects/settings',{form_enabled:false},403);
  await admin.req('prospects/settings',{form_enabled:false,form_intro:'We serve the Gulf Coast.'});
  assert.equal((await anon.req('public/quote-form/'+slug)).enabled,false);
  await ip(11).req('public/quote-form/'+slug,{name:'Late',email:'l@x.co'},403);
  await admin.req('prospects/settings',{form_enabled:true});assert.equal((await anon.req('public/quote-form/'+slug)).intro,'We serve the Gulf Coast.');

  // ---- quotes and online acceptance
  await staff.req('prospects/'+ele.id+'/quotes',{frequency:'Weekly',monthly:''},422);
  await staff.req('prospects/'+ele.id+'/quotes',{frequency:'',monthly:'420'},422);
  await staff.req('prospects/'+ele.id+'/quotes',{frequency:'Weekly',monthly:'420',items:[{label:''}]},422);
  const q1=await staff.req('prospects/'+ele.id+'/quotes',{planName:'Seasonal Watch',frequency:'Weekly',monthly:'420',items:[{label:'Interior and exterior walkthrough',amount:''},{label:'Storm preparation',amount:'0'}],notes:'Includes key holding.'},201);
  await staff.req('prospects/'+ele.id+'/quotes',{quoteId:q1.id,planName:'Seasonal Watch',frequency:'Weekly',monthly:'425',items:[{label:'Interior and exterior walkthrough'}]});
  await rival.req('prospects/quotes/'+q1.id+'/send',{},404);
  const sent1=await staff.req('prospects/quotes/'+q1.id+'/send',{email:'eleanor@family.example'});
  assert.equal(sent1.emailed,true);assert.match(sent1.path,/^\/quotes\/[A-Za-z0-9_-]{43}$/);
  await staff.req('prospects/'+ele.id+'/quotes',{quoteId:q1.id,frequency:'Weekly',monthly:'1'},409);
  d=await admin.req('prospects/'+ele.id);assert.equal(d.prospect.stage,'quote_sent','sending moves the prospect to Quote sent');assert.equal(d.quotes[0].status,'sent');assert.equal(d.quotes[0].monthly_minor,42500);
  const tok1=sent1.path.split('/').pop();
  // Resend: a new link; the old one stops working.
  const sent2=await staff.req('prospects/quotes/'+q1.id+'/send',{email:''});assert.equal(sent2.emailed,false);
  const tok2=sent2.path.split('/').pop();
  await anon.req('public/quotes/'+tok1,undefined,404);
  await anon.req('public/quotes/'+'Z'.repeat(43),undefined,404);await anon.req('public/quotes/short',undefined,404);
  const pub=await anon.req('public/quotes/'+tok2);
  assert.equal(pub.quote.company,company);assert.equal(pub.quote.monthly_minor,42500);assert.equal(pub.quote.prospect.name,'Eleanor Whitcombe');assert.equal(pub.quote.accepted,null);
  assert.equal(JSON.stringify(pub).includes('Away November'),false,'the public page never shows the lead message or office notes');
  assert.equal(JSON.stringify(pub).includes('ip'),false);
  await anon.req('public/quotes/'+tok2+'/accept',{name:'Eleanor Whitcombe'},422);
  await anon.req('public/quotes/'+tok2+'/accept',{name:'',agree:true},422);
  assert.equal((await anon.call('POST','public/quotes/'+tok2+'/accept',{name:'E W',agree:true},{Origin:'https://evil.example'})).status,403);
  const acc=await anon.req('public/quotes/'+tok2+'/accept',{name:'Eleanor Whitcombe',agree:true},200,{'User-Agent':'Mozilla/5.0 (iPhone) Test'});
  assert.equal(acc.accepted_name,'Eleanor Whitcombe');
  await anon.req('public/quotes/'+tok2+'/accept',{name:'Someone Else',agree:true},409);
  assert.equal((await anon.req('public/quotes/'+tok2)).quote.accepted.name,'Eleanor Whitcombe');
  d=await admin.req('prospects/'+ele.id);
  assert.equal(d.prospect.stage,'won','accepting moves the prospect to Won');assert.ok(d.prospect.won_at);
  const qa=d.quotes.find(q=>q.id===q1.id);assert.equal(qa.status,'accepted');assert.equal(qa.accepted_name,'Eleanor Whitcombe');assert.equal(qa.accepted_ip,'203.0.113.10');assert.equal(qa.accepted_user_agent,'Mozilla/5.0 (iPhone) Test');assert.ok(qa.accepted_at);
  assert.ok((await admin.req('data')).notifications.some(n=>n.kind==='prospect_won'&&n.entity_id===ele.id));
  assert.equal(d.canConvert,true);assert.equal((await staff.req('prospects/'+ele.id)).canConvert,false,'staff cannot convert');
  // Withdrawn quotes are gone for the prospect.
  const q2=await staff.req('prospects/'+ashby.id+'/quotes',{frequency:'Every two weeks',monthly:'300'},201);const s2=await staff.req('prospects/quotes/'+q2.id+'/send',{});
  await staff.req('prospects/quotes/'+q2.id+'/withdraw',{});await anon.req('public/quotes/'+s2.path.split('/').pop(),undefined,410);
  await anon.req('public/quotes/'+s2.path.split('/').pop()+'/accept',{name:'Margaret Ashby',agree:true},410);

  // ---- company isolation
  for(const [ep,b] of [['prospects/'+ele.id,undefined],['prospects/'+ele.id,{name:'Hijack'}],['prospects/'+ele.id+'/stage',{stage:'lost'}],['prospects/'+ele.id+'/notes',{body:'x'}],['prospects/'+ele.id+'/quotes',{frequency:'Weekly',monthly:'1'}],['prospects/'+ele.id+'/convert',{}],['prospects/'+ele.id+'/delete',{}],['prospects/quotes/'+q1.id+'/withdraw',{}]])await rival.req(ep,b,404);
  await rival.req('prospects/staff',{userId:casey.id,access:false},404);
  const rp=await rival.req('prospects',{name:'Rival Lead'},201);await admin.req('prospects/'+rp.id,undefined,404);await staff.req('prospects/'+rp.id+'/stage',{stage:'won'},404);

  // ---- convert
  await admin.req('prospects/'+ashby.id+'/convert',{},409);
  await staff.req('prospects/'+ele.id+'/convert',{},403);
  const conv=await admin.req('prospects/'+ele.id+'/convert',{familyName:'Whitcombe family',residenceName:'Seagrape House'});
  const data=await admin.req('data');
  const newFam=data.clients.find(c=>c.id===conv.clientId),home=data.properties.find(p=>p.id===conv.propertyId);
  assert.equal(newFam.name,'Whitcombe family');assert.equal(newFam.email,'eleanor@family.example');assert.equal(newFam.phone,'239-555-0101');
  assert.equal(home.name,'Seagrape House');assert.equal(home.client_id,conv.clientId);assert.match(home.address,/14 Seagrape Lane, Naples, FL 34102/);
  const note=data.notes.find(n=>n.property_id===conv.propertyId);assert.match(note.body,/Converted from Prospects/);assert.match(note.body,/Away November to April/);assert.match(note.body,/Accepted by Eleanor Whitcombe/);
  d=await admin.req('prospects/'+ele.id);assert.equal(d.prospect.client_id,conv.clientId);assert.equal(d.prospect.property_id,conv.propertyId);assert.ok(d.prospect.converted_at);assert.equal(d.canConvert,false);
  await admin.req('prospects/'+ele.id+'/convert',{},409);await admin.req('prospects/'+ele.id+'/stage',{stage:'lost'},409);await admin.req('prospects/'+ele.id+'/delete',{},409);
  // A won prospect without an address cannot be converted.
  const noAddr=await admin.req('prospects',{name:'Theo Pemberton',phone:'239 555 0170'},201);await admin.req('prospects/'+noAddr.id+'/stage',{stage:'won'});
  await admin.req('prospects/'+noAddr.id+'/convert',{},422);
  // Staff access removed: back to 403.
  await admin.req('prospects/staff',{userId:casey.id,access:false});await staff.req('prospects',undefined,403);
  // Delete (admins only).
  await admin.req('prospects/'+noAddr.id+'/delete',{});await admin.req('prospects/'+noAddr.id,undefined,404);
  return {srv,dir,admin,slug};
 }catch(e){e.message+='\n'+srv.log.slice(-2000);await srv.stop();throw e;}
}
test('API: stages, public form, spam protection, quotes, acceptance, conversion, permissions and isolation (SQLite)',async()=>{
 const {srv,dir,admin}=await apiScenario('S',{});
 try{
  // Expired quote (set the date in the database) can be viewed but not accepted.
  const p=await admin.req('prospects',{name:'Clara Halvorsen',email:'clara@trust.example',streetAddress:'2 Bay Rd',city:'Mystic',state:'CT',postalCode:'06355'},201);
  const q=await admin.req('prospects/'+p.id+'/quotes',{frequency:'Monthly',monthly:'190'},201);const s=await admin.req('prospects/quotes/'+q.id+'/send',{});
  const db=new DatabaseSync(path.join(dir,'estateos.sqlite'));db.exec('PRAGMA busy_timeout=5000');db.prepare("UPDATE prospect_quotes SET valid_until='2026-01-01' WHERE id=?").run(q.id);
  const anon=client(srv,'192.0.2.50'),tok=s.path.split('/').pop();
  assert.equal((await anon.req('public/quotes/'+tok)).quote.expired,true);await anon.req('public/quotes/'+tok+'/accept',{name:'Clara Halvorsen',agree:true},410);
  // The prospect email and the admin lead email went through the outbox; nothing goes to a company's demo/suspended state here.
  const out=db.prepare("SELECT email,subject,user_id FROM email_outbox ORDER BY created_at").all();
  assert.ok(out.some(r=>r.email==='eleanor@family.example'&&r.subject==='Your home watch quote from Harborline Home Watch S'&&r.user_id===null),'quote email to the prospect');
  assert.ok(out.some(r=>r.email==='jordan@harborline.example'&&/New quote request: Eleanor Whitcombe/.test(r.subject)),'lead email to administrators');
  assert.ok(out.some(r=>r.email==='jordan@harborline.example'&&/Quote accepted: Eleanor Whitcombe/.test(r.subject)),'acceptance email to administrators');
  // Plan residence limit: converting respects billing.assertCapacity and rolls back the family too.
  const w=await admin.req('prospects',{name:'Victor Okafor',email:'v@ok.example',streetAddress:'5 Palm Ct',city:'Naples',state:'FL',postalCode:'34103'},201);await admin.req('prospects/'+w.id+'/stage',{stage:'won'});
  const org=db.prepare("SELECT organization_id FROM users WHERE email='jordan@harborline.example'").get().organization_id;
  const clientsBefore=db.prepare('SELECT COUNT(*) n FROM clients WHERE organization_id=?').get(org).n;
  db.prepare("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES(?,?,?,'past_due','essentials',0,0,?)").run(org,'cus_t','sub_t',new Date().toISOString());
  const blocked=await admin.call('POST','prospects/'+w.id+'/convert',{});assert.equal(blocked.status,409);assert.match(blocked.body.error,/subscription|residences/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients WHERE organization_id=?').get(org).n,clientsBefore,'no half-created family when the plan limit blocks the residence');
  assert.equal(db.prepare('SELECT converted_at FROM prospects WHERE id=?').get(w.id).converted_at,null);
  db.prepare("UPDATE stripe_billing SET status='active' WHERE organization_id=?").run(org);
  const ok=await admin.req('prospects/'+w.id+'/convert',{});assert.ok(ok.propertyId);
  // Audit trail for public actions.
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE actor_id='quote-form' AND action='prospect.form_submitted'").get());assert.ok(db.prepare("SELECT 1 FROM audit WHERE actor_id='quote-acceptance' AND action='prospect.quote_accepted'").get());
  db.close();
 }finally{await srv.stop();}
});
test('API: stages, public form, spam protection, quotes, acceptance, conversion, permissions and isolation (Postgres/PGlite)',async()=>{
 const {srv}=await apiScenario('P',{pg:true});await srv.stop();
});
