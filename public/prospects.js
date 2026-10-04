/* Prospects (signed-in app): each company's sales leads, from first enquiry to an accepted quote and a new client family.
   - Desktop: a board with the four open stages as columns and Won / Lost below. Phone: a stage filter row plus stacked
     cards. No tables, no scrolling boxes, 44px tap targets, wine accent (app.css palette).
   - A prospect opens on its own screen (#/prospects/<id>): stage buttons, contact details, follow-up date, assignee,
     quotes (build, send, copy link, withdraw), notes timeline and, once Won, Convert to a client family + residence.
   - Admins also get the quote request form settings (public link + embed snippet) and staff access.
   Loads after live.js and hooks view(), action() and notificationTarget() like insurance.js. No inline scripts/styles. */
let prospectsState={list:null,loading:false,error:'',stage:'',q:'',sort:'follow',openId:null,detail:null,detailLoading:false,pendingLink:null};
const PR_OPEN=['new','contacted','walkthrough','quote_sent'];
const PR_SORTS=[['follow','Follow-up date'],['newest','Newest'],['name','Name'],['value','Monthly value']];
const prMoney=minor=>minor==null?'':'$'+(Number(minor)/100).toLocaleString('en-US',{minimumFractionDigits:Number(minor)%100?2:0,maximumFractionDigits:2});
const prPlural=(n,one,many)=>`${n} ${n===1?one:(many||one+'s')}`;
const prToday=()=>prospectsState.list?.today||data?.prospects?.today||today();
const prDaysBetween=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/864e5);
const prAddDays=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const prStageLabel=k=>(prospectsState.list?.stages||[]).find(s=>s.key===k)?.label||({new:'New',contacted:'Contacted',walkthrough:'Walkthrough booked',quote_sent:'Quote sent',won:'Won',lost:'Lost'})[k]||k;
const prStageBadge=(k,label)=>`<span class="pr-stage pr-stage-${esc(k)}">${esc(label||prStageLabel(k))}</span>`;
const prAdmin=()=>!!(prospectsState.list?.admin||data?.user?.role==='admin');
function prFollowText(p){
 if(!p.next_follow_up)return '';const t=prToday(),n=prDaysBetween(t,p.next_follow_up);
 if(['won','lost'].includes(p.stage))return '';
 if(n<0)return `Follow-up ${prPlural(-n,'day')} late`;if(n===0)return 'Follow up today';if(n===1)return 'Follow up tomorrow';
 return 'Follow up '+fmtDay(p.next_follow_up);
}
function prCity(p){return [p.city,p.state].filter(Boolean).join(', ');}

async function prFetch(){
 if(prospectsState.loading)return;prospectsState.loading=true;
 try{prospectsState.list=await api('prospects');prospectsState.error='';}catch(e){prospectsState.error=e.message;}
 finally{prospectsState.loading=false;if(page==='prospects')render();}
}
async function prFetchDetail(id){
 if(prospectsState.detailLoading===id)return;prospectsState.detailLoading=id;
 try{prospectsState.detail=await api('prospects/'+encodeURIComponent(id));}
 catch(e){prospectsState.detail=null;prospectsState.openId=null;toast(e.status===404?'That prospect is no longer available.':e.message);}
 finally{prospectsState.detailLoading=false;if(page==='prospects')render();}
}
/** After a change: reload the list, the open prospect and the app data (bell, Overview and the sidebar count). */
async function prRefresh(){
 const id=prospectsState.openId;
 try{prospectsState.list=await api('prospects');}catch{}
 if(id){try{prospectsState.detail=await api('prospects/'+encodeURIComponent(id));}catch{prospectsState.detail=null;prospectsState.openId=null;}}
 lastLoadAt=0;await load();
}

/* ---------- list ---------- */
function prFiltered(){
 const L=prospectsState.list,q=prospectsState.q.trim().toLowerCase();
 let rows=(L?.prospects||[]).slice();
 if(q)rows=rows.filter(p=>[p.name,p.email,p.phone,p.address,p.assigned_name,p.source_label].join(' ').toLowerCase().includes(q));
 const s=prospectsState.sort;
 rows.sort((a,b)=>s==='name'?a.name.localeCompare(b.name):s==='newest'?String(b.created_at).localeCompare(String(a.created_at)):s==='value'?(Number(b.monthly_value_minor||0)-Number(a.monthly_value_minor||0))||a.name.localeCompare(b.name):String(a.next_follow_up||'9999').localeCompare(String(b.next_follow_up||'9999'))||String(b.created_at).localeCompare(String(a.created_at)));
 return rows;
}
function prCard(p){
 const fu=prFollowText(p),bits=[prCity(p),p.source_label].filter(Boolean);
 const meta=[p.monthly_value_minor!=null?`<span class="pr-value">${esc(prMoney(p.monthly_value_minor))}/mo</span>`:'',fu?`<span class="pr-fu pr-fu-${esc(p.follow_up||'upcoming')}">${esc(fu)}</span>`:'',p.converted_at?'<span class="pr-fu pr-fu-done">Client family created</span>':'',p.quote&&p.quote.status==='sent'?`<span class="pr-quote-note">Quote sent${p.quote.view_count?' · opened':''}</span>`:'',p.assigned_name?`<span class="pr-who">${esc(p.assigned_name)}</span>`:''].filter(Boolean).join('');
 return `<li class="pr-card${p.follow_up==='overdue'?' pr-card-overdue':''}"><button type="button" class="pr-card-main" data-action="prospect-open" data-id="${esc(p.id)}"><span class="pr-card-top"><strong class="pr-name">${esc(p.name)}</strong>${prStageBadge(p.stage,p.stage_label)}</span>${bits.length?`<span class="pr-line">${esc(bits.join(' · '))}</span>`:''}${meta?`<span class="pr-meta">${meta}</span>`:''}</button></li>`;
}
function prSummary(){
 const all=prospectsState.list?.prospects||[],overdue=all.filter(p=>p.follow_up==='overdue').length,due=all.filter(p=>p.follow_up==='today').length,fresh=all.filter(p=>p.stage==='new').length;
 const open=all.filter(p=>PR_OPEN.includes(p.stage)),pipeline=open.reduce((n,p)=>n+Number(p.monthly_value_minor||0),0);
 const bits=[overdue?`<strong>${prPlural(overdue,'follow-up')}</strong> overdue`:'',due?`<strong>${due}</strong> due today`:'',fresh?`<strong>${fresh}</strong> new`:'',open.length?`<strong>${open.length}</strong> open${pipeline?` worth <strong>${esc(prMoney(pipeline))}</strong>/mo`:''}`:''].filter(Boolean);
 return bits.length?`<p class="pr-summary">${bits.join('<span aria-hidden="true"> · </span>')}</p>`:'';
}
function prospectsListPage(){
 const L=prospectsState.list,admin=prAdmin();
 const more=admin?moreMenu(btn('Quote request form','prospect-form-settings')+btn('Staff access','prospect-staff-access'),'Settings'):'';
 let html=head('Prospects','Sales leads from the first enquiry to a signed quote.',`<div class="pr-head-actions">${btn('Add prospect','prospect-new','',true)}${more}</div>`);
 if(!L){if(prospectsState.error)return html+`<div class="panel">${empty('Could not load prospects',prospectsState.error,btn('Try again','prospect-reload'))}</div>`;if(!prospectsState.loading)setTimeout(prFetch,0);return html+'<p class="pr-loading">Loading prospects…</p>';}
 const all=L.prospects||[];
 if(!all.length){
  return html+`<div class="panel pr-empty">${empty('No prospects yet','Add a lead by hand, or share your quote request form so new enquiries land here automatically.',btn('Add prospect','prospect-new','',true)+(admin?btn('Get your form link','prospect-form-settings'):''))}</div>`;
 }
 html+=prSummary();
 html+=`<div class="pr-tools"><div class="pr-search"><label class="sr-only" for="pr-q">Search prospects</label><input id="pr-q" type="search" placeholder="Search prospects" value="${esc(prospectsState.q)}" autocomplete="off"></div><div class="pr-sort"><label for="pr-sort">Sort by</label><select id="pr-sort">${PR_SORTS.map(([k,t])=>`<option value="${k}"${prospectsState.sort===k?' selected':''}>${esc(t)}</option>`).join('')}</select></div></div>`;
 const rows=prFiltered(),count=k=>rows.filter(p=>p.stage===k).length;
 // Phone: stage filter row + stacked cards.
 const chips=[['','All',rows.length],...(L.stages||[]).map(s=>[s.key,s.label,count(s.key)])];
 html+=`<div class="work-chips pr-chips" role="group" aria-label="Filter by stage">${chips.map(([k,t,n])=>`<button type="button" class="chip${prospectsState.stage===k?' active':''}" data-action="prospect-stage-filter" data-id="${esc(k)}" aria-pressed="${prospectsState.stage===k}">${esc(t)} <span>${n}</span></button>`).join('')}</div>`;
 const phoneRows=prospectsState.stage?rows.filter(p=>p.stage===prospectsState.stage):rows;
 html+=`<ul class="pr-stack" aria-label="Prospects">${phoneRows.map(prCard).join('')||`<li class="pr-none">${esc(prospectsState.q?'No prospects match your search.':'No prospects in this stage.')}</li>`}</ul>`;
 // Desktop: board.
 const col=s=>{const items=rows.filter(p=>p.stage===s.key),value=items.reduce((n,p)=>n+Number(p.monthly_value_minor||0),0);return `<section class="pr-col pr-col-${esc(s.key)}" aria-labelledby="pr-col-${esc(s.key)}"><header class="pr-col-head"><h2 id="pr-col-${esc(s.key)}">${esc(s.label)}</h2><span class="pr-col-count">${items.length}</span>${value&&s.key!=='lost'?`<span class="pr-col-value">${esc(prMoney(value))}/mo</span>`:''}</header>${items.length?`<ul class="pr-col-list">${items.map(prCard).join('')}</ul>`:`<p class="pr-col-empty">${s.key==='new'?'New website requests land here.':'Nothing here.'}</p>`}</section>`;};
 const stages=L.stages||[];
 html+=`<div class="pr-board" aria-label="Prospects by stage"><div class="pr-board-open">${stages.filter(s=>PR_OPEN.includes(s.key)).map(col).join('')}</div><div class="pr-board-closed">${stages.filter(s=>!PR_OPEN.includes(s.key)).map(col).join('')}</div></div>`;
 return html;
}

/* ---------- detail ---------- */
function prFact(k,v,raw=false){return v?`<div><dt>${esc(k)}</dt><dd>${raw?v:esc(v)}</dd></div>`:'';}
function prQuoteCard(q,p){
 const st={draft:'Draft',sent:'Sent',accepted:'Accepted',withdrawn:'Withdrawn'}[q.status]||q.status;
 const facts=[q.plan_name?['Plan',q.plan_name]:null,['Visits',q.frequency],q.sent_at?['Sent',fmtWhen(q.sent_at)+(q.sent_to?' to '+q.sent_to:'')]:null,q.status==='sent'&&q.valid_until?['Valid until',fmtDay(q.valid_until)]:null,q.status==='sent'?['Opened',q.view_count?prPlural(q.view_count,'time')+(q.viewed_at?', last '+fmtWhen(q.viewed_at):''):'Not yet']:null,q.accepted_at?['Accepted by',`${q.accepted_name} on ${fmtWhen(q.accepted_at)}`]:null,q.accepted_ip?['Recorded from',`IP ${q.accepted_ip}`]:null].filter(Boolean);
 const items=(q.items||[]).length?`<ul class="pr-items">${q.items.map(i=>`<li><span>${esc(i.label)}</span><span>${i.amount_minor==null?'Included':esc(prMoney(i.amount_minor))}</span></li>`).join('')}</ul>`:'';
 const acts=q.status==='draft'?btn('Send quote','prospect-quote-send',q.id,true)+btn('Edit','prospect-quote-edit',q.id)+btn('Withdraw','prospect-quote-withdraw',q.id):q.status==='sent'?btn('Send again','prospect-quote-send',q.id)+btn('Withdraw','prospect-quote-withdraw',q.id):'';
 return `<li class="pr-quote pr-quote-${esc(q.status)}"><div class="pr-quote-top"><div><span class="pr-quote-price">${esc(prMoney(q.monthly_minor))}</span><span class="pr-quote-per"> per month</span></div><span class="pr-qstatus pr-qstatus-${esc(q.status)}">${esc(st)}</span></div><p class="pr-quote-ref">Quote ${esc(q.reference)}</p><dl class="pr-facts pr-quote-facts">${facts.map(([k,v])=>prFact(k,v)).join('')}</dl>${items}${q.notes?`<p class="pr-quote-notes">${esc(q.notes)}</p>`:''}${acts?`<div class="pr-actions">${acts}</div>`:''}</li>`;
}
function prospectDetailPage(){
 const id=prospectsState.openId,D=prospectsState.detail;
 const back=`<button type="button" class="pr-back" data-action="prospect-back">← All prospects</button>`;
 if(!D||D.prospect.id!==id){if(prospectsState.detailLoading!==id)setTimeout(()=>prFetchDetail(id),0);return back+'<p class="pr-loading">Loading the prospect…</p>';}
 const p=D.prospect,admin=prAdmin(),t=D.today,fu=prFollowText(p);
 const draft=D.quotes.find(q=>q.status==='draft'),live=D.quotes.find(q=>['sent','accepted'].includes(q.status));
 const primary=p.converted_at?'':p.stage==='won'?'':p.stage==='lost'?'':draft?btn('Send quote','prospect-quote-send',draft.id,true):live?'':btn('Build a quote','prospect-quote-new',p.id,true);
 const more=moreMenu(btn('Edit details','prospect-edit',p.id)+(admin&&!p.converted_at?btn('Delete prospect','prospect-delete',p.id):''),'More');
 let html=back+head(p.name,[p.stage_label,p.source_label,'added '+fmtDay(String(p.created_at).slice(0,10))].join(' · '),`<div class="pr-head-actions">${primary}${more}</div>`);
 // Stage buttons
 html+=`<div class="pr-stages" role="group" aria-label="Stage">${(D.stages||prospectsState.list?.stages||[{key:'new'},{key:'contacted'},{key:'walkthrough'},{key:'quote_sent'},{key:'won'},{key:'lost'}]).map(s=>{const on=p.stage===s.key,locked=!!p.converted_at&&s.key!=='won';return `<button type="button" class="pr-stage-btn pr-stage-btn-${esc(s.key)}${on?' active':''}" data-action="prospect-stage" data-id="${esc(s.key)}" aria-pressed="${on}"${locked?' disabled':''}>${esc(s.label||prStageLabel(s.key))}</button>`;}).join('')}</div>`;
 if(p.stage==='lost'&&p.lost_reason)html+=`<p class="pr-note-line">Lost: ${esc(p.lost_reason)}</p>`;
 // Won: convert / converted
 if(p.converted_at)html+=`<section class="panel pr-converted"><h2>Client family created</h2><p>Converted on ${esc(fmtDay(String(p.converted_at).slice(0,10)))}. The contact details, address and notes were carried over.</p><div class="pr-actions">${p.client_id?btn('Open client family','prospect-open-client',p.client_id,true):''}${p.property_id?btn('Open residence','property',p.property_id):''}</div></section>`;
 else if(p.stage==='won')html+=`<section class="panel pr-convert"><h2>Ready to become a client</h2><p>${D.canConvert?'Convert creates the client family and their residence with this contact information, address and notes, and links them back here.':'An administrator can convert this prospect into a client family.'}</p>${D.canConvert?`<div class="pr-actions">${btn('Convert to client','prospect-convert',p.id,true)}</div>`:''}</section>`;
 const contact=[prFact('Email',p.email?`<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`:'',true),prFact('Phone',p.phone?`<a href="tel:${esc(p.phone.replace(/[^0-9+]/g,''))}">${esc(p.phone)}</a>`:'',true),prFact('Property',p.address),prFact('Source',p.source_label),prFact('Estimated value',p.monthly_value_minor!=null?prMoney(p.monthly_value_minor)+' per month':'')].join('');
 const team=D.team||[];
 const followBtns=[['Tomorrow',prAddDays(t,1)],['In 3 days',prAddDays(t,3)],['Next week',prAddDays(t,7)]];
 html+=`<div class="pr-detail">
<div class="pr-detail-main">
<section class="panel pr-panel"><div class="pr-panel-head"><h2>Contact</h2>${btn('Edit','prospect-edit',p.id)}</div>${contact?`<dl class="pr-facts">${contact}</dl>`:`<p class="pr-muted">No contact details yet. ${''}</p>`}${p.message?`<div class="pr-message"><h3>Their request</h3><p>${esc(p.message)}</p></div>`:''}</section>
<section class="panel pr-panel"><div class="pr-panel-head"><h2>Follow-up</h2></div>
<p class="pr-follow ${p.follow_up?'pr-follow-'+esc(p.follow_up):''}">${p.next_follow_up?`<strong>${esc(fmtDay(p.next_follow_up))}</strong>${fu?' · '+esc(fu):''}`:'No follow-up date set.'}</p>
${['won','lost'].includes(p.stage)?'':`<div class="pr-actions pr-follow-actions">${followBtns.map(([l,d])=>`<button type="button" data-action="prospect-follow" data-id="${d}">${esc(l)}</button>`).join('')}${btn('Pick a date','prospect-follow-pick',p.id)}${p.next_follow_up?btn('Clear','prospect-follow','none'):''}</div>`}
<div class="field pr-assign"><label for="pr-assign">Assigned to</label><select id="pr-assign" data-prospect="${esc(p.id)}"><option value="">No one yet</option>${team.map(u=>`<option value="${esc(u.id)}"${p.assigned_to===u.id?' selected':''}>${esc(u.name)}${u.role==='admin'?' (admin)':''}</option>`).join('')}</select></div>
</section>
</div>
<div class="pr-detail-side">
<section class="panel pr-panel"><div class="pr-panel-head"><h2>Quotes</h2>${p.stage!=='lost'&&!p.converted_at&&D.quotes.length?btn('New quote','prospect-quote-new',p.id):''}</div>${D.quotes.length?`<ul class="pr-quotes">${D.quotes.map(q=>prQuoteCard(q,p)).join('')}</ul>`:`<p class="pr-muted">No quote yet. Build one with the visit frequency and monthly price, then send it by email. The prospect can accept online.</p>${p.stage!=='lost'&&!p.converted_at?`<div class="pr-actions">${btn('Build a quote','prospect-quote-new',p.id,true)}</div>`:''}`}</section>
<section class="panel pr-panel"><div class="pr-panel-head"><h2>Notes</h2></div>
<form class="pr-note-form" id="pr-note-form" data-prospect="${esc(p.id)}"><label class="sr-only" for="pr-note">Add a note</label><textarea id="pr-note" name="body" rows="2" placeholder="Add a note: a call, a walkthrough, what they asked about" required maxlength="4000"></textarea><button type="submit" class="primary">Add note</button></form>
<ol class="pr-timeline">${D.notes.map(n=>`<li class="pr-tl pr-tl-${esc(n.kind)}"><p class="pr-tl-body">${esc(n.body)}</p><p class="pr-tl-meta">${esc([n.author_name||({form:'Website form',quote:'Quote',stage:'Stage',system:'EstateAegis'})[n.kind]||'',fmtWhen(n.created_at)].filter(Boolean).join(' · '))}</p></li>`).join('')}</ol>
</section>
</div></div>`;
 return html;
}
function prospectsPage(){return prospectsState.openId?prospectDetailPage():prospectsListPage();}

/* ---------- dialogs ---------- */
function prProspectForm(p){
 const L=prospectsState.list,team=prospectsState.detail?.team||L?.team||[],sources=L?.sources||[{key:'website',label:'Website form'},{key:'referral',label:'Referral'},{key:'phone',label:'Phone'},{key:'other',label:'Other'}];
 const v=k=>p?.[k]??'';
 return `${input('name','Name','text',v('name'))}${input('email','Email','email',v('email'),false)}${input('phone','Phone','tel',v('phone'),false)}
${select('source','Source',sources.map(s=>`<option value="${esc(s.key)}"${(p?.source||'referral')===s.key?' selected':''}>${esc(s.label)}</option>`).join(''))}
${input('streetAddress','Property street address','text',v('street_address'),false)}${input('city','City','text',v('city'),false)}${input('state','State','text',v('state'),false)}${input('postalCode','ZIP code','text',v('postal_code'),false)}
${input('monthlyValue','Estimated monthly value ($)','text',p?.monthly_value_minor!=null?String(p.monthly_value_minor/100):'',false)}${input('nextFollowUp','Next follow-up','date',v('next_follow_up'),false)}
${select('assignedTo','Assigned to',`<option value="">No one yet</option>`+team.map(u=>`<option value="${esc(u.id)}"${p?.assigned_to===u.id?' selected':''}>${esc(u.name)}</option>`).join(''))}${p?'':textarea('note','First note (optional)','')}`;
}
function prNewDialog(){
 dialog('Add a prospect',prProspectForm(null),'Add prospect',async b=>{const r=await api('prospects',{...b,country:''});prospectsState.openId=r.id;prospectsState.detail=null;page='prospects';toast('Prospect added.');await prRefresh();});
}
function prEditDialog(){
 const p=prospectsState.detail?.prospect;if(!p)return;
 dialog('Edit prospect',prProspectForm(p),'Save',async b=>{delete b.note;await api('prospects/'+encodeURIComponent(p.id),{...b,addressLine2:p.address_line2||'',country:p.country||'',version:p.version});toast('Prospect saved.');await prRefresh();});
}
function prQuoteDialog(quote){
 const p=prospectsState.detail?.prospect;if(!p)return;
 const freqs=prospectsState.list?.frequencies||['Weekly','Every two weeks','Twice a month','Monthly','Twice a week'];
 const items=quote?.items?.length?quote.items:[{label:'Interior and exterior walkthrough with photo report',amount_minor:null},{label:'Storm preparation and post-storm check',amount_minor:null}];
 const rows=Array.from({length:Math.max(4,items.length)},(_,i)=>items[i]||{label:'',amount_minor:null});
 const freqOpts=[...new Set([...(quote?.frequency&&!freqs.includes(quote.frequency)?[quote.frequency]:[]),...freqs])];
 dialog(quote?'Edit quote':'Build a quote',`<p class="field full pr-hint">Prepared for ${esc(p.name)}${p.address?' · '+esc(p.address):''}. You can review it before it is sent.</p>
${input('planName','Plan name (optional)','text',quote?.plan_name||'',false)}${select('frequency','Visit frequency',freqOpts.map(f=>`<option${(quote?.frequency||'Weekly')===f?' selected':''}>${esc(f)}</option>`).join(''))}
${input('monthly','Monthly price ($)','text',quote?String(quote.monthly_minor/100):p.monthly_value_minor!=null?String(p.monthly_value_minor/100):'')}
<fieldset class="field full pr-lines"><legend>What is included</legend><p class="pr-hint">Leave the amount empty for items included in the monthly price.</p>${rows.map((it,i)=>`<div class="pr-line-row"><label class="sr-only" for="f-item${i}">Line item ${i+1}</label><input id="f-item${i}" name="item${i}" value="${esc(it.label)}" placeholder="Line item ${i+1}"><label class="sr-only" for="f-amount${i}">Amount for line item ${i+1}</label><input id="f-amount${i}" name="amount${i}" inputmode="decimal" value="${it.amount_minor==null?'':esc(String(it.amount_minor/100))}" placeholder="Amount"></div>`).join('')}</fieldset>
${textarea('notes','Notes for the prospect (optional)',quote?.notes||'')}`,quote?'Save quote':'Save draft',async b=>{
  const items=rows.map((_,i)=>({label:String(b['item'+i]||'').trim(),amount:String(b['amount'+i]||'').trim()})).filter(i=>i.label);
  await api('prospects/'+encodeURIComponent(p.id)+'/quotes',{quoteId:quote?.id,planName:b.planName,frequency:b.frequency,monthly:b.monthly,items,notes:b.notes});
  toast(quote?'Quote saved.':'Draft quote saved. Send it when you are ready.');await prRefresh();
 });
}
function prSendDialog(qid){
 const D=prospectsState.detail,p=D?.prospect,q=D?.quotes.find(x=>x.id===qid);if(!q)return;
 dialog(q.status==='sent'?'Send the quote again':'Send the quote',`<p class="field full pr-hint">${esc(p.name)} gets an email with a link to view the ${esc(prMoney(q.monthly_minor))} per month quote in your company's branding and accept it online.${q.status==='sent'?' The earlier link will stop working.':''}</p>
${input('email','Email to','email',p.email||'',false)}<p class="field full pr-hint">Leave the email empty to only create the link (to share it yourself).</p>
${select('validDays','Quote is valid for',[14,30,60,90].map(n=>`<option value="${n}"${n===30?' selected':''}>${n} days</option>`).join(''))}`,q.status==='sent'?'Send again':'Send quote',async b=>{
  const r=await api('prospects/quotes/'+encodeURIComponent(qid)+'/send',{email:b.email||'',validDays:Number(b.validDays)});
  prospectsState.pendingLink={url:location.origin+r.path,emailed:r.emailed,to:b.email};
  toast(r.emailed?'Quote sent.':'Quote link created.');await prRefresh();
 });
}
function prShowLink(){
 const l=prospectsState.pendingLink;if(!l)return;prospectsState.pendingLink=null;
 $('modalBody').innerHTML=`<h2>${l.emailed?'Quote sent':'Quote link ready'}</h2><p class="pr-hint">${l.emailed?`We emailed the quote to ${esc(l.to)}. You can also copy the link:`:'Send this link to the prospect. They can view and accept the quote without signing in.'}</p><div class="field full"><label for="pr-link">Quote link</label><input id="pr-link" readonly value="${esc(l.url)}"></div><div class="dialog-footer pr-dialog-actions">${btn('Copy link','prospect-copy','pr-link',true)}${btn('Done','close')}</div>`;
 const modal=$('modal');if(!modal.open)modal.showModal();
}
function prConvertDialog(){
 const p=prospectsState.detail?.prospect;if(!p)return;
 const last=String(p.name).trim().split(/\s+/).at(-1)||p.name;
 dialog('Convert to a client family',`<p class="field full pr-hint">This creates the client family and their residence, carries over ${esc(p.name)}'s email, phone, address and notes, and links them back to this prospect. The residence counts toward your plan's residence limit.</p>
${input('familyName','Family name','text',`${last} family`)}${input('residenceName','Residence name','text',`${last} residence`)}
<div class="field full pr-convert-facts"><dl class="pr-facts">${prFact('Contact',[p.email,p.phone].filter(Boolean).join(' · '))}${prFact('Residence address',p.address||'Add the address first (Edit details)')}</dl></div>`,'Convert',async b=>{
  const r=await api('prospects/'+encodeURIComponent(p.id)+'/convert',{familyName:b.familyName,residenceName:b.residenceName});
  toast('Client family and residence created.');await prRefresh();prospectsState.converted=r;
 });
}
function prLostDialog(){
 const p=prospectsState.detail?.prospect;if(!p)return;
 dialog('Mark as lost',`<p class="field full pr-hint">Keep a short reason so the team knows what happened. You can move the prospect back later.</p>${input('reason','Reason (optional)','text','',false)}`,'Mark as lost',async b=>{await api('prospects/'+encodeURIComponent(p.id)+'/stage',{stage:'lost',lostReason:b.reason||'',version:p.version});toast('Moved to Lost.');await prRefresh();});
}
function prFormSettings(){
 const L=prospectsState.list;if(!L)return;const s=L.settings,url=location.origin+s.path;
 const snippet=`<iframe src="${url}?embed=1" title="Request a quote" style="width:100%;max-width:680px;min-height:980px;border:0" loading="lazy"></iframe>\n<script>window.addEventListener('message',function(e){if(e.origin!=='${location.origin}'||!e.data||e.data.type!=='estateaegis-quote-height')return;document.querySelectorAll('iframe[src^="${location.origin}/quote/"]').forEach(function(f){f.style.height=e.data.height+'px';});});<\/script>`;
 dialog('Quote request form',`<p class="field full pr-hint">Your public form carries your company name and logo. New requests land in Prospects under New and administrators get a notification and an email.</p>
<div class="field full"><label class="pr-check"><input type="checkbox" name="form_enabled" ${s.form_enabled?'checked':''}> Accept online quote requests</label></div>
<div class="field full"><label for="f-form_intro">Introduction on the form (optional)</label><textarea id="f-form_intro" name="form_intro" maxlength="500" placeholder="Tell us about your home and we'll be in touch about a home watch plan that fits.">${esc(s.form_intro||'')}</textarea></div>
<div class="field full"><label for="pr-form-link">Form link</label><input id="pr-form-link" readonly value="${esc(url)}"><div class="pr-actions">${btn('Copy link','prospect-copy','pr-form-link')}<a class="button" href="${esc(s.path)}" target="_blank" rel="noopener">Open the form</a></div></div>
<div class="field full"><span class="pr-label" id="pr-embed-label">Embed on your website</span><p class="pr-hint">Paste this where the form should appear on your own website. It resizes itself to fit.</p><pre class="pr-snippet" id="pr-embed" aria-labelledby="pr-embed-label">${esc(snippet)}</pre><div class="pr-actions">${btn('Copy embed code','prospect-copy','pr-embed')}</div></div>`,'Save',async b=>{await api('prospects/settings',{form_enabled:!!b.form_enabled,form_intro:b.form_intro||''});toast('Form settings saved.');await prRefresh();});
}
function prStaffAccess(){
 const L=prospectsState.list;if(!L)return;const emp=L.employees||[];
 $('modalBody').innerHTML=`<h2>Staff access to Prospects</h2><p class="pr-hint">Administrators always have access. Turn it on for staff who follow up with leads; they can add prospects, write notes and send quotes. Converting to a client family stays with administrators.</p>${emp.length?`<ul class="pr-staff">${emp.map(u=>`<li><label class="pr-check"><input type="checkbox" data-prospect-staff="${esc(u.id)}" ${u.access?'checked':''}><span><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></span></label></li>`).join('')}</ul>`:empty('No staff accounts yet','Invite staff from Team & access first.')}<div class="dialog-footer">${btn('Done','close',' ',true)}</div>`;
 const modal=$('modal');if(!modal.open)modal.showModal();
}

/* ---------- wiring ---------- */
const prBaseView=view;
view=function(...args){if(page==='prospects'&&isStaff()&&(data.user.role==='admin'||data.prospects?.access)&&!data.offline)return prospectsPage();return prBaseView(...args);};
const prBaseTarget=notificationTarget;
notificationTarget=function(n){if(String(n?.kind||'').startsWith('prospect_')&&n.entity_id&&data?.prospects?.access)return ['prospect-open',n.entity_id];return prBaseTarget(n);};
const prBaseAction=action;
action=async function(name,key,button){
 if(name==='navigate'&&key==='prospects'){prospectsState.openId=null;prospectsState.detail=null;prospectsState.list=null;}
 if(!String(name).startsWith('prospect-'))return prBaseAction(name,key,button);
 const p=prospectsState.detail?.prospect;
 switch(name){
  case 'prospect-open':if(page!=='prospects')prospectsState.list=null;page='prospects';prospectsState.openId=key;prospectsState.detail=null;search='';render();window.scrollTo?.(0,0);return;
  case 'prospect-back':prospectsState.openId=null;prospectsState.detail=null;render();return;
  case 'prospect-reload':prospectsState.error='';prospectsState.list=null;render();return;
  case 'prospect-new':prNewDialog();return;
  case 'prospect-edit':prEditDialog();return;
  case 'prospect-stage-filter':prospectsState.stage=key||'';render();return;
  case 'prospect-stage':{if(!p||p.stage===key)return;if(key==='lost')return prLostDialog();await api('prospects/'+encodeURIComponent(p.id)+'/stage',{stage:key,version:p.version});toast('Moved to '+prStageLabel(key)+'.');await prRefresh();return;}
  case 'prospect-follow':{if(!p)return;await api('prospects/'+encodeURIComponent(p.id),{nextFollowUp:key==='none'?'':key,version:p.version});toast(key==='none'?'Follow-up cleared.':'Follow-up set for '+fmtDay(key)+'.');await prRefresh();return;}
  case 'prospect-follow-pick':if(!p)return;dialog('Next follow-up',input('date','Follow up on','date',p.next_follow_up||prAddDays(prToday(),2)),'Save',async b=>{await api('prospects/'+encodeURIComponent(p.id),{nextFollowUp:b.date,version:p.version});toast('Follow-up set for '+fmtDay(b.date)+'.');await prRefresh();});return;
  case 'prospect-quote-new':prQuoteDialog(null);return;
  case 'prospect-quote-edit':prQuoteDialog(prospectsState.detail?.quotes.find(q=>q.id===key));return;
  case 'prospect-quote-send':prSendDialog(key);return;
  case 'prospect-quote-withdraw':if(!confirm('Withdraw this quote? Its link stops working.'))return;await api('prospects/quotes/'+encodeURIComponent(key)+'/withdraw',{});toast('Quote withdrawn.');await prRefresh();return;
  case 'prospect-convert':prConvertDialog();return;
  case 'prospect-delete':if(!p||!confirm(`Delete ${p.name}? Their notes and quotes are deleted too.`))return;await api('prospects/'+encodeURIComponent(p.id)+'/delete',{});prospectsState.openId=null;prospectsState.detail=null;toast('Prospect deleted.');await prRefresh();return;
  case 'prospect-open-client':page='clients';activeClient=key;render();return;
  case 'prospect-form-settings':if(!prospectsState.list)await prFetch();prFormSettings();return;
  case 'prospect-staff-access':if(!prospectsState.list)await prFetch();prStaffAccess();return;
  case 'prospect-copy':{const el=$(key);if(!el)return;const v=el.value??el.textContent;try{await navigator.clipboard.writeText(v);toast('Copied.');}catch{if(el.select)el.select();toast('Select the text and copy it.');}return;}
 }
 return prBaseAction(name,key,button);
};
const prBaseRender=render;
render=function(...args){const out=prBaseRender(...args);if(prospectsState.pendingLink)setTimeout(prShowLink,0);return out;};
document.addEventListener('input',e=>{if(e.target.id!=='pr-q')return;prospectsState.q=e.target.value;const pos=e.target.selectionStart;render();const f=$('pr-q');if(f){f.focus();try{f.setSelectionRange(pos,pos);}catch{}}});
document.addEventListener('change',async e=>{
 const el=e.target;
 if(el.id==='pr-sort'){prospectsState.sort=el.value;render();return;}
 if(el.id==='pr-assign'){const p=prospectsState.detail?.prospect;if(!p)return;try{await api('prospects/'+encodeURIComponent(p.id),{assignedTo:el.value,version:p.version});toast(el.value?'Assigned.':'Unassigned.');await prRefresh();}catch(err){toast(err.message);await prRefresh();}return;}
 if(el.dataset.prospectStaff){try{await api('prospects/staff',{userId:el.dataset.prospectStaff,access:el.checked});const u=(prospectsState.list?.employees||[]).find(x=>x.id===el.dataset.prospectStaff);if(u)u.access=el.checked;toast(el.checked?'Access turned on.':'Access turned off.');try{prospectsState.list=await api('prospects');}catch{}}catch(err){el.checked=!el.checked;toast(err.message);}}
});
document.addEventListener('submit',async e=>{
 if(e.target.id!=='pr-note-form')return;e.preventDefault();const f=e.target,b=f.querySelector('button[type=submit]'),text=f.body.value.trim();if(!text)return;
 b.disabled=true;try{await api('prospects/'+encodeURIComponent(f.dataset.prospect)+'/notes',{body:text});toast('Note added.');await prRefresh();}catch(err){toast(err.message);}finally{b.disabled=false;}
});
if(typeof AUDIT_NOUN==='object')Object.assign(AUDIT_NOUN,{prospect:'Prospect'});
