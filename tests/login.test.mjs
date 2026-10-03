// Sign-in: one form for every role, two-factor code step, uniform errors, invitation / reset pages, and the
// company-branded client portal. Runs against a local server with a temporary database (never a real one).
import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {totp} from '../security.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const dir=mkdtempSync(path.join(os.tmpdir(),'estateos-login-'));
let proc,base,log='';
async function start(){const env={...process.env,PORT:'0',ESTATEOS_DATA_DIR:dir,ESTATEOS_VAULT_KEY:randomBytes(32).toString('base64')};delete env.DATABASE_URL;delete env.RENDER;delete env.ESTATEOS_SECURE_COOKIES;
 proc=spawn(process.execPath,['server.mjs'],{cwd:root,env,windowsHide:true});proc.stderr.on('data',c=>{log+=c;});
 base=await new Promise((resolve,reject)=>{proc.stdout.on('data',c=>{const m=String(c).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});proc.once('exit',code=>reject(Error('Server exited: '+code+' '+log)));setTimeout(()=>reject(Error('Startup timeout')),10000).unref();});}
after(async()=>{if(proc&&!proc.killed){proc.kill();await new Promise(r=>proc.once('exit',r));}rmSync(dir,{recursive:true,force:true});});
function client(){let cookie='';return {async req(endpoint,b,expected=200){const res=await fetch(base+'/api/'+endpoint,{method:b===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=await res.json();assert.equal(res.status,expected,endpoint+': '+JSON.stringify(result)+' '+log);return result;}};}
const pw='Test-only-strong-password-928!';
const tokenOf=inv=>new URL('http://x'+inv.invitePath).searchParams.get('invite');
let admin,pendingClientInvite,fam;
before(async()=>{
 await start();admin=client();
 await admin.req('setup',{company:'Harbor & Pine Home Watch',name:'Owner',email:'owner@example.test',password:pw},201);
 await admin.req('workspace/settings',{name:'Harbor & Pine Home Watch',supportEmail:'care@harborpine.example',clientPortalTitle:'Welcome home',clientPortalSubtitle:'Reports for your home.'},201);
 fam=await admin.req('clients',{name:'Rivera Family'},201);const ven=await admin.req('vendors',{name:'Bluewater Pools'},201);
 const accept=async(role,email,extra={})=>client().req('accept-invite',{token:tokenOf(await admin.req('invitations',{role,email,...extra},201)),name:email,password:pw},201);
 await accept('employee','staff@example.test');await accept('vendor','vendor@example.test',{vendorId:ven.id});await accept('client','client@example.test',{clientId:fam.id});await accept('employee','mfa@example.test');
 pendingClientInvite=tokenOf(await admin.req('invitations',{role:'client',email:'new@example.test',clientId:fam.id},201));
});

test('one sign-in form: admin, staff, vendor and client accounts all log in without choosing a portal', async()=>{
 for(const [email,role] of [['owner@example.test','admin'],['staff@example.test','employee'],['vendor@example.test','vendor'],['client@example.test','client']]){
  const c=client();const r=await c.req('login',{email,password:pw});assert.equal(r.user.role,role,email);
  assert.equal((await c.req('status')).user.email,email);
 }
 // Older cached pages still send a portal role; it must never block an account (staff had no portal of their own).
 assert.equal((await client().req('login',{email:'staff@example.test',password:pw,role:'admin'})).user.role,'employee');
 assert.equal((await client().req('login',{email:'owner@example.test',password:pw,role:'client'})).user.role,'admin');
 // Email matching ignores case and stray spaces.
 assert.equal((await client().req('login',{email:'  Staff@Example.TEST ',password:pw})).user.role,'employee');
});

test('no account enumeration: wrong password, unknown email and wrong portal share one 401 message', async()=>{
 const wrongPw=await client().req('login',{email:'staff@example.test',password:'Not-the-password-123'},401);
 const unknown=await client().req('login',{email:'nobody@example.test',password:'Not-the-password-123'},401);
 const wrongPortal=await client().req('login',{email:'staff@example.test',password:'Not-the-password-123',role:'client'},401);
 for(const r of [wrongPw,unknown,wrongPortal]){assert.deepEqual(r,{error:'Email or password is incorrect.'});}
 assert.doesNotMatch(read('server.mjs'),/Choose the portal assigned/);
});

test('two-factor sign-in: code required after the password, wrong codes rejected, TOTP and recovery codes accepted once', async()=>{
 const c=client();await c.req('login',{email:'mfa@example.test',password:pw});
 const {secret}=await c.req('security/setup',{password:pw});
 const {recoveryCodes}=await c.req('security/enable',{password:pw,code:totp(secret,Math.floor(Date.now()/30000))});
 assert.equal(recoveryCodes.length,8);
 const need=await client().req('login',{email:'mfa@example.test',password:pw},401);
 assert.equal(need.mfaRequired,true);assert.match(need.error,/6-digit code/);
 // A wrong password never reveals that the account uses two-factor.
 assert.deepEqual(await client().req('login',{email:'mfa@example.test',password:'Not-the-password-123'},401),{error:'Email or password is incorrect.'});
 const wrong=await client().req('login',{email:'mfa@example.test',password:pw,code:'000000'},401);
 assert.equal(wrong.mfaRequired,true);assert.match(wrong.error,/didn’t work/);
 const ok=client();assert.equal((await ok.req('login',{email:'mfa@example.test',password:pw,code:totp(secret,Math.floor(Date.now()/30000)+1)})).user.email,'mfa@example.test');
 assert.equal((await ok.req('status')).user.email,'mfa@example.test');
 assert.equal((await client().req('login',{email:'mfa@example.test',password:pw,code:recoveryCodes[0]})).user.email,'mfa@example.test');
 assert.equal((await client().req('login',{email:'mfa@example.test',password:pw,code:recoveryCodes[0]},401)).mfaRequired,true,'recovery codes work once');
});

test('invitation and branded portal info carry the company branding and support email', async()=>{
 const info=await (await fetch(base+'/api/invite-info?token='+pendingClientInvite)).json();
 assert.equal(info.company,'Harbor & Pine Home Watch');assert.equal(info.role,'client');assert.equal(info.supportEmail,'care@harborpine.example');assert.equal(info.title,'Welcome home');
 assert.equal((await fetch(base+'/api/invite-info?token=nope')).status,422);
 assert.equal((await fetch(base+'/api/invite-info?token='+'a'.repeat(64))).status,404);
 const portal=await (await fetch(base+'/api/client-portal?slug=harbor-pine-home-watch')).json();
 assert.equal(portal.company,'Harbor & Pine Home Watch');assert.equal(portal.supportEmail,'care@harborpine.example');assert.equal(portal.subtitle,'Reports for your home.');
 assert.equal((await fetch(base+'/api/client-portal?slug=no-such-company')).status,404);
});

test('sign-in, reset, invitation, branded portal and sign-up pages load the new sign-in assets', async()=>{
 for(const p of ['/login','/login?reset='+'0'.repeat(64),'/client-login','/client-login?invite='+pendingClientInvite,'/client/harbor-pine-home-watch','/?invite='+pendingClientInvite,'/?workspaceInvite='+'b'.repeat(64),'/login?inspection=abc']){
  const res=await fetch(base+p);const html=await res.text();
  assert.equal(res.status,200,p);assert.match(html,/<script src="\/login\.js\?v=[^"]+"><\/script>/,p);assert.match(html,/href="\/login\.css\?v=/,p);
  assert.match(res.headers.get('x-robots-tag')||'',/noindex/,p);assert.match(res.headers.get('content-security-policy')||'',/script-src 'self'/,p);
 }
 for(const [p,type] of [['/login.js','javascript'],['/login.css','text/css'],['/fonts/inter-latin-var.woff2','font/woff2']]){const res=await fetch(base+p);assert.equal(res.status,200,p);assert.match(res.headers.get('content-type'),new RegExp(type),p);}
 const sw=await (await fetch(base+'/sw.js')).text();for(const a of ['/login.js','/login.css'])assert.ok(sw.includes(`'${a}'`),a);
});

// ---------- Unit tests for the screen markup (public/login.js) ----------
function loadLogin(){const sandbox={};vm.createContext(sandbox);vm.runInContext(read('public/login.js'),sandbox);return sandbox.EALogin;}
const L=loadLogin();
const base0={email:'',password:'',name:'',resetToken:'',recovery:false,error:'',notice:''};
const view=(mode,ctxArgs={},extra={})=>{const ctx=L.loginContext({configured:true,path:'/login',...ctxArgs});return {ctx,html:L.page(ctx,L.card({...base0,mode,...extra},ctx))};};

test('log-in form markup: no portal picker, password-manager friendly, announced errors, forgot password always shown', ()=>{
 for(const path of ['/login','/client-login']){
  const {html}=view('login',{path});
  assert.doesNotMatch(html,/portal-tile|data-portal|name="role"/,path);
  assert.match(html,/name="email" type="email" autocomplete="username"/,path);
  assert.match(html,/name="password" type="password" autocomplete="current-password" required maxlength="200">/,path);
  assert.doesNotMatch(html.match(/<input id="f-password"[^>]*>/)[0],/minlength/,path);
  assert.match(html,/id="authError" class="login-alert" role="alert"/,path);assert.match(html,/role="status"/,path);
  assert.match(html,/data-forgot>Forgot password\?<\/button>/,path);
  assert.match(html,/<h1 id="login-title"/,path);assert.match(html,/<main class="login-main"/,path);
 }
 const branded=view('login',{path:'/client/harbor-pine',brand:{company:'Harbor & Pine',logo:'',supportEmail:'care@hp.example'}}).html;
 assert.match(branded,/data-forgot>Forgot password\?/);
});

test('new-password screens keep the 12-character rule; the code step offers recovery codes', ()=>{
 const reset=view('reset',{},{resetToken:'f'.repeat(64)}).html;
 assert.match(reset,/name="newPassword" type="password" autocomplete="new-password" required maxlength="200" minlength="12"/);
 assert.match(reset,/name="confirmPassword" type="password" autocomplete="new-password" required minlength="12"/);
 assert.match(reset,/name="token" value="f{64}"/);
 const invite=view('invite',{invitation:'t',brand:{company:'Harbor & Pine',role:'client'}}).html;
 assert.match(invite,/Join Harbor &amp; Pine/);assert.match(invite,/name="password" type="password" autocomplete="new-password" required maxlength="200" minlength="12"/);
 assert.doesNotMatch(invite,/Invited email/);
 const setup=view('setup',{configured:false}).html;assert.match(setup,/name="email" type="email" autocomplete="email"/);assert.match(setup,/name="company"/);
 const mfa=view('mfa',{}, {email:'a@b.test'}).html;
 assert.match(mfa,/autocomplete="one-time-code"/);assert.match(mfa,/inputmode="numeric" pattern="\[0-9\]\{6\}" maxlength="6"/);
 assert.match(mfa,/Use a recovery code instead/);assert.match(mfa,/Signing in as <strong>a@b\.test<\/strong>/);assert.match(mfa,/Back to log in/);
 const rec=view('mfa',{}, {email:'a@b.test',recovery:true}).html;assert.match(rec,/Recovery code/);assert.match(rec,/Use your authenticator app instead/);assert.doesNotMatch(rec,/one-time-code/);
});

test('company-branded client portal: company logo, name and headline up front, no EstateAegis marketing', ()=>{
 const brand={company:'Harbor & Pine <Home Watch>',logo:'data:image/png;base64,AAAA',title:'Welcome home',subtitle:'Reports for your home.',supportEmail:'care@hp.example'};
 for(const html of [view('login',{path:'/client/harbor-pine',brand}).html,view('invite',{invitation:'t',brand:{...brand,role:'client'}}).html]){
  assert.match(html,/login-header-branded/);assert.match(html,/Harbor &amp; Pine &lt;Home Watch&gt;/);assert.doesNotMatch(html,/<Home Watch>/,'company name is escaped');
  assert.match(html,/src="data:image\/png;base64,AAAA"/);assert.match(html,/Welcome home/);assert.match(html,/Reports for your home\./);
  assert.match(html,/href="mailto:care@hp\.example">Need help\?/);
  assert.doesNotMatch(html,/Start free demo|free 7-day|7-day demo|30-day|trial|pricing|login-cta|class="login-brand"|Back to homepage|help@estateaegis\.com/i);
  assert.equal((html.match(/Powered by EstateAegis/g)||[]).length,1,'one small powered-by line');
 }
 const noLogo=view('login',{path:'/client/harbor-pine',brand:{company:'Harbor & Pine'}}).html;
 assert.match(noLogo,/login-monogram/);assert.doesNotMatch(noLogo,/Need help\?/,'no EstateAegis help when the company has no support email');assert.match(noLogo,/Contact Harbor &amp; Pine for help/);
 const generic=view('login',{path:'/client-login'}).html;
 assert.match(generic,/Client log in/);assert.doesNotMatch(generic,/Start free demo|7-day|30-day|trial|pricing|Back to homepage/i);
 const company=view('login').html;assert.match(company,/Start free demo/);assert.match(company,/Back to homepage/);assert.match(company,/30-day free trial/);
 const reset=view('reset',{reset:true},{resetToken:'x'});assert.equal(reset.ctx.kind,'account');assert.match(reset.html,/Set a new password/);assert.doesNotMatch(reset.html,/Start free demo|7-day|30-day|trial|pricing|login-cta/i,'reset links reach clients too: no sales links');
 const afterReset=view('login',{reset:true}).html;assert.match(afterReset,/Log in to EstateAegis/);assert.doesNotMatch(afterReset,/Start free demo|7-day|30-day|trial|pricing/i);
 assert.doesNotMatch(company+generic,/Florida/i);
});

test('friendly expired-link screens replace the developer "could not connect" message', ()=>{
 const ctx={kind:'client',configured:true};
 assert.match(L.problemCard('invite',ctx),/This invitation link has expired/);assert.match(L.problemCard('portal',ctx),/couldn’t find that client portal/);
 assert.match(L.problemCard('workspace',{kind:'company'}),/This sign-up link has expired/);
 const live=read('public/live.js');
 assert.doesNotMatch(live,/Keep the EstateAegis server running/);assert.match(live,/authProblem\(brandedSlug\?'portal':'invite'\)/);
 assert.match(live,/status:response\.status,data:result/,'api() exposes response flags such as mfaRequired');
 assert.doesNotMatch(live,/role:portal|function portalAuth|originalPortalAuth/);
});

test('sign-in assets are CSP-safe and wired into the app shell', ()=>{
 const js=read('public/login.js'),css=read('public/login.css'),html=read('public/live.html');
 assert.doesNotMatch(js,/style="|\.style\.|onclick=|innerHTML\s*=\s*[^;]*<script/);
 assert.doesNotMatch(html,/<script>(?!<\/script>)|<style/);
 assert.match(html,/<script src="\/login\.js\?v=[^"]+"><\/script>/);assert.ok(html.indexOf('/live.js')<html.indexOf('/login.js'),'login.js loads after live.js');
 for(const hex of css.match(/#[0-9a-f]{6}\b/gi)) assert.ok(['#f7f8fa','#f1f4f6','#e2e7eb','#1f2933','#5f6b76','#8b242b','#701c23','#182631','#2f4150','#c9d0cb','#b89960','#d0b686','#7a6847','#fff7f7','#ead5d3'].includes(hex.toLowerCase()),'palette colour '+hex);
 assert.match(read('server.mjs'),/SHELL_FILES = \['live\.html','live\.js','login\.js','login\.css'/);
 assert.doesNotMatch(read('public/live.css')+read('public/refresh.css'),/\.auth-intro|\.portal-tile|\.auth-form/);
});
