/* "Your EstateAegis plan" panel on the admin Billing page: plan, status, allowances against usage, add-ons, and the
   reminder that client and vendor logins are unlimited. Allowances come from the server (GET /api/billing/status),
   which derives them from the plan catalog, so the panel never carries its own copy of the limits.
   Pure HTML builder (window.EAPlan.panel) so Node tests can render it; one delegated click handler opens Stripe's
   billing portal. Every value is escaped; no inline scripts or styles (CSP). */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=minor=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:Number(minor)%100?2:0}).format(Number(minor||0)/100);
 const GB=1e9,gb=bytes=>{const n=Number(bytes||0)/GB;return (n>=10?n.toFixed(0):n>=0.1?n.toFixed(1):n>0?'<0.1':'0')+' GB';};
 const STATUS={active:'Active',trialing:'Free trial',past_due:'Payment past due',unpaid:'Unpaid',canceled:'Canceled',payment_pending:'Payment pending',incomplete:'Incomplete',pending:'Activation pending',not_subscribed:'Not subscribed'};
 const statusLabel=s=>STATUS[s]||String(s||'').replace(/_/g,' ');
 const meter=(used,limit,label)=>limit?`<meter class="plan-meter" min="0" max="${esc(limit)}" low="${esc(limit*0.75)}" high="${esc(limit*0.9)}" optimum="0" value="${esc(Math.min(used,limit))}" aria-label="${esc(label)}"></meter>`:'';
 const row=(title,value,detail,bar='')=>`<div class="plan-row"><div class="plan-row-text"><strong>${esc(title)}</strong>${detail?`<small>${detail}</small>`:''}</div><div class="plan-row-value">${value}</div>${bar}</div>`;
 /** data: the app's loaded data ({billing, subscription, users}). Returns '' for non-admins. */
 function panel(data){
  if(!data||!data.user||data.user.role!=='admin')return '';
  const b=data.billing||{},s=data.subscription||{},q=b.quote,u=b.usage||{residences:0,seats:Number(s.seats||0),bytes:Number(s.used||0)};
  const users=Array.isArray(data.users)?data.users:[],active=x=>x.active!==false&&x.active!==0;
  const portalUsers=users.filter(x=>active(x)&&(x.role==='client'||x.role==='vendor')).length;
  const unlimited=row('Client and vendor logins',`<span class="plan-unlimited">Unlimited</span>`,`${esc(portalUsers)} active · never counted toward your admin/staff users`);
  const catalog=Array.isArray(b.catalog)?b.catalog:[];
  if(!q){
   const storageLimit=Number(s.limit||0);
   const choices=catalog.length?`<p class="plan-note">Plans: ${catalog.map(p=>`<strong>${esc(p.name)}</strong> ${esc(money(p.monthlyMinor))}/month · up to ${esc(p.residences)} residences · ${esc(p.seats)} admin/staff users · ${esc(p.storageGB)} GB`).join('; ')}. Extra admin/staff users are $15 each per month; extra storage is $5 per 20 GB per month.</p>`:'';
   return `<section class="panel res-panel plan-panel" aria-labelledby="plan-panel-title"><div class="res-panel-head"><h2 id="plan-panel-title">Your EstateAegis plan</h2><a class="plan-link" href="/pricing">See plans</a></div>
<p class="plan-status"><span class="badge">${esc(statusLabel(b.status||'not_subscribed'))}</span> No paid subscription is connected to this company yet.</p>
<div class="plan-rows">${row('Active residences',esc(u.residences),'')}${row('Admin/staff users',esc(u.seats),'Administrators and staff each use one seat.')}${row('Storage',`${esc(gb(u.bytes))}${storageLimit?' of '+esc(gb(storageLimit)):''}`,'',meter(u.bytes,storageLimit,'Storage used'))}${unlimited}</div>${choices}</section>`;
  }
  const plan=catalog.find(p=>p.key===q.plan),name=plan?plan.name:q.plan;
  const addOns=[q.extraSeats?`${esc(q.extraSeats)} extra admin/staff user${q.extraSeats===1?'':'s'} ($15 each/month)`:'',q.storagePacks?`${esc(q.storagePacks)} extra 20 GB storage pack${q.storagePacks===1?'':'s'} ($5 each/month)`:''].filter(Boolean);
  const portal=b.connected&&b.enabled?`<button type="button" data-plan-action="portal">Manage billing</button>`:'';
  return `<section class="panel res-panel plan-panel" aria-labelledby="plan-panel-title"><div class="res-panel-head"><h2 id="plan-panel-title">Your EstateAegis plan</h2>${portal}</div>
<p class="plan-status"><strong class="plan-name">${esc(name)}</strong> · ${esc(money(q.monthlyMinor))}/month <span class="badge${['past_due','unpaid','canceled'].includes(b.status)?' red':b.status==='trialing'?' amber':''}">${esc(statusLabel(b.status))}</span></p>
<div class="plan-rows">${row('Active residences',`${esc(u.residences)} of ${esc(q.residences)}`,'Archived residences don’t count.',meter(u.residences,q.residences,'Active residences used'))}${row('Admin/staff users',`${esc(u.seats)} of ${esc(q.seats)}`,q.extraSeats?`Includes ${esc(q.extraSeats)} extra user${q.extraSeats===1?'':'s'}.`:'Administrators and staff each use one seat.',meter(u.seats,q.seats,'Admin/staff users used'))}${row('Storage',`${esc(gb(u.bytes))} of ${esc(q.storageGB)} GB`,'Shared across your company.',meter(u.bytes,q.storageGB*GB,'Storage used'))}${unlimited}</div>
<p class="plan-note">${addOns.length?'Add-ons: '+addOns.join(' · ')+'. ':''}Need more users or storage? Extra admin/staff users are $15 each per month and extra storage is $5 per 20 GB per month. Email <a href="mailto:sales@estateaegis.com">sales@estateaegis.com</a> to change your plan.</p><p class="plan-error" id="plan-panel-error" role="alert" hidden></p></section>`;
 }
 root.EAPlan={panel,statusLabel,money};
 if(typeof document!=='undefined')document.addEventListener('click',async event=>{
  const button=event.target.closest&&event.target.closest('[data-plan-action="portal"]');if(!button)return;
  button.disabled=true;const error=document.getElementById('plan-panel-error');
  try{const response=await fetch('/api/billing/portal',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const result=await response.json();if(!response.ok)throw Error(result.error||'Billing management is unavailable right now.');const url=new URL(result.url);if(url.origin!=='https://billing.stripe.com')throw Error('Unexpected billing address.');location.assign(url.href);}
  catch(e){if(error){error.textContent=e.message;error.hidden=false;}button.disabled=false;}
 });
})(typeof window!=='undefined'?window:globalThis);
