/* Public "Request a quote" form for one home watch company (/quote/<company-slug>). Carries the company's own name and
   logo; the only EstateAegis wording is the small "Powered by EstateAegis" footer. ?embed=1 is the same form without the
   page chrome, for the iframe snippet a company pastes on its own website (it reports its height to the parent page).
   Spam protection: a hidden honeypot field plus server-side rate limits. No inline scripts or styles (CSP). */
(function(){
 'use strict';
 const main=document.getElementById('main');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const slug=(location.pathname.match(/^\/quote\/([a-z0-9-]{2,80})$/)||[])[1];
 const embed=new URLSearchParams(location.search).get('embed')==='1';
 if(embed)document.body.classList.add('qp-embed');
 const initials=name=>String(name||'').split(/\s+/).filter(w=>/^[A-Za-z]/.test(w)).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'Q';
 // In the iframe, tell the host page how tall the form is so it never needs its own scroll box.
 const report=()=>{if(embed&&window.parent!==window){try{window.parent.postMessage({type:'estateaegis-quote-height',height:Math.ceil(document.documentElement.scrollHeight)},'*');}catch{}}};
 if(embed&&'ResizeObserver' in window)new ResizeObserver(report).observe(document.body);
 const brand=c=>`<header class="qp-brand">${c.logo?`<img class="qp-logo" src="${esc(c.logo)}" alt="${esc(c.company)} logo">`:`<span class="qp-mark" aria-hidden="true">${esc(initials(c.company))}</span>`}<p class="qp-company">${esc(c.company)}</p></header>`;
 const message=(title,text)=>{document.title=title;main.innerHTML=`<section class="qp-card qp-message"><h1>${esc(title)}</h1><p>${esc(text)}</p></section>`;report();};
 if(!slug)return message('Form not found','Check the link and try again.');
 const field=(name,label,{type='text',auto='',required=false,full=false,hint='',inputmode=''}={})=>`<div class="qp-field${full?' full':''}"><label for="q-${name}">${esc(label)}${required?' <span class="qp-req">(required)</span>':''}</label><input id="q-${name}" name="${name}" type="${type}"${auto?` autocomplete="${auto}"`:''}${inputmode?` inputmode="${inputmode}"`:''}${required?' required':''}${hint?` aria-describedby="q-${name}-hint"`:''}>${hint?`<p class="qp-hint" id="q-${name}-hint">${esc(hint)}</p>`:''}</div>`;
 fetch('/api/public/quote-form/'+slug,{credentials:'omit',cache:'no-store'}).then(async r=>{
  const c=await r.json().catch(()=>({}));
  if(!r.ok)return message(r.status===404?'Form not found':'Something went wrong',c.error||'Check the link and try again.');
  document.title=`Request a quote · ${c.company}`;
  if(!c.enabled){main.innerHTML=`${brand(c)}<section class="qp-card qp-message"><h1>Online requests are paused</h1><p>${esc(c.company)} is not taking online quote requests right now.${c.supportEmail?` You can email <a href="mailto:${esc(c.supportEmail)}">${esc(c.supportEmail)}</a>.`:''}</p></section>`;return report();}
  main.innerHTML=`${brand(c)}<section class="qp-card">
<h1>Request a quote</h1>
<p class="qp-lede">${esc(c.intro||`Tell us about your home and ${c.company} will be in touch about a home watch plan that fits.`)}</p>
<div id="qp-error" class="qp-alert" role="alert" hidden></div>
<form id="qp-form" class="qp-form" novalidate>
${field('name','Your name',{auto:'name',required:true,full:true})}
${field('email','Email',{type:'email',auto:'email',inputmode:'email'})}
${field('phone','Phone',{type:'tel',auto:'tel',inputmode:'tel'})}
<p class="qp-hint full">Give us an email address or a phone number (or both) so we can reply.</p>
<fieldset class="qp-group full"><legend>Property address</legend>
${field('streetAddress','Street address',{auto:'address-line1',full:true})}
${field('city','City',{auto:'address-level2'})}
<div class="qp-pair">${field('state','State',{auto:'address-level1'})}${field('postalCode','ZIP code',{auto:'postal-code',inputmode:'numeric'})}</div>
</fieldset>
<div class="qp-field full"><label for="q-message">How can we help?</label><textarea id="q-message" name="message" rows="4" maxlength="2000" placeholder="For example: we are away from November to April and want weekly checks."></textarea></div>
<div class="qp-trap" aria-hidden="true"><label for="q-website">Leave this field empty</label><input id="q-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="qp-actions full"><button type="submit" class="qp-button">Request a quote</button></div>
<p class="qp-fine full">Your details go only to ${esc(c.company)}, who will use them to reply to this request.</p>
</form></section>`;
  report();
  const form=document.getElementById('qp-form'),err=document.getElementById('qp-error');
  form.addEventListener('submit',async e=>{
   e.preventDefault();const b=Object.fromEntries(new FormData(form));err.hidden=true;
   if(!String(b.name||'').trim())return show('Enter your name.','q-name');
   if(!String(b.email||'').trim()&&!String(b.phone||'').trim())return show('Enter an email address or a phone number so we can reply.','q-email');
   const button=form.querySelector('button[type=submit]');button.disabled=true;button.textContent='Sending…';
   try{
    const res=await fetch('/api/public/quote-form/'+slug,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    const d=await res.json().catch(()=>({}));
    if(!res.ok)throw Error(d.error||'Something went wrong. Please try again.');
    const first=String(b.name).trim().split(/\s+/)[0];
    main.innerHTML=`${brand(c)}<section class="qp-card qp-message qp-done"><span class="qp-check" aria-hidden="true">✓</span><h1>Thank you, ${esc(first)}</h1><p>${esc(c.company)} has your request and will be in touch soon.</p>${c.supportEmail?`<p class="qp-hint">Questions in the meantime? Email <a href="mailto:${esc(c.supportEmail)}">${esc(c.supportEmail)}</a>.</p>`:''}</section>`;
    report();main.querySelector('h1').focus?.();
   }catch(error){show(error.message);button.disabled=false;button.textContent='Request a quote';}
  });
  function show(text,focus){err.textContent=text;err.hidden=false;report();if(focus)document.getElementById(focus)?.focus();else err.scrollIntoView({block:'center'});}
 }).catch(()=>message('Could not load the form','Check your connection and try again.'));
})();
