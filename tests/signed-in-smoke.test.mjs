// Signed-in browser smoke test: every role logs in, opens every menu item (and none that was reachable before is missing), starts an inspection, goes offline
// and back, signs out and in again, and reloads, with zero page errors and zero error toasts. It would have
// caught the Oct 3 sign-out regression (auth is not defined, then data.offline on a null session).
// Runs against a local server with a temporary database (never a real one). Needs playwright-core and a browser:
// set PLAYWRIGHT_CORE (path to playwright-core/index.mjs) and CHROME_PATH, or it looks in the usual places and
// skips with a message when neither is available. WebKit (iPhone emulation) runs when Playwright's WebKit is installed.
// The Overview checks: admin and staff get the refreshed Overview (needs-your-attention list, message previews and a
// "Plan today's route" button that opens the Daily route planner); clients and vendors never see the route button; the
// marketing footer stays hidden inside the app; on the phone the menu opens over a dimmed backdrop that closes it.
import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pwCore=[process.env.PLAYWRIGHT_CORE,path.join(root,'node_modules/playwright-core/index.mjs'),'/node_modules/playwright-core/index.mjs'].find(p=>p&&existsSync(p));
const chromePath=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>p&&existsSync(p));
const pw=pwCore?await import(pathToFileURL(pwCore).href):null;
const webkitOk=!!pw&&existsSync(pw.webkit.executablePath());
const skip=!pw?'playwright-core not found (set PLAYWRIGHT_CORE)':!chromePath&&!webkitOk?'no browser found (set CHROME_PATH)':false;
const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-smoke-'));
let proc,base,log='';
const password='Test-only-strong-password-928!';
async function start(){const env={...process.env,PORT:'0',ESTATEOS_DATA_DIR:dir,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64')};delete env.DATABASE_URL;delete env.RENDER;delete env.ESTATEOS_SECURE_COOKIES;
 proc=spawn(process.execPath,['server.mjs'],{cwd:root,env,windowsHide:true});proc.stderr.on('data',c=>{log+=c;});
 base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited: '+code+' '+log)));setTimeout(()=>reject(Error('Startup timeout')),10000).unref();});}
function client(){let cookie='';return async(endpoint,b,expected=200)=>{const res=await fetch(base+'/api/'+endpoint,{method:b===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=await res.json();assert.equal(res.status,expected,endpoint+': '+JSON.stringify(result));return result;};}
const tokenOf=inv=>new URL('http://x'+inv.invitePath).searchParams.get('invite');
const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
let draftId;
before(async()=>{if(skip)return;await start();const admin=client();
 await admin('setup',{company:'Smoke Test Home Watch',name:'Avery Admin',email:'admin@example.test',password},201);
 const fam=await admin('clients',{name:'Rivera Family'},201);const ven=await admin('vendors',{name:'Bluewater Pools'},201);
 const home=await admin('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
 draftId=(await admin('inspections',{propertyId:home.id,date:'2026-10-01'},201)).id;
 const accept=async(role,email,extra={})=>{const c=client();await c('accept-invite',{token:tokenOf(await admin('invitations',{role,email,...extra},201)),name:email.split('@')[0],password},201);return c;};
 const staff=await accept('employee','staff@example.test');await accept('vendor','vendor@example.test',{vendorId:ven.id});await accept('client','client@example.test',{clientId:fam.id});
 // Something for the Overview to show: the staff member looks after Ocean House, an overdue work order, a message.
 const users=(await admin('data')).users;const id=e=>users.find(u=>u.email===e).id;
 await admin('access',{userId:id('staff@example.test'),propertyId:home.id},201);
 await admin('work',{propertyId:home.id,title:'Replace pool light',priority:'High',dueDate:day(-3)},201);
 await staff('messages/send',{subject:'Ocean House gate',message:'The side gate latch is loose; I zip-tied it for now.',messageId:randomUUID(),recipientId:id('admin@example.test')},201);
});
after(async()=>{if(proc&&!proc.killed){proc.kill();await new Promise(r=>proc.once('exit',r));}rmSync(dir,{recursive:true,force:true});});

// Records toasts and page errors for one page.
async function watch(ctx){
 await ctx.addInitScript(()=>{window.__toasts=[];const seen=()=>{const t=document.getElementById('toast');if(t&&!t.hidden&&t.textContent&&window.__toasts[window.__toasts.length-1]!==t.textContent)window.__toasts.push(t.textContent);};new MutationObserver(seen).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});});
 const page=await ctx.newPage();const errors=[];
 page.on('pageerror',e=>errors.push('pageerror: '+e.message));
 page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errors.push('console: '+m.text());});
 page.on('dialog',d=>d.accept());
 return {page,errors,toasts:()=>page.evaluate(()=>window.__toasts||[])};
}
// Screens the menu reached before the sidebar refresh (stability-baseline 75b4901), per role.
const MENU_BEFORE={
 admin:['dashboard','messages','properties','clients','arrivals','work','requests','inspections','storm','calendar','routes','staff','staff-schedules','vendors','users','assets','maintenance','documents','platform','workspace','billing','audit','checklist-templates','profile','notifications'],
 employee:['dashboard','messages','properties','arrivals','work','requests','inspections','storm','calendar','routes','staff-schedules','assets','maintenance','documents','profile','notifications'],
 client:['dashboard','messages','properties','arrivals','shopping','work','requests','inspections','calendar','documents','approvals','profile','notifications'],
 vendor:['dashboard','messages','properties','work','profile','notifications']
};
const ERROR_TOAST=/not defined|can't find variable|is not an object|is not a function|cannot read|undefined|null|TypeError|ReferenceError/i;
async function signIn(page,email){await page.waitForSelector('#f-email',{timeout:15000});await page.fill('#f-email',email);await page.fill('#f-password',password);await page.click('#authForm [type=submit]');await page.waitForSelector('.shell',{timeout:15000});}
const click=(page,selector)=>page.evaluate(s=>{const el=document.querySelector(s);if(!el)throw Error('missing '+s);el.click();},selector);
const settle=page=>page.waitForTimeout(250);

async function journey(browserName,launch,contextOptions,role,email){
 const browser=await launch();const ctx=await browser.newContext({...contextOptions,serviceWorkers:'block'});
 const {page,errors,toasts}=await watch(ctx);const visited=[];
 try{
  await page.goto(base+'/login');await signIn(page,email);
  assert.equal(await page.evaluate(()=>{const f=document.getElementById('siteFooter');return !f||getComputedStyle(f).display==='none';}),true,`${role}: no marketing footer inside the app`);
  if(['admin','employee'].includes(role)){
   await page.waitForSelector('.ov #overviewAttention',{timeout:5000});
   assert.match(await page.locator('#overviewAttention .ov-row').allInnerTexts().then(t=>t.join('\n')),/Replace pool light/,`${role}: the overdue work order needs attention`);
   assert.ok(await page.locator('.ov-msg').count()>=1,`${role}: message previews`);
   assert.match(await page.locator('.ov-msg').first().innerText(),/side gate latch/,`${role}: message snippet`);
   await click(page,'.ov-route');await settle(page);
   assert.equal(await page.evaluate(()=>page),'routes',`${role}: the route button opens the route planner`);
   assert.match(await page.locator('.shell main h1').first().innerText(),/Plan your day/);
   visited.push('route-button');
   await click(page,'aside [data-action="navigate"][data-id="dashboard"]');await settle(page);
  }else{
   assert.equal(await page.locator('.ov-route').count(),0,`${role}: no route button`);
  }
  if(contextOptions.isMobile){
   await page.click('.topbar-menu');await settle(page);
   assert.equal(await page.locator('.nav-backdrop').isVisible(),true,`${role}: dimmed backdrop behind the menu`);
   assert.equal(await page.locator('.topbar-menu').getAttribute('aria-expanded'),'true');
   const vp=page.viewportSize();await page.mouse.click(vp.width-8,Math.round(vp.height/2));await settle(page);
   assert.equal(await page.locator('#sidebar.open').count(),0,`${role}: tapping the backdrop closes the menu`);
   visited.push('menu-backdrop');
  }else{
   assert.equal(await page.locator('.topbar-menu').isVisible(),false,`${role}: no Menu button on desktop`);
  }
  // Every left-menu section, as listed in the sidebar for this role.
  const pages=await page.evaluate(()=>[...document.querySelectorAll('aside [data-action="navigate"]')].map(b=>b.dataset.id));
  assert.ok(pages.length>=4,`${role}: menu has sections`);
  // The flat menu: no collapsible groups, every screen this role may open is listed once, nothing that was
  // reachable before the refresh is missing.
  assert.equal(await page.locator('aside details, aside .nav-chevron').count(),0,`${role}: no collapsible groups`);
  const allowed=await page.evaluate(()=>window.EASidebar.navFor(data.user).map(n=>n[0]));
  assert.deepEqual([...pages].sort(),[...allowed].sort(),`${role}: menu lists exactly the screens this role may open`);
  for(const id of MENU_BEFORE[role])assert.ok(pages.includes(id),`${role}: ${id} is still in the menu`);
  for(const id of pages){
   await click(page,`aside [data-action="navigate"][data-id="${id}"]`);await settle(page);visited.push(id);
   assert.equal(await page.locator('.shell').count(),1,`${role}: ${id} renders`);
   assert.equal(await page.evaluate(()=>page),id,`${role}: ${id} opens`);
   assert.equal(await page.locator(`aside [data-id="${id}"][aria-current="page"]`).count(),1,`${role}: ${id} is highlighted`);
  }
  assert.deepEqual(errors,[],`${role}: no page errors while opening every menu item`);
  if(['admin','employee'].includes(role)){
   await page.evaluate(id=>action('inspection',id),draftId);await page.waitForSelector('.shell main',{timeout:5000});await settle(page);visited.push('inspection');
   await ctx.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await page.waitForTimeout(600);
   await click(page,'aside [data-action="navigate"][data-id="inspections"]');await settle(page);
   await ctx.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(800);visited.push('offline-and-back');
  }
  await click(page,'[data-action="logout"]');await page.waitForSelector('#authForm',{timeout:10000});
  assert.equal(await page.locator('.shell').count(),0,`${role}: the app is gone after sign-out`);
  assert.match(new URL(page.url()).pathname,/^\/login$/);
  await signIn(page,email);await page.reload();await page.waitForSelector('.shell',{timeout:15000});visited.push('signout-signin-reload');
  await page.waitForTimeout(500);
  const shown=await toasts();
  return {errors,shown,visited};
 }finally{await browser.close();}
}

const browsers=[];
if(!skip&&chromePath)browsers.push(['chromium desktop',()=>pw.chromium.launch({executablePath:chromePath,args:['--no-sandbox']}),{viewport:{width:1280,height:800}}]);
if(!skip&&webkitOk)browsers.push(['webkit iPhone',()=>pw.webkit.launch(),{...pw.devices['iPhone 15']}]);
const roles=[['admin','admin@example.test'],['employee','staff@example.test'],['client','client@example.test'],['vendor','vendor@example.test']];
for(const [name,launch,options] of browsers.length?browsers:[['browser',null,null]]){
 test(`signed in (${name}): every role opens every section, signs out and in, and reloads with no errors`,{skip,timeout:240000},async()=>{
  for(const [role,email] of roles){
   const {errors,shown,visited}=await journey(name,launch,options,role,email);
   assert.deepEqual(errors,[],`${role}: page errors after ${visited.join(', ')}`);
   assert.deepEqual(shown.filter(t=>ERROR_TOAST.test(t)),[],`${role}: error toasts`);
  }
 });
}
