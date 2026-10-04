// Import from another system (Oct 2026): CSV/XLSX parsing and limits, header auto-matching (incl. documented Jobber and
// Housecall Pro exports), duplicate detection (skip or update), sealed access codes that never reach logs, admin-only
// routes, company isolation, plan limits, imported staff that stay inactive until invited, and whole-batch undo.
// Server scenarios run on SQLite and Postgres (PGlite).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LIMITS,TYPES,TYPE_ORDER,KNOWN_SOURCES,autoMap,parseCsv,readUpload,parseDate,timezoneFor,checkEmail,checkPhone,staffRole,addressKey,templateCsv,csvCell,pick,cleanMapping,zipUncompressedSize} from '../import-core.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const dirs=[];after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=mkdtempSync(path.join(os.tmpdir(),'estateos-imp-'));dirs.push(d);return d;};
const engines=[['SQLite',d=>({ESTATEOS_DATA_DIR:d})],['Postgres (PGlite)',d=>({NODE_ENV:'test',ESTATEOS_TEST_POSTGRES_DIR:path.join(d,'pg')})]];
const xlsx=readFileSync(path.join(root,'tests/fixtures/import-clients.xlsx'));
const b64=s=>Buffer.from(s).toString('base64');
const csv=rows=>rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
const keys=(type,headers)=>Object.fromEntries(Object.entries(autoMap(type,headers)).map(([k,i])=>[k,headers[i]]));

test('CSV parsing: BOM, quotes, embedded newlines, CRLF, semicolon and tab files', () => {
 const t=parseCsv('\ufeffName,Notes\r\n"Ashby, Grace","Line one\nLine ""two"""\r\nKim,Plain\r\n');
 assert.deepEqual(t,[['Name','Notes'],['Ashby, Grace','Line one\nLine "two"'],['Kim','Plain']]);
 assert.deepEqual(parseCsv('a;b\n1;2\n'),[['a','b'],['1','2']]);
 assert.deepEqual(parseCsv('a\tb\n1\t2\n'),[['a','b'],['1','2']]);
});

test('uploads: xlsx first sheet, empty rows skipped, size/row/column limits, .xls and zip bombs refused', async () => {
 const x=await readUpload({fileName:'Clients.xlsx',data:xlsx.toString('base64')});
 assert.equal(x.headers[0],'First name');assert.equal(x.rows.length,3);
 const ashby=x.rows[1].cells;assert.equal(ashby[x.headers.indexOf('Postal Code or Zip Code')],'2108','numeric ZIP comes through as text (padded later)');
 assert.match(ashby[x.headers.indexOf('Client since')],/^2022-05-09/);
 const c=await readUpload({fileName:'clients.csv',data:b64('Name,Email\n\nGrace Ashby,grace@example.com\n,\n')});assert.equal(c.rows.length,1);assert.equal(c.rows[0].line,3,'line numbers match the spreadsheet');
 await assert.rejects(readUpload({fileName:'old.xls',data:b64('x')}),/Save As.*\.xlsx.*CSV/i);
 await assert.rejects(readUpload({fileName:'notes.pdf',data:b64('x')}),/\.csv or \.xlsx/);
 await assert.rejects(readUpload({fileName:'big.csv',data:Buffer.alloc(LIMITS.bytes+10,97).toString('base64')}),/5 MB/);
 await assert.rejects(readUpload({fileName:'rows.csv',data:b64('Name\n'+Array.from({length:LIMITS.rows+1},(_,i)=>'Person '+i).join('\n'))}),/limit is 1,500/);
 await assert.rejects(readUpload({fileName:'wide.csv',data:b64(Array.from({length:LIMITS.columns+1},(_,i)=>'c'+i).join(',')+'\n'+'x\n')}),/columns/);
 await assert.rejects(readUpload({fileName:'empty.csv',data:b64('Name,Email\n')}),/no data rows/i);
 await assert.rejects(readUpload({fileName:'broken.xlsx',data:b64('not a zip')}),/doesn.t look like an Excel/);
 // Claim a huge uncompressed size in the central directory: refused before unzipping.
 const bomb=Buffer.from(xlsx);let at=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 while(at>=0){bomb.writeUInt32LE(0x7fffffff,at+24);at=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),at+4);}
 assert.ok(zipUncompressedSize(bomb)>LIMITS.unzippedBytes);
 await assert.rejects(readUpload({fileName:'bomb.xlsx',data:bomb.toString('base64')}),/too large/i);
});

test('auto-matching: common synonyms and documented Jobber / Housecall Pro export headers', () => {
 assert.deepEqual(keys('clients',['Owner','Property Address','Zip','Gate Code','Alarm Code','Phone','Email','Time Zone']),{family:'Owner',street:'Property Address',postal:'Zip',gate:'Gate Code',alarm:'Alarm Code',phone:'Phone',email:'Email',timezone:'Time Zone'});
 assert.equal(keys('clients',['Client Name']).family,'Client Name');
 assert.equal(keys('clients',['Postal Code']).postal,'Postal Code');
 // Jobber client import/export headers (help.getjobber.com)
 const jobber=keys('clients',['First name','Last name','Company name','Main Phone #s','Email','Street 1','Street 2','City','Province or State','Postal Code or Zip Code','Country']);
 assert.deepEqual(jobber,{firstName:'First name',lastName:'Last name',company:'Company name',phone:'Main Phone #s',email:'Email',street:'Street 1',line2:'Street 2',city:'City',state:'Province or State',postal:'Postal Code or Zip Code',country:'Country'});
 // Housecall Pro customers.xlsx
 const hcp=keys('clients',['First Name','Last Name','Display Name','Mobile Number','Email','Address_1 Street Line 1','Address_1 Street Line 2','Address_1 City','Address_1 State','Address_1 Postal Code']);
 assert.equal(hcp.street,'Address_1 Street Line 1');assert.equal(hcp.line2,'Address_1 Street Line 2');assert.equal(hcp.city,'Address_1 City');assert.equal(hcp.state,'Address_1 State');assert.equal(hcp.postal,'Address_1 Postal Code');assert.equal(hcp.phone,'Mobile Number');
 assert.ok(KNOWN_SOURCES.some(s=>/Jobber/.test(s.name))&&KNOWN_SOURCES.some(s=>/Housecall/.test(s.name)));
 // Each column is used once, unknown ones stay unmapped, and bad mappings are cleaned.
 const m=autoMap('vendors',['Vendor','Vendor Name','Favorite color']);assert.equal(Object.values(m).length,new Set(Object.values(m)).size);
 assert.deepEqual(cleanMapping('vendors',{name:0,email:9,bogus:1,phone:'1'},3),{name:0,phone:1});
 // Unmapped fields read as empty text (a file with only a few columns still previews).
 assert.deepEqual([pick({cells:['Ashby']},{family:0}).family,pick({cells:['Ashby']},{family:0}).firstName,pick({cells:[]},{}).email],['Ashby','','']);
 for(const t of TYPE_ORDER){const rows=parseCsv(templateCsv(t).replace(/^\ufeff/,''));const map=autoMap(t,rows[0]);assert.equal(Object.keys(map).length,TYPES[t].fields.length,t+' template maps every field');assert.equal(rows.length,3);}
});

test('value checks: dates, time zones nationwide, email, phone, roles, address keys', () => {
 assert.equal(parseDate('2026-03-02'),'2026-03-02');assert.equal(parseDate('3/2/2026'),'2026-03-02');assert.equal(parseDate('Mar 2, 2026'),'2026-03-02');assert.equal(parseDate('46083'),'2026-03-02');assert.equal(parseDate('13/45/2026'),'');
 assert.equal(timezoneFor('','CO','United States','America/New_York').tz,'America/Denver');
 assert.equal(timezoneFor('','Hawaii','','America/New_York').tz,'Pacific/Honolulu');
 assert.equal(timezoneFor('Central','FL','','').tz,'America/Chicago');
 assert.equal(timezoneFor('America/Phoenix','','','').tz,'America/Phoenix');
 assert.equal(timezoneFor('','','Canada','America/Los_Angeles').tz,'America/Los_Angeles');
 assert.equal(checkEmail('Grace@Example.com; other@example.com').value,'grace@example.com');assert.ok(checkEmail('not-an-email').bad);
 assert.ok(checkPhone('12').bad);assert.ok(!checkPhone('(555) 201-4410').bad);
 assert.equal(staffRole('Field inspector').role,'inspector');assert.equal(staffRole('Office manager').role,'employee');assert.ok(staffRole('Owner / Admin').error);
 assert.equal(addressKey('412 Seagrape Lane','34996-1234'),addressKey('412 seagrape ln.','34996'));
 assert.equal(csvCell('=HYPERLINK("x")')[0]!=='=',true,'spreadsheet formulas are neutralized in downloads');
});

test('wiring: admin-only route, nav entry, shell files, migration, demo reset, backup', () => {
 const server=read('server.mjs');
 assert.match(server,/dataImport\.handle\(req,res,url,user\)/);assert.match(server,/'data-import\.js'/);
 assert.match(read('public/view-route.js'),/case 'import'/);assert.match(read('public/sidebar-core.js'),/\['import','Import data'\]/);
 assert.match(read('migrations/046_data_import.sql'),/CREATE TABLE IF NOT EXISTS import_batches/);
 assert.match(read('demos.mjs'),/\['import_batches','organization_id=\?'\]/);
 assert.match(read('public/sw.js'),/data-import\.js/);
 assert.doesNotMatch(read('data-import.mjs'),/console\.\w+\([^)]*(row|cells|value|details|vault|parsed)/,'imports never log row values');
 assert.doesNotMatch(read('public/data-import.js')+read('public/data-import.css'),/Florida/);
});

function server(env){
 let proc,base,log='';
 return {get base(){return base;},get log(){return log;},
  async start(extra={}){const e={...process.env,PORT:'0',...env,...extra};delete e.DATABASE_URL;delete e.STRIPE_SECRET_KEY;Object.assign(e,extra);proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:e,windowsHide:true});proc.stdout.on('data',c=>{log+=c;});proc.stderr.on('data',c=>{log+=c;});base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited '+code+'\n'+log)));});},
  async stop(){if(proc&&proc.exitCode===null){proc.kill();await new Promise(r=>proc.once('exit',r));}}};
}
function client(srv){let cookie='';const c={async call(method,endpoint,b,headers={}){const res=await fetch(srv.base+'/api/'+endpoint,{method,headers:{Origin:srv.base,'Content-Type':'application/json',Cookie:cookie,...headers},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const text=await res.text();let body={};try{body=JSON.parse(text);}catch{body={raw:text};}return {status:res.status,body,text};},
 async req(endpoint,b,expected){const r=await c.call(b===undefined?'GET':'POST',endpoint,b);if(expected===undefined)assert.ok(r.status>=200&&r.status<300,endpoint+': '+r.status+' '+r.text.slice(0,400));else assert.equal(r.status,expected,endpoint+': '+r.text.slice(0,400));return r.body;},
 async parse(type,fileName,data){return c.req('import/parse',{type,fileName,data});},
 async preview(type,fileName,data,mode='skip',mapping){mapping??=(await c.parse(type,fileName,data)).mapping;return c.req('import/preview',{type,fileName,data,mapping,mode});},
 async run(type,fileName,data,mode='skip',mapping){mapping??=(await c.parse(type,fileName,data)).mapping;return c.req('import/run',{type,fileName,data,mapping,mode});}};return c;}
const tokenOf=inv=>new URL('http://x'+inv.invitePath).searchParams.get('invite');
const pw='Test-only-strong-password-928!';

for(const [label,envFor] of engines)test('server on '+label+': admin-only import with duplicates, sealed codes, isolation, staff invites and undo', async () => {
 const dir=tmp();
 const srv=server({...envFor(dir),ESTATEOS_DATA_DIR:dir,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64'),RESEND_API_KEY:''});await srv.start();
 try{
  const admin=client(srv),staff=client(srv),insp=client(srv),fam=client(srv),rival=client(srv),anon=client(srv);
  const setup=await admin.req('setup',{company:'Harborline Home Watch',name:'Jordan Ellis',email:'jordan@example.test',password:pw},201);
  await srv.stop();await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});
  await admin.req('login',{email:'jordan@example.test',password:pw});
  // Existing records the import should recognise.
  const whit=await admin.req('clients',{name:'Whitcombe family',email:'eleanor.whitcombe@example.com'},201);
  const seagrape=(await admin.req('properties',{clientId:whit.id,name:'Seagrape House',streetAddress:'412 Seagrape Ln',city:'Stuart',state:'FL',postalCode:'34996',country:'United States',timezone:'America/New_York'},201)).id;
  const accept=async(c,body,email,name)=>{const inv=await admin.req('invitations',{...body,email},201);return (await c.req('accept-invite',{token:tokenOf(inv),name,password:pw},201)).user;};
  await accept(staff,{role:'employee'},'taylor@example.test','Taylor Brooks');
  await accept(insp,{role:'inspector'},'riley@example.test','Riley Chen');
  await accept(fam,{role:'client',clientId:whit.id},'eleanor.whitcombe@example.com','Eleanor Whitcombe');

  // Permissions: admins only; CSRF same as every other form.
  assert.equal((await anon.call('GET','import/info')).status,401);
  for(const c of [staff,insp,fam]){
   assert.equal((await c.call('GET','import/info')).status,403);
   assert.equal((await c.call('GET','import/template/clients.csv')).status,403);
   assert.equal((await c.call('POST','import/parse',{type:'vendors',fileName:'v.csv',data:b64(templateCsv('vendors'))})).status,403);
   assert.equal((await c.call('POST','import/run',{type:'vendors',fileName:'v.csv',data:b64(templateCsv('vendors')),mapping:{name:0}})).status,403);
  }
  assert.equal((await admin.call('POST','import/parse',{type:'vendors',fileName:'v.csv',data:b64(templateCsv('vendors'))},{Origin:'https://evil.example'})).status,403);
  const info=await admin.req('import/info');
  assert.deepEqual(info.types.map(t=>t.key),TYPE_ORDER);assert.equal(info.undoDays,7);assert.equal(info.vaultReady,true);assert.deepEqual(info.batches,[]);
  const tpl=await admin.call('GET','import/template/clients.csv');assert.equal(tpl.status,200);assert.match(tpl.text,/^\ufeff?Family name,First name/);

  // Clients + residences from the xlsx fixture (Jobber-style headers).
  const data=xlsx.toString('base64'),file='Clients.xlsx';
  const parsed=await admin.parse('clients',file,data);
  assert.equal(parsed.rowCount,3);for(const k of ['firstName','lastName','company','phone','email','street','city','state','postal','country','gate','alarm'])assert.ok(parsed.mapping[k]!==undefined,k+' auto-matched');
  assert.deepEqual(parsed.samples[parsed.mapping.gate],[],'code samples are hidden');
  const pv=await admin.preview('clients',file,data);
  assert.deepEqual(pv.counts.create,2);assert.equal(pv.counts.skip,1);
  const [r1,r2,r3]=pv.rows;
  assert.equal(r1.status,'skip');assert.equal(r1.duplicate,true);
  assert.equal(r2.status,'create');assert.ok(r2.warnings.some(w=>/02108/.test(w)),'ZIP padding is called out');
  assert.equal(r3.status,'create');assert.ok(r3.warnings.some(w=>/email/i.test(w)));
  for(const secret of ['4127','7316','2468'])assert.ok(!JSON.stringify(pv).includes(secret),'preview never echoes codes');
  const ran=await admin.run('clients',file,data);
  assert.equal(ran.created,2);assert.equal(ran.updated,0);assert.equal(ran.skipped,1);assert.match(ran.skippedCsv,/Row,Reason|Reason/);assert.match(ran.skippedCsv,/already/i);
  let d=await admin.req('data');
  const ashby=d.properties.find(p=>/Beacon Hill/.test(p.address||p.street_address||''))||d.properties.find(p=>/Ashby/.test(p.name));
  const lake=d.properties.find(p=>/Lakeshore/.test((p.address||'')+p.name));
  assert.ok(ashby&&lake,'both residences created');assert.equal(ashby.timezone,'America/New_York');assert.equal(lake.timezone,'America/Chicago','time zone from the state');
  assert.match(JSON.stringify(ashby),/02108/);
  assert.equal((await admin.req('access-codes/read',{propertyId:lake.id})).details.alarm,'2468');
  // Re-running is a no-op in skip mode; update mode fills the existing residence's empty codes.
  const again=await admin.preview('clients',file,data);assert.equal(again.counts.skip,3);assert.equal(again.counts.create,0);
  const up=await admin.run('clients',file,data,'update');assert.ok(up.updated>=1);assert.equal(up.created,0);
  const codes=(await admin.req('access-codes/read',{propertyId:seagrape})).details;assert.equal(codes.gate,'4127');assert.equal(codes.alarm,'7316');
  if(label==='SQLite'){const sql=new DatabaseSync(path.join(dir,'estateos.sqlite'),{readOnly:true});const vault=sql.prepare('SELECT encrypted_details FROM property_vault').all().map(r=>String(r.encrypted_details)).join('|');sql.close();for(const s of ['4127','7316','2468'])assert.ok(!vault.includes(s),'codes are encrypted at rest');}

  // Contacts, vendors, staff and history from the templates (they reference the Whitcombe residence).
  const contacts=await admin.run('contacts','contacts.csv',b64(templateCsv('contacts')));assert.equal(contacts.created,1);assert.equal(contacts.skipped,1,'Marchetti family is not in this company');
  const vendors=await admin.run('vendors','vendors.csv',b64(templateCsv('vendors')));assert.equal(vendors.created,2);
  assert.equal((await admin.preview('vendors','vendors.csv',b64(templateCsv('vendors')))).counts.skip,2,'vendor duplicates by name/email');
  const staffRun=await admin.run('staff','staff.csv',b64(csv([['Name','Email','Role'],['Alex Kim','alex.kim@harborline.example.com','Staff'],['Sam Rivera','sam.rivera@harborline.example.com','Field inspector'],['Pat Owner','pat@harborline.example.com','Admin'],['Taylor Brooks','taylor@example.test','Staff'],['Bad Email','nope','Staff']])));
  assert.equal(staffRun.created,2);assert.equal(staffRun.skipped,3);
  assert.deepEqual(staffRun.pendingStaff.map(p=>p.email).sort(),['alex.kim@harborline.example.com','sam.rivera@harborline.example.com']);
  const sam=staffRun.pendingStaff.find(p=>/sam/.test(p.email)),alex=staffRun.pendingStaff.find(p=>/alex/.test(p.email));
  assert.equal((await client(srv).call('POST','login',{email:'sam.rivera@harborline.example.com',password:''})).status>=400,true,'imported staff cannot sign in before an invite');
  const users=(await admin.req('data')).users;assert.ok(users.find(u=>u.id===sam.id).invite_pending);assert.equal(users.find(u=>u.id===sam.id).role,'inspector');
  assert.equal((await admin.call('POST','users/reactivate',{userId:alex.id})).status,422);
  const history=await admin.run('history','history.csv',b64(templateCsv('history')));assert.equal(history.created,1);assert.equal(history.skipped,1);
  // Files with only the required columns preview cleanly for every type.
  for(const [t,rows] of [['clients',[['Owner'],['Kim household']]],['contacts',[['Family','Name'],['Whitcombe family','Ruth Whitcombe']]],['vendors',[['Vendor'],['Coastal Glass']]],['staff',[['Name','Email'],['Casey Lin','casey@harborline.example.com']]],['history',[['Property Address','Visit Date'],['412 Seagrape Lane','2026-07-01']]]]){
   const r=await admin.preview(t,t+'-min.csv',b64(csv(rows)));assert.equal(r.counts.error,0,t+': '+JSON.stringify(r.rows[0]));
  }
  d=await admin.req('data');assert.equal(d.importedVisits.length,1);assert.equal(d.importedVisits[0].property_id,seagrape);
  assert.equal((await fam.req('data')).importedVisits,undefined,'clients do not get imported history');

  // Invite an imported person; accepting the invite activates that same user.
  const sent=await admin.req('import/staff-invite',{userId:sam.id});assert.equal(sent.email,'sam.rivera@harborline.example.com');
  const samC=client(srv);const accepted=(await samC.req('accept-invite',{token:tokenOf(sent),name:'Sam Rivera',password:pw},201)).user;
  assert.equal(accepted.id,sam.id);assert.equal(accepted.role,'inspector');
  assert.equal((await admin.call('POST','import/staff-invite',{userId:sam.id})).status,404,'already active');

  // A second company sees none of this.
  const inv=await admin.req('platform/invite',{company:'Northgate Property Watch',email:'morgan@example.test'},201);
  await rival.req('workspace-register',{token:new URL('http://x'+inv.invitePath).searchParams.get('workspaceInvite'),name:'Morgan Blake',password:pw},201);
  const rInfo=await rival.req('import/info');assert.deepEqual(rInfo.batches,[]);assert.deepEqual(rInfo.pendingStaff,[]);
  const clientBatch=(await admin.req('import/info')).batches.find(b=>b.type==='clients'&&b.created===2);
  assert.equal((await rival.call('POST','import/undo',{batchId:clientBatch.id})).status,404);
  assert.equal((await rival.call('GET','import/batches/'+clientBatch.id+'/skipped.csv')).status,404);
  assert.equal((await rival.call('POST','import/staff-invite',{userId:alex.id})).status,404);
  const rp=await rival.preview('clients',file,data);assert.equal(rp.counts.create,3,'duplicates are only matched inside your own company');
  const rh=await rival.preview('history','history.csv',b64(templateCsv('history')));assert.equal(rh.counts.create,0,'history cannot attach to another company’s residence');
  const rs=await rival.preview('staff','staff.csv',b64(csv([['Name','Email'],['Jordan Ellis','jordan@example.test']])));assert.match(rs.rows[0].reason,/already has an EstateAegis login/);

  // Skipped rows download: line numbers and reasons only.
  const skipped=await admin.call('GET','import/batches/'+clientBatch.id+'/skipped.csv');assert.equal(skipped.status,200);assert.match(skipped.text,/^\ufeff?Row,Reason/);assert.doesNotMatch(skipped.text,/4127|7316/);

  // Undo: blocked by later work and by later imports that depend on the batch; then removes exactly what it created.
  const work=await admin.req('work',{propertyId:lake.id,title:'Replace pool light'});
  let blocked=await admin.call('POST','import/undo',{batchId:clientBatch.id});assert.equal(blocked.status,409);assert.match(blocked.text,/1 work order\b/);
  await srv.stop();
  if(label==='SQLite'){const sql=new DatabaseSync(path.join(dir,'estateos.sqlite'));sql.prepare('DELETE FROM work_orders WHERE id=?').run(work.id);sql.close();}
  await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});await admin.req('login',{email:'jordan@example.test',password:pw});
  if(label==='SQLite'){
   const vendorBatch=(await admin.req('import/info')).batches.find(b=>b.type==='vendors');
   const undone=await admin.req('import/undo',{batchId:vendorBatch.id});assert.equal(undone.removed.vendors,2);
   assert.equal((await admin.req('data')).vendors.filter(v=>/Bayside|Summit/.test(v.name)).length,0);
   assert.equal((await admin.call('POST','import/undo',{batchId:vendorBatch.id})).status,409,'cannot undo twice');
   const undoClients=await admin.req('import/undo',{batchId:clientBatch.id});assert.deepEqual([undoClients.removed.residences,undoClients.removed.clients],[2,2]);
   d=await admin.req('data');assert.ok(!d.properties.some(p=>p.id===lake.id||p.id===ashby.id));assert.ok(d.properties.some(p=>p.id===seagrape),'records that were only updated stay');
   // Expired batches can no longer be undone.
   const staffBatch=(await admin.req('import/info')).batches.find(b=>b.type==='staff');
   await srv.stop();const sql=new DatabaseSync(path.join(dir,'estateos.sqlite'));sql.prepare("UPDATE import_batches SET undo_until='2026-01-01T00:00:00.000Z' WHERE id=?").run(staffBatch.id);sql.close();
   await srv.start({ESTATEOS_PLATFORM_OWNER_ID:setup.user.id});await admin.req('login',{email:'jordan@example.test',password:pw});
   blocked=await admin.call('POST','import/undo',{batchId:staffBatch.id});assert.equal(blocked.status,409);assert.match(blocked.text,/7 days|expired|no longer/i);
  }else{
   // Postgres: the work order still blocks; undo the later history batch, then the vendors.
   const b=(await admin.req('import/info')).batches;
   assert.equal((await admin.req('import/undo',{batchId:b.find(x=>x.type==='history').id})).removed.visits,1);
   assert.equal((await admin.req('import/undo',{batchId:b.find(x=>x.type==='vendors').id})).removed.vendors,2);
   assert.equal((await admin.req('data')).importedVisits.length,0);
  }
  for(const s of ['4127','7316','2468'])assert.ok(!srv.log.includes(s),'codes never reach the server log');
 }finally{await srv.stop();}
});

test('server: plan limits cap imported residences and staff (pending imports count against the import, seats rechecked on invite)', async () => {
 const dir=tmp();
 const srv=server({ESTATEOS_DATA_DIR:dir,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64'),RESEND_API_KEY:''});await srv.start();
 try{
  const admin=client(srv);
  const setup=await admin.req('setup',{company:'Harborline Home Watch',name:'Jordan Ellis',email:'jordan@example.test',password:pw},201);
  await srv.stop();
  const sql=new DatabaseSync(path.join(dir,'estateos.sqlite'));
  const org=sql.prepare('SELECT organization_id FROM users WHERE id=?').get(setup.user.id).organization_id;
  sql.prepare("INSERT INTO stripe_billing(organization_id,customer_id,subscription_id,status,plan,extra_seats,storage_packs,verified_at) VALUES(?,?,?,'active','essentials',0,0,?)").run(org,'cus_t','sub_t',new Date().toISOString());
  sql.close();
  await srv.start();await admin.req('login',{email:'jordan@example.test',password:pw});
  // Essentials: 4 admin/staff seats (1 used by Jordan) -> 3 staff rows import, the rest are refused with the plan message.
  const people=Array.from({length:5},(_,i)=>['Team Member '+i,`member${i}@harborline.example.com`,'Staff']);
  const pv=await admin.preview('staff','staff.csv',b64(csv([['Name','Email','Role'],...people])));
  assert.equal(pv.counts.create,3);assert.equal(pv.counts.error,2);assert.match(pv.rows[4].reason,/plan/i);
  const run=await admin.run('staff','staff.csv',b64(csv([['Name','Email','Role'],...people])));assert.equal(run.created,3);assert.equal(run.skipped,2);
  // Pending people can't sign in, so they don't block a regular invitation; the seat is checked again on Send invite.
  for(const [i,name] of ['Casey Morgan','Drew Parker','Jamie Fox'].entries()){const inv=await admin.req('invitations',{role:'employee',email:`direct${i}@example.test`},201);await client(srv).req('accept-invite',{token:tokenOf(inv),name,password:pw},201);}
  const full=await admin.call('POST','import/staff-invite',{userId:run.pendingStaff[0].id});
  assert.equal(full.status,409);assert.match(full.text,/seat/i);
  // And the import itself refuses new staff once seats are spoken for.
  assert.equal((await admin.preview('staff','more.csv',b64(csv([['Name','Email'],['Late Addition','late@harborline.example.com']])))).counts.create,0);
  // Residences: Essentials includes a fixed number; a file that would go over it imports only what fits.
  const max=(await admin.req('billing/status')).quote.residences;assert.ok(max>0&&max<1000);
  {
   const homes=Array.from({length:max+2},(_,i)=>['Sample family '+i,`${100+i} Harbor View Road`,'Portland','ME','04101']);
   const hp=await admin.preview('clients','homes.csv',b64(csv([['Client Name','Street','City','State','Zip'],...homes])));
   assert.equal(hp.counts.create,max);assert.equal(hp.counts.error,2);
  }
 }finally{await srv.stop();}
});
