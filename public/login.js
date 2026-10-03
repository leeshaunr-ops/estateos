/* EstateAegis sign-in screens (loaded after live.js; CSP-safe: no inline scripts or styles).
   One form for every role: the server opens the right portal for the account, so no role is sent.
   Screens: log in, two-step code, forgot password, reset password, invitation, company sign-up
   (?workspaceInvite=), first-run setup, and friendly "link expired" pages.
   Company-branded client portals (/client/<company>) and invitations keep the company's own logo,
   name, headline and support email up front, with only a small "Powered by EstateAegis". */
(function(){
'use strict';
const EA_HELP='help@estateaegis.com';
const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const svg=(body,size=20)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON={
 lock:s=>svg('<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',s),
 shield:s=>svg('<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',s),
 clock:s=>svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',s),
 report:s=>svg('<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',s),
 calendar:s=>svg('<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 10h16"/>',s),
 chat:s=>svg('<path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z"/>',s),
 tools:s=>svg('<path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-7.6 7.6a2.1 2.1 0 0 1-3-3z"/>',s),
 alert:s=>svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',s),
 check:s=>svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',s)
};

/* Which sign-in page is this? company = EstateAegis /login; client = generic /client-login;
   branded = /client/<company>; invite = ?invite= (company-branded); signup = ?workspaceInvite=. */
function loginContext({configured=true,invitation=null,brand=null,path='/login',workspace=null}={}){
 if(workspace)return {kind:'signup',configured,company:workspace.company||'',email:workspace.email||''};
 if(invitation)return {kind:'invite',configured,invitation,company:brand?.company||'',logo:brand?.logo||'',title:brand?.title||'',subtitle:brand?.subtitle||'',support:brand?.supportEmail||'',role:brand?.role||'client'};
 if(brand&&/^\/client\/[a-z0-9-]+$/i.test(path))return {kind:'branded',configured,company:brand.company||'',logo:brand.logo||'',title:brand.title||'',subtitle:brand.subtitle||'',support:brand.supportEmail||''};
 if(path==='/client-login')return {kind:'client',configured};
 return {kind:'company',configured};
}
const isClientSide=ctx=>ctx.kind==='client'||ctx.kind==='branded'||ctx.kind==='invite';
const isCompanyBranded=ctx=>(ctx.kind==='branded'||ctx.kind==='invite')&&!!ctx.company;
const companyLogo=(ctx,cls,size)=>ctx.logo?`<img class="${cls}" src="${h(ctx.logo)}" alt="" width="${size}" height="${size}">`:`<span class="${cls} login-monogram" aria-hidden="true">${h((ctx.company||'?').trim().charAt(0).toUpperCase())}</span>`;
const eaLogo=size=>`<img src="/ea-shield-80.png" srcset="/ea-shield-80.png 1x, /ea-shield-120.png 2x" alt="" width="${size}" height="${size}">`;
function supportLink(ctx){return ctx.support?`<a href="mailto:${h(ctx.support)}">${h(ctx.support)}</a>`:'';}

function header(ctx){
 if(isCompanyBranded(ctx))return `<header class="login-header login-header-branded"><span class="login-company-brand">${companyLogo(ctx,'login-company-logo',40)}<span>${h(ctx.company)}</span></span>${ctx.support?`<nav class="login-header-links" aria-label="Help"><a href="mailto:${h(ctx.support)}">Need help?</a></nav>`:''}</header>`;
 const brand=`<a class="login-brand" href="/" aria-label="EstateAegis home">${eaLogo(40)}EstateAegis</a>`;
 if(isClientSide(ctx))return `<header class="login-header">${brand}<nav class="login-header-links" aria-label="Help"><a href="mailto:${EA_HELP}">Need help?</a></nav></header>`;
 return `<header class="login-header">${brand}<nav class="login-header-links" aria-label="Site"><a class="login-hide-sm" href="/"><span aria-hidden="true">←</span> Back to homepage</a><a class="login-hide-sm" href="mailto:${EA_HELP}">Need help?</a>${ctx.kind==='signup'?'':'<a class="login-cta" href="/demo">Start free demo</a>'}</nav></header>`;
}

const ROLE_FEATURES={
 client:[['report','Visit reports with photos'],['calendar','Arrivals and service requests'],['chat','Messages with your home watch team']],
 employee:[['report','Your visits, checklists and reports'],['calendar','Schedules and arrivals'],['tools','Work orders assigned to you']],
 admin:[['report','Residences, visits and reports'],['calendar','Schedules, arrivals and storm prep'],['tools','Work orders, vendors and clients']],
 vendor:[['tools','Jobs assigned to your company'],['report','Upload completion photos'],['chat','Messages about each job']]
};
function panel(ctx){
 if(isClientSide(ctx)){
  const features=(ROLE_FEATURES[ctx.kind==='invite'?ctx.role:'client']||ROLE_FEATURES.client).map(([i,t])=>`<li>${ICON[i](20)}<span>${h(t)}</span></li>`).join('');
  const branded=isCompanyBranded(ctx);
  const headline=branded?(ctx.title||`${ctx.company}`):'Your homes, reports and requests in one place.';
  const lede=branded?(ctx.subtitle||(ctx.kind==='invite'&&ctx.role!=='client'?`Your ${h(ctx.company)} workspace.`:'See visit reports and photos, upcoming arrivals, service requests and messages from your home watch team.')):'The client portal your home watch or residence management company uses to keep you informed.';
  return `<aside class="login-panel login-panel-client" aria-labelledby="login-panel-title">${branded?`<div class="login-panel-company">${companyLogo(ctx,'login-panel-logo',64)}<p class="login-eyebrow">${ctx.kind==='invite'&&ctx.role!=='client'?'Team workspace':'Client portal'}</p></div>`:'<p class="login-eyebrow">Client portal</p>'}<h2 id="login-panel-title">${h(headline)}</h2><p class="login-lede">${branded&&ctx.subtitle?h(lede):lede}</p><ul class="login-features">${features}</ul></aside>`;
 }
 return `<aside class="login-panel" aria-labelledby="login-panel-title"><p class="login-eyebrow">Home watch &amp; residence management</p><h2 id="login-panel-title">Your residences. Your team. One place.</h2><p class="login-lede">Visits, inspection reports, work orders, arrivals and storm prep for every home you care for, wherever your clients live.</p><ul class="login-trust"><li>${ICON.shield(20)}<span>Two-factor authentication<small>Use an authenticator app, with one-time recovery codes.</small></span></li><li>${ICON.lock(20)}<span>Encrypted, private sign-in<small>Each company’s records stay in its own workspace.</small></span></li><li>${ICON.clock(20)}<span>Automatic sign-out<small>Idle sessions close after 30 minutes.</small></span></li></ul><div class="login-portals"><h3>Who logs in here</h3><dl><div><dt>Company team</dt><dd>Admins and staff run residences, visits and reports.</dd></div><div><dt>Clients</dt><dd>Homeowners see their homes, reports and requests.</dd></div><div><dt>Vendors</dt><dd>See assigned jobs and upload completion photos.</dd></div></dl></div></aside>`;
}

function footer(ctx){
 const legal='<a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a>';
 if(isClientSide(ctx))return `<footer class="login-footer"><div class="login-footer-wrap"><span class="login-powered-small">${eaLogo(16)}Powered by EstateAegis</span><nav aria-label="Legal">${legal}</nav></div></footer>`;
 return `<footer class="login-footer"><div class="login-footer-wrap"><span>© ${new Date().getFullYear()} EstateAegis · Home watch and residence management software</span><nav aria-label="Legal and help"><a href="/faq">FAQ</a>${legal}<a href="mailto:${EA_HELP}">${EA_HELP}</a></nav></div></footer>`;
}

const field=(name,label,{type='text',autocomplete='',value='',required=true,extra='',hint=''}={})=>`<div class="login-field"><label for="f-${name}">${h(label)}</label><input id="f-${name}" name="${name}" type="${type}"${autocomplete?` autocomplete="${autocomplete}"`:''}${value?` value="${h(value)}"`:''}${required?' required':''}${hint?` aria-describedby="f-${name}-hint"`:''} ${extra}>${hint?`<p class="login-hint" id="f-${name}-hint">${h(hint)}</p>`:''}</div>`;
const passwordField=(name,label,{autocomplete='current-password',value='',newPassword=false,link=''}={})=>`<div class="login-field"><div class="login-label-row"><label for="f-${name}">${h(label)}</label>${link}</div><div class="login-password"><input id="f-${name}" name="${name}" type="password" autocomplete="${autocomplete}" required maxlength="200"${newPassword?' minlength="12" aria-describedby="f-'+name+'-hint"':''}${value?` value="${h(value)}"`:''}><button type="button" class="login-show" data-show-password="f-${name}" aria-pressed="false" aria-label="Show password">Show</button></div>${newPassword?`<p class="login-hint" id="f-${name}-hint">Use at least 12 characters.</p>`:''}</div>`;
const messages=state=>`<div id="authError" class="login-alert" role="alert"${state.error?'':' hidden'}>${ICON.alert(18)}<span id="authErrorText">${h(state.error||'')}</span></div><div id="authNotice" class="login-notice" role="status"${state.notice?'':' hidden'}>${ICON.check(18)}<span id="authNoticeText">${h(state.notice||'')}</span></div>`;
const cardHead=(eyebrow,title,intro)=>`<p class="login-eyebrow">${h(eyebrow)}</p><h1 id="login-title" tabindex="-1">${h(title)}</h1>${intro?`<p class="login-intro">${intro}</p>`:''}`;
const secureLine=()=>`<p class="login-secure">${ICON.lock(15)}Encrypted sign-in · two-factor authentication supported</p>`;
function helpLine(ctx){
 if(isCompanyBranded(ctx))return `<p class="login-help">Trouble logging in? ${ctx.support?`Contact ${h(ctx.company)} at ${supportLink(ctx)}.`:`Contact ${h(ctx.company)} for help with your account.`}</p>`;
 if(ctx.kind==='client')return `<p class="login-help">Trouble logging in? Contact your home watch company, or email <a href="mailto:${EA_HELP}">${EA_HELP}</a>.</p>`;
 return `<p class="login-help">Invited by your company? Use the link in your invitation email.<br>Trouble logging in? <a href="mailto:${EA_HELP}">${EA_HELP}</a></p>`;
}

/* Card markup for each screen. Pure: depends only on (state, ctx), so it can be unit tested. */
function card(state,ctx){
 const m=state.mode;
 if(m==='mfa'){
  const recovery=!!state.recovery;
  return cardHead('Two-step verification',recovery?'Enter a recovery code':'Enter your 6-digit code',recovery?'Use one of the recovery codes you saved when you turned on two-factor authentication. Each code works once.':'Open your authenticator app and enter the current code for EstateAegis.')+messages(state)+`<p class="login-signed-as">Signing in as <strong>${h(state.email)}</strong></p><form id="authForm" class="login-form" novalidate data-form="mfa">${recovery?field('code','Recovery code',{autocomplete:'off',extra:'maxlength="64" autocapitalize="off" spellcheck="false"'}):field('code','Authenticator code',{autocomplete:'one-time-code',extra:'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" class="login-code"'})}<button class="login-submit" type="submit">Verify and log in</button></form><p class="login-links"><button type="button" class="login-link" data-recovery>${recovery?'Use your authenticator app instead':'Use a recovery code instead'}</button><button type="button" class="login-link" data-back>Back to log in</button></p>`;
 }
 if(m==='forgot')return cardHead('Password recovery','Reset your password','Enter your account email. If it matches an account, we’ll send a reset link that works for 1 hour.')+messages(state)+`<form id="authForm" class="login-form" novalidate data-form="forgot">${field('email','Email',{type:'email',autocomplete:'username',value:state.email,extra:'inputmode="email" autocapitalize="off" spellcheck="false"'})}<button class="login-submit" type="submit">Send reset link</button></form><p class="login-links"><button type="button" class="login-link" data-back>Back to log in</button></p>`;
 if(m==='reset')return cardHead('Password recovery','Set a new password','Choose a new password for your account.')+messages(state)+`<form id="authForm" class="login-form" novalidate data-form="reset"><input type="hidden" name="token" value="${h(state.resetToken)}">${passwordField('newPassword','New password',{autocomplete:'new-password',newPassword:true})}<div class="login-field"><label for="f-confirmPassword">Confirm new password</label><input id="f-confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="200"></div><button class="login-submit" type="submit">Save new password</button></form><p class="login-links"><button type="button" class="login-link" data-back>Back to log in</button></p>`;
 if(m==='invite'){
  const who=ctx.company||'your company';
  const intro=ctx.role==='client'?`Create your login to see your homes, reports and requests from ${h(who)}.`:ctx.role==='vendor'?`Create your login to see jobs ${h(who)} assigns to you.`:`Create your login for the ${h(who)} workspace.`;
  return cardHead('Your invitation',ctx.company?`Join ${ctx.company}`:'Create your account',intro)+messages(state)+`<form id="authForm" class="login-form" novalidate data-form="invite">${field('name','Your name',{autocomplete:'name',value:state.name})}${passwordField('password','Create password',{autocomplete:'new-password',newPassword:true})}<button class="login-submit" type="submit">Create account</button></form><p class="login-help">Invitation links work once and expire after 48 hours.</p>`;
 }
 if(m==='signup')return cardHead('Company sign-up',ctx.company?`Welcome to ${ctx.company}`:'Create your company workspace','Create the administrator account for your company.')+messages(state)+`${ctx.email?`<p class="login-signed-as">Account email: <strong>${h(ctx.email)}</strong></p>`:''}<form id="authForm" class="login-form" novalidate data-form="signup">${field('name','Your name',{autocomplete:'name',value:state.name})}${passwordField('password','Create password',{autocomplete:'new-password',newPassword:true})}<div class="login-field"><label for="f-companyLogo">Company logo (optional)</label><input id="f-companyLogo" name="companyLogo" type="file" accept="image/png,image/jpeg"></div><button class="login-submit" type="submit">Create company workspace</button></form>${helpLine({kind:'company'})}`;
 if(m==='setup')return cardHead('Company setup','Set up your company','Create the first administrator account. Your workspace starts empty, ready for your real records.')+messages(state)+`<form id="authForm" class="login-form" novalidate data-form="setup">${field('company','Company name',{autocomplete:'organization'})}<div class="login-field"><label for="f-companyLogo">Company logo (optional)</label><input id="f-companyLogo" name="companyLogo" type="file" accept="image/png,image/jpeg"></div>${field('setupKey','Setup key',{type:'password',autocomplete:'off',required:false,hint:'Required on hosted servers.'})}${field('name','Your name',{autocomplete:'name'})}${field('email','Email',{type:'email',autocomplete:'email',extra:'inputmode="email" autocapitalize="off" spellcheck="false"'})}${passwordField('password','Create password',{autocomplete:'new-password',newPassword:true})}<button class="login-submit" type="submit">Create company</button></form><p class="login-help">Setup is for the person running the workspace.</p>`;
 // log in
 const branded=isCompanyBranded(ctx);
 const head=ctx.kind==='company'?cardHead('Welcome back','Log in to EstateAegis','One login for company teams, clients and vendors. We’ll open the right portal for your account.'):branded?cardHead('Client portal','Log in',`See your homes, visit reports and requests from ${h(ctx.company)}.`):cardHead('Client portal','Client log in','See your homes, visit reports, arrivals and requests from your home watch company.');
 const extras=ctx.kind==='company'?`<div class="login-divider">New to EstateAegis?</div><div class="login-next"><a class="login-next-link" href="/demo"><span><strong>Start your free 7-day demo</strong><span>Sample residences to explore. No credit card.</span></span><span class="login-arrow" aria-hidden="true">→</span></a><a class="login-next-link" href="/pricing"><span><strong>See plans and pricing</strong><span>30-day free trial when you sign up for a paid plan.</span></span><span class="login-arrow" aria-hidden="true">→</span></a></div>`:'';
 return head+messages(state)+`<form id="authForm" class="login-form" novalidate data-form="login">${field('email','Email',{type:'email',autocomplete:'username',value:state.email,extra:'inputmode="email" autocapitalize="off" spellcheck="false"'})}${passwordField('password','Password',{value:state.password,link:'<button type="button" class="login-link" data-forgot>Forgot password?</button>'})}<button class="login-submit" type="submit">Log in</button></form>${secureLine()}${extras}${helpLine(ctx)}`;
}

function problemCard(kind,ctx){
 if(kind==='workspace')return cardHead('Company sign-up','This sign-up link has expired','Company sign-up links work once. If you already created your account, log in. Otherwise you can start a new free demo.')+`<div class="login-actions"><a class="login-submit" href="/login">Go to log in</a><a class="login-secondary" href="/demo">Start a free demo</a></div><p class="login-help">Need help? <a href="mailto:${EA_HELP}">${EA_HELP}</a></p>`;
 if(kind==='portal')return cardHead('Client portal','We couldn’t find that client portal','Check the link from your home watch company, or log in to the client portal below.')+`<div class="login-actions"><a class="login-submit" href="/client-login">Go to client log in</a></div><p class="login-help">Need help? Contact your home watch company, or email <a href="mailto:${EA_HELP}">${EA_HELP}</a>.</p>`;
 return cardHead('Your invitation','This invitation link has expired','Invitation links work once and expire after 48 hours. This one may also have been cancelled or already used. Ask your company administrator to send a new one.')+`<div class="login-actions"><a class="login-submit" href="/login">Go to log in</a></div><p class="login-help">Already created your account? Log in with your email and password. Need help? <a href="mailto:${EA_HELP}">${EA_HELP}</a></p>`;
}

function page(ctx,cardHtml){
 return `<div class="login-page login-${ctx.kind}"><a class="login-skip" href="#login-card">Skip to log in</a>${header(ctx)}<main class="login-main" id="login-main"><section class="login-card" id="login-card" aria-labelledby="login-title">${cardHtml}</section>${panel(ctx)}</main>${footer(ctx)}</div>`;
}
function pageTitle(state,ctx){const base=isCompanyBranded(ctx)?ctx.company:'EstateAegis';const t={mfa:'Two-step verification',forgot:'Reset your password',reset:'Set a new password',invite:'Create your account',signup:'Create your company workspace',setup:'Set up your company'}[state.mode]||'Log in';return `${t} | ${base}`;}

/* ---------- Browser behaviour ---------- */
function apiCall(path,payload){return typeof api==='function'?api(path,payload):Promise.reject(Error('Not ready.'));}
function afterSignIn(){history.replaceState(null,'','/'+(/^#\/./.test(location.hash)?location.hash:''));document.title='EstateAegis';return load();}
function setMessage(id,text){const box=document.getElementById(id),span=document.getElementById(id+'Text');if(!box||!span)return;span.textContent=text||'';box.hidden=!text;}
function wire(root,state,ctx,redraw){
 root.querySelectorAll('[data-show-password]').forEach(b=>b.addEventListener('click',()=>{const input=document.getElementById(b.dataset.showPassword);if(!input)return;const show=input.type==='password';input.type=show?'text':'password';b.textContent=show?'Hide':'Show';b.setAttribute('aria-pressed',String(show));b.setAttribute('aria-label',show?'Hide password':'Show password');}));
 const keep=()=>{const f=document.getElementById('authForm');if(!f)return;for(const k of ['email','password','name']){const el=f.querySelector(`[name=${k}]`);if(el&&el.type!=='file')state[k]=el.value;}};
 root.querySelector('[data-forgot]')?.addEventListener('click',()=>{keep();redraw({mode:'forgot',error:'',notice:''});});
 root.querySelector('[data-back]')?.addEventListener('click',()=>{if(state.mode==='reset')history.replaceState(null,'','/login');redraw({mode:'login',error:'',notice:'',recovery:false});});
 root.querySelector('[data-recovery]')?.addEventListener('click',()=>redraw({recovery:!state.recovery,error:''}));
 const form=document.getElementById('authForm');if(!form)return;
 form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(!form.checkValidity()){const bad=form.querySelector(':invalid');setMessage('authError',bad?.validationMessage?`${bad.labels?.[0]?.textContent||'This field'}: ${bad.validationMessage}`:'Check the highlighted fields.');setMessage('authNotice','');bad?.focus();return;}
  const button=form.querySelector('[type=submit]');button.disabled=true;form.setAttribute('aria-busy','true');setMessage('authError','');
  const values=Object.fromEntries(new FormData(form));delete values.companyLogo;
  try{
   const kind=form.dataset.form;
   if(kind==='login'){state.email=values.email.trim();state.password=values.password;await apiCall('login',{email:state.email,password:state.password});await afterSignIn();return;}
   if(kind==='mfa'){await apiCall('login',{email:state.email,password:state.password,code:String(values.code||'').trim()});await afterSignIn();return;}
   if(kind==='forgot'){state.email=values.email.trim();await apiCall('password-reset/request',{email:state.email});setMessage('authNotice',`If an account matches ${state.email}, we’ve sent a reset link. Check your inbox.`);return;}
   if(kind==='reset'){await apiCall('password-reset',values);history.replaceState(null,'','/login');redraw({mode:'login',password:'',notice:'Your password was reset. You can now log in.',error:''});return;}
   if(kind==='invite'){state.name=values.name;await apiCall('accept-invite',{token:ctx.invitation,name:values.name,password:values.password});await afterSignIn();return;}
   if(kind==='signup'){state.name=values.name;const logoData=typeof readCompanyLogo==='function'?await readCompanyLogo(form):'';await apiCall('workspace-register',{token:state.workspaceToken,name:values.name,password:values.password,...(logoData?{logoData}:{})});history.replaceState(null,'','/');document.title='EstateAegis';await load();return;}
   if(kind==='setup'){const logoData=typeof readCompanyLogo==='function'?await readCompanyLogo(form):'';await apiCall('setup',{...values,...(logoData?{logoData}:{})});await afterSignIn();return;}
  }catch(error){
   if(error?.data?.mfaRequired&&state.mode!=='mfa'){redraw({mode:'mfa',recovery:false,error:'',notice:''});return;}
   setMessage('authNotice','');setMessage('authError',error?.message||'Something went wrong. Try again.');
  }finally{if(document.body.contains(button)){button.disabled=false;form.removeAttribute('aria-busy');if(!form.contains(document.activeElement)){const target=form.querySelector('[name=code]')||form.querySelector('[name=password]')||form.querySelector('input:not([type=hidden])');target?.focus();target?.select?.();}}}
 });
}
function mount(state,ctx){
 const app=document.getElementById('app');
 const redraw=(patch={})=>{const modeChanged=patch.mode&&patch.mode!==state.mode||'recovery' in patch;Object.assign(state,patch);app.innerHTML=page(ctx,card(state,ctx));document.title=pageTitle(state,ctx);wire(app,state,ctx,redraw);if(modeChanged){const first=app.querySelector('#authForm input:not([type=hidden])');(state.mode==='mfa'&&first?first:document.getElementById('login-title'))?.focus();}};
 redraw();
 return redraw;
}

function portalAuth(configured,invitation,brand=null){
 const params=new URLSearchParams(location.search);
 const ctx=loginContext({configured,invitation,brand,path:location.pathname});
 const reset=params.get('reset');
 const mode=invitation?'invite':reset!==null?'reset':!configured&&ctx.kind==='company'?'setup':'login';
 return mount({mode,email:'',password:'',name:'',resetToken:reset||'',recovery:false,error:'',notice:''},ctx);
}
async function workspaceRegistration(token){
 let invite;
 try{invite=await apiCall('workspace-invite?token='+encodeURIComponent(token));}
 catch(error){if(!error?.status)throw error;return authProblem('workspace');}
 return mount({mode:'signup',workspaceToken:token,name:'',error:'',notice:''},loginContext({workspace:invite}));
}
function authProblem(kind){
 const ctx=kind==='workspace'?{kind:'company',configured:true}:{kind:'client',configured:true};
 const app=document.getElementById('app');app.innerHTML=page(ctx,problemCard(kind,ctx));
 document.title=(kind==='workspace'?'Sign-up link expired':kind==='portal'?'Client portal not found':'Invitation expired')+' | EstateAegis';
}

const api_={loginContext,card,problemCard,page,pageTitle,header,panel,footer};
if(typeof window!=='undefined'){window.portalAuth=portalAuth;window.workspaceRegistration=workspaceRegistration;window.authProblem=authProblem;window.EALogin=api_;}
if(typeof globalThis!=='undefined')globalThis.EALogin=api_;
})();
