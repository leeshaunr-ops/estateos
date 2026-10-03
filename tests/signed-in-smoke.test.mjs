// Signed-in browser smoke test: every role logs in, opens every menu item by expanding its group where the menu has
// collapsible groups (admin and staff; none that was reachable before is missing), starts an inspection, goes offline
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
function client(){let cookie='';const call=async(endpoint,b,expected=200)=>{const res=await fetch(base+'/api/'+endpoint,{method:b===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=await res.json();assert.equal(res.status,expected,endpoint+': '+JSON.stringify(result));return result;};call.cookie=()=>cookie;return call;}
const tokenOf=inv=>new URL('http://x'+inv.invitePath).searchParams.get('invite');
const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
let draftId;
// Sessions from setup / accept-invite, reused by the app-page checks so the suite stays under the sign-in rate limit
// (20 sign-ins per 10 minutes per address); the full sign-in flow is covered by the journey test.
const sessions={};
before(async()=>{if(skip)return;await start();const admin=client();
 await admin('setup',{company:'Smoke Test Home Watch',name:'Avery Admin',email:'admin@example.test',password},201);
 const fam=await admin('clients',{name:'Rivera Family'},201);const ven=await admin('vendors',{name:'Bluewater Pools'},201);
 const home=await admin('properties',{clientId:fam.id,name:'Ocean House',streetAddress:'1 Ocean Dr',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
 draftId=(await admin('inspections',{propertyId:home.id,date:'2026-10-01'},201)).id;
 const accept=async(role,email,extra={})=>{const c=client();await c('accept-invite',{token:tokenOf(await admin('invitations',{role,email,...extra},201)),name:email.split('@')[0],password},201);return c;};
 const staff=await accept('employee','staff@example.test');const vendor=await accept('vendor','vendor@example.test',{vendorId:ven.id});const family=await accept('client','client@example.test',{clientId:fam.id});
 Object.assign(sessions,{'admin@example.test':admin.cookie(),'staff@example.test':staff.cookie(),'vendor@example.test':vendor.cookie(),'client@example.test':family.cookie()});
 // Something for the Overview to show: the staff member looks after Ocean House, an overdue work order, a message.
 const users=(await admin('data')).users;const id=e=>users.find(u=>u.email===e).id;
 await admin('access',{userId:id('staff@example.test'),propertyId:home.id},201);
 await admin('work',{propertyId:home.id,title:'Replace pool light',priority:'High',dueDate:day(-3)},201);
 await staff('messages/send',{subject:'Ocean House gate',message:'The side gate latch is loose; I zip-tied it for now.',messageId:randomUUID(),recipientId:id('admin@example.test')},201);
 // App pages (audit batches): a second home with no work, requests at both, an arrival entered as a wall-clock time and an estimate.
 const cottage=await admin('properties',{clientId:fam.id,name:'Bay Cottage',streetAddress:'9 Bay Rd',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
 await family('requests',{propertyId:cottage.id,title:'Check the dock lights',description:'',priority:'Normal'},201);
 await family('requests',{propertyId:home.id,title:'Stock the fridge',description:'Sparkling water.',priority:'Normal'},201);
 await family('arrivals',{propertyId:home.id,arrivalAt:day(5)+'T15:00',notes:'Arriving with grandchildren.'},201);
 const job=(await admin('data')).work.find(w=>w.title==='Replace pool light');
 await admin('operations/approval',{workId:job.id,amountMinor:12500,description:'New pool light fixture and labor.'},200);
 // Batch 3a: a third home where the vendor has a job, so the vendor can open a residence.
 const loft=await admin('properties',{clientId:fam.id,name:'Harbor Loft',streetAddress:'3 Harbor Way',city:'Stuart',state:'FL',postalCode:'34994',country:'United States'},201);
 await admin('work',{propertyId:loft.id,title:'Service the pool pump',priority:'Normal',dueDate:day(4),vendorId:ven.id},201);
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
 admin:['dashboard','messages','properties','clients','arrivals','work','requests','inspections','storm','calendar','routes','staff','staff-schedules','vendors','users','assets','maintenance','documents','workspace','billing','audit','checklist-templates','profile','notifications'],
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
  // Every screen this role may open is listed once, and nothing that was reachable before the refresh is missing.
  const allowed=await page.evaluate(()=>window.EASidebar.navFor(data.user).map(n=>n[0]));
  assert.deepEqual([...pages].sort(),[...allowed].sort(),`${role}: menu lists exactly the screens this role may open`);
  for(const id of MENU_BEFORE[role])assert.ok(pages.includes(id),`${role}: ${id} is still in the menu`);
  // Admin and staff: each heading is a collapsible group button; Daily work starts open, the rest collapsed.
  // Client and vendor menus stay flat.
  const grouped=['admin','employee'].includes(role),mobile=!!contextOptions.isMobile;
  const openMenu=async()=>{if(mobile&&!(await page.locator('#sidebar.open').count())){await page.click('.topbar-menu');await page.locator('#sidebar.open').waitFor({timeout:3000});await settle(page);}};
  const groupState=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('aside [data-side-toggle]')].map(b=>[b.dataset.sideToggle,b.getAttribute('aria-expanded')])));
  if(grouped){
   const groups=await page.evaluate(()=>[...document.querySelectorAll('aside [data-side-toggle]')].map(b=>({key:b.dataset.sideToggle,tag:b.tagName,type:b.type,controls:b.getAttribute('aria-controls'),target:!!document.getElementById(b.getAttribute('aria-controls')),chevron:!!b.querySelector('.side-chevron'),text:b.innerText.trim()})));
   const expected=role==='admin'?['daily-work','residences','team','company']:['daily-work','residences','team'];
   assert.deepEqual(groups.map(g=>g.key),expected,`${role}: group buttons`);
   for(const g of groups){assert.equal(g.tag,'BUTTON');assert.equal(g.type,'button');assert.ok(g.target&&g.chevron,`${role}: ${g.key} has aria-controls and a chevron`);assert.match(g.text,/^(DAILY WORK|RESIDENCES|TEAM|COMPANY)/);}
   assert.deepEqual(await groupState(),Object.fromEntries(expected.map(k=>[k,String(k==='daily-work')])),`${role}: defaults on Overview`);
   assert.equal(await page.locator('#sideGroupItems-residences [data-id="properties"]').isVisible(),false,`${role}: collapsed items are hidden`);
   assert.equal(await page.evaluate(()=>{const b=document.querySelector('#sideGroupItems-residences [data-id="properties"]');return getComputedStyle(b).visibility;}),'hidden',`${role}: collapsed items are out of the tab order`);
   if(!mobile){
    // Keyboard: Enter and Space toggle the focused group button.
    await page.focus('aside [data-side-toggle="daily-work"]');await page.keyboard.press('Enter');await settle(page);
    assert.equal((await groupState())['daily-work'],'false',`${role}: Enter collapses Daily work`);
    await page.keyboard.press('Space');await page.locator('#sideGroupItems-daily-work [data-id="inspections"]').waitFor({state:'visible',timeout:2000});
    assert.equal((await groupState())['daily-work'],'true',`${role}: Space opens it again`);
   }
  }else{
   assert.equal(await page.locator('aside [data-side-toggle], aside details, aside .side-chevron, aside [aria-expanded]').count(),0,`${role}: flat menu, no collapsible groups`);
  }
  // Open every item the way a person would: expand its group if it is collapsed, then click the visible item
  // (on the phone through the slide-out menu). The current page's group is open after each navigation.
  for(const id of pages){
   await openMenu();
   const btn=page.locator(`aside [data-action="navigate"][data-id="${id}"]`);
   if(!(await btn.isVisible())){
    assert.ok(grouped,`${role}: ${id} is visible in the flat menu`);
    const key=await btn.evaluate(b=>b.closest('[data-side-group]')?.dataset.sideGroup);
    assert.ok(key,`${role}: hidden ${id} is inside a group`);
    const toggle=page.locator(`aside [data-side-toggle="${key}"]`);
    assert.equal(await toggle.getAttribute('aria-expanded'),'false',`${role}: ${key} was collapsed`);
    await toggle.click();
    await btn.waitFor({state:'visible',timeout:3000});
    assert.equal(await toggle.getAttribute('aria-expanded'),'true',`${role}: ${key} expands`);
    visited.push('expand:'+key);
   }
   await btn.click({timeout:5000});await settle(page);visited.push(id);
   assert.equal(await page.locator('.shell').count(),1,`${role}: ${id} renders`);
   assert.equal(await page.evaluate(()=>page),id,`${role}: ${id} opens`);
   assert.equal(await page.locator(`aside [data-id="${id}"][aria-current="page"]`).count(),1,`${role}: ${id} is highlighted`);
   if(grouped){const key=await page.evaluate(id=>document.querySelector(`aside [data-id="${id}"]`).closest('[data-side-group]')?.dataset.sideGroup||null,id);if(key)assert.equal((await groupState())[key],'true',`${role}: ${id}'s group is open`);}
  }
  if(grouped){
   // A detail screen keeps its parent's group open even after the user collapses that group elsewhere.
   await openMenu();await click(page,'aside [data-side-toggle="daily-work"]');await settle(page);
   assert.equal((await groupState())['daily-work'],'false');
   await page.evaluate(id=>action('inspection',id),draftId);await page.waitForSelector('.shell main',{timeout:5000});await settle(page);
   assert.equal((await groupState())['daily-work'],'true',`${role}: the inspection detail opens Daily work`);
   assert.equal(await page.locator('aside [data-id="inspections"][aria-current="page"]').count(),1,`${role}: Visits & inspections is highlighted on the detail screen`);
   visited.push('detail-opens-group');
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
  if(['admin','employee'].includes(role)){
   // Remembered per user: every group was expanded above and Daily work was last collapsed, which beats its default.
   const saved=await page.evaluate(()=>({key:window.EASidebar.storageKey(data.user.id),value:JSON.parse(localStorage.getItem(window.EASidebar.storageKey(data.user.id))||'{}'),page,state:Object.fromEntries([...document.querySelectorAll('aside [data-side-toggle]')].map(b=>[b.dataset.sideToggle,b.getAttribute('aria-expanded')]))}));
   assert.equal(saved.value['daily-work'],false,`${role}: the collapsed Daily work choice is saved`);
   for(const [k,v] of Object.entries(saved.state))if(k!=='daily-work')assert.equal(v,'true',`${role}: ${k} stays open after sign-out, sign-in and reload`);
   const current=await page.evaluate(()=>window.EASidebar.groupOf(window.EASidebar.menu(window.EASidebar.navFor(data.user),data.user.role),page));
   assert.equal(saved.state['daily-work'],current==='daily-work'?'true':'false',`${role}: Daily work follows the saved choice unless it holds the current page`);
   visited.push('groups-remembered');
  }
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

// App pages (design audit batches): each affected page opens for the roles that use it, shows readable dates
// (never "2026-10-08 15:00:00.000Z"), and its fixed features work, with zero page errors and error toasts.
const MACHINE_DATE=/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const mainText=page=>page.locator('.shell main .content').innerText();
async function go(page,id){await page.evaluate(id=>action('navigate',id),id);await page.waitForSelector('.shell main .content',{timeout:5000});await settle(page);return mainText(page);}
// Batch 1: every page header matches the Overview (Georgia title, no company eyebrow; left-aligned with full-width
// actions on the phone) and shows readable dates.
async function headerChecks(page,mobile,role,ids,done){
 for(const id of ids){const t=await go(page,id);assert.doesNotMatch(t,MACHINE_DATE,`${role}: ${id} has no machine dates`);
  const h=await page.evaluate(()=>{const head=document.querySelector('.content .page-head'),title=head?.querySelector('.page-title'),text=head?.querySelector('.page-head-text'),acts=[...(head?.querySelectorAll('.page-actions button,.page-actions .button')||[])];
   return head&&{font:getComputedStyle(title).fontFamily,eyebrow:!!head.querySelector('.eyebrow'),textLeft:Math.round(text.getBoundingClientRect().left-head.getBoundingClientRect().left),
    full:acts.every(b=>b.getBoundingClientRect().width>=head.getBoundingClientRect().width-2)};});
  assert.ok(h,`${role}: ${id} has the shared page header`);assert.match(h.font,/Georgia/,`${role}: ${id} title uses Georgia`);
  assert.equal(h.eyebrow,false,`${role}: ${id} has no company eyebrow`);
  if(mobile){assert.ok(h.textLeft<=1,`${role}: ${id} header is left-aligned on the phone`);assert.ok(h.full,`${role}: ${id} header actions are full width on the phone`);}
  done.push(id);}
}
// Empty lists show a card with a title, one sentence and (where the role can act) the next step.
async function emptyCheck(page,role,id,title,action){await go(page,id);
 const e=await page.evaluate(()=>{const c=document.querySelector('.content .empty-state');return c&&{title:c.querySelector('.empty-title')?.textContent,detail:!!c.querySelector('.empty-detail'),action:c.querySelector('.empty-action [data-action]')?.dataset.action||''};});
 assert.ok(e,`${role}: ${id} shows an empty-state card`);assert.match(e.title,title,`${role}: ${id} empty-state title`);assert.ok(e.detail,`${role}: ${id} empty state explains the next step`);assert.equal(e.action,action,`${role}: ${id} empty-state action`);}
// Batch 3a: residence detail has a facts strip and wrapping sections (no sideways tab strip), and the Summary shows
// visits and work openly (no closed toggles). Old tab names still open the section that holds them.
async function residenceChecks(page,role,name,expect,done){
 await go(page,'properties');await page.evaluate(n=>action('property',data.properties.find(p=>p.name===n).id),name);await settle(page);
 const r=await page.evaluate(()=>{const tabs=document.querySelector('.content .res-tabs');return {title:document.querySelector('.content .page-title')?.textContent,facts:document.querySelectorAll('.content .res-fact').length,
  tabs:tabs?[...tabs.querySelectorAll('button')].map(b=>b.dataset.id):null,overflow:tabs?tabs.scrollWidth>tabs.clientWidth+1:false,closed:document.querySelectorAll('.content details.collapsible-panel:not([open])').length,
  panels:[...document.querySelectorAll('.content .res-panel h2')].map(h=>h.textContent.replace(/\s*\d+$/,'').trim()),wide:document.documentElement.scrollWidth>innerWidth+1};});
 assert.equal(r.title,name,`${role}: residence title`);assert.equal(r.wide,false,`${role}: residence page fits the screen`);
 if(expect.tabs===null){assert.equal(r.tabs,null,`${role}: no lone tab strip`);done.push('residence');return;}
 assert.deepEqual(r.tabs,expect.tabs,`${role}: residence sections`);assert.equal(r.overflow,false,`${role}: sections wrap instead of scrolling`);
 assert.equal(r.facts,5,`${role}: facts strip`);assert.equal(r.closed,0,`${role}: nothing hidden behind closed toggles`);
 for(const p of expect.panels)assert.ok(r.panels.includes(p),`${role}: Summary shows ${p} (got ${r.panels.join(', ')})`);
 if(expect.alias){await page.evaluate(([t])=>action('tab',t),[expect.alias[0]]);await settle(page);
  assert.equal(await page.locator('.content .res-tabs button.active').getAttribute('data-id'),expect.alias[1],`${role}: old tab ${expect.alias[0]} opens ${expect.alias[1]}`);}
 done.push('residence');
}
// Batch 3b: work orders are a filtered list grouped by due date with one open work order and a single next step.
async function workChecks(page,role,expect,done){
 await go(page,'work');
 const w=await page.evaluate(()=>({chips:[...document.querySelectorAll('.content .work-chips .chip')].map(c=>c.textContent.replace(/\s+\d+$/,'').trim()),groups:[...document.querySelectorAll('.content .work-group')].map(g=>g.textContent),
  rows:[...document.querySelectorAll('.content .work-row')].map(r=>r.querySelector('strong').textContent),title:document.querySelector('.content .work-detail-title')?.textContent,
  primary:document.querySelectorAll('.content .work-actions > button.primary').length,cards:document.querySelectorAll('.content details.work-card').length,wide:document.documentElement.scrollWidth>innerWidth+1}));
 assert.equal(w.cards,0,`${role}: no fold-out work cards`);assert.equal(w.wide,false,`${role}: work page fits the screen`);
 for(const c of expect.chips)assert.ok(w.chips.includes(c),`${role}: filter chip ${c} (got ${w.chips.join(', ')})`);
 for(const r of expect.rows)assert.ok(w.rows.includes(r),`${role}: work list shows ${r}`);
 assert.equal(w.title,w.rows[0],`${role}: the first work order is open beside the list`);
 assert.ok(w.primary<=1,`${role}: at most one primary next step`);if(expect.primary)assert.equal(await page.locator('.content .work-actions > button.primary').innerText(),expect.primary,`${role}: next step`);
 if(expect.groups)for(const g of expect.groups)assert.ok(w.groups.includes(g),`${role}: group ${g}`);
 if(w.rows.length>1){await page.locator('.content .work-row').nth(1).click();await settle(page);assert.equal(await page.locator('.content .work-detail-title').innerText(),w.rows[1],`${role}: choosing a row opens it`);}
 await page.locator('.content .work-chips .chip',{hasText:'Completed'}).click();await settle(page);assert.equal(await page.locator('.content .work-chips .chip.active').getAttribute('data-id'),'completed',`${role}: Completed filter`);
 await page.locator('.content .work-chips .chip[data-id="open"]').click();await settle(page);done.push('work');
}
const PAGE_CHECKS={
 admin:async(page,mobile,done)=>{
  await headerChecks(page,mobile,'admin',['properties','work','inspections','requests','maintenance','documents','assets','audit','billing','messages','notifications','storm'],done);
  await residenceChecks(page,'admin','Ocean House',{tabs:['overview','inspections','services','arrivals','records','people','notes'],panels:['Needs attention here','Visits','Work orders','Owners & family','Next arrival','Home records','Latest note'],alias:['assets','records']},done);
  await emptyCheck(page,'admin','assets',/No assets yet/,'new-asset');await emptyCheck(page,'admin','documents',/No documents yet/,'new-document');await emptyCheck(page,'admin','billing',/No invoices yet/,'');done.push('empty-states');
  assert.equal(await page.locator('aside [data-id="platform"]').count(),0,'admin: no duplicate Platform Administration item');
  for(const id of ['arrivals','calendar']){const t=await go(page,id);assert.doesNotMatch(t,MACHINE_DATE,`admin: ${id} has no machine dates`);done.push(id);}
  assert.match(await go(page,'arrivals'),/Arrival|3:00 PM/,'admin: arrivals list');
  assert.doesNotMatch(await mainText(page),/0\/0 (rooms|items)/,'admin: no empty 0/0 badges');
  // Assign / schedule opens a real assignment dialog and saves.
  await go(page,'work');
  await page.evaluate(()=>{const d=document.querySelector('details.work-card');if(d)d.open=true;});
  await click(page,'[data-action="work-assignment"]');await page.waitForSelector('dialog[open] select[name="assignee"]',{timeout:5000});
  const staffValue=await page.evaluate(()=>[...document.querySelectorAll('dialog[open] select[name="assignee"] option')].find(o=>o.value.startsWith('staff:')&&/staff/i.test(o.textContent))?.value);
  assert.ok(staffValue,'admin: staff members are offered');
  await page.selectOption('dialog[open] select[name="assignee"]',staffValue);await page.click('dialog[open] button[type="submit"]');
  await page.waitForSelector('dialog[open]',{state:'detached',timeout:5000}).catch(()=>{});await page.waitForFunction(()=>!document.querySelector('dialog[open]'),null,{timeout:5000});await settle(page);
  await page.evaluate(()=>{const d=document.querySelector('details.work-card');if(d)d.open=true;});
  await click(page,'[data-action="work-assignment"]');await page.waitForSelector('dialog[open] select[name="assignee"]',{timeout:5000});
  assert.equal(await page.locator('dialog[open] select[name="assignee"]').inputValue(),staffValue,'admin: the saved assignment is shown when reopened');
  await page.evaluate(()=>document.querySelector('dialog[open]').close());done.push('work-assignment');
  // Approvals: amount on its own line, no dangling separator.
  const appr=await go(page,'approvals');assert.match(appr,/\$125\.00/);assert.doesNotMatch(appr,/·\s*$/m,'admin: no dangling separator');done.push('approvals');
  await workChecks(page,'admin',{chips:['Open','Overdue','Waiting on client','Vendors','Completed'],rows:['Replace pool light','Service the pool pump'],groups:['Overdue','Due this week']},done);
  // Requests: "Link work order" only where there is work to link.
  await go(page,'requests');
  const links=await page.evaluate(()=>[...document.querySelectorAll('.content .row')].map(r=>({t:r.innerText,link:!!r.querySelector('[data-action="link-request"]')})));
  assert.equal(links.find(r=>/dock lights/.test(r.t))?.link,false,'admin: no Link work order without work at Bay Cottage');
  assert.equal(links.find(r=>/Stock the fridge/.test(r.t))?.link,true,'admin: Link work order where work exists');done.push('requests');
  // Secondary request actions sit behind More; it opens, and closes on an outside click.
  const more=page.locator('.content .row',{hasText:'Stock the fridge'}).locator('details.more-menu');
  await more.locator('summary').click();assert.equal(await more.evaluate(d=>d.open),true,'admin: More opens');
  assert.ok(await more.locator('[data-action="request-priority"]').isVisible(),'admin: Edit priority is in More');
  await page.locator('.content .page-title').click();assert.equal(await more.evaluate(d=>d.open),false,'admin: More closes on an outside click');done.push('more-menu');
  assert.doesNotMatch(await go(page,'profile'),/Account ID/,'admin: no raw account ID');done.push('profile');
  // Batch 2 wording: one name for Staff, plain audit events and email statuses, no staff jargon.
  await go(page,'staff');assert.equal(await page.locator('.content .page-title').innerText(),'Staff','admin: Staff page title matches the menu');
  const audit=await go(page,'audit');assert.match(audit,/Residence created/,'admin: audit events in sentence case');assert.doesNotMatch(audit,/Property Created|Work Created/,'admin: no Title Case codes');
  const email=await go(page,'email-activity');assert.doesNotMatch(email,/\d+ attempts|submissions to the provider/,'admin: no email jargon');
  assert.doesNotMatch(await go(page,'automation'),/Recovery backup|encrypted archive|consolidated/,'admin: no automation jargon');done.push('wording');
 },
 vendor:async(page,mobile,done)=>{
  await headerChecks(page,mobile,'vendor',['work','properties','messages'],done);
  await go(page,'work');assert.equal(await page.locator('.content .page-title').innerText(),'Your jobs','vendor: jobs title');
  await residenceChecks(page,'vendor','Harbor Loft',{tabs:null},done);
  await workChecks(page,'vendor',{chips:['Open','Completed'],rows:['Service the pool pump'],primary:'Start work'},done);
  assert.match(await go(page,'messages'),/company that sends you jobs/,'vendor: messages subtitle for vendors');done.push('wording');
 },
 client:async(page,mobile,done)=>{
  await headerChecks(page,mobile,'client',['properties','work','inspections','requests','documents','messages','notifications'],done);
  await emptyCheck(page,'client','documents',/No documents yet/,'');
  await workChecks(page,'client',{chips:['Open','Needs your approval','Completed'],rows:['Replace pool light'],primary:'Review the estimate'},done);
  await residenceChecks(page,'client','Ocean House',{tabs:['overview','inspections','services','arrivals','records','people'],panels:['Needs attention here','Visits','Service updates','Owners & family','Next arrival','Home records'],alias:['shopping','arrivals']},done);
  // Batch 2 wording: written for the family, not for staff.
  const home=await go(page,'dashboard');assert.match(await page.locator('.content .page-title').innerText(),/^Good (morning|afternoon|evening)/,'client: home greets the family');
  assert.equal(await page.locator('details.action-needed').evaluate(d=>d.open),true,'client: Action needed starts open');assert.doesNotMatch(home,/\b1 work orders\b/,'client: singular work order');
  assert.doesNotMatch(await go(page,'messages'),/staff, vendors, employees/,'client: messages subtitle for the family');
  assert.doesNotMatch(await go(page,'inspections'),/correct family/,'client: reports subtitle for the family');
  const work=await go(page,'work');assert.equal(await page.locator('.content .page-title').innerText(),'Service updates','client: title matches the menu');assert.doesNotMatch(work,/verified completion/,'client: no staff wording');
  await page.evaluate(()=>action('property',data.properties.find(p=>p.name==='Ocean House').id));await settle(page);assert.doesNotMatch(await mainText(page),/Client access active/,'client: no staff access wording');done.push('wording');
  for(const id of ['arrivals','calendar']){const t=await go(page,id);assert.doesNotMatch(t,MACHINE_DATE,`client: ${id} has no machine dates`);done.push(id);}
  const appr=await go(page,'approvals');assert.match(appr,/\$125\.00/);assert.doesNotMatch(appr,/·\s*$/m,'client: no dangling separator');done.push('approvals');
  assert.doesNotMatch(await go(page,'profile'),/Account ID/,'client: no raw account ID');done.push('profile');
 }
};
async function pageJourney(launch,contextOptions,role,email){
 const browser=await launch();const ctx=await browser.newContext({...contextOptions,serviceWorkers:'block'});
 const {page,errors,toasts}=await watch(ctx);const done=[];
 try{const [name,value]=sessions[email].split('=');await ctx.addCookies([{name,value,url:base}]);
  await page.goto(base+'/login');await page.waitForSelector('.shell',{timeout:15000});await settle(page);
  await PAGE_CHECKS[role](page,!!contextOptions.isMobile,done);
  await page.waitForTimeout(300);return {errors,shown:await toasts(),done};
 }finally{await browser.close();}
}
for(const [name,launch,options] of browsers.length?browsers:[['browser',null,null]]){
 test(`signed in (${name}): app pages from the design audit work for each role`,{skip,timeout:240000},async()=>{
  for(const [role,email] of roles.filter(([r])=>PAGE_CHECKS[r])){
   const {errors,shown,done}=await pageJourney(launch,options,role,email);
   assert.deepEqual(errors,[],`${role}: page errors after ${done.join(', ')}`);
   assert.deepEqual(shown.filter(t=>ERROR_TOAST.test(t)),[],`${role}: error toasts`);
  }
 });
}
