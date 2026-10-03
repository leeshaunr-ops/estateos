// Sidebar menu rules (no DOM): which screens each role can open, and how the flat menu groups them.
// Loaded in the browser as window.EASidebar and in Node tests via import (sets globalThis.EASidebar).
(function(root){
 'use strict';
 // Every screen a signed-in user can open from the menu, by role. Same rules and order as before the refresh.
 function navFor(user,{unreadMessages=0}={}){
  const role=user&&user.role,staff=role==='admin'||role==='employee';
  const nav=[['dashboard','Overview'],['messages','Messages'+(unreadMessages?' ('+unreadMessages+')':'')],['properties',role==='client'?'My residences':'Residences'],['work',role==='vendor'?'My jobs':'Work orders']];
  if(role==='client')nav.push(['shopping','Shopping list']);
  if(role!=='vendor')nav.push(['inspections','Inspection reports'],['requests','Service requests'],['arrivals','Arrival preparation'],['calendar','Calendar'],['documents','Documents']);
  if(staff)nav.push(['maintenance','Maintenance'],['assets','Assets'],['routes','Daily route'],['storm','Storms']);
  if(user&&user.platformOwner||role==='admin')nav.push(['platform','Platform Administration']);
  if(staff)nav.push(['staff-schedules','Staff schedules']);
  if(role==='admin')nav.push(['staff','Staff'],['workspace','Company settings'],['clients','Client families'],['vendors','Vendors'],['billing','Billing'],['users','Team & access'],['audit','Audit history']);
  if(role==='admin'||role==='client')nav.push(['approvals','Client approvals']);
  if(role==='admin')nav.push(['automation','Schedules & automation'],['email-activity','Email activity'],['checklist-templates','Checklist templates']);
  nav.push(['profile','My profile'],['notifications','Notifications']);
  return nav;
 }
 const TOP=['dashboard','messages','notifications'];
 const SECTIONS={
  staff:[['Daily work',['inspections','routes','calendar','work','requests','arrivals','storm','approvals']],
   ['Residences',['properties','clients','documents','assets','maintenance']],
   ['Team',['staff','staff-schedules','vendors','users']],
   ['Company',['workspace','checklist-templates','automation','billing','email-activity','audit','platform']]],
  client:[['Your home',['properties','inspections','work','requests','documents']],
   ['Plans',['arrivals','shopping','calendar','approvals']],['Company',['platform']]],
  vendor:[['Your work',['work','properties']],['Company',['platform']]]
 };
 const LABELS={
  staff:{inspections:'Visits & inspections',requests:'Requests',storm:'Storm board',messages:'Messages'},
  client:{work:'Service updates',requests:'Requests',arrivals:'Arrivals',approvals:'Approvals',messages:'Messages'},
  vendor:{messages:'Messages'}
 };
 const SUBTITLE={admin:'Admin workspace',employee:'Staff workspace',client:'Client portal',vendor:'Vendor portal'};
 const kind=role=>role==='client'?'client':role==='vendor'?'vendor':'staff';
 // The flat menu: a top block, titled sections and a footer (profile). Anything in nav that no section lists
 // still gets a place under "More", so a screen can never drop out of the menu.
 function menu(nav,role){
  const k=kind(role),labels=LABELS[k],have=new Map(nav.map(([id,label])=>[id,label])),placed=new Set();
  const take=id=>{if(!have.has(id)||placed.has(id))return null;placed.add(id);return {id,label:labels[id]||have.get(id)};};
  const top=TOP.map(take).filter(Boolean);
  const footer=['profile'].map(take).filter(Boolean);
  const sections=SECTIONS[k].map(([title,ids])=>({title,items:ids.map(take).filter(Boolean)})).filter(s=>s.items.length);
  const rest=nav.map(([id])=>id).filter(id=>!placed.has(id)).map(take).filter(Boolean);
  if(rest.length)sections.push({title:'More',items:rest});
  return {top,sections,footer,subtitle:SUBTITLE[role]||'Workspace'};
 }
 // Which menu item is highlighted for detail screens.
 const activeId=page=>page==='property'?'properties':page==='inspection'?'inspections':page==='asset-inspection'?'assets':page==='checklist-editor'?'checklist-templates':page;
 const ids=m=>[...m.top,...m.sections.flatMap(s=>s.items),...m.footer].map(i=>i.id);
 const api={navFor,menu,activeId,ids,SECTIONS,TOP};
 root.EASidebar=api;
 if(typeof module==='object'&&module&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
