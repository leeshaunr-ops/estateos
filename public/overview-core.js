/* EstateAegis Overview: pure rules for the signed-in Overview (browser and Node tests share this file).
   Everything here is computed from data the app already loads (/api/data, /api/operations, /api/staff/data,
   /api/storm, /api/messages). No DOM, no network. Dates are 'YYYY-MM-DD' strings in the viewer's local day. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.EAOverview=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const DAY=86400000;
 const FAIL=['fail','attention'],MONITOR=['monitor'];
 const DONE_WORK=['completed','cancelled'];
 const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],WEEKDAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],LONG_WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],LONG_MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const isoDay=v=>{const s=String(v||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';};
 const parts=d=>{const [y,m,day]=d.split('-').map(Number);return {y,m,day,date:new Date(Date.UTC(y,m-1,day))};};
 function addDays(d,n){const p=parts(d).date;p.setUTCDate(p.getUTCDate()+n);return p.toISOString().slice(0,10);}
 function daysBetween(from,to){return Math.round((parts(to).date-parts(from).date)/DAY);}
 /** Local calendar day for a Date ('YYYY-MM-DD'). */
 function localDay(now=new Date()){const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');return `${y}-${m}-${d}`;}
 /** "Thu, Oct 8" (adds the year when it is not the current one). Accepts a date or an ISO timestamp. */
 function niceDate(value,today){const d=isoDay(value);if(!d)return String(value||'');const p=parts(d),wd=WEEKDAYS[p.date.getUTCDay()];const year=today&&isoDay(today).slice(0,4)!==d.slice(0,4)?', '+p.y:'';return `${wd}, ${MONTHS[p.m-1]} ${p.day}${year}`;}
 /** "Today", "Tomorrow", "Yesterday", else niceDate. */
 function relativeDay(value,today){const d=isoDay(value);if(!d||!today)return niceDate(value,today);const n=daysBetween(today,d);return n===0?'Today':n===1?'Tomorrow':n===-1?'Yesterday':niceDate(d,today);}
 function longDate(today){const p=parts(today);return `${LONG_WEEKDAYS[p.date.getUTCDay()]}, ${LONG_MONTHS[p.m-1]} ${p.day}`;}
 function greeting(hour){return hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';}
 const firstName=name=>String(name||'').trim().split(/\s+/)[0]||'';
 const plural=(n,word,many)=>`${n} ${n===1?word:(many||word+'s')}`;
 const clip=(s,n)=>{s=String(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1).replace(/[\s,;.:-]+$/,'')+'…':s;};
 const cityOf=p=>[p?.city,p?.state].filter(Boolean).join(', ');

 /** Shared context: lookups and role rules used by every widget. */
 function context(data,{today,statusOf}={}){
  const user=data.user||{},role=user.role,admin=role==='admin',staff=['admin','employee'].includes(role);
  const props=new Map((data.properties||[]).map(p=>[p.id,p]));
  const users=new Map((data.users||[]).map(u=>[u.id,u]));
  const vendors=new Map((data.vendors||[]).map(v=>[v.id,v]));
  const clients=new Map((data.clients||[]).map(c=>[c.id,c]));
  const assignments=data.staff?.assignments||[];
  const followups=data.operations?.followups||[];
  const status=i=>(statusOf?statusOf(i):i.status)||i.status;
  const mine=i=>admin||i.inspector_id===user.id;
  const workMine=w=>admin||assignments.some(a=>a.work_id===w.id&&a.user_id===user.id)||(!w.vendor_id&&!assignments.some(a=>a.work_id===w.id&&a.user_id));
  return {data,user,role,admin,staff,today:today||localDay(),props,users,vendors,clients,assignments,followups,status,mine,workMine,
   propertyName:id=>props.get(id)?.name||'Residence',inspectorName:i=>i.inspector_name||users.get(i.inspector_id)?.name||'',
   clientName:p=>clients.get(p?.client_id)?.name||''};
 }

 /** Failed / monitor answers on submitted or published visits that have no finished follow-up work. */
 function findings(ctx){
  const out=[];
  for(const i of ctx.data.inspections||[]){
   const st=ctx.status(i);if(!['submitted','published'].includes(st))continue;
   for(const a of i.answers||[]){
    const severity=FAIL.includes(a.status)?'fail':MONITOR.includes(a.status)?'monitor':'';if(!severity)continue;
    const f=ctx.followups.find(f=>f.inspection_id===i.id&&f.answer_key===a.key);
    if(f&&DONE_WORK.includes(f.status))continue;
    out.push({inspection:i,answer:a,severity,followup:f||null,status:st});
   }
  }
  return out.sort((x,y)=>String(y.inspection.inspection_date).localeCompare(String(x.inspection.inspection_date)));
 }
 function visitTally(i){const a=i.answers||[];const f=a.filter(x=>FAIL.includes(x.status)).length,m=a.filter(x=>MONITOR.includes(x.status)).length;return f||m?[f?plural(f,'fail'):'',m?plural(m,'monitor item'):''].filter(Boolean).join(', '):'all clear';}

 /**
  * "Needs your attention": grouped, one action each.
  * Groups in priority order: failed items, reports to sign off (admins), overdue (visits and work), new from clients.
  * Lower-priority items (monitor findings, unassigned work, awaiting approvals) only count toward "N more".
  */
 function attention(data,opts={}){
  const ctx=opts.ctx||context(data,opts),t=ctx.today,items=[];
  const add=(group,item)=>items.push({group,...item});
  for(const f of findings(ctx)){
   const i=f.inspection,a=f.answer,p=ctx.props.get(i.property_id);
   const who=ctx.inspectorName(i),when=relativeDay(i.inspection_date,t);
   const found=clip(a.note,90),title=found||`${a.label} - ${f.severity==='fail'?'failed':'monitor'}`;
   const detailBits=[cityOf(p),[who,when.toLowerCase()==='today'||when.toLowerCase()==='yesterday'?when.toLowerCase():when].filter(Boolean).join(', '),found?clip(a.label,60):'',f.followup?'work: '+String(f.followup.status||'open').replaceAll('_',' '):''];
   let action;
   if(f.followup)action={label:'View work',name:'focus-work',key:f.followup.work_order_id};
   else if(f.status==='published')action={label:'Create work order',name:'finding-work',key:i.id+'|'+a.key};
   else action={label:ctx.admin?'Review report':'Open report',name:'inspection',key:i.id};
   add(f.severity==='fail'?'failed':'monitor',{id:'finding:'+i.id+':'+a.key,tone:f.severity,pill:f.severity==='fail'?'Fail':'Monitor',title,place:ctx.propertyName(i.property_id),detail:detailBits.filter(Boolean).join(' · '),action,date:i.inspection_date});
  }
  if(ctx.admin)for(const i of data.inspections||[]){
   if(ctx.status(i)!=='submitted')continue;
   const gps=i.visit?.status;
   add('sign',{id:'sign:'+i.id,tone:'sign',pill:'Sign & send',title:`${ctx.propertyName(i.property_id)} · ${niceDate(i.inspection_date,t)} visit`,place:'',detail:[ctx.inspectorName(i),visitTally(i),gps==='verified'?'GPS verified on site':gps==='outside_geofence'?'checked in away from the residence':''].filter(Boolean).join(' · '),action:{label:'Review',name:'inspection',key:i.id},date:i.inspection_date});
  }
  if(ctx.admin)for(const w of data.work||[]){if(w.status!=='submitted')continue;add('sign',{id:'work-review:'+w.id,sub:1,tone:'sign',pill:'Completed',title:w.title,place:ctx.propertyName(w.property_id),detail:'Completion waiting for your review',action:{label:'Review',name:'focus-work',key:w.id},date:w.due_date||''});}
  for(const i of data.inspections||[]){
   if(ctx.status(i)!=='draft'||!isoDay(i.inspection_date)||i.inspection_date>=t||!ctx.mine(i))continue;
   const late=daysBetween(i.inspection_date,t),p=ctx.props.get(i.property_id),who=ctx.inspectorName(i);
   const started=(i.answers||[]).some(a=>a.status&&a.status!=='unchecked');
   add('overdue',{id:'visit:'+i.id,tone:'fail',pill:plural(late,'day')+' late',title:'Visit: '+ctx.propertyName(i.property_id),place:'',detail:[cityOf(p),ctx.admin&&who?'assigned to '+who:'',started?'in progress':'not started'].filter(Boolean).join(' · '),action:{label:'Open',name:'inspection',key:i.id},date:i.inspection_date,late});
  }
  for(const w of data.work||[]){
   if(DONE_WORK.includes(w.status)||w.status==='submitted'||!isoDay(w.due_date)||w.due_date>=t||!ctx.workMine(w))continue;
   const late=daysBetween(w.due_date,t),urgent=['High','Urgent'].includes(w.priority);
   const who=w.vendor_id?ctx.vendors.get(w.vendor_id)?.name:(ctx.assignments.filter(a=>a.work_id===w.id&&a.user_id).map(a=>ctx.users.get(a.user_id)?.name).filter(Boolean)[0]||'');
   add('overdue',{id:'work:'+w.id,tone:urgent?'fail':'monitor',pill:plural(late,'day')+' late',title:w.title,place:ctx.propertyName(w.property_id),detail:[who||'no one assigned',w.priority&&w.priority!=='Normal'?w.priority+' priority':''].filter(Boolean).join(' · '),action:{label:'Open',name:'focus-work',key:w.id},date:w.due_date,late});
  }
  if(ctx.staff)for(const r of data.requests||[]){
   if(r.status!=='new')continue;const p=ctx.props.get(r.property_id);
   add('clients',{id:'request:'+r.id,tone:'info',pill:'Request',title:r.title,place:ctx.propertyName(r.property_id),detail:[ctx.clientName(p),r.priority&&r.priority!=='Normal'?r.priority+' priority':''].filter(Boolean).join(' · '),action:{label:'Review',name:'navigate',key:'requests'},date:String(r.created_at||'').slice(0,10)});
  }
  if(ctx.admin)for(const w of data.work||[]){
   if(DONE_WORK.includes(w.status)||w.status==='submitted'||w.vendor_id||ctx.assignments.some(a=>a.work_id===w.id&&a.user_id))continue;
   if(isoDay(w.due_date)&&w.due_date<t)continue;// already listed as overdue
   add('unassigned',{id:'unassigned:'+w.id,tone:'info',pill:'Unassigned',title:w.title,place:ctx.propertyName(w.property_id),detail:w.due_date?'due '+niceDate(w.due_date,t):'no due date',action:{label:'Assign',name:'focus-work',key:w.id},date:w.due_date||''});
  }
  // Insurance and vacancy compliance (data.insurance, computed by the server in the residence time zone).
  if(ctx.staff)for(const r of data.insurance?.residences||[]){
   const st=r.status||{};
   if(['breached','at_risk','due_soon'].includes(st.code))add('insurance',{id:'insurance:'+r.property_id,tone:st.code==='breached'?'fail':st.code==='at_risk'?'monitor':'info',pill:st.label,title:'Insurance: '+(r.name||ctx.propertyName(r.property_id)),place:'',detail:clip(st.reason,140),action:{label:st.code==='breached'||st.code==='at_risk'?'Plan a visit':'Review',name:'insurance-open',key:r.property_id},date:st.deadline||'',late:st.code==='breached'?Math.max(1,-(st.daysLeft||0)):0});
   if(ctx.admin&&r.renewal?.due)add('insurance',{id:'renewal:'+r.property_id,sub:1,tone:'info',pill:'Renewal',title:'Policy renews: '+(r.name||ctx.propertyName(r.property_id)),place:'',detail:`${niceDate(r.renewal.date,t)} · ${plural(r.renewal.daysLeft,'day')} left`,action:{label:'Checklist',name:'insurance-open',key:r.property_id},date:r.renewal.date});
  }
  const order=['failed','sign','overdue','insurance','clients','monitor','unassigned'];
  items.sort((a,b)=>order.indexOf(a.group)-order.indexOf(b.group)||(a.sub||0)-(b.sub||0)||(b.late||0)-(a.late||0)||String(b.date).localeCompare(String(a.date)));
  const primary=items.filter(i=>['failed','sign','overdue','insurance','clients'].includes(i.group));
  const counts=Object.fromEntries(order.map(g=>[g,items.filter(i=>i.group===g).length]));
  return {items,primary,counts,total:items.length};
 }
 const GROUP_TITLES={failed:'Failed items',sign:'Reports to sign off',overdue:'Overdue',insurance:'Insurance compliance',clients:'New from clients',monitor:'To monitor',unassigned:'Work without an assignee'};
 /** Splits the attention list into what is shown and a plain "N more" summary. */
 function attentionView(att,{limit=10,perGroup=3,showAll=false}={}){
  // Up to three per group so every kind of problem shows, at most ten in all; the rest go into "N more".
  const taken={},shown=showAll?att.items:att.primary.filter(i=>(taken[i.group]=(taken[i.group]||0)+1)<=perGroup).slice(0,limit);
  const hidden=att.items.filter(i=>!shown.includes(i));
  const groups=[];for(const item of shown){let g=groups.find(g=>g.key===item.group);if(!g){g={key:item.group,title:GROUP_TITLES[item.group],items:[]};groups.push(g);}g.items.push(item);}
  const byGroup={};for(const i of hidden)byGroup[i.group]=(byGroup[i.group]||0)+1;
  const words={failed:['failed item'],sign:['report to sign','reports to sign'],overdue:['overdue item'],insurance:['insurance item'],clients:['client request'],monitor:['monitor item'],unassigned:['work order without an assignee','work orders without an assignee']};
  const moreText=Object.entries(byGroup).map(([g,n])=>{const w=words[g];return `${n} ${n===1?w[0]:(w[1]||w[0]+'s')}`;}).join(', ');
  return {groups,hidden:hidden.length,moreText};
 }

 /** Visits panel: today's visits, the next 7 days, and visits done in the last 7 days (with GPS status). */
 function visits(data,opts={}){
  const ctx=opts.ctx||context(data,opts),t=ctx.today,end=addDays(t,7),since=addDays(t,-6);
  const list=(data.inspections||[]).filter(i=>ctx.mine(i));
  const row=(i,kind)=>({id:i.id,kind,date:i.inspection_date,property:ctx.propertyName(i.property_id),city:cityOf(ctx.props.get(i.property_id)),who:ctx.inspectorName(i),storm:!!i.storm_event_id,visitType:i.visit_type||'',started:(i.answers||[]).some(a=>a.status&&a.status!=='unchecked'),visit:i.visit||null,status:ctx.status(i)});
  const drafts=list.filter(i=>ctx.status(i)==='draft'&&isoDay(i.inspection_date));
  const today=drafts.filter(i=>i.inspection_date===t).map(i=>row(i,'visit'));
  const upcoming=drafts.filter(i=>i.inspection_date>t&&i.inspection_date<=end).map(i=>row(i,'visit'));
  // Recurring plans and "next due" dates that do not have a visit yet.
  const planned=new Set(drafts.map(i=>i.property_id+'|'+i.inspection_date));
  const plans=(data.operations?.plans||[]).filter(p=>Number(p.active)!==0&&isoDay(p.next_due)&&p.next_due>=t&&p.next_due<=end&&(ctx.admin||p.assigned_to===ctx.user.id));
  for(const p of plans){if(planned.has(p.property_id+'|'+p.next_due))continue;planned.add(p.property_id+'|'+p.next_due);const r={id:'plan:'+p.id,kind:'plan',date:p.next_due,property:ctx.propertyName(p.property_id),city:cityOf(ctx.props.get(p.property_id)),who:p.assigned_name||'',storm:false,visitType:'recurring',started:false,visit:null,status:'planned',propertyId:p.property_id};(p.next_due===t?today:upcoming).push(r);}
  for(const i of list){const d=isoDay(i.next_due);if(!d||d<t||d>end||planned.has(i.property_id+'|'+d))continue;planned.add(i.property_id+'|'+d);const r={id:'due:'+i.id,kind:'due',date:d,property:ctx.propertyName(i.property_id),city:cityOf(ctx.props.get(i.property_id)),who:ctx.inspectorName(i),storm:false,visitType:'next visit due',started:false,visit:null,status:'planned',propertyId:i.property_id};(d===t?today:upcoming).push(r);}
  upcoming.sort((a,b)=>a.date.localeCompare(b.date)||a.property.localeCompare(b.property));
  const done=list.filter(i=>['submitted','published'].includes(ctx.status(i))&&isoDay(i.inspection_date)>=since&&isoDay(i.inspection_date)<=t).sort((a,b)=>b.inspection_date.localeCompare(a.inspection_date)).map(i=>row(i,'done'));
  const days=[];for(const v of upcoming){let d=days.find(x=>x.date===v.date);if(!d){d={date:v.date,label:relativeDay(v.date,t),storm:false,items:[]};days.push(d);}d.items.push(v);if(v.storm)d.storm=true;}
  return {today,upcoming,days,done};
 }

 /** Five clickable numbers. */
 function kpis(data,opts={}){
  const ctx=opts.ctx||context(data,opts),t=ctx.today,since=addDays(t,-6),v=opts.visits||visits(data,{ctx}),att=opts.attention||attention(data,{ctx});
  const list=(data.inspections||[]).filter(i=>ctx.mine(i));
  const week=list.filter(i=>isoDay(i.inspection_date)>=since&&isoDay(i.inspection_date)<=t);
  const done=week.filter(i=>['submitted','published'].includes(ctx.status(i)));
  const verified=done.filter(i=>i.visit?.status==='verified'||i.visit?.override).length;
  const openWork=(data.work||[]).filter(w=>!DONE_WORK.includes(w.status)&&ctx.workMine(w)).length;
  const gpsOn=!!data.visitVerification?.enabled;
  return [
   ctx.admin?{key:'residences',value:String((data.properties||[]).length),label:'Residences',action:{name:'navigate',key:'properties'}}:{key:'today',value:String(v.today.length),label:'My visits today',action:{name:'overview-jump',key:'overviewVisits'}},
   {key:'done',value:`${done.length} / ${week.length}`,label:'Visits done, last 7 days',action:{name:'navigate',key:'inspections'}},
   gpsOn?{key:'gps',value:`${verified} of ${done.length}`,label:'Visits GPS-verified',action:{name:'navigate',key:'inspections'}}:{key:'gps',value:'Off',label:'GPS visit check-in',action:{name:'navigate',key:ctx.admin?'workspace':'inspections'}},
   {key:'failed',value:String(att.counts.failed),label:'Failed items open',warn:att.counts.failed>0,action:{name:'overview-jump',key:'overviewAttention'}},
   {key:'work',value:String(openWork),label:ctx.admin?'Open work orders':'My open work',action:{name:'navigate',key:'work'}}
  ];
 }

 /** Open storm events for the strip. Employees see their own storm visits. */
 function storms(data,opts={}){
  const ctx=opts.ctx||context(data,opts);
  return (data.storm?.events||[]).filter(e=>e.status!=='closed').map(e=>{const c=e.counts||{};const mine=(e.residences||[]).filter(r=>r.assigned_user_id===ctx.user.id&&[r.pre,r.post].some(v=>v&&v.status==='draft')).length;return {id:e.id,name:e.name,type:e.type_label||'Storm',status:e.status_label||'',secured:Number(c.secured||0),total:Number(c.total||0),damage:Number(c.damageFound||0),prepDeadline:e.prep_deadline_at||'',impact:e.expected_impact_at||'',mine};});
 }

 /** One-line summary under the greeting. */
 function summary(att,stormList,{today}={}){
  const bits=[];
  if(att.counts.failed)bits.push(plural(att.counts.failed,'failed item'));
  if(att.counts.sign)bits.push(`${att.counts.sign} ${att.counts.sign===1?'report':'reports'} to sign`);
  if(att.counts.overdue)bits.push(plural(att.counts.overdue,'overdue item'));
  if(att.counts.insurance)bits.push(plural(att.counts.insurance,'insurance item'));
  if(att.counts.clients)bits.push(plural(att.counts.clients,'new client request'));
  const verb=bits.length===1&&/^1 /.test(bits[0])?'needs':'need';
  let storm='';const s=stormList.find(s=>s.prepDeadline&&isoDay(s.prepDeadline)>=today);
  if(s){const n=daysBetween(today,isoDay(s.prepDeadline));storm=`Storm prep is due ${n===0?'today':n===1?'tomorrow':LONG_WEEKDAYS[parts(isoDay(s.prepDeadline)).date.getUTCDay()]}.`;}
  const joined=bits.length>1?bits.slice(0,-1).join(', ')+' and '+bits.at(-1):bits[0]||'';
  const line=(bits.length?`${joined} ${verb} you today.`:'Nothing needs you right now.')+(storm?' '+storm:'');
  return {line,parts:bits,verb,storm};
 }
 /** Residences table: one status per home, worst first. */
 function residences(data,opts={}){
  const ctx=opts.ctx||context(data,opts),t=ctx.today,f=opts.findings||findings(ctx);
  const stormHomes=new Map();for(const e of (data.storm?.events||[]).filter(e=>e.status!=='closed'))for(const r of e.residences||[])if(r.prep_status!=='secured')stormHomes.set(r.property_id,e.name);
  const RANK={fail:0,storm:1,late:2,monitor:3,ok:4,none:5};
  return (data.properties||[]).map(p=>{
   const ins=(data.inspections||[]).filter(i=>i.property_id===p.id);
   const done=ins.filter(i=>['submitted','published'].includes(ctx.status(i))&&isoDay(i.inspection_date)).sort((a,b)=>b.inspection_date.localeCompare(a.inspection_date));
   const last=done[0]||null;
   const fails=f.filter(x=>x.inspection.property_id===p.id&&x.severity==='fail').length,mons=f.filter(x=>x.inspection.property_id===p.id&&x.severity==='monitor').length;
   const lateWork=(data.work||[]).filter(w=>w.property_id===p.id&&!DONE_WORK.includes(w.status)&&isoDay(w.due_date)&&w.due_date<t&&['High','Urgent'].includes(w.priority));
   const lateVisit=ins.filter(i=>ctx.status(i)==='draft'&&isoDay(i.inspection_date)&&i.inspection_date<t).sort((a,b)=>a.inspection_date.localeCompare(b.inspection_date))[0];
   const future=[...ins.filter(i=>ctx.status(i)==='draft'&&isoDay(i.inspection_date)>=t).map(i=>({date:i.inspection_date,storm:!!i.storm_event_id})),...ins.filter(i=>isoDay(i.next_due)>=t).map(i=>({date:isoDay(i.next_due),storm:false})),...(data.operations?.plans||[]).filter(x=>x.property_id===p.id&&Number(x.active)!==0&&isoDay(x.next_due)>=t).map(x=>({date:x.next_due,storm:false}))].sort((a,b)=>a.date.localeCompare(b.date))[0];
   let state='none',text='No report yet';
   if(fails){state='fail';text=plural(fails,'failed item');}
   else if(lateWork.length){state='fail';text=lateWork.length===1?'Urgent work overdue':plural(lateWork.length,'urgent job')+' overdue';}
   else if(stormHomes.has(p.id)){state='storm';text='Storm prep';}
   else if(lateVisit){state='late';text=`Visit ${plural(daysBetween(lateVisit.inspection_date,t),'day')} late`;}
   else if(mons){state='monitor';text=plural(mons,'item')+' to monitor';}
   else if(last){state='ok';text='All clear';}
   return {id:p.id,name:p.name,client:ctx.clientName(p),city:cityOf(p),state,text,rank:RANK[state],
    last:last?{date:last.inspection_date,label:niceDate(last.inspection_date,t),who:firstName(ctx.inspectorName(last)),gps:last.visit?.status==='verified'||!!last.visit?.override}:null,
    next:lateVisit?{date:lateVisit.inspection_date,label:'Overdue',late:true}:future?{date:future.date,label:relativeDay(future.date,t)+(future.storm?' · pre-storm':'')}:null};
  }).sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name));
 }

 /** Owner arrivals in the next 14 days. */
 function arrivals(data,opts={}){
  const ctx=opts.ctx||context(data,opts),t=ctx.today,end=addDays(t,14);
  return (data.arrivals||[]).filter(a=>!['completed','cancelled'].includes(a.status)&&isoDay(a.arrival_at)>=t&&isoDay(a.arrival_at)<=end).sort((a,b)=>String(a.arrival_at).localeCompare(String(b.arrival_at))).map(a=>{const p=ctx.props.get(a.property_id),items=a.items||[],rooms=a.room_status||[];
   const stocked=items.filter(i=>['purchased','stocked'].includes(i.status)).length,ready=rooms.filter(r=>r.ready).length;
   return {id:a.id,property:ctx.propertyName(a.property_id),client:ctx.clientName(p),date:isoDay(a.arrival_at),label:relativeDay(a.arrival_at,t),status:a.status,ready:a.status==='ready',detail:[items.length?`${stocked} of ${items.length} items stocked`:'',rooms.length?`${ready} of ${rooms.length} rooms ready`:'',a.status==='ready'?'ready':''].filter(Boolean).join(' · ')||clip(a.needs,80)||'No preparation list yet'};});
 }

 /** Messages panel: unread first, then newest. Uses the server's last-message snippet. */
 function messages(data,{limit=3}={}){
  const threads=[...(data.messaging?.threads||[])];
  threads.sort((a,b)=>(Number(b.unread)>0)-(Number(a.unread)>0)||String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
  const me=data.user?.id;
  return {unread:threads.reduce((n,t)=>n+Number(t.unread||0),0),threads:threads.slice(0,limit).map(t=>{const others=(t.people||[]).filter(p=>p.id!==me).map(p=>p.name);return {id:t.id,subject:t.subject||'Conversation',from:t.last?.sender_id===me?'You':t.last?.sender_name||others[0]||'',snippet:clip(t.last?.body,140),at:t.last?.created_at||t.updated_at||'',unread:Number(t.unread||0)};})};
 }

 /** Setup checklist for a new company (admins). */
 function setupSteps(data){
  const users=data.users||[],props=data.properties||[];
  const published=(data.checklistTemplates?.templates||data.checklistTemplates||[]);
  const hasTemplate=Array.isArray(published)&&published.some(t=>!Number(t.is_system)&&t.status==='published');
  const steps=[
   {key:'company',title:'Company details',detail:'Your company name, logo and support email appear on every report.',done:!!(data.company&&(data.workspaceSupport||data.companyLogo)),action:{label:'Edit',name:'navigate',key:'workspace'}},
   {key:'client',title:'Add a client family and their residence',detail:'The address and location are used for directions and GPS-verified visits.',done:props.length>0,action:{label:(data.clients||[]).length?'Add residence':'Add client',name:(data.clients||[]).length?'new-property':'new-client',key:''},alt:{label:'Or import them from another system',name:'navigate',key:'import'}},
   {key:'checklist',title:'Pick a visit checklist',detail:'Use the standard checklist or build your own, with alerts on failed items.',done:hasTemplate||(data.inspections||[]).length>0,action:{label:'Choose',name:'navigate',key:'checklist-templates'}},
   {key:'team',title:'Invite your team',detail:'Staff get their visits on their phone, with GPS check-in.',done:users.some(u=>u.role==='employee'),action:{label:'Invite',name:'navigate',key:'users'}},
   {key:'visit',title:'Schedule the first visit',detail:'Start a visit now or set one to repeat every week or two.',done:(data.inspections||[]).length>0||(data.operations?.plans||[]).length>0,action:{label:'Schedule',name:'navigate',key:'inspections'}},
   {key:'invite-client',title:'Invite the client',detail:'They see reports, photos and storm updates in their own portal.',done:users.some(u=>u.role==='client'),action:{label:'Invite',name:'navigate',key:'users'}}
  ];
  return {steps,done:steps.filter(s=>s.done).length,total:steps.length};
 }

 return {addDays,daysBetween,localDay,niceDate,relativeDay,longDate,greeting,firstName,clip,context,findings,attention,attentionView,visits,kpis,storms,summary,residences,arrivals,messages,setupSteps,GROUP_TITLES};
});
