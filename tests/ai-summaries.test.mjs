// AI inspection summaries: redaction, leak scan and coverage rules, the OpenAI provider against a local stand-in
// (strict schema, store:false, retries, refusals, timeouts, malformed answers), and the HTTP API on SQLite and Postgres
// (PGlite): both switches, permissions, company isolation, idempotency, rate limits, the monthly cap under concurrency,
// the review gate on publish and auto-publish, the PDF label, usage, and that the API key never leaves the server.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {knownTerms,redact,leakScan,coverage,buildInput,parseAnswer,summaryHash,SCHEMA} from '../ai-core.mjs';
import {createAiProvider,aiModel,DEFAULT_MODEL} from '../ai-provider.mjs';
import {inspectionPdf} from '../pdf.mjs';
import {startOpenAiMock} from './openai-mock.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw='Test-only-strong-password-928!';
const FAKE_KEY='sk-test-FAKEKEY-must-never-leave-0123456789';
const builtIn=JSON.parse(readFileSync(path.join(root,'inspection-template.json'),'utf8'));
const dirs=[],mocks=[];after(async()=>{for(const m of mocks)await m.close();for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-ai-'));dirs.push(d);return d;};
const mock=async()=>{const m=await startOpenAiMock();mocks.push(m);return m;};
const words=pdf=>[...pdf.matchAll(/\((.*?)\) Tj/g)].map(m=>m[1].replace(/\\([()\\])/g,'$1')).join(' ');
const terms=knownTerms({company:'Coastal Estate Care',people:['Casey Morgan','Jordan Lee'],places:['Ocean Villa'],addresses:['12 Palm Way, Naples, FL 34102']});

// ---------- pure rules ----------
test('redaction removes contact details, codes, addresses and known names',()=>{
 const out=redact('Casey said the gate code is 4471 and the alarm pin 9911#. Call 239-555-0101 or casey@example.com, see https://x.example/a. Ocean Villa at 12 Palm Way; Coastal Estate Care team; Jordan checked. Ref 12345678. Lockbox AB1234.',terms);
 for(const bad of ['Casey','4471','9911','239-555','casey@','https://','Ocean Villa','Palm Way','Coastal Estate Care','Jordan','12345678','AB1234'])assert.ok(!out.includes(bad),`${bad} in: ${out}`);
 assert.match(out,/gate code is \[code\]/);assert.match(out,/\[phone\]/);assert.match(out,/\[email\]/);assert.match(out,/\[link\]/);assert.match(out,/the residence at \[address\]/);assert.match(out,/our team/);
 assert.equal(redact('The back door on the 2nd floor was latched; 3 windows checked at 72 °F.',terms),'The back door on the 2nd floor was latched; 3 windows checked at 72 °F.','ordinary words and small numbers survive');
});

test('leak scan catches names, codes and contact details in model output, not ordinary text',()=>{
 assert.deepEqual(leakScan('The water heater is leaking slightly; we will check it next visit.',terms),[]);
 assert.deepEqual(leakScan('Everything checked at the residence was in good order.',terms),[]);
 assert.ok(leakScan('Morgan noticed a leak.',terms).includes('person'));
 assert.ok(leakScan('Ocean Villa is fine.',terms).includes('place'));
 assert.ok(leakScan('Use gate code 4471.',terms).includes('code'));
 assert.ok(leakScan('Call 239-555-0101.',terms).includes('phone'));
 assert.ok(leakScan('Email a@b.co',terms).includes('email'));
 assert.ok(leakScan('At 12 Palm Way the door was open.',terms).length);
 assert.ok(leakScan('The [code] was used.',terms).includes('placeholder'));
});

test('input builder is an allow-list: no internal notes, names, inspector or coordinates; flags fail, attention and monitor',()=>{
 const answers=builtIn.slice(0,6).map((a,k)=>({...a,status:k===0?'fail':k===1?'monitor':k===2?'attention':k===3?'unchecked':'pass',note:k===0?'Casey Morgan saw a drip; gate code 4471':k===1?'Slight rust':''}));
 const {input,flagged,checked}=buildInput({inspection:{visit_type:'routine',inspection_date:'2026-10-04',notes:'Jordan Lee left the keys at 12 Palm Way.',internal_notes:'INTERNAL-ONLY',inspector_id:'u1',latitude:26.1},answers,weatherLine:'81 °F, sunny',timezoneLabel:'America/New_York',terms});
 const s=JSON.stringify(input);
 for(const bad of ['INTERNAL-ONLY','Casey','Morgan','Jordan','4471','Palm Way','u1','26.1','latitude'])assert.ok(!s.includes(bad),`${bad} leaked: ${s}`);
 assert.equal(checked,5);assert.deepEqual(flagged.map(f=>f.label),[builtIn[0].label,builtIn[1].label,builtIn[2].label]);
 assert.equal(input.visit_type,'Routine home watch');assert.equal(input.weather_at_visit,'81 °F, sunny');assert.equal(input.overall,'Needs attention');
 assert.ok(input.items.every(i=>i.tone!=='open'),'unchecked items are not sent');
});

test('coverage needs the model claim and the text to agree; answers are validated',()=>{
 const flagged=[{label:'Check water heater',sent:'Check water heater',note:'Slow drip at the valve'},{label:'Inspect roof',sent:'Inspect roof',note:''}];
 assert.deepEqual(coverage('The water heater has a slow drip at the valve. The roof looked fine.',['Check water heater','Inspect roof'],flagged),[]);
 assert.deepEqual(coverage('The water heater has a slow drip.',['Check water heater','Inspect roof'],flagged),['Inspect roof'],'claimed but not in the text');
 assert.deepEqual(coverage('The water heater drips and the roof is worn.',['Check water heater'],flagged),['Inspect roof'],'in the text but not claimed');
 assert.throws(()=>parseAnswer({summary:'x'}),/Malformed/);assert.throws(()=>parseAnswer({summary:'  ',mentioned_items:[]}),/Empty/);
 assert.deepEqual(parseAnswer({summary:' Fine. ',mentioned_items:['a',3]}),{summary:'Fine.',mentioned:['a']});
 assert.equal(summaryHash('a\r\nb '),summaryHash('a\nb'));assert.notEqual(summaryHash('a'),summaryHash('b'));
 assert.equal(SCHEMA.additionalProperties,false);assert.deepEqual(SCHEMA.required,['summary','mentioned_items']);
});

// ---------- provider ----------
test('OpenAI provider: strict schema, store off, low reasoning, retries, refusals, timeouts and no key in errors',async()=>{
 const m=await mock();
 assert.equal(aiModel({}),DEFAULT_MODEL);assert.equal(aiModel({OPENAI_MODEL:'gpt-4.1-mini'}),'gpt-4.1-mini');
 const env={OPENAI_API_KEY:FAKE_KEY,OPENAI_BASE_URL:m.base+'/v1',OPENAI_TIMEOUT_MS:'1000'};
 const p=createAiProvider({env});
 const input={visit_type:'Routine home watch',items:[{section:'Water',label:'Check water heater',result:'Fail',tone:'fail',note:'Slow drip'}]};
 const ok=await p.summarize({instructions:'x',input});
 assert.equal(ok.parsed.mentioned_items[0],'Check water heater');assert.equal(ok.usage.in,180);
 const r=m.requests.at(-1);
 assert.equal(r.path,'/v1/responses');assert.equal(r.auth,'Bearer '+FAKE_KEY);assert.equal(r.body.store,false);assert.equal(r.body.max_output_tokens,800);
 assert.equal(r.body.model,DEFAULT_MODEL);assert.deepEqual(r.body.reasoning,{effort:'low'});assert.equal(r.body.text.format.type,'json_schema');assert.equal(r.body.text.format.strict,true);
 const legacy=createAiProvider({env:{...env,OPENAI_MODEL:'gpt-4.1-mini'}});await legacy.summarize({instructions:'x',input});
 assert.equal(m.requests.at(-1).body.reasoning,undefined,'no reasoning field for non-reasoning models');
 const expectCode=async(s,code,calls)=>{m.set(s);const before=m.requests.length;const e=await p.summarize({instructions:'x',input}).then(()=>null,e=>e);assert.equal(e?.code,code,s);if(calls)assert.equal(m.requests.length-before,calls,s+' calls');assert.ok(!String(e.message).includes(FAKE_KEY)&&!JSON.stringify(e).includes(FAKE_KEY));return e;};
 await expectCode('refusal','refused',1);await expectCode('malformed','malformed',1);await expectCode('incomplete','malformed',1);
 const rl=await expectCode('429','rate_limited',2);assert.equal(rl.beforeResponse,true);
 await expectCode('401','config',1);
 const to=await expectCode('timeout','timeout',1);assert.equal(to.beforeResponse,true);
 m.set('500-once');assert.ok((await p.summarize({instructions:'x',input})).parsed.summary,'one retry after a 5xx');
 m.set('429-once');assert.ok((await p.summarize({instructions:'x',input})).parsed.summary,'one retry after a 429');
 m.set('ok');
 const none=createAiProvider({env:{}});assert.equal(none.configured,false);assert.equal((await none.summarize({instructions:'x',input}).catch(e=>e)).code,'config');
 const fake=createAiProvider({env:{AI_PROVIDER:'fake'}});const f=await fake.summarize({input});assert.equal(fake.name,'fake');assert.match(f.parsed.summary,/Check water heater needs attention: Slow drip\./);
});

test('PDF: AI label only when the report carries it',()=>{
 const base={id:'r1',completedAt:'2026-10-04T15:00:00Z',timezone:'America/New_York',company:'Coastal Estate Care',property:'Ocean Villa',client:'Morgan',date:'2026-10-04',inspector:'Jordan',overall:'Good',summary:'All clear.',answers:[],fileIds:[]};
 const off=words(inspectionPdf(base,[]).toString('latin1'));assert.ok(!off.includes('AI assistance'));
 const on=words(inspectionPdf({...base,aiNote:'Summary drafted with AI assistance and reviewed by Coastal Estate Care.'},[]).toString('latin1'));
 assert.ok(on.includes('Summary drafted with AI assistance and reviewed by Coastal Estate Care.'),on.slice(0,500));
});

// ---------- HTTP API ----------
function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});proc.stdout.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{const on=c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){proc.stdout.off('data',on);resolve(m[0]);}};proc.stdout.on('data',on);proc.once('exit',code=>reject(new Error(`server exited ${code}: ${log}`)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
const seen=[];
function client(srv){let cookie='';const c={
 async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();seen.push(text);let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body};},
 async req(endpoint,b,expected=200,headers){const r=await c.call(b===undefined?'GET':'POST',endpoint,b,headers);assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;},
 raw:endpoint=>fetch(srv.base+'/api/'+endpoint,{headers:{Cookie:cookie}})};return c;}
const filesUnder=d=>readdirSync(d).flatMap(n=>{const p=path.join(d,n);return statSync(p).isDirectory()?filesUnder(p):[p];});

async function apiScenario(label,pg){
 const m=await mock();const dir=tmp();
 const env={ESTATEOS_DATA_DIR:dir,AI_FEATURES_ENABLED:'true',OPENAI_API_KEY:FAKE_KEY,OPENAI_BASE_URL:m.base+'/v1',OPENAI_TIMEOUT_MS:'1500',...(pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})};
 const srv=server(env);await srv.start();
 try{
  const admin=client(srv),employee=client(srv),family=client(srv),vendor=client(srv),outsider=client(srv);
  const setup=await admin.req('setup',{company:'Coastal Estate Care '+label,name:'Avery Quinn',email:'owner@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'owner@example.test',password:pw});
  const fam=await admin.req('clients',{name:'Morgan Family',firstName:'Casey',lastName:'Morgan',streetAddress:'40 Harbor Lane'},201);
  const villa=await admin.req('properties',{clientId:fam.id,name:'Ocean Villa',streetAddress:'12 Palm Way',city:'Naples',state:'FL',postalCode:'34102',country:'United States'},201);
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const emp=await accept(employee,'employee','tech@example.test','Jordan Lee');await accept(family,'client','fam@example.test','Casey Morgan',{clientId:fam.id});
  const vend=await admin.req('vendors',{name:'Pool Co'},201);await accept(vendor,'vendor','vendor@example.test','Pat Vendor',{vendorId:vend.id});
  await admin.req('access',{userId:emp.user.id,propertyId:villa.id},201);
  const inviteB=await admin.req('platform/invite',{company:'Rival Co',email:'rival@example.test'},201);
  await outsider.req('workspace-register',{token:new URL('http://x'+inviteB.invitePath).searchParams.get('workspaceInvite'),name:'Rival',password:pw},201);

  // Company switch off by default.
  let d=await admin.req('data');assert.deepEqual({s:d.ai.serverEnabled,e:d.ai.enabled,a:d.ai.available},{s:true,e:false,a:false});
  assert.equal('ai' in await family.req('data'),false);assert.equal('ai' in await vendor.req('data'),false);
  const find=async(c,id)=>(await c.req('data')).inspections.find(i=>i.id===id);
  const today=new Date().toISOString().slice(0,10);
  const answersWith=()=>builtIn.map((a,k)=>({...a,status:k===0?'attention':k===1?'monitor':'pass',note:k===0?'Casey Morgan reported a drip; gate code 4471; call 239-555-0101':k===1?'Light rust on the valve':''}));
  const visit=async(c=employee)=>{const id=(await c.req('inspections',{propertyId:villa.id,date:today},201)).id;const i=await find(c,id);await c.req('inspections/save',{id,version:i.version,answers:answersWith(),summary:'',notes:'Jordan Lee left the spare keys at 12 Palm Way.',internalNotes:'INTERNAL-SECRET alarm 9911'},201);return id;};
  const gen=(c,id,expected=200,key=randomUUID())=>c.req(`inspections/${id}/ai-summary`,{idempotencyKey:key},expected);
  const A=await visit();
  const off=await gen(employee,A,403);assert.match(off.error,/admin can turn on/);
  await employee.req('settings/ai',undefined,403);await employee.req('settings/ai',{enabled:true},403);await family.req('settings/ai',undefined,403);
  for(const bad of [{enabled:'maybe'},{monthly_cap:-1},{monthly_cap:301},{monthly_cap:2.5},{label_reports:'x'}])await admin.req('settings/ai',bad,422);
  const s=await admin.req('settings/ai',{enabled:true});assert.equal(s.settings.enabled,true);assert.equal(s.cap,300);assert.equal(s.model,'gpt-5.4-mini');
  assert.ok(s.privacy.includes('OpenAI, our AI subprocessor')&&s.privacy.includes('names, addresses and access codes removed'));
  assert.ok(!JSON.stringify(s).includes(FAKE_KEY));

  // Draft: allow-listed and redacted input, strict schema, store off.
  const r1=await gen(employee,A);
  assert.equal(r1.draft.status,'ready');assert.deepEqual(r1.draft.missing,[]);assert.match(r1.draft.text,new RegExp(builtIn[0].label.slice(0,12)));
  assert.equal(r1.usage.used,1);
  const sent=m.requests.at(-1);assert.equal(sent.body.store,false);assert.equal(sent.body.text.format.strict,true);
  for(const bad of ['Casey','Morgan','Jordan','4471','239-555','Palm Way','Harbor Lane','INTERNAL-SECRET','9911','Ocean Villa','Coastal Estate Care','Avery','tech@example.test'])assert.ok(!sent.raw.includes(bad),`${bad} was sent to the provider`);
  assert.ok(sent.raw.includes('[code]')&&sent.raw.includes('Light rust on the valve'));
  // Idempotency: the same key returns the same draft without a second provider call.
  const key=randomUUID(),k1=await gen(employee,A,200,key),calls=m.requests.length,k2=await gen(employee,A,200,key);
  assert.equal(k1.draft.id,k2.draft.id);assert.equal(k2.draft.replay,true);assert.equal(m.requests.length,calls);
  const h=await employee.req(`inspections/${A}/ai-summary`,{},200,{'Idempotency-Key':key});assert.equal(h.draft.id,k1.draft.id,'header works too');
  // Permissions and isolation.
  await family.req(`inspections/${A}/ai-summary`,{},403);await vendor.req(`inspections/${A}/ai-summary`,{},403);
  await outsider.req(`inspections/${A}/ai-summary`,{},404);await outsider.req(`inspections/${A}/ai-summary/${r1.draft.id}/use`,{},404);await outsider.req(`inspections/${A}/ai-summary/review`,{},404);
  await employee.req(`inspections/${A}/ai-summary/not-a-draft/use`,{},404);
  // Discard, then use.
  assert.equal((await employee.req(`inspections/${A}/ai-summary/${r1.draft.id}/discard`,{})).status,'discarded');
  await employee.req(`inspections/${A}/ai-summary/${r1.draft.id}/use`,{},409);
  const used=await employee.req(`inspections/${A}/ai-summary/${k1.draft.id}/use`,{});assert.equal(used.summarySource,'ai_draft');assert.equal(used.text,k1.draft.text);
  let i=await find(employee,A);assert.equal(i.summary_source,'ai_draft');assert.equal(i.summary_review_current,false);assert.equal('summary_reviewed_hash' in i,false);
  assert.equal(i.summary,'','the server never writes the summary itself');
  await employee.req('inspections/save',{id:A,version:i.version,answers:answersWith().map(a=>({...a,note:a.note.replace(/Casey.*$/,'Drip under sink')})),summary:used.text,notes:'',internalNotes:''},201);
  // Review gate on publish: unreviewed, reviewed, edited after review, reviewed again.
  const pub=async(id,expected)=>admin.req('inspections/publish',{id,version:(await find(admin,id)).version,idempotencyKey:randomUUID()},expected);
  const blocked=await pub(A,422);assert.equal(blocked.code,'ai_review_required');
  const rv=await employee.req(`inspections/${A}/ai-summary/review`,{});assert.equal(rv.reviewedBy,'Jordan Lee');
  assert.equal((await find(employee,A)).summary_review_current,true);
  i=await find(employee,A);await employee.req('inspections/save',{id:A,version:i.version,answers:i.answers,summary:used.text+' Edited.',notes:'',internalNotes:''},201);
  assert.equal((await find(employee,A)).summary_review_current,false,'an edit after review needs a new review');
  assert.equal((await pub(A,422)).code,'ai_review_required');
  await admin.req(`inspections/${A}/ai-summary/review`,{});await pub(A,201);
  await admin.req(`inspections/${A}/ai-summary`,{},409);
  const fi=await find(family,A);for(const k of ['summary_source','summary_ai_draft_id','summary_reviewed_by','summary_reviewed_at','summary_reviewed_hash','summary_review_current'])assert.equal(k in fi,false,k+' reaches the family');
  const pdf=async(c,id)=>words(Buffer.from(await (await c.raw('inspections/'+id+'/pdf')).arrayBuffer()).toString('latin1'));
  assert.ok(!(await pdf(family,A)).includes('AI assistance'),'label off by default');

  // Auto-publish waits for review; label on the PDF when the company turns it on.
  await admin.req('settings/ai',{label_reports:true});
  const B=await visit(admin);const rb=await gen(admin,B);const ub=await admin.req(`inspections/${B}/ai-summary/${rb.draft.id}/use`,{});
  i=await find(admin,B);await admin.req('inspections/save',{id:B,version:i.version,answers:answersWith().map(a=>({...a,note:a.status==='attention'?'Drip under sink':a.note})),summary:ub.text,notes:'',internalNotes:''},201);
  i=await find(admin,B);const sub=await admin.req('inspections/submit',{id:B,version:i.version,autoPublish:true},201);
  assert.equal(sub.status,'submitted');assert.equal(sub.autoPublishSkipped,'ai_review_required');
  await admin.req(`inspections/${B}/ai-summary/review`,{});await pub(B,201);
  const pb=await pdf(family,B);assert.ok(pb.includes(`Summary drafted with AI assistance and reviewed by Coastal Estate Care ${label}.`),pb.slice(0,800));
  // A manual summary is never gated or labelled.
  const C=await visit(admin);i=await find(admin,C);await admin.req('inspections/save',{id:C,version:i.version,answers:answersWith(),summary:'Typed by hand.',notes:'',internalNotes:''},201);await pub(C,201);
  assert.ok(!(await pdf(family,C)).includes('AI assistance'));

  // Provider problems: friendly errors; failures before a response are refunded; leaks are blocked.
  const usedNow=async()=>(await admin.req('ai/usage')).used;
  const E1=await visit();const E2=await visit();
  let before=await usedNow();
  m.set('timeout');assert.equal((await gen(employee,E1,504)).code,'ai_timeout');
  m.set('429');assert.equal((await gen(employee,E1,503)).code,'ai_rate_limited');
  assert.equal(await usedNow(),before,'timeouts and provider rate limits are refunded');
  m.set('refusal');assert.equal((await gen(employee,E1,422)).code,'ai_refused');
  m.set('malformed');assert.equal((await gen(employee,E2,502)).code,'ai_malformed');
  m.set('leaky');const lk=await gen(employee,E2,422);assert.equal(lk.code,'ai_blocked');assert.ok(!JSON.stringify(lk).includes('Casey'));
  m.set('missing');const ms=await gen(employee,E2);assert.equal(ms.draft.missing.length,2,'both flagged items reported as not mentioned');
  m.set('ok');
  assert.equal(await usedNow(),before+4,'refusal, malformed and leak attempts count; the missing-items draft counts');
  // Rate limits: 5 per visit per hour, 10 per person per 10 minutes.
  await gen(employee,E1);await gen(employee,E1);
  const vl=await gen(employee,E1,429);assert.equal(vl.code,'ai_rate_limited');assert.match(vl.error,/several drafts in the last hour/);
  const F=await visit();
  const lim=await gen(employee,F,429);assert.match(lim.error,/last few minutes/);

  // Monthly cap: atomic under concurrency.
  const cur=await usedNow();await admin.req('settings/ai',{monthly_cap:cur+2});
  m.set('slow');
  const vs=[];for(let k=0;k<5;k++)vs.push(await visit(admin));
  const rs=await Promise.all(vs.map(v=>admin.call('POST',`inspections/${v}/ai-summary`,{idempotencyKey:randomUUID()})));
  m.set('ok');
  assert.equal(rs.filter(r=>r.status===200).length,2,JSON.stringify(rs.map(r=>r.status)));
  assert.equal(rs.filter(r=>r.status===429&&r.body.code==='ai_cap_reached').length,3);
  assert.equal(await usedNow(),cur+2);
  d=await admin.req('data');assert.equal(d.ai.available,false);assert.match(d.ai.reason,/used this month/);
  // Platform owner can lower the ceiling; company settings cannot exceed it.
  await employee.req('ai/platform-cap',{organizationId:'x',cap:5},403);
  const org=(await admin.req('owner/overview')).companies.find(c=>c.name===`Coastal Estate Care ${label}`).id;
  await admin.req('ai/platform-cap',{organizationId:'missing',cap:50},404);await admin.req('ai/platform-cap',{organizationId:org,cap:-5},422);
  const pc=await admin.req('ai/platform-cap',{organizationId:org,cap:50});assert.equal(pc.ceiling,50);
  await admin.req('settings/ai',{monthly_cap:60},422);assert.equal((await admin.req('settings/ai',{monthly_cap:null})).cap,50);
  await admin.req('ai/platform-cap',{organizationId:org,cap:null});assert.equal((await admin.req('settings/ai')).cap,300);
  // Usage report.
  const u=await admin.req('ai/usage');assert.ok(u.byUser.some(x=>x.name==='Jordan Lee'));assert.ok(u.tokensIn>0);await employee.req('ai/usage',undefined,403);

  // Server switch off: hidden and refused even with the company on.
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id,AI_FEATURES_ENABLED:'false'});
  await admin.req('login',{email:'owner@example.test',password:pw});
  d=await admin.req('data');assert.equal(d.ai.serverEnabled,false);assert.equal(d.ai.available,false);
  const G=await visit(admin);assert.match((await gen(admin,G,403)).error,/not available on this server/);
  // Turning the company switch back on is refused while the server switch is off.
  await admin.req('settings/ai',{enabled:false});await admin.req('settings/ai',{enabled:true},409);
  await srv.stop();
  // The API key never leaves the server: not in any response, log line or database file.
  assert.ok(!seen.some(t=>t.includes(FAKE_KEY)),'key in a response');
  assert.ok(!srv.log.includes(FAKE_KEY),'key in the server log');
  for(const f of filesUnder(dir))assert.ok(!readFileSync(f).includes(Buffer.from(FAKE_KEY)),'key in '+f);
  assert.ok(!srv.log.includes('Light rust'),'visit content is never logged');
 }finally{await srv.stop();}
}
test('API on SQLite: switches, drafts, review gate, auto-publish, label, errors, limits, cap, key safety',async()=>{await apiScenario('sqlite',false);});
test('API on Postgres (PGlite): the same scenario',async()=>{await apiScenario('postgres',true);});
