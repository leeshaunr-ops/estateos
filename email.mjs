import { createHash } from 'node:crypto';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function sendInvitation({to, invitePath, company = 'your workspace'}, {env = process.env, fetcher = fetch} = {}) {
  if (!env.RESEND_API_KEY) return {emailStatus:'not_configured'};
  let link;
  try {
    const base = new URL(env.APP_URL || 'https://estateaegis.com');
    if (base.protocol !== 'https:' || base.username || base.password) throw Error('Invalid app URL');
    link = new URL(invitePath, base.origin);
    if (link.origin !== base.origin || link.pathname !== '/' || !/^\/\?((workspaceInvite)|(invite))=[a-f0-9]{64}$/.test(invitePath)) throw Error('Invalid invitation');
  } catch { return {emailStatus:'failed'}; }
  const intro = `You have been invited to ${company} on EstateAegis.`;
  const payload = {
    from: env.EMAIL_FROM || 'EstateAegis <notifications@estateaegis.com>',
    to: [to],
    subject: 'Your EstateAegis invitation',
    text: `${intro}\n\nCreate your account: ${link.href}\n\nThis invitation expires in 48 hours and can be used once.\n\nEstateAegis\nThe smarter way to manage private residences.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#303438;background:#faf8f2"><h1>EstateAegis</h1><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#92232e;color:white;padding:14px 22px;text-decoration:none;border-radius:6px">Create your account</a></p><p>This invitation expires in 48 hours and can be used once.</p><p>If the button does not work, copy this link:<br>${escapeHtml(link.href)}</p><p>The smarter way to manage private residences.</p></div>`
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
