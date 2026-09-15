import {createHmac,timingSafeEqual} from 'node:crypto';
import {PLANS,ADDONS,subscriptionQuote} from './stripe-plans.mjs';

export function verifyStripeEvent(raw, header, secret, nowSeconds=Math.floor(Date.now()/1000)) {
  if(!secret || !Buffer.isBuffer(raw) || raw.length>1048576) throw new Error('Invalid webhook.');
  const parts=String(header||'').split(',').map(s=>s.split('='));
  const stamps=parts.filter(([k])=>k==='t');
  if(stamps.length!==1 || !/^\d+$/.test(stamps[0][1])) throw new Error('Invalid webhook timestamp.');
  const t=Number(stamps[0][1]);
  if(Math.abs(nowSeconds-t)>300) throw new Error('Expired webhook.');
  const expected=createHmac('sha256',secret).update(String(t)+'.').update(raw).digest();
  if(!parts.some(([k,v])=>k==='v1' && /^[a-f0-9]{64}$/i.test(v||'') && timingSafeEqual(expected,Buffer.from(v,'hex')))) throw new Error('Invalid webhook signature.');
  const event=JSON.parse(raw.toString('utf8'));
  if(!event.id || !event.type || !event.data?.object) throw new Error('Invalid webhook event.');
  return event;
}

export function createStripeClient({secret=process.env.STRIPE_SECRET_KEY, origin=process.env.ESTATEOS_PUBLIC_URL, fetcher=fetch, plans=PLANS, addons=ADDONS}={}) {
  let portalConfiguration;
  async function request(path, params, idempotencyKey) {
    if(!secret) throw new Error('Stripe is not configured.');
    const headers={Authorization:'Bearer '+secret};
    if(params){headers['Content-Type']='application/x-www-form-urlencoded';if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;}
    const response=await fetcher('https://api.stripe.com/v1/'+path,{method:params?'POST':'GET',headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(20000)});
    const result=await response.json();
    if(!response.ok) throw new Error('Stripe request failed ('+response.status+').');
    return result;
  }
  async function price(item) {
    const result=await request('prices?active=true&limit=100&product='+encodeURIComponent(item.product));
    const matches=result.data.filter(p=>p.active && p.currency==='usd' && p.unit_amount===item.monthlyMinor && p.recurring?.interval==='month' && p.recurring.interval_count===1 && p.billing_scheme==='per_unit');
    if(matches.length!==1 || result.has_more) throw new Error('Stripe catalog price needs review.');
    return matches[0].id;
  }
  async function checkout({organizationId, customer, email, plan, extraSeats=0, storagePacks=0, attemptId,successPath='/login?billing=success',cancelPath='/login?billing=canceled'}) {
    const quote=subscriptionQuote(plan,extraSeats,storagePacks);
    const site=new URL(origin);
    if(site.protocol!=='https:' || site.username || site.password || site.search || site.hash) throw new Error('A secure public URL is required.');
    if(!organizationId || !attemptId) throw new Error('Checkout identity required.');
    if(![successPath,cancelPath].every(p=>p.startsWith('/')&&!p.startsWith('//')&&new URL(p,site.origin).origin===site.origin))throw Error('Invalid checkout return URL.');
    const fields={mode:'subscription',success_url:site.origin+successPath,cancel_url:site.origin+cancelPath,client_reference_id:organizationId,'subscription_data[metadata][organization_id]':organizationId,'subscription_data[trial_period_days]':'30','metadata[organization_id]':organizationId,'metadata[attempt_id]':attemptId,'payment_method_types[0]':'card',billing_address_collection:'required'};
    if(customer)fields.customer=customer;else fields.customer_email=email;
    const items=[[plans[plan],1],...(extraSeats?[[addons.seats,extraSeats]]:[]),...(storagePacks?[[addons.storage,storagePacks]]:[])];
    for(let i=0;i<items.length;i++){fields[`line_items[${i}][price]`]=await price(items[i][0]);fields[`line_items[${i}][quantity]`]=String(items[i][1]);}
    const result=await request('checkout/sessions',fields,'estate-checkout-'+attemptId);
    if(!result.id || !result.url?.startsWith('https://checkout.stripe.com/'))throw new Error('Unexpected checkout response.');
    return {id:result.id,url:result.url,quote};
  }
  async function portal(customer){
    const site=new URL(origin),live=String(secret).startsWith('sk_live_');
    if(site.protocol!=='https:'||!customer)throw Error('Billing portal identity required.');
    if(!portalConfiguration){
      const config=await request('billing_portal/configurations',{
        name:'EstateAegis billing management',
        'features[invoice_history][enabled]':'true',
        'features[payment_method_update][enabled]':'true',
        'features[subscription_cancel][enabled]':'true',
        'features[subscription_cancel][mode]':'at_period_end',
        'features[subscription_cancel][proration_behavior]':'none',
        'features[subscription_update][enabled]':'false',
        'features[customer_update][enabled]':'false',
        default_return_url:site.origin+'/login'
      },'estate-portal-config-v1');
      if(config.livemode!==live)throw Error('Billing portal mode mismatch.');
      portalConfiguration=config.id;
    }
    const session=await request('billing_portal/sessions',{customer,configuration:portalConfiguration,return_url:site.origin+'/login'});
    if(session.livemode!==live||session.customer!==customer||!session.url?.startsWith('https://billing.stripe.com/'))throw Error('Unexpected billing portal response.');
    return {url:session.url};
  }
  return {request,price,checkout,portal};
}
