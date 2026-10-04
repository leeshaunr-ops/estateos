// Pure rules for AI inspection summaries: what we send (allow-list + redaction), what we accept back (leak scan,
// coverage check) and the summary hash used by the review gate. No I/O here; ai-summaries.mjs does the database work.
import {createHash} from 'node:crypto';
import './public/inspection-checklist.js';
const C=globalThis.EAChecklist;
export const PROMPT_VERSION='inspection-summary-v1';
export const MAX_SUMMARY=2000;
export const SCHEMA={type:'object',additionalProperties:false,required:['summary','mentioned_items'],properties:{summary:{type:'string'},mentioned_items:{type:'array',items:{type:'string'}}}};
const str=v=>v==null?'':String(v);
const clip=(s,n)=>{s=str(s).replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s;};
export const summaryHash=s=>createHash('sha256').update(str(s).replace(/\r\n/g,'\n').trim()).digest('hex');
const escapeRe=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const VISIT_LABELS={routine:'Routine home watch',storm:'Storm check',arrival:'Arrival preparation',departure:'Departure close-up',post_storm:'Post-storm check',pre_storm:'Pre-storm preparation'};
export const visitLabel=t=>VISIT_LABELS[t]||clip(str(t||'routine').replace(/[_-]+/g,' ').replace(/^./,c=>c.toUpperCase()),40);

// ---------- detectors ----------
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_RE=/\b(?:https?:\/\/|www\.)[^\s)]+/gi;
const PHONE=/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CODE_WORDS='(?:access|alarm|gate|door|lockbox|lock\\s?box|keypad|garage|entry|security|wifi|wi-fi|safe)\\s*(?:code|pin|combo|combination|password|passcode)?|code|codes|passcode|password|pin|combo|combination';
const CODE=new RegExp(`(\\b(?:${CODE_WORDS})\\b[^.\\n\\d]{0,24}?)(#?\\d{3,10}#?|(?=[A-Za-z0-9]*\\d[A-Za-z0-9]*\\d[A-Za-z0-9]*\\d)[A-Za-z0-9]{4,12})`,'gi');
const LONG_DIGITS=/\b\d{5,}\b/g;
const STREET=/\b\d{1,6}\s+(?:[A-Z0-9][A-Za-z0-9'.-]*\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Boulevard|Blvd|Place|Pl|Circle|Cir|Terrace|Ter|Trail|Trl|Highway|Hwy|Parkway|Pkwy|Square|Sq|Loop|Row|Point|Pt)\b\.?/g;
const COMMON=new Set(['the','and','for','house','home','estate','villa','residence','cottage','lodge','manor','farm','ranch','beach','lake','river','park','north','south','east','west','main','team','company','group','services','service','management','property','properties','care','watch','llc','inc','mr','mrs','ms','dr','family','client','office','staff','demo']);

/** Known sensitive strings for one company + residence: { people, places, company }. Callers pass raw rows. */
export function knownTerms({company='',people=[],places=[],addresses=[]}={}){
 const full=new Set(),parts=new Set();
 const addName=(n,kind)=>{n=clip(n,120);if(n.length<3)return;full.add(JSON.stringify([n,kind]));if(kind==='person')for(const w of n.split(/[\s,]+/))if(w.length>=3&&!COMMON.has(w.toLowerCase())&&/^[A-Z]/.test(w))parts.add(w.replace(/[.,'’]+$/,''));};
 if(company)addName(company,'company');
 for(const p of people)addName(p,'person');
 for(const p of places)addName(p,'place');
 for(const a of addresses){const s=clip(a,200);if(s.length>=5)full.add(JSON.stringify([s,'address']));const first=s.split(',')[0].trim();if(first.length>=5&&first!==s)full.add(JSON.stringify([first,'address']));}
 const list=[...full].map(j=>JSON.parse(j)).sort((a,b)=>b[0].length-a[0].length);
 return {list,parts:[...parts].sort((a,b)=>b.length-a.length)};
}
const REPLACE={company:'our team',person:'a member of the household',place:'the residence',address:'the residence'};

/** Replace contact details, codes, addresses and known names with neutral words. */
export function redact(text,terms={list:[],parts:[]}){
 let s=str(text);
 if(!s)return '';
 s=s.replace(EMAIL,'[email]').replace(URL_RE,'[link]').replace(CODE,(m,pre)=>pre+'[code]').replace(PHONE,'[phone]').replace(STREET,'[address]').replace(LONG_DIGITS,'[number]');
 for(const [term,kind] of terms.list||[])s=s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`,'gi'),REPLACE[kind]||'[removed]');
 for(const part of terms.parts||[])s=s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(part)}(?:'s|’s)?(?![A-Za-z0-9])`,'g'),'a member of the household');
 return s;
}

/** Problems with model output: a list of reasons (empty = clean). Raw known strings never appear in the reasons. */
export function leakScan(text,terms={list:[],parts:[]}){
 const s=str(text),reasons=[];
 if(new RegExp(EMAIL.source).test(s))reasons.push('email');
 if(new RegExp(URL_RE.source,'i').test(s))reasons.push('link');
 if(new RegExp(PHONE.source).test(s))reasons.push('phone');
 if(new RegExp(CODE.source,'i').test(s))reasons.push('code');
 if(new RegExp(STREET.source).test(s))reasons.push('address');
 for(const [term,kind] of terms.list||[])if(new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`,'i').test(s)){reasons.push(kind);break;}
 for(const part of terms.parts||[])if(new RegExp(`(?<![A-Za-z0-9])${escapeRe(part)}(?![A-Za-z0-9])`).test(s)){reasons.push('person');break;}
 if(/\[(?:email|link|phone|code|address|number|removed)\]/i.test(s))reasons.push('placeholder');
 return [...new Set(reasons)];
}

/** Items the family must hear about: built-in fail/attention/monitor, template fail/monitor/"no". */
export function flaggedItems(answers){
 return (answers||[]).filter(a=>['fail','monitor'].includes(C.tone(a)));
}

/** The allow-listed visit data sent to the model, plus the flagged items (original + redacted labels) for checks. */
export function buildInput({inspection,answers,weatherLine='',timezoneLabel='',terms}){
 const items=[],flagged=[];
 let checked=0;
 for(const a of answers||[]){
  const tone=C.tone(a);if(tone==='open')continue;checked++;
  const label=clip(redact(a.label,terms),140),section=clip(redact(a.section||a.room_name||'',terms),80),note=clip(redact(a.note,terms),400);
  const item={section,label,result:C.displayValue(a),tone};
  if(note)item.note=note;
  items.push(item);
  if(tone==='fail'||tone==='monitor')flagged.push({label:clip(a.label,140),sent:label,note});
 }
 const counts={};for(const it of items)counts[it.tone]=(counts[it.tone]||0)+1;
 const overall=flagged.some(f=>items.find(i=>i.label===f.sent)?.tone==='fail')?'Needs attention':flagged.length?'Items to watch':'All clear';
 const input={visit_type:visitLabel(inspection.visit_type),visit_date:str(inspection.inspection_date).slice(0,10),time_zone:clip(timezoneLabel,40),overall,counts,
  items:items.length>80?[...items.filter(i=>i.tone!=='pass'),...items.filter(i=>i.tone==='pass').slice(0,Math.max(0,80-items.filter(i=>i.tone!=='pass').length))]:items,
  notes_to_client:clip(redact(inspection.notes,terms),1200)};
 const wl=clip(redact(weatherLine,terms),200);if(wl)input.weather_at_visit=wl;
 return {input,flagged,checked};
}

const norm=s=>str(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const STOP=new Set(['the','and','for','with','from','every','each','all','any','check','checked','inspect','inspected','test','tested','run','verify','area','areas','room','rooms','item','items','that','this','into','under','over','around','near','minutes','min','condition','working','ensure','look']);
const keywords=s=>norm(s).split(' ').filter(w=>w.length>=4&&!STOP.has(w));

/** Which flagged items the draft fails to mention (model claim AND a text check must agree). */
export function coverage(text,mentioned,flagged){
 const t=norm(text),claims=new Set((mentioned||[]).map(norm));
 const words=new Set(t.split(' '));
 const stem=w=>w.replace(/(ing|ed|es|s)$/,'');
 const stems=new Set([...words].map(stem));
 return flagged.filter(f=>{
  const claimed=claims.has(norm(f.sent))||claims.has(norm(f.label));
  const kws=[...keywords(f.sent),...keywords(f.note).slice(0,6)];
  const inText=!kws.length||kws.some(k=>words.has(k)||stems.has(stem(k)));
  return !(claimed&&inText);
 }).map(f=>f.label);
}

/** Validate a parsed model answer. Returns {summary, mentioned} or throws Error with code 'malformed'. */
export function parseAnswer(obj){
 if(!obj||typeof obj!=='object'||typeof obj.summary!=='string'||!Array.isArray(obj.mentioned_items))throw Object.assign(new Error('Malformed answer'),{code:'malformed'});
 const summary=obj.summary.replace(/\r\n/g,'\n').trim();
 if(!summary)throw Object.assign(new Error('Empty answer'),{code:'malformed'});
 return {summary:summary.slice(0,MAX_SUMMARY),mentioned:obj.mentioned_items.filter(x=>typeof x==='string').slice(0,100).map(x=>clip(x,140))};
}
