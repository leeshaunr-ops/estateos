// Visit history certificate: a branded PDF a family or the company can send to an insurance broker. It lists the
// published visits in the period with dates and times in the residence's time zone, whether each visit was GPS
// verified at the residence, and a findings summary. It is not an adjuster's assessment and says so on every page.
import {Doc, C, BG, BOTTOM, wrap} from './storm-pdf.mjs';
import {reportTimestamp} from './pdf.mjs';

export const CERTIFICATE_DISCLAIMER = company => `This certificate lists visits recorded in EstateAegis by ${company || 'the residence care company'}. It documents that the visits took place and what was observed; it is not an insurance adjuster's assessment, an inspection under any policy, or a guarantee of condition or coverage.`;

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function footer(doc, c) {
 return (index, total) => {
  doc.rect(40, 724, 532, 1, C.line);
  wrap(c.disclaimer, 470, 7).slice(0, 3).forEach((line, i) => doc.text(line, 40, 731 + i * 9, 7, C.muted));
  doc.text(`Page ${index + 1} of ${total}`, 520, 731, 8, C.muted);
  doc.text(`Certificate ${c.reference} \u00b7 prepared ${reportTimestamp(c.preparedAt, c.timezone)}`, 40, 761, 6, C.muted);
 };
}

/**
 * c: {company, companyLogo, timezone, preparedAt, fromLabel, toLabel, reference, residence:{name,address}, policyholder,
 *     policy:{carrier,number,renewal,rule}, status:{label,code,reason}, devices:[{label,required,discount,installed,proof}],
 *     visits:[{dateLabel,type,inspector,arrived,departed,verified,verification,findings:{pass,monitor,attention},summary,reportNumber}],
 *     verifiedCount, longestGap, disclaimer}
 */
export function certificatePdf(c) {
 const doc = new Doc({company: c.company, companyLogo: c.companyLogo, label: 'VISIT HISTORY CERTIFICATE'});
 doc.paragraph('Visit history certificate', {size: 21, strong: true, gap: 6});
 doc.paragraph(c.residence.name, {size: 13, color: C.muted, gap: 5}); doc.y += 8;
 doc.facts([
  ['Residence', c.residence.name], ['Address', c.residence.address || 'Address not entered'], ['Policyholder', c.policyholder || 'Not recorded'],
  ['Carrier', c.policy.carrier || 'Not recorded'], ['Policy number', c.policy.number || 'Not recorded'], ['Renewal date', c.policy.renewal || 'Not recorded'],
  ['Unoccupancy rule', c.policy.rule], ['Period', `${c.fromLabel} to ${c.toLabel}`], ['Prepared', reportTimestamp(c.preparedAt, c.timezone)]
 ]);
 // Summary cards. The words carry the meaning; colour only supports it.
 doc.y += 6; doc.need(66);
 const tone = {ok: 'pass', due_soon: 'monitor', at_risk: 'monitor', breached: 'attention'}[c.status.code] || 'na';
 [['VISITS IN PERIOD', String(c.visits.length), 'na'], ['GPS VERIFIED', `${c.verifiedCount} of ${c.visits.length}`, c.visits.length && c.verifiedCount === c.visits.length ? 'pass' : 'na'], ['LONGEST GAP', c.longestGap === null ? '\u2014' : plural(c.longestGap, 'day'), 'na'], ['CURRENT STATUS', c.status.label, tone]].forEach(([title, value, style], i) => {
  const x = 40 + i * 135; doc.rect(x, doc.y, 127, 54, BG[style] || BG.panel); doc.rect(x, doc.y, 127, 3, C[style] || C.muted);
  doc.text(title, x + 10, doc.y + 11, 7.5, C.muted, true); wrap(value, 110, 13, true).slice(0, 2).forEach((l, k) => doc.text(l, x + 10, doc.y + 25 + k * 15, 13, style === 'na' ? C.ink : C[style], true));
 });
 doc.y += 66;
 if (c.status.reason) doc.paragraph(`Current status: ${c.status.label}. ${c.status.reason}`, {size: 9, color: C.muted});
 if (c.devices.length) {
  doc.heading('Protective devices', 90);
  for (const d of c.devices) {
   const tags = [d.required ? 'Required by the policy' : '', d.discount ? 'Qualifies for a discount' : '', d.installed ? 'Installed' : 'Not confirmed installed', d.proof ? 'Photo or document on file' : ''].filter(Boolean).join(' \u00b7 ');
   doc.need(30); doc.text(d.label, 40, doc.y, 10, C.ink, true); doc.y += 14; doc.paragraph(tags, {size: 9, color: C.muted, gap: 4}); doc.y += 4;
  }
 }
 // Visits table: Date | Visit and inspector | On site | Verification | Findings
 doc.heading('Visits', 120);
 doc.paragraph(`Published visits from ${c.fromLabel} to ${c.toLabel}. Times are in the residence time zone (${c.timezone}).`, {size: 9, color: C.muted}); doc.y += 2;
 const cols = [['Date', 40, 70], ['Visit', 112, 128], ['On site', 244, 106], ['Verification', 354, 112], ['Findings', 470, 102]];
 const header = () => { doc.rect(40, doc.y, 532, 18, BG.head); cols.forEach(([t, x]) => doc.text(t, x + 3, doc.y + 5, 8, C.muted, true)); doc.y += 22; };
 if (!c.visits.length) doc.paragraph('No published visits in this period.', {color: C.muted});
 else header();
 for (const v of c.visits) {
  const f = v.findings, findings = [f.pass ? `${f.pass} passed` : '', f.monitor ? `${f.monitor} to monitor` : '', f.attention ? `${f.attention} needing attention` : ''].filter(Boolean).join(', ') || 'No checklist items';
  const cells = [wrap(v.dateLabel, cols[0][2], 9, true), [...wrap(v.type, cols[1][2], 8), ...wrap(v.inspector, cols[1][2], 8)], wrap(v.arrived ? `${v.arrived}${v.departed ? ' to ' + v.departed : ''}` : 'Not checked in', cols[2][2], 8), wrap(v.verification, cols[3][2], 8), wrap(findings, cols[4][2], 8)];
  const h = Math.max(1, ...cells.map(l => l.length)) * 11 + 8;
  if (doc.y + h > BOTTOM) { doc.newPage(); header(); }
  if (v.verified) doc.rect(40, doc.y - 3, 2.5, h - 4, C.pass);
  cells.forEach((lines, i) => lines.forEach((l, k) => doc.text(l, cols[i][1] + 3, doc.y + k * 11, i === 0 ? 9 : 8, i === 3 && v.verified ? C.pass : i === 0 ? C.ink : C.muted, i === 0 || (i === 3 && v.verified && k === 0))));
  doc.y += h; doc.rect(40, doc.y - 4, 532, .6, C.line);
 }
 // Findings summary: totals, then each visit's summary as written for the family (internal notes never appear).
 const total = c.visits.reduce((t, v) => ({pass: t.pass + v.findings.pass, monitor: t.monitor + v.findings.monitor, attention: t.attention + v.findings.attention}), {pass: 0, monitor: 0, attention: 0});
 doc.heading('Findings summary', 90);
 doc.paragraph(c.visits.length ? `Across ${plural(c.visits.length, 'visit')}: ${plural(total.pass, 'item')} passed, ${total.monitor} to monitor, ${total.attention} needing attention.` : 'No findings to summarize.', {size: 10});
 doc.y += 4;
 for (const v of c.visits.filter(v => v.summary).slice(0, 24)) { doc.need(32); doc.text(`${v.dateLabel}${v.reportNumber ? ' \u00b7 ' + v.reportNumber : ''}`, 40, doc.y, 9, C.muted, true); doc.y += 13; doc.paragraph(v.summary, {size: 9, gap: 4}); doc.y += 4; }
 // The disclaimer, in full, at the end (and in the footer of every page).
 doc.need(70); doc.y += 8;
 const lines = wrap(c.disclaimer, 500, 9), h = lines.length * 12 + 26;
 doc.rect(40, doc.y, 532, h, BG.panel); doc.rect(40, doc.y, 4, h, C.gold);
 doc.text('IMPORTANT', 54, doc.y + 9, 8, C.brand, true); lines.forEach((l, i) => doc.text(l, 54, doc.y + 22 + i * 12, 9, C.ink)); doc.y += h + 6;
 return doc.finish(footer(doc, c));
}
