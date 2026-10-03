// Sidebar menu refresh: the flat menu (public/sidebar-core.js) keeps every screen each role could open before,
// shows only the screens that role may open, and the shell renders it without collapsible groups.
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

test('the shell renders the flat menu, wires the rules and keeps the logo fix',()=>{
 const live=read('public/live.js'),html=read('public/live.html'),sw=read('public/sw.js'),server=read('server.mjs'),css=read('public/overview.css');
 assert.match(live,/const nav=window\.EASidebar\.navFor\(data\.user/,'render builds the menu from sidebar-core');
 assert.match(live,/<aside id="sidebar" class="side/);
 assert.doesNotMatch(live,/groupedNavigation|nav-chevron|data-nav-group/,'no collapsible groups or chevrons');
 assert.match(live,/const logo=workspaceLogoSrc\(\)/,'sidebar badge uses the company logo (companyLogo || workspaceLogo)');
 assert.match(html,/<script src="\/sidebar-core\.js\?v=[^"]+"><\/script>[\s\S]*<script src="\/live\.js/,'menu rules load before live.js');
 assert.ok(sw.includes("'/sidebar-core.js'"),'service worker caches sidebar-core.js');
 assert.match(server,/SHELL_FILES = \[[^\]]*'sidebar-core\.js'/,'shell version covers sidebar-core.js');
 assert.match(css,/\.shell>aside \.side-item\.active\{[^}]*inset 3px 0 0 #8b242b/,'active item has the wine left bar');
 assert.doesNotMatch(read('public/sidebar-core.js')+live,/style=/,'no inline styles (CSP)');
});
