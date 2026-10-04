// Plan catalog: the single source of truth for prices and allowances. Allowances are derived from the plan key at
// read time (stripe_billing stores only plan + add-on quantities), so changing a limit here applies to every existing
// subscriber on the next request. Stripe holds only products and prices; no limits are read from Stripe metadata.
export const PLANS = Object.freeze({
  essentials: {name:'Essentials', monthlyMinor:5900, regularMinor:7900, residences:50, seats:4, storageGB:10, product:'prod_VFtm9ebEAmXkPc'},
  growth: {name:'Growth', monthlyMinor:10900, regularMinor:12900, residences:150, seats:10, storageGB:30, product:'prod_VFtn294ZmM6pd4'},
  professional: {name:'Professional', monthlyMinor:17900, regularMinor:19900, residences:300, seats:20, storageGB:50, product:'prod_VFtoQSXsffoRnV'}
});
export const ADDONS = Object.freeze({
  seats:{monthlyMinor:1500,product:'prod_VFtqdzKdnd2dGe'},
  storage:{monthlyMinor:500,gb:20,product:'prod_VFtrzQiIh2m0PO'}
});
// Only these roles use an admin/staff seat. Client and vendor logins are unlimited on every plan.
export const SEAT_ROLES = Object.freeze(['admin','employee']);
export const UNLIMITED_ROLES = Object.freeze(['client','vendor']);
export const SEAT_ROLE_SQL = "role IN ('admin','employee')";
export function subscriptionQuote(plan, extraSeats=0, storagePacks=0) {
  const p=PLANS[plan];
  if(!p || !Number.isSafeInteger(extraSeats) || extraSeats<0 || extraSeats>1000 || !Number.isSafeInteger(storagePacks) || storagePacks<0 || storagePacks>1000) throw new Error('Invalid subscription selection.');
  return {plan, extraSeats, storagePacks, monthlyMinor:p.monthlyMinor+extraSeats*ADDONS.seats.monthlyMinor+storagePacks*ADDONS.storage.monthlyMinor, residences:p.residences, seats:p.seats+extraSeats, storageGB:p.storageGB+storagePacks*ADDONS.storage.gb};
}
// A stored selection (paid signup or checkout attempt) is the same purchase when the plan, add-on quantities and
// price match. Allowances are deliberately ignored so a limit change never strands a checkout made before it.
export function sameSelection(a, b) {
  if(typeof a==='string')try{a=JSON.parse(a);}catch{return false;}
  if(typeof b==='string')try{b=JSON.parse(b);}catch{return false;}
  return !!a && !!b && ['plan','extraSeats','storagePacks','monthlyMinor'].every(k=>a[k]===b[k]);
}
