import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendInvitation} from './email.mjs';
const invitation={to:'recipient@example.com',invitePath:'/?invite='+'a'.repeat(64),company:'A <script> company'};
const env={RESEND_API_KEY:'test-only',APP_URL:'https://estateaegis.com'};
test('missing configuration never sends', async()=>{
 assert.deepEqual(await sendInvitation(invitation,{env:{},fetcher:()=>{throw Error('must not call');}}),{emailStatus:'not_configured'});
});
test('sends escaped invitation with correct destination and stable idempotency',async()=>{
 const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'message-id'})};};
 assert.deepEqual(await sendInvitation(invitation,{env,fetcher}),{emailStatus:'sent'});
 await sendInvitation(invitation,{env,fetcher});
 const body=JSON.parse(calls[0].options.body);
 assert.equal(calls[0].url,'https://api.resend.com/emails');
 assert.deepEqual(body.to,['recipient@example.com']);
 assert.match(body.html,/A &lt;script&gt; company/);
 assert.match(body.text,/https:\/\/estateaegis.com\/\?invite=/);
 assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);
});
test('provider errors and timeouts preserve safe failure state',async()=>{
 for(const fetcher of [async()=>({ok:false}),async()=>{throw Error('secret provider detail');}])
 assert.deepEqual(await sendInvitation(invitation,{env,fetcher}),{emailStatus:'failed'});
});
test('untrusted invitation destinations never send',async()=>{
 assert.deepEqual(await sendInvitation({...invitation,invitePath:'https://other.example/?invite='+'a'.repeat(64)},{env,fetcher:()=>{throw Error('must not call');}}),{emailStatus:'failed'});
});

test('demo activation email includes guide and checklist while ordinary invitations do not',async()=>{
 const bodies=[];const fetcher=async(url,options)=>{bodies.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'test-id'})};};
 await sendInvitation({...invitation,demoGuide:true},{env,fetcher});await sendInvitation(invitation,{env,fetcher});
 assert.match(bodies[0].subject,/demo/);assert.match(bodies[0].text,/https:\/\/estateaegis.com\/demo-guide/);assert.match(bodies[0].html,/Activate your demo/);assert.match(bodies[0].html,/Create a practice work order/);assert.match(bodies[0].text,/seven-day demo starts when you register/);assert.doesNotMatch(bodies[1].html,/demo-guide/);
 assert.ok(bodies[0].html.indexOf('Activate your demo')<bodies[0].html.indexOf('Your first five minutes'));
});
