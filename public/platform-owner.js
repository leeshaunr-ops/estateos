/* Platform (owner monitoring) screen inside the app. Only rendered for the platform owner; the server answers 404 to
   everyone else. Read-only: companies, plans, trials, Stripe status, usage vs limits, MRR, signups, trials ending,
   failed payments, cancellations and /demo requests. Dates are shown in Eastern Time with an "ET" label.
   Lists are plain stacked cards (no scrolling boxes) that collapse to one column on phones.
   window.EAOwner.html(model, nowMs) is a pure builder so Node tests can render it. No inline scripts or styles (CSP). */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const TZ='America/New_York',DAY=86400000;
 const valid=v=>v&&!Number.isNaN(Date.parse(v));
 /** "Oct 4, 2026" in Eastern Time. */
 const fmtDate=v=>valid(v)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric'}).format(new Date(v)):'—';
 /** "Oct 4, 2026, 9:25 AM ET". */
 const fmtDateTime=v=>valid(v)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v))+' ET':'—';
 const money=minor=>minor==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:Number(minor)%100?2:0}).format(Number(minor)/100);
 const gb=bytes=>{const n=Number(bytes||0)/1e9;return (n>=10?n.toFixed(0):n>=0.1?n.toFixed(1):n>0?'<0.1':'0')+' GB';};
 const STATUS={active:'Active',trialing:'Free trial',past_due:'Past due',unpaid:'Unpaid',canceled:'Canceled',incomplete:'Incomplete',incomplete_expired:'Expired checkout',paused:'Paused',payment_pending:'Payment pending',pending:'Activation pending',no_subscription:'No subscription',demo:'Demo workspace',unknown:'Syncing'};
 const TONE={active:'',trialing:'amber',past_due:'red',unpaid:'red',canceled:'red',incomplete:'amber',payment_pending:'amber',no_subscription:'grey',demo:'grey'};
 const statusBadge=s=>`<span class="badge owner-badge ${TONE[s]??''}">${esc(STATUS[s]||String(s||'').replace(/_/g,' '))}</span>`;
 const DEMO={demo_active:'Demo active',demo_ended:'Demo ended',accepted:'Accepted',invited:'Invitation sent',delivery_failed:'Email not delivered'};
 const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
 /** Whole calendar days (Eastern Time) from now until v: tomorrow is 1, whatever the hour. */
 const etDay=ms=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));return Date.parse(p+'T00:00:00Z');};
 const daysUntil=(v,now)=>Math.round((etDay(Date.parse(v))-etDay(now))/DAY);
 function usageLine(label,used,limit,fmt=String){
  const over=limit!=null&&used>limit,meter=limit?`<meter class="owner-meter" min="0" max="${esc(limit)}" low="${esc(limit*0.75)}" high="${esc(limit*0.9)}" optimum="0" value="${esc(Math.min(used,limit))}" aria-label="${esc(label)}"></meter>`:'';
  return `<div class="owner-usage${over?' over':''}"><span class="owner-usage-label">${esc(label)}</span><span class="owner-usage-value">${esc(fmt(used))}${limit!=null?' of '+esc(fmt(limit)):''}${over?' · over limit':''}</span>${meter}</div>`;
 }
 function trialText(c,now){
  if(c.status!=='trialing'||!c.trialEnd)return '';
  const days=daysUntil(c.trialEnd,now);
  return `Trial ends ${fmtDate(c.trialEnd)}${c.trialEndEstimated?' (estimated)':''} · ${days<0?'ended':days===0?'today':plural(days,'day')+' left'}`;
 }
 function companyCard(c,now){
  const facts=[`Signed up ${fmtDate(c.signupAt)}`,c.planName?`${c.planName} · ${money(c.amountMinor)}/month`:'',trialText(c,now),
   c.kind==='demo'?`Demo ends ${fmtDate(c.demoExpiresAt)}`:'',c.cancelAtPeriodEnd&&c.status!=='canceled'?`Cancels ${fmtDate(c.periodEnd)}`:'',c.status==='canceled'?`Canceled ${fmtDate(c.canceledAt||c.endedAt)}`:'',
   c.status==='active'&&c.periodEnd?`Renews ${fmtDate(c.periodEnd)}`:'',c.workspaceStatus==='suspended'?'Workspace suspended':''].filter(Boolean);
  const addOns=[c.addOns.extraSeats?plural(c.addOns.extraSeats,'extra user'):'',c.addOns.storagePacks?plural(c.addOns.storagePacks,'extra 20 GB pack'):'',c.addOns.extraInspectors?plural(c.addOns.extraInspectors,'extra field inspector'):''].filter(Boolean);
  return `<article class="owner-company" data-owner-company="${esc(c.id)}"><div class="owner-company-head"><div><h3>${esc(c.name)}</h3>${c.admin?`<p class="owner-sub">${esc(c.admin.name)} · ${esc(c.admin.email)}</p>`:''}</div><div class="owner-badges">${c.planName?`<span class="badge owner-badge plan">${esc(c.planName)}</span>`:''}${statusBadge(c.status)}</div></div>
<p class="owner-facts">${facts.map(esc).join(' <span aria-hidden="true">·</span> ')}</p>
<div class="owner-usage-grid">${usageLine('Residences',c.usage.residences,c.limits.residences)}${usageLine('Admin/staff users',c.usage.seats,c.limits.seats)}${usageLine('Field inspectors',c.usage.inspectors||0,c.limits.inspectors)}${usageLine('Storage',c.usage.bytes,c.limits.storageBytes,gb)}<div class="owner-usage"><span class="owner-usage-label">Client and vendor logins</span><span class="owner-usage-value">${esc(c.usage.portalUsers)} · unlimited</span></div></div>
${addOns.length?`<p class="owner-sub">Add-ons: ${esc(addOns.join(' · '))}</p>`:''}${c.lastPaymentFailedAt?`<p class="owner-alert">Payment failed ${esc(fmtDateTime(c.lastPaymentFailedAt))}${c.lastPaymentFailedMinor!=null?' · '+esc(money(c.lastPaymentFailedMinor)):''}</p>`:''}</article>`;
 }
 const listPanel=(title,items,emptyText,count=items.length)=>`<section class="panel owner-list"><div class="owner-list-head"><h2>${esc(title)}</h2><span class="owner-count">${esc(count)}</span></div>${items.length?`<ul>${items.join('')}</ul>`:`<p class="owner-empty">${esc(emptyText)}</p>`}</section>`;
 const li=(main,sub,end='')=>`<li><div><strong>${main}</strong>${sub?`<small>${sub}</small>`:''}</div>${end?`<span class="owner-li-end">${end}</span>`:''}</li>`;
 function html(m,now=Date.now()){
  const byId=new Map(m.companies.map(c=>[c.id,c])),pick=ids=>ids.map(id=>byId.get(id)).filter(Boolean),k=m.metrics;
  const tile=(label,value,detail='')=>`<div class="owner-kpi"><span>${esc(label)}</span><b>${esc(value)}</b>${detail?`<small>${esc(detail)}</small>`:''}</div>`;
  const kpis=`<div class="owner-kpis">${tile('Monthly recurring revenue',money(k.mrrMinor),'Active subscriptions only')}${tile('Paying companies',k.paid)}${tile('On free trial',k.trialing,money(k.trialValueMinor)+'/month after trials')}${tile('Past due',k.pastDue,k.pastDue?money(k.pastDueMinor)+'/month at risk':'')}${tile('Canceled',k.canceled)}${tile('No subscription',k.noSubscription,'Invited or legacy companies')}${tile('Demo workspaces active',k.demosActive)}${tile('Demo requests',k.demoRequests30,'Last 30 days')}</div>`;
  const signups=pick(m.recentSignups).map(c=>li(esc(c.name),esc([fmtDate(c.signupAt),c.planName||STATUS[c.status]].filter(Boolean).join(' · ')),statusBadge(c.status)));
  const ending=pick(m.trialsEndingSoon).map(c=>li(esc(c.name),esc(`${c.planName||'Plan'} · ${money(c.amountMinor)}/month after trial`),esc(trialText(c,now).replace(/^Trial ends /,''))));
  const failed=m.failedPayments.map(f=>li(esc(f.company),esc(fmtDateTime(f.at)),`${esc(money(f.amountMinor))} ${f.status?statusBadge(f.status):''}`));
  const cancels=pick(m.cancellations).map(c=>li(esc(c.name),esc(c.status==='canceled'?`Canceled ${fmtDate(c.canceledAt||c.endedAt)}`:`Cancels at period end · ${fmtDate(c.periodEnd)}`),esc(money(c.amountMinor)+'/month')));
  const demos=m.demoRequests.map(r=>li(esc(r.company),esc([r.name,r.email,r.residences?r.residences+' residences':'',r.requestedAt?'Requested '+fmtDate(r.requestedAt):''].filter(Boolean).join(' · ')),esc(DEMO[r.status]+(r.demoEndsAt&&r.status==='demo_active'?' · ends '+fmtDate(r.demoEndsAt):''))));
  const companies=m.companies.map(c=>companyCard(c,now)).join('');
  const hook=m.webhook||{};
  return `<div class="owner-page">${kpis}
<div class="owner-lists">${listPanel('Trials ending in 7 days',ending,'No trials end in the next 7 days.')}${listPanel('Failed payments',failed,'No failed payments in the last 60 days.')}${listPanel('Recent signups',signups,'No new companies in the last 30 days.')}${listPanel('Cancellations',cancels,'No cancellations.')}</div>
${listPanel('Demo workspace requests',demos,'No demo requests yet.')}
<section class="owner-companies" aria-labelledby="owner-companies-title"><div class="owner-list-head"><h2 id="owner-companies-title">All companies</h2><span class="owner-count">${esc(m.companies.length)}</span></div>${companies||'<p class="owner-empty">No companies yet.</p>'}</section>
<p class="owner-foot">Updated ${esc(fmtDateTime(m.generatedAt))}. Stripe webhook ${hook.configured?`connected (${esc(hook.mode)} mode)${hook.lastEventAt?' · last event '+esc(fmtDateTime(hook.lastEventAt)):' · no events yet'}`:'not configured: add STRIPE_WEBHOOK_SECRET in Render'}. MRR counts active subscriptions at their monthly price; it is not cash collected. Private residence records, client details and access codes are never shown here.</p></div>`;
 }
 const state={model:null,loading:false,error:'',at:0};
 async function load(force){
  if(state.loading)return;state.loading=true;state.error='';
  try{const r=await fetch('/api/owner/overview',{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to load the Platform view.');state.model=d;state.at=Date.now();}
  catch(e){state.error=e.message;}finally{state.loading=false;if(typeof root.render==='function')root.render();}
 }
 function page(){
  if(!state.model&&!state.loading&&!state.error)load();
  const heading=typeof root.head==='function'?root.head('Platform','Every company on EstateAegis: plans, trials, payments and usage. Only you can see this page.',`<button type="button" data-owner-action="refresh">Refresh</button><button type="button" data-owner-action="backfill">Sync from Stripe</button>`):'<h1>Platform</h1>';
  if(state.error&&!state.model)return heading+`<div class="panel owner-empty" role="alert">${esc(state.error)} <button type="button" data-owner-action="refresh">Try again</button></div>`;
  if(!state.model)return heading+'<div class="panel owner-empty">Loading companies…</div>';
  return heading+(state.error?`<p class="owner-alert" role="alert">${esc(state.error)}</p>`:'')+html(state.model);
 }
 root.EAOwner={html,page,load,fmtDate,fmtDateTime,money,daysUntil,state};
 if(typeof document!=='undefined')document.addEventListener('click',async event=>{
  const button=event.target.closest&&event.target.closest('[data-owner-action]');if(!button)return;
  button.disabled=true;
  try{if(button.dataset.ownerAction==='backfill'){const r=await fetch('/api/owner/backfill',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const d=await r.json();if(!r.ok)throw Error(d.error||'Sync failed.');}state.model=state.model;await load(true);}
  catch(e){state.error=e.message;if(typeof root.render==='function')root.render();}
 });
})(typeof window!=='undefined'?window:globalThis);
