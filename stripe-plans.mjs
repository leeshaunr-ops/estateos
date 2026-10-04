export const PLANS = Object.freeze({
  essentials: {name:'Essentials', monthlyMinor:5900, residences:50, seats:2, storageGB:10, product:'prod_VFtm9ebEAmXkPc'},
  growth: {name:'Growth', monthlyMinor:10900, residences:150, seats:5, storageGB:30, product:'prod_VFtn294ZmM6pd4'},
  professional: {name:'Professional', monthlyMinor:17900, residences:300, seats:10, storageGB:50, product:'prod_VFtoQSXsffoRnV'}
});
export const ADDONS = Object.freeze({
  seats:{monthlyMinor:1500,product:'prod_VFtqdzKdnd2dGe'},
  storage:{monthlyMinor:500,product:'prod_VFtrzQiIh2m0PO'}
});
// Subscription statuses in good standing. Checkout starts every new company on a 30-day trial (status 'trialing',
// card collected, $0 first invoice), so a trial has the same access as a paid subscription.
export const GOOD_STANDING = Object.freeze(['active','trialing']);
// A completed Checkout with a trial reports payment_status 'no_payment_required' instead of 'paid'.
export const CHECKOUT_SETTLED = Object.freeze(['paid','no_payment_required']);
export function subscriptionQuote(plan, extraSeats=0, storagePacks=0) {
  const p=PLANS[plan];
  if(!p || !Number.isSafeInteger(extraSeats) || extraSeats<0 || extraSeats>1000 || !Number.isSafeInteger(storagePacks) || storagePacks<0 || storagePacks>1000) throw new Error('Invalid subscription selection.');
  return {plan, extraSeats, storagePacks, monthlyMinor:p.monthlyMinor+extraSeats*1500+storagePacks*500, residences:p.residences, seats:p.seats+extraSeats, storageGB:p.storageGB+storagePacks*20};
}
