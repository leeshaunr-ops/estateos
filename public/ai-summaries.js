/* AI inspection summaries (shown only when the server has AI on). A team member asks for a draft summary on a draft
   visit, reads it, then uses it (it fills the summary box like typed text and saves through the device draft queue),
   tries again, or discards it. An AI-assisted summary must be confirmed before the report is published. */
const aiState={drafts:{},busy:null,error:{}};
const aiStaff=()=>['admin','employee'].includes(data?.user?.role);
const aiServer=()=>!!data?.ai?.serverEnabled;
const aiInspection=id=>data?.inspections?.find(i=>i.id===id);
const aiOnline=()=>!data?.offline&&(typeof offlineIsOnline==='function'?offlineIsOnline():navigator.onLine);
const aiTag=i=>i?.summary_source==='ai_draft'?`<span class="ai-tag" title="This summary started from an AI draft">AI-assisted</span>${i.summary_review_current?'<span class="ai-reviewed">Reviewed</span>':''}`:'';

function aiPanel(i){
 const ai=data.ai||{},draft=aiState.drafts[i.id],busy=aiState.busy===i.id;
 if(!ai.enabled&&data.user.role!=='admin')return '';
 const head=`<div class="ai-head"><h3 id="ai-title">Draft the summary with AI</h3>${aiTag(i)}</div>`;
 if(draft&&draft.status==='ready'){
  const missing=draft.missing||[];
  return `<section class="ai-panel" aria-labelledby="ai-title">${head}<div class="ai-review" role="region" aria-label="AI draft for review"><p class="ai-review-label">Suggested summary. Read it before you use it.</p><div class="ai-draft-text" id="ai-draft-text" tabindex="-1">${esc(draft.text)}</div>${missing.length?`<div class="ai-missing" role="note"><strong>Not mentioned in this draft:</strong><ul>${missing.map(m=>`<li>${esc(m)}</li>`).join('')}</ul><span>Add these after you use the draft, or try again.</span></div>`:''}<div class="actions">${btn('Use this draft','ai-use',draft.id,true)}${btn('Try again','ai-retry',draft.id)}${btn('Discard','ai-discard',draft.id)}</div><p class="muted ai-fine">Written by AI from this visit\u2019s checklist results, notes to the client and weather. Names, addresses and codes were removed before sending. You can edit it after you use it.</p></div></section>`;
 }
 let reason=busy?'':!aiOnline()?'Drafting needs a connection.':ai.available?'':ai.reason||'AI drafting is not available.';
 const usage=ai.enabled&&ai.cap?`<span class="muted ai-usage">${Number(ai.used||0)} of ${Number(ai.cap)} drafts used this month</span>`:'';
 const err=aiState.error[i.id]?`<p class="ai-error" role="alert">${esc(aiState.error[i.id])}</p>`:'';
 return `<section class="ai-panel" aria-labelledby="ai-title"${busy?' aria-busy="true"':''}>${head}<p class="muted">Writes a first draft from the checklist results, notes to the client and weather at the visit. You read and edit it before anything reaches the family.</p>${err}<div class="actions"><button type="button" class="ai-generate" data-action="ai-draft" data-id="${esc(i.id)}"${reason||busy?' disabled':''}${reason?' aria-describedby="ai-reason"':''}>${busy?'<span class="ai-spinner" aria-hidden="true"></span>Drafting\u2026':'Draft summary with AI'}</button>${usage}</div>${reason?`<p id="ai-reason" class="muted ai-reason">${esc(reason)}${data.user.role==='admin'&&!ai.enabled&&ai.serverEnabled?' '+btn('AI settings','ai-settings'):''}</p>`:''}${busy?'<p class="sr-only" role="status">Drafting the summary\u2026</p>':''}</section>`;
}

const aiBaseInspectionView=inspectionView;
inspectionView=function(...args){
 let html=aiBaseInspectionView(...args);
 if(!aiStaff()||!aiServer())return html;
 const i=aiInspection(activeInspection);if(!i)return html;
 // Read-only (submitted) view: tag the summary heading so the admin knows it needs confirming.
 if(i.summary_source==='ai_draft')html=html.replace('<section class="insp-summary"><h2>Inspection summary</h2>',`<section class="insp-summary"><h2>Inspection summary ${aiTag(i)}</h2>`);
 if(i.status!=='draft'||!html.includes('data-sync-key="summary"'))return html;
 const at=html.indexOf('<h2>Photo evidence');
 return at<0?html:html.slice(0,at)+aiPanel(i)+html.slice(at);
};

const aiBaseSettingsView=settingsView;
settingsView=function(...args){
 const html=aiBaseSettingsView(...args);if(data?.user?.role!=='admin'||!aiServer())return html;
 const ai=data.ai||{};
 const panel=resPanel('AI inspection summaries',factList([['AI drafts',ai.enabled?'On':'Off'],['This month',`${Number(ai.used||0)} of ${Number(ai.cap||0)} drafts`],['Label on PDF reports',ai.labelReports?'On':'Off']]),btn(ai.enabled?'AI settings':'Set up','ai-settings'));
 const at=html.lastIndexOf('</div></div>');return at<0?html+panel:html.slice(0,at)+panel+html.slice(at);
};

async function aiSettingsDialog(){
 const r=await api('settings/ai'),s=r.settings;
 dialog('AI inspection summaries',`<label class="check-row full ai-full"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Let the team ask for AI-drafted inspection summaries</label><label class="check-row full ai-full"><input type="checkbox" name="label_reports" ${s.label_reports?'checked':''}> Add \u201cSummary drafted with AI assistance and reviewed by ${esc(data.company)}\u201d to PDF reports</label><div class="field full"><label for="ai-cap">Monthly drafts limit</label><input id="ai-cap" name="monthly_cap" type="number" min="0" max="${Number(r.ceiling)}" step="1" inputmode="numeric" value="${s.monthly_cap??''}" placeholder="${Number(r.ceiling)}" aria-describedby="ai-cap-help"><small id="ai-cap-help" class="muted">Leave blank for the plan limit (${Number(r.ceiling)}). Used this month: ${Number(r.used)}.</small></div><div class="full ai-full ai-privacy"><strong>What is shared</strong><p>${esc(r.privacy)}</p></div>${r.configured?'':'<p class="notice full ai-full">AI drafting is not set up on this server yet.</p>'}`,'Save',async v=>{
  await api('settings/ai',{enabled:v.enabled==='on',label_reports:v.label_reports==='on',monthly_cap:String(v.monthly_cap||'').trim()===''?null:Number(v.monthly_cap)});
  toast('AI settings saved.');
 });
}

function aiFillSummary(text){
 const el=document.getElementById('f-summary');if(!el)return false;
 el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));return true;
}

async function aiGenerate(id){
 if(!aiOnline())throw Error('Drafting needs a connection.');
 aiState.busy=id;delete aiState.error[id];render();
 try{
  if(typeof syncInspectionDraft==='function')await syncInspectionDraft({requireSynced:true});
  const r=await api(`inspections/${encodeURIComponent(id)}/ai-summary`,{idempotencyKey:crypto.randomUUID()});
  aiState.drafts[id]=r.draft;if(r.usage)data.ai=r.usage;
 }catch(e){aiState.error[id]=e.message||'The draft could not be written.';if(e.data?.code==='ai_cap_reached'&&data.ai)data.ai={...data.ai,available:false,reason:e.message};}
 finally{aiState.busy=null;render();}
 setTimeout(()=>{const el=document.getElementById(aiState.drafts[id]?'ai-draft-text':'ai-title');el?.focus?.();},0);
}

const aiBaseAction=action;
action=async function(name,key,button){
 if(name==='inspection-publish'&&aiStaff()){
  const i=aiInspection(key);
  if(i?.summary_source==='ai_draft'){
   const local=document.getElementById('f-summary')?.value;
   const text=local??(typeof offlineDraft==='function'&&offlineDraft(i.id)?.summary)??i.summary??'';
   dialog('Confirm the AI-assisted summary',`<p class="full ai-full">This summary started from an AI draft. Read it once more before it goes to the family.</p><div class="ai-draft-text full ai-full">${esc(text||'No summary yet.')}</div><label class="check-row full ai-full"><input type="checkbox" name="confirm" required> I have read this summary and it is accurate</label>`,'Confirm and publish',async()=>{
    if(typeof syncInspectionDraft==='function'&&i.status==='draft')await syncInspectionDraft({requireSynced:true});
    await api(`inspections/${encodeURIComponent(key)}/ai-summary/review`,{});
    await aiBaseAction(name,key,button);
   });
   return;
  }
 }
 if(name==='inspection-complete'){
  const r=await aiBaseAction(name,key,button);
  const i=aiInspection(key),form=document.getElementById('offlineCompleteForm');
  if(i?.summary_source==='ai_draft'&&form?.autoPublish)form.autoPublish.closest('label')?.insertAdjacentHTML('afterend','<p class="muted full">The summary is AI-assisted, so the report waits for an admin to confirm it before it is published.</p>');
  return r;
 }
 if(!String(name).startsWith('ai-'))return aiBaseAction(name,key,button);
 const id=activeInspection;
 try{
  switch(name){
   case 'ai-draft':return await aiGenerate(key||id);
   case 'ai-retry':{const old=aiState.drafts[id];delete aiState.drafts[id];if(old)api(`inspections/${encodeURIComponent(id)}/ai-summary/${encodeURIComponent(old.id)}/discard`,{}).catch(()=>{});return await aiGenerate(id);}
   case 'ai-discard':{await api(`inspections/${encodeURIComponent(id)}/ai-summary/${encodeURIComponent(key)}/discard`,{});delete aiState.drafts[id];render();toast('Draft discarded.');document.querySelector('.ai-generate')?.focus();return;}
   case 'ai-use':{
    const current=document.getElementById('f-summary')?.value?.trim();
    const apply=async()=>{
     const r=await api(`inspections/${encodeURIComponent(id)}/ai-summary/${encodeURIComponent(key)}/use`,{});
     const i=aiInspection(id);if(i){i.summary_source='ai_draft';i.summary_review_current=false;}
     delete aiState.drafts[id];
     aiFillSummary(r.text);render();aiFillSummary(r.text);
     toast('Draft added to the summary. Edit it as needed; you confirm it before publishing.');
     document.getElementById('f-summary')?.focus();
    };
    if(current){dialog('Replace your summary?','<p class="full ai-full">The summary box already has text. Using the AI draft replaces it.</p>','Replace summary',async()=>{await apply();});return;}
    return await apply();
   }
   case 'ai-settings':return await aiSettingsDialog();
  }
 }catch(e){toast(e.message||'Something went wrong.');}
};
