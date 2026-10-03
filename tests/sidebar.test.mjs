// Sidebar menu: the menu (public/sidebar-core.js) keeps every screen each role could open before, shows only the
// screens that role may open; admin and staff get collapsible groups (defaults, current-group auto-open, per-user
// localStorage choices); client and vendor menus stay flat.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import '../public/sidebar-core.js';
const S=globalThis.EASidebar;
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');

// What the menu reached before the refresh (stability-baseline 75b4901: direct items plus the collapsible groups,
// intersected with each role's screens). Approvals, Schedules & automation and Email activity were admin screens
// that the old groups never listed; the new menu adds them.
const BEFORE={
 admin:['dashboard','messages','properties','clients','arrivals','work','requests','inspections','storm','calendar','routes','staff','staff-schedules','vendors','users','assets','maintenance','documents','platform','workspace','billing','audit','checklist-templates','profile','notifications'],
 employee:['dashboard','messages','properties','arrivals','work','requests','inspections','storm','calendar','routes','staff-schedules','assets','maintenance','documents','profile','notifications'],
 client:['dashboard','messages','properties','arrivals','shopping','work','requests','inspections','calendar','documents','approvals','profile','notifications'],
 vendor:['dashboard','messages','properties','work','profile','notifications']
};
const users=[];for(const role of Object.keys(BEFORE))for(const platformOwner of [false,true])users.push({role,platformOwner});

test('no screen that was reachable from the menu became unreachable, for every role',()=>{
 for(const user of users){
  const ids=S.ids(S.menu(S.navFor(user),user.role));
  const before=BEFORE[user.role].concat(user.platformOwner&&user.role!=='client'?['platform']:[]);
  for(const id of before)assert.ok(ids.includes(id),`${user.role}${user.platformOwner?' (platform owner)':''}: ${id} is still in the menu`);
 }
});

test('every screen a role may open is in its menu exactly once, and nothing else',()=>{
 for(const user of users){
  const nav=S.navFor(user).map(n=>n[0]),ids=S.ids(S.menu(S.navFor(user),user.role));
  assert.deepEqual([...ids].sort(),[...nav].sort(),`${user.role}: menu matches the screens this role may open`);
  assert.equal(new Set(ids).size,ids.length,`${user.role}: no duplicates`);
  const m=S.menu(S.navFor(user),user.role);
  assert.ok(!m.sections.some(s=>s.title==='More'),`${user.role}: every screen has a proper heading`);
 }
});

test('role visibility is unchanged',()=>{
 const ids=(role,platformOwner=false)=>S.navFor({role,platformOwner}).map(n=>n[0]);
 assert.ok(!ids('employee').some(id=>['staff','clients','vendors','billing','users','audit','workspace','automation','email-activity','checklist-templates','approvals','platform'].includes(id)),'staff never see admin screens');
 assert.ok(ids('employee',true).includes('platform'),'platform owners keep Platform Administration');
 assert.deepEqual(ids('vendor'),['dashboard','messages','properties','work','profile','notifications']);
 assert.ok(!ids('client').some(id=>['routes','storm','assets','maintenance','staff-schedules','platform'].includes(id)),'clients never see staff screens');
 assert.ok(ids('client').includes('shopping')&&!ids('admin').includes('shopping'),'shopping list is the client screen');
});

test('menu structure: flat headings in the mockup style, short client and vendor menus',()=>{
 const titles=role=>S.menu(S.navFor({role}),role).sections.map(s=>s.title+': '+s.items.map(i=>i.label).join(', '));
 const m=S.menu(S.navFor({role:'admin'},{unreadMessages:3}),'admin');
 assert.deepEqual(m.top.map(i=>i.label),['Overview','Messages','Notifications'],'counts are badges, not part of the label');
 assert.equal(m.subtitle,'Admin workspace');
 assert.deepEqual(titles('admin'),[
  'Daily work: Visits & inspections, Daily route, Calendar, Work orders, Requests, Arrival preparation, Storm board, Client approvals',
  'Residences: Residences, Client families, Documents, Assets, Maintenance',
  'Team: Staff, Staff schedules, Vendors, Team & access',
  'Company: Company settings, Checklist templates, Schedules & automation, Billing, Email activity, Audit history, Platform Administration']);
 assert.deepEqual(titles('employee'),[
  'Daily work: Visits & inspections, Daily route, Calendar, Work orders, Requests, Arrival preparation, Storm board',
  'Residences: Residences, Documents, Assets, Maintenance',
  'Team: Staff schedules']);
 assert.deepEqual(titles('client'),['Your home: My residences, Inspection reports, Service updates, Requests, Documents','Plans: Arrivals, Shopping list, Calendar, Approvals']);
 assert.deepEqual(titles('vendor'),['Your work: My jobs, Residences']);
 assert.deepEqual(m.footer.map(i=>i.id),['profile']);
 assert.equal(S.activeId('property'),'properties');assert.equal(S.activeId('inspection'),'inspections');assert.equal(S.activeId('asset-inspection'),'assets');
});

test('the shell renders the menu, wires the rules and keeps the logo fix',()=>{
 const live=read('public/live.js'),html=read('public/live.html'),sw=read('public/sw.js'),server=read('server.mjs'),css=read('public/overview.css');
 assert.match(live,/const nav=window\.EASidebar\.navFor\(data\.user/,'render builds the menu from sidebar-core');
 assert.match(live,/<aside id="sidebar" class="side/);
 assert.doesNotMatch(live,/groupedNavigation|nav-chevron|data-nav-group/,'the old <details> groups are gone');
 assert.match(live,/const logo=workspaceLogoSrc\(\)/,'sidebar badge uses the company logo (companyLogo || workspaceLogo)');
 assert.match(html,/<script src="\/sidebar-core\.js\?v=[^"]+"><\/script>[\s\S]*<script src="\/live\.js/,'menu rules load before live.js');
 assert.ok(sw.includes("'/sidebar-core.js'"),'service worker caches sidebar-core.js');
 assert.match(server,/SHELL_FILES = \[[^\]]*'sidebar-core\.js'/,'shell version covers sidebar-core.js');
 assert.match(css,/\.shell>aside \.side-item\.active\{[^}]*inset 3px 0 0 #8b242b/,'active item has the wine left bar');
 assert.doesNotMatch(read('public/sidebar-core.js')+live,/style=/,'no inline styles (CSP)');
});

// ---------- Collapsible groups ----------
const menuFor=(role,platformOwner=false)=>S.menu(S.navFor({role,platformOwner}),role);
const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),dump:()=>Object.fromEntries(m)};};

test('collapsible groups: admin and staff only; client and vendor menus stay flat',()=>{
 assert.equal(S.collapsible('admin'),true);assert.equal(S.collapsible('employee'),true);
 assert.equal(S.collapsible('client'),false);assert.equal(S.collapsible('vendor'),false);assert.equal(S.collapsible(undefined),false);
 assert.deepEqual(menuFor('admin').sections.map(s=>S.groupKey(s.title)),['daily-work','residences','team','company']);
 assert.deepEqual(menuFor('employee').sections.map(s=>S.groupKey(s.title)),['daily-work','residences','team']);
});

test('defaults: Daily work is open and the other groups are collapsed',()=>{
 for(const page of ['dashboard','messages','notifications','profile']){
  assert.deepEqual(S.groupStates(menuFor('admin'),{page}),{'daily-work':true,residences:false,team:false,company:false},`admin on ${page}`);
  assert.deepEqual(S.groupStates(menuFor('employee'),{page}),{'daily-work':true,residences:false,team:false},`staff on ${page}`);
 }
 assert.deepEqual(S.DEFAULT_OPEN,['daily-work']);
 assert.equal(S.groupOf(menuFor('admin'),'dashboard'),null,'the top block is not in a group');
 assert.equal(S.groupOf(menuFor('admin'),'profile'),null,'the footer is not in a group');
});

test('the group holding the current page (or the parent a detail screen highlights) opens automatically',()=>{
 const m=menuFor('admin',true),cases={
  inspections:'daily-work',routes:'daily-work',approvals:'daily-work',inspection:'daily-work',
  properties:'residences',property:'residences',clients:'residences',assets:'residences','asset-inspection':'residences',maintenance:'residences',
  staff:'team','staff-schedules':'team',users:'team',vendors:'team',
  workspace:'company',billing:'company',audit:'company',platform:'company','checklist-templates':'company','checklist-editor':'company','email-activity':'company',automation:'company'};
 for(const [page,group] of Object.entries(cases)){
  assert.equal(S.groupOf(m,page),group,`${page} lives in ${group}`);
  const states=S.groupStates(m,{page});
  assert.equal(states[group],true,`${page}: ${group} is open`);
  for(const [k,open] of Object.entries(states))if(k!==group)assert.equal(open,k==='daily-work',`${page}: ${k} keeps its default`);
 }
 // Every menu item in a group opens that group when it is the current page.
 for(const role of ['admin','employee'])for(const sec of menuFor(role).sections)for(const it of sec.items)
  assert.equal(S.groupStates(menuFor(role),{page:it.id,saved:{[S.groupKey(sec.title)]:false}})[S.groupKey(sec.title)],true,`${role}: ${it.id}`);
 // Even when the user collapsed Daily work, an inspection detail screen keeps it open.
 assert.equal(S.groupStates(m,{page:'inspection',saved:{'daily-work':false}})['daily-work'],true);
});

test('choices are remembered per user in localStorage and override the defaults, except for the current group',()=>{
 const store=memory(),m=menuFor('admin');
 assert.equal(S.storageKey('u-1'),'estateaegis-sidebar-groups-v2:u-1');
 assert.deepEqual(S.readSaved(store,'u-1'),{},'nothing saved yet');
 S.saveChoice(store,'u-1','daily-work',false);S.saveChoice(store,'u-1','team',true);
 assert.deepEqual(JSON.parse(store.getItem('estateaegis-sidebar-groups-v2:u-1')),{'daily-work':false,team:true});
 assert.deepEqual(S.readSaved(store,'u-2'),{},'another user on the same device keeps the defaults');
 assert.deepEqual(S.groupStates(m,{page:'dashboard',saved:S.readSaved(store,'u-2')}),{'daily-work':true,residences:false,team:false,company:false});
 // A later visit: the saved choices beat the defaults.
 const saved=S.readSaved(store,'u-1');
 assert.deepEqual(S.groupStates(m,{page:'dashboard',saved}),{'daily-work':false,residences:false,team:true,company:false});
 // ...but the current page's group is always open, without changing what was saved.
 assert.deepEqual(S.groupStates(m,{page:'calendar',saved}),{'daily-work':true,residences:false,team:true,company:false});
 assert.deepEqual(S.readSaved(store,'u-1'),{'daily-work':false,team:true});
 // Re-opening is remembered too; the last choice wins.
 S.saveChoice(store,'u-1','daily-work',true);S.saveChoice(store,'u-1','team',false);
 assert.deepEqual(S.groupStates(m,{page:'dashboard',saved:S.readSaved(store,'u-1')}),{'daily-work':true,residences:false,team:false,company:false});
});

test('collapsing the current group holds on that page (background refresh) and reopens on navigation',()=>{
 const m=menuFor('admin'),manual={key:'team',page:'staff',open:false};
 assert.equal(S.groupStates(m,{page:'staff',saved:{team:false},manual}).team,false,'stays collapsed on the same page');
 assert.equal(S.groupStates(m,{page:'vendors',saved:{team:false},manual}).team,true,'another page in the group opens it again');
 assert.equal(S.groupStates(m,{page:'staff',saved:{team:false}}).team,true,'reload (no manual state) opens it again');
});

test('storage problems never break the menu',()=>{
 const broken={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('quota');}};
 assert.deepEqual(S.readSaved(broken,'u'),{});
 assert.deepEqual(S.saveChoice(broken,'u','team',true),{team:true});
 assert.deepEqual(S.readSaved(null,'u'),{});
 for(const raw of ['not json','[1,2]','null','"x"','{"team":"yes","company":true}']){
  const store=memory();store.setItem(S.storageKey('u'),raw);
  assert.deepEqual(S.readSaved(store,'u'),raw.includes('company')?{company:true}:{},raw);
 }
});

test('a collapsed group header shows the total of its items\' badges',()=>{
 const m=menuFor('admin'),[daily,res]=m.sections;
 assert.equal(S.groupCount(daily,{}),0);
 assert.equal(S.groupCount(daily,{requests:2,approvals:3,messages:9}),5,'only items inside the group count');
 assert.equal(S.groupCount(res,{requests:2}),0);
 assert.equal(S.groupCount(res,{documents:'4',assets:-1,maintenance:NaN}),4,'bad values are ignored');
});

test('the shell renders accessible group buttons with quick, motion-safe expand and no inline styles',()=>{
 const live=read('public/live.js'),css=read('public/overview.css');
 const fn=live.slice(live.indexOf('function sideNavigation('),live.indexOf('function familyMemberActions('));
 assert.match(fn,/<button type="button" class="side-toggle" id="'\+btnId\+'" data-side-toggle="'\+esc\(key\)\+'" aria-expanded="'\+open\+'" aria-controls="'\+listId\+'">/,'heading is a button with aria-expanded and aria-controls');
 assert.match(fn,/class="side-group-items" id="'\+listId\+'" role="group" aria-labelledby="'\+btnId\+'"/,'the controlled list is labelled by its button');
 assert.match(fn,/if\(S\.collapsible\(role\)\)/,'only admin and staff get groups');
 assert.match(fn,/S\.groupStates\(\{\.\.\.m,sections:secs\},\{page,saved:S\.readSaved\(sidebarStorage\(\),data\.user\.id\),manual:sidebarManual\}\)/,'states come from the rules, keyed by user id');
 assert.match(fn,/S\.groupCount\(sec,counts\)/,'group badge');
 assert.match(live,/saveChoice\(sidebarStorage\(\),data\.user\.id,key,open\)/,'toggling saves the choice for this user');
 assert.match(live,/if\(name==='navigate'\)\{sidebarManual=null;/,'navigation re-opens the current group');
 assert.match(css,/\.side-toggle\[aria-expanded="false"\]\+\.side-group-items\{grid-template-rows:0fr;visibility:hidden;/,'collapsed items are hidden from tab order');
 assert.match(css,/\.side-toggle\[aria-expanded="true"\] \.side-group-count\{display:none\}/,'badge only while collapsed');
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{[^}]*\.side-group-items[^}]*\{transition:none\}/,'respects reduced motion');
 const dur=[...css.matchAll(/grid-template-rows \.(\d+)s/g)].map(x=>Number('0.'+x[1]));
 assert.ok(dur.length&&dur.every(d=>d<=0.25),'expand is quick');
 assert.doesNotMatch(fn,/style=|<script/,'no inline styles or scripts (CSP)');
});
