// Static checks on the app shell scripts. They share one global scope in the browser, so a function removed from
// one file can still be called from another and only fails when that button is pressed (Oct 3: Sign out called
// the removed auth(), then the stale app read data.offline with data cleared). TypeScript's checker finds every
// name that no loaded script declares.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=f=>readFileSync(path.join(root,f),'utf8');
const scripts=[...read('public/live.html').matchAll(/<script src="\/([^"?]+)/g)].map(m=>path.join(root,'public',m[1]));

// Names that are known and safe. Keep this list short and explained.
const KNOWN={
 // Implicit globals: only ever assigned before they are read (non-strict scripts create them on first assignment).
 platformCompanies:'assigned in load() for platform owners before the platform screen can read it',
 platformDemo:'assignment only',platformInvite:'assignment only',platformEmailStatus:'assignment only',
 // Removed with the old billing screen on Sep 14 (c8f7152). No screen renders these action buttons any more.
 stripeSandboxAction:'unreachable: no button renders stripe-sandbox-* actions',
 stripeBillingAction:'unreachable: no button renders stripe-* actions',
 subscriptionAction:'unreachable: no button renders storage-*/subscription-* actions',
};

function undeclaredNames(){
 const program=ts.createProgram(scripts,{allowJs:true,checkJs:true,noEmit:true,target:ts.ScriptTarget.ES2022,lib:['lib.es2023.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],types:[],skipLibCheck:true,moduleDetection:ts.ModuleDetectionKind.Legacy});
 // Scripts also publish names on window / globalThis / their root object; those count as declared.
 const exported=new Set();for(const f of scripts)for(const m of readFileSync(f,'utf8').matchAll(/\b(?:window|globalThis|root|self)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g))exported.add(m[1]);
 const found=[];
 for(const sf of program.getSourceFiles()){
  if(!scripts.includes(path.resolve(sf.fileName)))continue;
  for(const d of program.getSemanticDiagnostics(sf)){
   if(![2304,2552,2582].includes(d.code))continue;// "Cannot find name ..."
   const name=sf.text.slice(d.start,d.start+d.length);if(exported.has(name))continue;
   found.push({name,where:`${path.basename(sf.fileName)}:${sf.getLineAndCharacterOfPosition(d.start).line+1}`});
  }
 }
 return found;
}

test('app shell scripts never call a function or read a variable that no loaded script defines', ()=>{
 assert.ok(scripts.length>=10&&scripts.some(f=>f.endsWith('live.js'))&&scripts.some(f=>f.endsWith('login.js')),'reads the script list from live.html');
 const found=undeclaredNames();
 const unknown=found.filter(f=>!KNOWN[f.name]);
 assert.deepEqual(unknown,[],'undefined globals:\n'+unknown.map(f=>`${f.name} (${f.where})`).join('\n'));
});

test('the checker really catches a missing function (guards the test itself)', ()=>{
 const program=ts.createProgram(['probe.js'],{allowJs:true,checkJs:true,noEmit:true,types:[],lib:['lib.es2023.d.ts','lib.dom.d.ts']},Object.assign(ts.createCompilerHost({}),{getSourceFile:(n,v)=>n==='probe.js'?ts.createSourceFile(n,"async function action(name){if(name==='logout'){auth(true);}}",v):ts.createCompilerHost({}).getSourceFile(n,v)}));
 const names=program.getSemanticDiagnostics().filter(d=>d.code===2304).map(d=>d.file.text.slice(d.start,d.start+d.length));
 assert.deepEqual(names,['auth']);
});

test('sign-out and a cleared session never leave the old app running without data', ()=>{
 const live=read('public/live.js'),drafts=read('public/inspection-drafts.js');
 assert.match(live,/if\(name==='logout'\)\{[^\n]*data=null;[^\n]*showSignIn\(\);return;\}/,'sign-out draws the sign-in screen');
 assert.match(live,/function showSignIn\(\)\{[^\n]*boot\(\);\}/);
 assert.match(live,/function render\(\)\{if\(!data\)return;/,'render does nothing without a signed-in user');
 assert.match(live,/if\(!data&&button\.closest\('\.shell'\)\)return;/,'buttons left on a signed-out app are ignored');
 assert.doesNotMatch(drafts,/name==='navigate'&&data\.offline/,'navigation reads data safely');
});

test('page and scripts carry the deploy shell version; mixed versions recover instead of running', ()=>{
 const html=read('public/live.html'),live=read('public/live.js'),login=read('public/login.js'),sw=read('public/sw.js'),server=read('server.mjs');
 assert.match(html,/<meta name="ea-shell" content="__SHELL_VERSION__">/);
 assert.ok(live.startsWith("window.EA_SHELL_VERSION='__SHELL_VERSION__';"));
 assert.match(server,/file === 'live\.html' \|\| file === 'live\.js'\) return res\.end\([^\n]*replaceAll\('__SHELL_VERSION__', shellVersion\(\)\)/);
 assert.match(server,/res\.setHeader\('X-EA-Shell', shellVersion\(\)\)/);
 assert.match(login,/function checkShellVersion\(\)/);assert.match(live,/async function boot\(\)\{if\(window\.EA_SHELL_RECOVERING\)return;/);
 assert.match(sw,/CACHE='estateaegis-shell-v2-'\+VERSION/);assert.match(sw,/response\.headers\.get\('X-EA-Shell'\)/);
 assert.match(sw,/key\.startsWith\('estateaegis-shell-'\)&&!key\.startsWith\('estateaegis-shell-v2-'\)\)\)await self\.skipWaiting\(\)/,'pre-v2 workers are replaced at once');
});
