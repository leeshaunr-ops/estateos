import { createHash } from 'node:crypto';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function sendInvitation({to, invitePath, company = 'your workspace',planDescription='',demoGuide=false}, {env = process.env, fetcher = fetch} = {}) {
  if (!env.RESEND_API_KEY) return {emailStatus:'not_configured'};
  let link;
  try {
    const base = new URL(env.APP_URL || 'https://estateaegis.com');
    if (base.protocol !== 'https:' || base.username || base.password) throw Error('Invalid app URL');
    link = new URL(invitePath, base.origin);
    if (link.origin !== base.origin || link.pathname !== '/' || !/^\/\?((workspaceInvite)|(invite))=[a-f0-9]{64}$/.test(invitePath)) throw Error('Invalid invitation');
  } catch { return {emailStatus:'failed'}; }
  const intro = `You have been invited to ${company} on EstateAegis.${planDescription?' Your paid subscription: '+planDescription+'.':''}`;
  const guideUrl=new URL('/demo-guide',link.origin).href;
  const steps=['Open the sample residence.','Try the sample inspection.','Create a practice work order.','Explore an upcoming arrival.'];
  const guideText=demoGuide?`\n\nWatch your demo quick start: ${guideUrl}\n\nYour first five minutes:\n${steps.map(s=>'- '+s).join('\n')}\n\nYour seven-day demo starts when you register. Report emails and payments are disabled. Reset demo restores the sample records; it does not extend the expiry. Need help or more time? sales@estateaegis.com · 772-237-1382.`:'';
  const guideHtml=demoGuide?`<h2 style="font-size:20px;margin:24px 0 10px">Your first five minutes</h2><p><a href="${escapeHtml(guideUrl)}">Watch the short demo quick start →</a></p><ol>${steps.map(s=>'<li>'+s+'</li>').join('')}</ol><p>Your seven-day demo starts when you register. Report emails and payments are disabled. Reset demo restores sample records without extending your expiry.</p><p>Need help or more time? <a href="mailto:sales@estateaegis.com">sales@estateaegis.com</a> · 772-237-1382.</p>`:'';
  const payload = {
    from: env.EMAIL_FROM || 'EstateAegis <notifications@estateaegis.com>',
    to: [to],
    subject: demoGuide?'Your EstateAegis demo — activate and get started':'Your EstateAegis invitation',
    text: `${intro}\n\nCreate your account: ${link.href}\n\nThis invitation expires in 48 hours and can be used once.${guideText}\n\nEstateAegis\nThe smarter way to manage private residences.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;color:#303438;background:#faf8f2"><h1>EstateAegis</h1><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#92232e;color:white;padding:14px 22px;text-decoration:none;border-radius:6px">${demoGuide?'Activate your demo':'Create your account'}</a></p><p>This invitation expires in 48 hours and can be used once.</p><p>If the button does not work, copy this link:<br>${escapeHtml(link.href)}</p>${guideHtml}<p>The smarter way to manage private residences.</p></div>`
  };
  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method:'POST', signal:AbortSignal.timeout(15000),
      headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':createHash('sha256').update(invitePath).digest('hex')},
      body:JSON.stringify(payload)
    });
    if (!response.ok) return {emailStatus:'failed'};
    const result = await response.json();
    return result.id ? {emailStatus:'sent'} : {emailStatus:'failed'};
  } catch { return {emailStatus:'failed'}; }
}
