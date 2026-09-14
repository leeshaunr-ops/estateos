export const PLANS = Object.freeze({
  essentials: {name:'Essentials', monthlyMinor:5900, residences:50, seats:2, storageGB:10, product:'prod_VFtm9ebEAmXkPc'},
  growth: {name:'Growth', monthlyMinor:10900, residences:150, seats:5, storageGB:30, product:'prod_VFtn294ZmM6pd4'},
  professional: {name:'Professional', monthlyMinor:17900, residences:300, seats:10, storageGB:50, product:'prod_VFtoQSXsffoRnV'}
});
export const ADDONS = Object.freeze({
  seats:{monthlyMinor:1500,product:'prod_VFtqdzKdnd2dGe'},
  storage:{monthlyMinor:500,product:'prod_VFtrzQiIh2m0PO'}
});
export function subscriptionQuote(plan, extraSeats=0, storagePacks=0) {
  const p=PLANS[plan];
  if(!p || !Number.isSafeInteger(extraSeats) || extraSeats<0 || extraSeats>1000 || !Number.isSafeInteger(storagePacks) || storagePacks<0 || storagePacks>1000) throw new Error('Invalid subscription selection.');
  return {plan, extraSeats, storagePacks, monthlyMinor:p.monthlyMinor+extraSeats*1500+storagePacks*500, residences:p.residences, seats:p.seats+extraSeats, storageGB:p.storageGB+storagePacks*20};
}
