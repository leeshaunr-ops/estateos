// Plan catalog: the single source of truth for prices and allowances. Allowances are derived from the plan key at
// read time (stripe_billing stores only plan + add-on quantities), so changing a limit here applies to every existing
// subscriber on the next request. Stripe holds only products and prices; no limits are read from Stripe metadata.
export const PLANS = Object.freeze({
  essentials: {name:'Essentials', monthlyMinor:5900, regularMinor:7900, residences:50, seats:4, storageGB:10, product:'prod_VFtm9ebEAmXkPc'},
  growth: {name:'Growth', monthlyMinor:10900, regularMinor:12900, residences:150, seats:10, storageGB:30, product:'prod_VFtn294ZmM6pd4'},
  professional: {name:'Professional', monthlyMinor:17900, regularMinor:19900, residences:300, seats:20, storageGB:50, product:'prod_VFtoQSXsffoRnV'}
});
// Extra field inspector add-on ($5/month each beyond the free allowance). Like the other add-ons its price is looked up
// on Stripe by product + amount. The Stripe product does not exist yet: set STRIPE_INSPECTOR_PRODUCT_ID (prod_...) on the
// server once it is created. Until then the add-on is unavailable and inspectors are capped at the free allowance.
const inspectorProduct=()=>{const v=String(process.env.STRIPE_INSPECTOR_PRODUCT_ID||'').trim();return /^prod_[A-Za-z0-9]{6,64}$/.test(v)?v:null;};
export const ADDONS = Object.freeze({
  seats:{monthlyMinor:1500,product:'prod_VFtqdzKdnd2dGe'},
  storage:{monthlyMinor:500,gb:20,product:'prod_VFtrzQiIh2m0PO'},
  inspectors:Object.freeze({monthlyMinor:500,get product(){return inspectorProduct();}})
});
// Field inspector logins: free up to twice the plan's included admin/staff seats (8 / 20 / 40), never use a seat.
export const INSPECTOR_ROLE = 'inspector';
export const FREE_INSPECTORS_PER_SEAT = 2;
export const freeInspectors = plan => (PLANS[plan]?.seats||0)*FREE_INSPECTORS_PER_SEAT;
export const inspectorAddonAvailable = () => !!ADDONS.inspectors.product;
// Only these roles use an admin/staff seat. Client and vendor logins are unlimited on every plan; field inspectors have
// their own free allowance (freeInspectors) and never use a seat.
export const SEAT_ROLES = Object.freeze(['admin','employee']);
export const UNLIMITED_ROLES = Object.freeze(['client','vendor']);
// Subscription statuses in good standing. Checkout starts every new company on a 30-day trial (status 'trialing',
// card collected, $0 first invoice), so a trial has the same access as a paid subscription.
export const GOOD_STANDING = Object.freeze(['active','trialing']);
// A completed Checkout with a trial reports payment_status 'no_payment_required' instead of 'paid'.
export const CHECKOUT_SETTLED = Object.freeze(['paid','no_payment_required']);
export const SEAT_ROLE_SQL = "role IN ('admin','employee')";
export function subscriptionQuote(plan, extraSeats=0, storagePacks=0, extraInspectors=0) {
  const p=PLANS[plan];
  extraInspectors=extraInspectors==null?0:Number(extraInspectors);
  if(!p || !Number.isSafeInteger(extraSeats) || extraSeats<0 || extraSeats>1000 || !Number.isSafeInteger(storagePacks) || storagePacks<0 || storagePacks>1000 || !Number.isSafeInteger(extraInspectors) || extraInspectors<0 || extraInspectors>1000) throw new Error('Invalid subscription selection.');
  const free=freeInspectors(plan);
  return {plan, extraSeats, storagePacks, extraInspectors, monthlyMinor:p.monthlyMinor+extraSeats*ADDONS.seats.monthlyMinor+storagePacks*ADDONS.storage.monthlyMinor+extraInspectors*ADDONS.inspectors.monthlyMinor, residences:p.residences, seats:p.seats+extraSeats, storageGB:p.storageGB+storagePacks*ADDONS.storage.gb, freeInspectors:free, inspectors:free+extraInspectors};
}
// A stored selection (paid signup or checkout attempt) is the same purchase when the plan, add-on quantities and
// price match. Allowances are deliberately ignored so a limit change never strands a checkout made before it.
export function sameSelection(a, b) {
  if(typeof a==='string')try{a=JSON.parse(a);}catch{return false;}
  if(typeof b==='string')try{b=JSON.parse(b);}catch{return false;}
  // extraInspectors arrived later (Oct 2026); a stored selection without it bought none.
  return !!a && !!b && ['plan','extraSeats','storagePacks','monthlyMinor'].every(k=>a[k]===b[k]) && (a.extraInspectors||0)===(b.extraInspectors||0);
}
