/* Public visit history certificate page (/certificate/<token>). Shows one residence's certificate from an expiring,
   revocable share link and nothing else: no sign-in, no navigation into the app. */
(function(){
 'use strict';
 const main=document.getElementById('main');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=(location.pathname.match(/^\/certificate\/([A-Za-z0-9_-]{43})$/)||[])[1];
 const fail=(title,text)=>{document.title=title;main.innerHTML=`<section class="cert-card cert-message"><h1>${esc(title)}</h1><p>${esc(text)}</p></section>`;};
 if(!token)return fail('Link not valid','Check that the whole link was copied.');
 const plural=(n,one,many)=>`${n} ${n===1?one:(many||one+'s')}`;
 fetch('/api/public/certificates/'+token,{credentials:'omit',cache:'no-store'}).then(async r=>{
  const body=await r.json().catch(()=>({}));
  if(!r.ok)return fail(r.status===410?'This link no longer works':'Link not valid',body.error||'Ask the sender for a new link.');
  const c=body.certificate;document.title=`Visit history certificate · ${c.residence.name}`;
  const facts=[['Residence',c.residence.name],['Address',c.residence.address||'Address not entered'],['Policyholder',c.policyholder||'Not recorded'],['Carrier',c.policy.carrier||'Not recorded'],['Policy number',c.policy.number||'Not recorded'],['Renewal date',c.policy.renewal||'Not recorded'],['Unoccupancy rule',c.policy.rule],['Period',`${c.fromLabel} to ${c.toLabel}`]];
  const tone={ok:'ok',due_soon:'warn',at_risk:'warn',breached:'bad'}[c.status.code]||'muted';
  const findings=f=>[f.pass?`${f.pass} passed`:'',f.monitor?`${f.monitor} to monitor`:'',f.attention?`${f.attention} needing attention`:''].filter(Boolean).join(', ')||'No checklist items';
  main.innerHTML=`<header class="cert-head">${c.companyLogo?`<img class="cert-logo" src="${esc(c.companyLogo)}" alt="${esc(c.company)}">`:''}<div><p class="cert-company">${esc(c.company)}</p><h1>Visit history certificate</h1><p class="cert-sub">${esc(c.residence.name)} · link works until ${esc(body.expiresLabel)}</p></div><a class="cert-button" href="/api/public/certificates/${token}/pdf" download>Download PDF</a></header>
<section class="cert-card"><dl class="cert-facts">${facts.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>
<section class="cert-stats" aria-label="Summary"><div><b>${c.visits.length}</b><span>Visits in period</span></div><div><b>${c.verifiedCount} of ${c.visits.length}</b><span>GPS verified</span></div><div><b>${c.longestGap===null?'—':plural(c.longestGap,'day')}</b><span>Longest gap</span></div><div class="cert-${tone}"><b>${esc(c.status.label)}</b><span>Current status</span></div></section>
${c.status.reason?`<p class="cert-note">Current status: ${esc(c.status.label)}. ${esc(c.status.reason)}</p>`:''}
${c.devices.length?`<section class="cert-card"><h2>Protective devices</h2><ul class="cert-devices">${c.devices.map(d=>`<li><strong>${esc(d.label)}</strong><span>${esc([d.required?'Required by the policy':'',d.discount?'Qualifies for a discount':'',d.installed?'Installed':'Not confirmed installed',d.proof?'Photo or document on file':''].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul></section>`:''}
<section class="cert-card"><h2>Visits</h2><p class="cert-muted">Published visits from ${esc(c.fromLabel)} to ${esc(c.toLabel)}. Times are in the residence time zone (${esc(c.timezone)}).</p>${c.visits.length?`<ol class="cert-visits">${c.visits.map(v=>`<li><div class="cert-visit-top"><strong>${esc(v.dateLabel)}</strong><span class="cert-pill ${v.verified?'cert-ok':'cert-muted-pill'}">${esc(v.verified?'GPS verified':v.verification)}</span></div><div class="cert-visit-meta">${esc([v.type,v.inspector,v.arrived?`on site ${v.arrived}${v.departed?' to '+v.departed:''}`:'not checked in',findings(v.findings)].join(' · '))}</div>${v.summary?`<p>${esc(v.summary)}</p>`:''}</li>`).join('')}</ol>`:'<p>No published visits in this period.</p>'}</section>
<section class="cert-card cert-disclaimer"><h2>Important</h2><p>${esc(c.disclaimer)}</p><p class="cert-muted">Certificate ${esc(c.reference)}.</p></section>`;
 }).catch(()=>fail('Could not load the certificate','Check your connection and try again.'));
})();
