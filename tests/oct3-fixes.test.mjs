// Oct 3 fixes: "Request service" priorities (any letter case accepted, stored as Low/Normal/High/Urgent; the form sends
// those values), "Edit email" on the inspection page saving through /api/inspections/recipient, and the October 2026
// homepage tutorial (12 chapters inside the video, cache-busted URLs, range requests, captions, poster).
// Server scenarios run on SQLite and on Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,statSync,openSync,readSync,closeSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const pw='Test-only-strong-password-928!';
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const TUTORIAL_SECONDS=361.8,V='?v=2026-10-03';

function server(env){let proc,base,log='';return {get base(){return base;},get log(){return log;},
 async start(extra={}){proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',...env,...extra},windowsHide:true});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
 async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};}
function client(srv){let cookie='';const c={
 async call(method,endpoint,b){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body};},
 async req(endpoint,b,expected){const r=await c.call(b===undefined?'GET':'POST',endpoint,b);if(expected===undefined)assert.ok(r.status>=200&&r.status<300,`${endpoint}: ${r.status} ${JSON.stringify(r.body)}`);else assert.equal(r.status,expected,`${endpoint}: ${JSON.stringify(r.body)}`);return r.body;}};return c;}

test('the request form sends the stored priority values and Edit email uses the recipient endpoint',()=>{
 const live=read('public/live.js');
 assert.match(live,/const REQUEST_PRIORITIES=\['Low','Normal','High','Urgent'\];/);
 assert.doesNotMatch(live,/<option value="(low|normal|high|urgent)"/,'no lowercase priority values in the form');
 const edit=live.match(/if\(name==='inspection-recipient-edit'\)\{.*?\}\);\}/)[0];
 assert.match(edit,/api\('inspections\/recipient',\{propertyId:key,email:/);assert.doesNotMatch(edit,/properties\/update/);
 assert.match(live,/data\.user\.role==='admin'\?btn\('Edit email','inspection-recipient-edit',p\.id\):''/,'only admins (who may save it) see Edit email');
});

async function scenario(label,env){
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-oct3-'));dirs.push(dir);
 const srv=server({ESTATEOS_DATA_DIR:dir,...(env.pg?{NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(dir,'pg')}:{})});await srv.start();
 try{
  const admin=client(srv),leo=client(srv),family=client(srv),vendor=client(srv);
  await admin.req('setup',{company:'Coastal Care '+label,name:'Owner',email:'owner@example.test',password:pw},201);
  const lee=await admin.req('clients',{name:'Lee family'},201);
  const ocean=await admin.req('properties',{clientId:lee.id,name:'Ocean House',streetAddress:'1 Ocean Rd',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
  const accept=async(c,role,email,name,extra={})=>{const inv=await admin.req('invitations',{role,email,...extra},201);return c.req('accept-invite',{token:new URL('http://x'+inv.invitePath).searchParams.get('invite'),name,password:pw},201);};
  const leoU=(await accept(leo,'employee','leo@example.test','Leo Tech')).user;await admin.req('access',{userId:leoU.id,propertyId:ocean.id},201);
  await accept(family,'client','lee@example.test','Ana Lee',{clientId:lee.id});
  const acme=await admin.req('vendors',{name:'Acme'},201);await accept(vendor,'vendor','v@example.test','Vic',{vendorId:acme.id});
  const priorityOf=async id=>(await admin.req('data')).requests.find(r=>r.id===id).priority;
  // Families and staff can request service with the form's values, in any letter case.
  for(const [c,sent,stored] of [[family,'Normal','Normal'],[family,'high','High'],[leo,'URGENT','Urgent'],[leo,' low ','Low'],[admin,'Urgent','Urgent'],[family,undefined,'Normal'],[family,'','Normal']]){
   const r=await c.req('requests',{propertyId:ocean.id,title:'Check '+String(sent),description:'',priority:sent},201);assert.equal(await priorityOf(r.id),stored,`${String(sent)} is stored as ${stored}`);}
  for(const bad of ['asap','Highest',3,{}])assert.equal((await family.call('POST','requests',{propertyId:ocean.id,title:'Bad',priority:bad})).status,422,'rejects '+JSON.stringify(bad));
  assert.equal((await vendor.call('POST','requests',{propertyId:ocean.id,title:'Nope',priority:'Normal'})).status,403);
  const r=await family.req('requests',{propertyId:ocean.id,title:'Stock the fridge',priority:'Normal'},201);
  await admin.req('requests/priority',{id:r.id,priority:'high'});assert.equal(await priorityOf(r.id),'High','the admin priority edit normalizes too');
  assert.equal((await admin.call('POST','requests/priority',{id:r.id,priority:'soon'})).status,422);
  await admin.req('requests/create-work',{id:r.id});assert.equal((await admin.req('data')).work.find(w=>w.title==='Stock the fridge').priority,'High','work order keeps the request priority');
  // Edit email on the inspection page: saved through /api/inspections/recipient (no address fields needed); admins only.
  const saved=await admin.req('inspections/recipient',{propertyId:ocean.id,email:' Reports@Example.TEST '});assert.equal(saved.email,'reports@example.test');
  assert.equal((await admin.req('data')).properties.find(p=>p.id===ocean.id).inspection_report_email,'reports@example.test');
  assert.equal((await admin.call('POST','inspections/recipient',{propertyId:ocean.id,email:'not-an-email'})).status,422);
  for(const c of [leo,family,vendor])assert.equal((await c.call('POST','inspections/recipient',{propertyId:ocean.id,email:'x@example.test'})).status,403);
  await admin.req('inspections/recipient',{propertyId:ocean.id,email:''});assert.equal((await admin.req('data')).properties.find(p=>p.id===ocean.id).inspection_report_email,'','blank turns automatic emails off');
  assert.equal((await admin.call('POST','properties/update',{id:ocean.id,inspection_report_email:'x@example.test'})).status,422,'the old path still needs the full address (why Edit email used to fail)');
  assert.ok(!/Request failed/.test(srv.log),srv.log);
 }finally{await srv.stop();}
}
test('request priorities and inspection recipient on SQLite',()=>scenario('SQLite',{}));
test('request priorities and inspection recipient on Postgres (PGlite)',()=>scenario('PG',{pg:true}));

test('homepage tutorial: October 2026 video, 12 chapters, new wording, cache-busted URLs',()=>{
 const home=read('public/marketing.html');
 const section=home.slice(home.indexOf('<section class="tutorial-section"'),home.indexOf('</section>',home.indexOf('<section class="tutorial-section"')));
 assert.ok(section.includes('<p>A six-minute tour of a typical week, from the first visit of the day to storm prep. 12 chapters to help you find what you need.</p>'));
 assert.doesNotMatch(home,/23 minutes|45 chapters/);
 const opts=[...section.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m=>[m[1],m[2].replace(/&#183;/g,'·')]);
 assert.deepEqual(opts[0],['','Choose a chapter…']);const ch=opts.slice(1);assert.equal(ch.length,12);
 const secs=ch.map(([v])=>Number(v));assert.equal(secs[0],0);assert.ok(secs.every((s,i)=>i===0||s>secs[i-1]),'chapters in order');assert.ok(secs.at(-1)<TUTORIAL_SECONDS,'every chapter is inside the video');
 ch.forEach(([v,t],i)=>{const s=Number(v),stamp=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;assert.ok(t.startsWith(`${stamp} — ${String(i+1).padStart(2,'0')} · `),`chapter label ${t} matches ${v}s`);});
 assert.equal(ch[11][1].split(' · ')[1],'Get started');
 for(const url of [`/tutorial.mp4${V}`,`/tutorial.vtt${V}`,`/img/tutorial-poster.webp${V}`])assert.ok(section.includes(url),'cache-busted '+url);
 assert.doesNotMatch(section,/"\/tutorial\.(mp4|vtt)"|tutorial-poster\.webp"/,'no un-versioned tutorial URLs on the homepage');
 assert.ok(read('public/demo-guide.html').includes(`<source src="/tutorial.mp4${V}"`),'the demo guide gets the new video too');
 // Repo/host limits: GitHub refuses files over 100 MB; the file is plain git (no LFS), as before.
 const size=statSync(path.join(root,'public/tutorial.mp4')).size;assert.ok(size>40e6&&size<95e6,'tutorial.mp4 is '+size+' bytes');
 const fd=openSync(path.join(root,'public/tutorial.mp4'),'r'),head=Buffer.alloc(2*1024*1024);readSync(fd,head,0,head.length,0);closeSync(fd);
 assert.ok(head.indexOf('moov')>0&&head.indexOf('moov')<head.indexOf('mdat'),'faststart: playback starts before the whole file downloads');
 const vtt=read('public/tutorial.vtt');assert.match(vtt,/^WEBVTT/);const ends=[...vtt.matchAll(/--> (\d\d):(\d\d):(\d\d\.\d+)/g)].map(m=>m[1]*3600+m[2]*60+Number(m[3]));
 assert.ok(ends.length>50&&ends.at(-1)<TUTORIAL_SECONDS,'captions cover the new video and end inside it');
});

test('tutorial files are served with range support and cache-busting query strings',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-oct3w-'));dirs.push(dir);const srv=server({ESTATEOS_DATA_DIR:dir});await srv.start();
 try{const size=statSync(path.join(root,'public/tutorial.mp4')).size;
  const head=await fetch(srv.base+'/tutorial.mp4'+V,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');assert.equal(head.headers.get('accept-ranges'),'bytes');assert.equal(Number(head.headers.get('content-length')),size);
  const part=await fetch(srv.base+'/tutorial.mp4'+V,{headers:{Range:'bytes=0-1023'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),`bytes 0-1023/${size}`);assert.equal((await part.arrayBuffer()).byteLength,1024);
  const tail=await fetch(srv.base+'/tutorial.mp4',{headers:{Range:'bytes=-100'}});assert.equal(tail.status,206);assert.equal((await tail.arrayBuffer()).byteLength,100);
  const vtt=await fetch(srv.base+'/tutorial.vtt'+V);assert.equal(vtt.status,200);assert.match(vtt.headers.get('content-type'),/^text\/vtt/);assert.match(await vtt.text(),/^WEBVTT/);
  const poster=await fetch(srv.base+'/img/tutorial-poster.webp'+V);assert.equal(poster.status,200);assert.equal(poster.headers.get('content-type'),'image/webp');
 }finally{await srv.stop();}
});
