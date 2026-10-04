/* Public quote page (/quotes/<token>): one prospect's quote from one home watch company, in that company's branding.
   The prospect types their name and accepts; the server records the name, time, IP address and browser and moves the
   prospect to Won. No sign-in, no navigation into the app, no payment collection. No inline scripts or styles (CSP). */
(function(){
 'use strict';
 const main=document.getElementById('main');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=(location.pathname.match(/^\/quotes\/([A-Za-z0-9_-]{43})$/)||[])[1];
 const money=minor=>'$'+(Number(minor||0)/100).toLocaleString('en-US',{minimumFractionDigits:Number(minor)%100?2:0,maximumFractionDigits:2});
 const when=iso=>{const t=Date.parse(iso);return Number.isNaN(t)?'':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(t));};
 const initials=name=>String(name||'').split(/\s+/).filter(w=>/^[A-Za-z]/.test(w)).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'Q';
 const message=(title,text)=>{document.title=title;main.innerHTML=`<section class="qp-card qp-message"><h1>${esc(title)}</h1><p>${esc(text)}</p></section>`;};
 if(!token)return message('Link not valid','Check that the whole link was copied.');
 let q=null;
 const brand=()=>`<header class="qp-brand">${q.logo?`<img class="qp-logo" src="${esc(q.logo)}" alt="${esc(q.company)} logo">`:`<span class="qp-mark" aria-hidden="true">${esc(initials(q.company))}</span>`}<p class="qp-company">${esc(q.company)}</p></header>`;
 function acceptBlock(){
  if(q.accepted)return `<section class="qp-card qp-accepted" id="qp-accept"><span class="qp-check" aria-hidden="true">✓</span><h2>Quote accepted</h2><p>Accepted by <strong>${esc(q.accepted.name)}</strong> on ${esc(when(q.accepted.at))}.</p><p class="qp-hint">${esc(q.company)} will contact you to arrange your first visit. No payment is taken on this page.</p></section>`;
  if(q.expired)return `<section class="qp-card qp-note" id="qp-accept"><h2>This quote has expired</h2><p>It was valid until ${esc(q.valid_label)}. Contact ${esc(q.company)}${q.supportEmail?` at <a href="mailto:${esc(q.supportEmail)}">${esc(q.supportEmail)}</a>`:''} for an updated quote.</p></section>`;
  return `<section class="qp-card" id="qp-accept"><h2>Accept this quote</h2><p class="qp-hint">Type your full name to accept. ${esc(q.company)} will then contact you to arrange your first visit. No payment is taken here.</p>
<div id="qp-error" class="qp-alert" role="alert" hidden></div>
<form id="qp-form" class="qp-form qp-accept-form" novalidate>
<div class="qp-field full"><label for="q-name">Your full name</label><input id="q-name" name="name" autocomplete="name" required value="${esc(q.prospect.name)}"></div>
<label class="qp-agree full"><input type="checkbox" name="agree" id="q-agree"><span>I accept this quote from ${esc(q.company)} for ${esc(money(q.monthly_minor))} per month.</span></label>
<div class="qp-actions full"><button type="submit" class="qp-button">Accept quote</button></div>
<p class="qp-fine full">When you accept, we record your name, the date and time, and your IP address as your acceptance.</p>
</form></section>`;
 }
 function draw(){
  document.title=`Your quote from ${q.company}`;
  const items=q.items||[];
  main.innerHTML=`${brand()}<section class="qp-card">
<p class="qp-kicker">Quote ${esc(q.reference)}</p>
<h1>Your home watch quote</h1>
<p class="qp-lede">Prepared for ${esc(q.prospect.name)}${q.prospect.address?` · ${esc(q.prospect.address)}`:''}</p>
<div class="qp-price"><span class="qp-amount">${esc(money(q.monthly_minor))}</span><span class="qp-per">per month</span></div>
<dl class="qp-facts">${q.plan_name?`<div><dt>Plan</dt><dd>${esc(q.plan_name)}</dd></div>`:''}<div><dt>Visits</dt><dd>${esc(q.frequency)}</dd></div>${q.valid_label?`<div><dt>Valid until</dt><dd>${esc(q.valid_label)}</dd></div>`:''}</dl>
${items.length?`<h2 class="qp-sub">What is included</h2><ul class="qp-items">${items.map(i=>`<li><span>${esc(i.label)}</span><span class="qp-item-amount">${i.amount_minor==null?'Included':esc(money(i.amount_minor))}</span></li>`).join('')}</ul>`:''}
${q.notes?`<h2 class="qp-sub">Notes</h2><p class="qp-notes">${esc(q.notes)}</p>`:''}
</section>${acceptBlock()}${q.supportEmail?`<p class="qp-contact">Questions about this quote? Email <a href="mailto:${esc(q.supportEmail)}">${esc(q.supportEmail)}</a>.</p>`:''}`;
  const form=document.getElementById('qp-form');if(!form)return;
  const err=document.getElementById('qp-error');
  form.addEventListener('submit',async e=>{
   e.preventDefault();err.hidden=true;
   const name=String(form.name.value||'').trim(),agree=form.agree.checked;
   if(name.length<2)return show('Type your full name to accept.','q-name');
   if(!agree)return show('Tick the box to confirm you accept the quote.','q-agree');
   const button=form.querySelector('button[type=submit]');button.disabled=true;button.textContent='Accepting…';
   try{
    const r=await fetch('/api/public/quotes/'+token+'/accept',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,agree:true})});
    const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Something went wrong. Please try again.');
    q.accepted={name:d.accepted_name,at:d.accepted_at};q.status='accepted';draw();document.getElementById('qp-accept')?.scrollIntoView({block:'start'});
   }catch(error){show(error.message);button.disabled=false;button.textContent='Accept quote';}
  });
  function show(text,focus){err.textContent=text;err.hidden=false;if(focus)document.getElementById(focus)?.focus();}
 }
 fetch('/api/public/quotes/'+token,{credentials:'omit',cache:'no-store'}).then(async r=>{
  const d=await r.json().catch(()=>({}));
  if(!r.ok)return message(r.status===410?'This quote is no longer available':'Link not valid',d.error||'Ask the sender for a new link.');
  q=d.quote;draw();
 }).catch(()=>message('Could not load the quote','Check your connection and try again.'));
})();
