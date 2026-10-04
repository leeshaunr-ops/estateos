// Storm PDFs: the per-residence insurance-claim-ready storm report and the admin storm summary.
// Same look as pdf.mjs (Helvetica, WinAnsi, wine/gold header) but a separate writer, so the legacy inspection PDF
// stays byte-for-byte unchanged. Only published storm visits reach these reports; internal notes never do.
import {decodeLogoPng} from './png-logo.mjs';
import {deflateSync} from 'node:zlib';
import {jpegSize,reportTimestamp,photoTakenAt,templateAnswerPdf} from './pdf.mjs';
import './public/inspection-checklist.js';
import './public/storm-core.js';
const EAChecklist=globalThis.EAChecklist, S=globalThis.EAStorm;
const C={ink:[.122,.161,.2],muted:[.373,.42,.463],brand:[.545,.141,.169],gold:[.722,.6,.376],line:[.886,.906,.922],white:[1,1,1],pass:[.12,.38,.29],monitor:[.57,.36,.02],attention:[.66,.12,.15],na:[.373,.42,.463],unchecked:[.373,.42,.463]};
const BG={pass:[.92,.96,.93],monitor:[1,.95,.72],attention:[1,.88,.88],na:[.95,.95,.94],unchecked:[.95,.95,.94],panel:[.985,.98,.97],head:[.97,.96,.93]};
const TONE_STYLE={done:'pass',issue:'attention',open:'na',progress:'monitor',muted:'na'};
const VISIT_STYLE={pass:'pass',monitor:'monitor',fail:'attention',open:'na'};
const BOTTOM=716;
export const disclaimer=company=>`Prepared by ${company||'your residence care team'} using EstateAegis. This report documents observations made during scheduled visits; it is not an insurance adjuster's assessment or a guarantee of condition.`;
// WinAnsi keeps the em dash (0x97) and en dash (0x96); anything else outside Latin-1 becomes "?".
export function clean(s){return String(s??'').replace(/[\u202f\u00a0\u2009]/g,' ').replace(/\u2014/g,'\x97').replace(/\u2013/g,'\x96').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\u2026/g,'...').replace(/\u2022/g,'\x95').replace(/[^\x20-\xff\n]/g,'?');}
const escape=s=>clean(s).replace(/([\\()])/g,'\\$1').replace(/[\r\n]/g,' ');
export function wrap(s,width,size=10,boldFace=false){const max=Math.max(8,Math.floor(width/(size*(boldFace?.6:.55))));return clean(s).split('\n').flatMap(line=>{const out=[];let cur='';for(let word of line.split(/\s+/)){while(word.length>max){if(cur){out.push(cur);cur='';}out.push(word.slice(0,max));word=word.slice(max);}if((cur+' '+word).trim().length>max){out.push(cur);cur=word;}else cur=(cur+' '+word).trim();}out.push(cur);return out;});}

class Doc{
 constructor({company,companyLogo,label}){
  this.objects=[];this.company=company||'Residence care';this.label=label;this.pages=[];this.images=new Map();
  this.catalog=this.add('');this.root=this.add('');
  this.regular=this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  this.bold=this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  this.logo=this.loadLogo(companyLogo);this.newPage();
 }
 add(o){this.objects.push(o);return this.objects.length;}
 stream(header,bytes){return this.add(Buffer.concat([Buffer.from(header+'\nstream\n'),bytes,Buffer.from('\nendstream')]));}
 loadLogo(data){
  if(!data)return null;
  try{const bytes=Buffer.from(String(data).split(',')[1],'base64');
   if(String(data).startsWith('data:image/png;')){const d=decodeLogoPng(bytes),alpha=deflateSync(d.alpha),rgb=deflateSync(d.rgb);const mask=this.stream(`<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alpha.length} >>`,alpha);return {...d,id:this.stream(`<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${mask} 0 R /Filter /FlateDecode /Length ${rgb.length} >>`,rgb)};}
   const d=jpegSize(bytes);return {...d,id:this.stream(`<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /${d.channels===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`,bytes)};
  }catch{return null;}
 }
 rect(x,top,w,h,c){this.page.stream+=`q ${c.join(' ')} rg ${x} ${792-top-h} ${w} ${h} re f Q\n`;}
 text(s,x,top,size=10,color=C.ink,strong=false){this.page.stream+=`BT /${strong?'F2':'F1'} ${size} Tf ${color.join(' ')} rg 1 0 0 1 ${x} ${792-top-size} Tm (${escape(s)}) Tj ET\n`;}
 newPage(){
  this.page={stream:'',images:[]};this.pages.push(this.page);const logo=this.logo;let x=logo?164:40;
  const title=wrap(this.company,572-x,19,true),labelTop=32+(Math.min(title.length,2)-1)*23,bottom=Math.max(labelTop+20,logo?64:0);
  this.rect(0,0,612,bottom,BG.head);
  if(logo){const sc=Math.min(100/logo.width,44/logo.height),w=logo.width*sc,h=logo.height*sc;this.page.images.push(['Logo',logo.id]);this.page.stream+=`q ${w} 0 0 ${h} ${44+(100-w)/2} ${792-13-h} cm /Logo Do Q\n`;}
  title.slice(0,2).forEach((line,i)=>this.text(line,x,7+i*23,19,C.brand,true));
  this.text(this.label,x,labelTop,8,C.muted,true);this.rect(40,bottom+12,532,2,C.gold);this.y=bottom+30;
 }
 need(h){if(this.y+h>BOTTOM)this.newPage();}
 paragraph(value,{size=10,color=C.ink,width=520,x=40,strong=false,gap=5}={}){for(const line of wrap(value,width,size,strong)){this.need(size+gap);this.text(line,x,this.y,size,color,strong);this.y+=size+gap;}}
 heading(title,keep=70){this.need(keep);this.y+=12;this.text(title,40,this.y,14,C.brand,true);this.y+=19;this.rect(40,this.y,532,1,C.line);this.y+=10;}
 pill(label,right,top,style){const t=clean(label).toUpperCase(),w=Math.max(46,t.length*5.4+16);this.rect(right-w,top,w,16,BG[style]||BG.na);this.text(t,right-w+8,top+4,7.5,C[style]||C.muted,true);return w;}
 facts(rows,{labelWidth=122,width=410}={}){for(const [label,value] of rows){const l=wrap(value||'Not recorded',width,10);this.need(l.length*14+6);this.text(label,40,this.y,9,C.muted,true);for(const line of l){this.text(line,40+labelWidth,this.y,10);this.y+=14;}this.y+=5;}}
 /** A JPEG as an image object, embedded once and reused (the before/after section repeats photos). Null when not a JPEG. */
 image(key,bytes){if(this.images.has(key))return this.images.get(key);let out=null;try{const d=jpegSize(bytes);out={...d,id:this.stream(`<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /${d.channels===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`,bytes)};}catch{}this.images.set(key,out);return out;}
 draw(img,x,top,w,h){const name='Im'+img.id;if(!this.page.images.some(([n])=>n===name))this.page.images.push([name,img.id]);this.page.stream+=`q ${w} 0 0 ${h} ${x} ${792-top-h} cm /${name} Do Q\n`;}
 finish(footer){
  const ids=[];
  this.pages.forEach((page,index)=>{this.page=page;footer(index,this.pages.length);const bytes=Buffer.from(page.stream,'latin1'),content=this.stream(`<< /Length ${bytes.length} >>`,bytes);ids.push(this.add(`<< /Type /Page /Parent ${this.root} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${this.regular} 0 R /F2 ${this.bold} 0 R >> /XObject << ${page.images.map(([n,i])=>`/${n} ${i} 0 R`).join(' ')} >> >> /Contents ${content} 0 R >>`));});
  this.objects[this.catalog-1]=`<< /Type /Catalog /Pages ${this.root} 0 R >>`;this.objects[this.root-1]=`<< /Type /Pages /Count ${ids.length} /Kids [${ids.map(i=>i+' 0 R').join(' ')}] >>`;
  const parts=[Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n','latin1')],offsets=[];let size=parts[0].length;
  for(const [i,obj] of this.objects.entries()){offsets.push(size);const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),Buffer.isBuffer(obj)?obj:Buffer.from(obj,'latin1'),Buffer.from('\nendobj\n')]);parts.push(chunk);size+=chunk.length;}
  parts.push(Buffer.from(`xref\n0 ${this.objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${this.objects.length+1} /Root ${this.catalog} 0 R >>\nstartxref\n${size}\n%%EOF`));
  return Buffer.concat(parts);
 }
}
function footerWith(doc,company,reference){return (index,total)=>{doc.rect(40,724,532,1,C.line);wrap(disclaimer(company),470,7).slice(0,3).forEach((line,i)=>doc.text(line,40,731+i*9,7,C.muted));doc.text(`Page ${index+1} of ${total}`,520,731,8,C.muted);if(reference)doc.text(reference,40,761,6,C.muted);};}

/** Visit verification box (arrival/departure, GPS check) as on the inspection PDF. */
function verificationBox(doc,v){
 if(!v)return;const style=VISIT_STYLE[v.tone]||'na',rows=(v.rows||[]).map(([l,val])=>[l,wrap(val,372,10)]),notes=(v.notes||[]).flatMap(n=>wrap(n,500,9));
 const h=38+rows.reduce((n,[,l])=>n+l.length*14+4,0)+notes.length*13;doc.need(h+10);
 doc.rect(40,doc.y,532,h,BG.panel);doc.rect(40,doc.y,4,h,C.brand);doc.text('VISIT VERIFICATION',54,doc.y+11,9,C.brand,true);doc.pill(v.label||'',560,doc.y+8,style);
 let top=doc.y+32;for(const [l,lines] of rows){doc.text(l,54,top,9,C.muted,true);for(const line of lines){doc.text(line,170,top,10);top+=14;}top+=4;}for(const n of notes){doc.text(n,54,top,9,C.muted);top+=13;}doc.y+=h+10;
}
/** One checklist answer as a compact row: label (and note / answer) with the result pill on the right. */
function answerRow(doc,a){
 const t=EAChecklist.isTemplateAnswer(a)?templateAnswerPdf(a):{style:a.status==='attention'?'attention':a.status==='pass'?'pass':a.status==='monitor'?'monitor':'na',pill:({pass:'PASS',monitor:'MONITOR',attention:'ATTENTION',na:'N/A',unchecked:'NOT ASSESSED'})[a.status]||String(a.status||'').toUpperCase(),value:''};
 const label=wrap(a.label,400,10,true),extra=[...(t.value?wrap('Answer: '+t.value,480,9):[]),...(a.note?wrap('Note: '+a.note,480,9):[])];
 const h=10+label.length*13+extra.length*12+4;doc.need(h+4);
 doc.rect(40,doc.y,532,h,BG[t.style]||BG.na);doc.rect(40,doc.y,3,h,C[t.style]||C.muted);doc.pill(t.pill,566,doc.y+5,t.style);
 let top=doc.y+6;for(const l of label){doc.text(l,52,top,10,C.ink,true);top+=13;}for(const l of extra){doc.text(l,52,top,9,C.muted);top+=12;}doc.y+=h+4;
}
function answerList(doc,answers){let section='';for(const a of answers||[]){if(a.section&&a.section!==section){section=a.section;doc.need(40);doc.y+=4;doc.text(section,40,doc.y,10,C.brand,true);doc.y+=16;}answerRow(doc,a);}}
/** Photos two per row with "Taken ..." captions. */
function photoGrid(doc,ids,photos,{prefix='PHOTO'}={}){
 const list=(ids||[]).map(id=>photos.get(id)).filter(Boolean);if(!list.length){doc.paragraph('No photos were attached to this visit.',{size:9,color:C.muted});return;}
 for(let i=0;i<list.length;i+=2){
  const row=list.slice(i,i+2).map((p,j)=>{const img=doc.image(p.id,p.bytes),w=img?Math.min(258,258*Math.min(1,img.width/img.height*194/258)):258,h=img?Math.min(194,w*img.height/img.width):30;const cap=[`${prefix} ${i+j+1}${p.name?' \u2014 '+p.name:''}`,...(photoTakenAt(p)?[photoTakenAt(p)]:[]),...(img?[]:['Photo not shown in the PDF (not a JPEG image).'])].flatMap(c=>wrap(c,258,8));return {p,img,w,h,cap};});
  const height=Math.max(...row.map(r=>r.h+r.cap.length*10+14));doc.need(height);
  row.forEach((r,j)=>{const x=40+j*274;if(r.img)doc.draw(r.img,x,doc.y,r.w,r.h);else doc.rect(x,doc.y,258,r.h,BG.na);let top=doc.y+r.h+5;r.cap.forEach((c,k)=>{doc.text(c,x,top,8,k===0?C.ink:C.muted,k===0);top+=10;});});
  doc.y+=height;
 }
}
function visitMeta(v,tz){return [['Visit date',v.dateLabel||v.date||'Not recorded'],['Completed',reportTimestamp(v.completedAt,tz)],['Inspected by',v.inspector||'Not recorded'],['Checklist',v.checklistName||'Standard checklist'],[v.reportNumber?'Report number':'Report reference',v.reportNumber||v.id||'Not recorded']];}

/**
 * The insurance-claim-ready storm report for one residence.
 * r: {company, companyLogo, timezone, preparedAt, event:{name,typeLabel,expectedImpactAt,prepDeadlineAt}, residence:{name,address},
 *     family, prepLabel, prepTone, postLabel, postTone, severity, pre, post, pairs:[{beforeId,afterId,match}], workOrders:[{title,status,vendor}]}
 * pre/post (published storm visits only): {id, date, dateLabel, completedAt, inspector, reportNumber, checklistName, summary, notes, answers, verification, photoIds}
 * photos: Map(fileId -> {id, name, bytes, capturedAt, timezone, atResidence})
 */
export function stormReportPdf(r,photos=new Map()){
 const tz=r.timezone||'America/New_York',doc=new Doc({company:r.company,companyLogo:r.companyLogo,label:'STORM REPORT'});
 doc.paragraph(`Storm Report \u2014 ${r.event.name}`,{size:21,strong:true,gap:6});
 doc.paragraph(r.residence.name,{size:13,color:C.muted,gap:5});doc.y+=8;
 doc.facts([['Residence',r.residence.name],['Address',r.residence.address||'Address not entered'],['Family',r.family||'Not specified'],['Storm',`${r.event.name} (${r.event.typeLabel})`],['Prepared',reportTimestamp(r.preparedAt,tz)]]);
 // Status cards: prep, post, damage severity. Text labels carry the meaning (never colour alone).
 doc.y+=6;doc.need(66);
 [['PRE-STORM PREP',r.prepLabel,TONE_STYLE[r.prepTone]||'na'],['POST-STORM CHECK',r.postLabel,TONE_STYLE[r.postTone]||'na'],['DAMAGE SEVERITY',r.severity||'Not assessed',r.severity&&!['None','Not assessed'].includes(r.severity)?'attention':r.severity==='None'?'pass':'na']].forEach(([title,value,style],i)=>{const x=40+i*180;doc.rect(x,doc.y,172,56,BG[style]||BG.na);doc.rect(x,doc.y,172,3,C[style]||C.muted);doc.text(title,x+12,doc.y+12,8,C.muted,true);wrap(value,150,13,true).slice(0,2).forEach((l,k)=>doc.text(l,x+12,doc.y+26+k*15,13,C[style]||C.ink,true));});doc.y+=70;
 // Timeline in the residence time zone.
 const events=[[r.event.prepDeadlineAt,'Preparation deadline'],[r.pre?.completedAt,`Pre-storm visit completed by ${r.pre?.inspector||'the team'}`],[r.event.expectedImpactAt,`Expected ${r.event.typeLabel.toLowerCase()} impact`],[r.post?.completedAt,`Post-storm visit completed by ${r.post?.inspector||'the team'}`]].filter(([at])=>at).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 doc.heading('Timeline');
 if(!events.length)doc.paragraph('No storm visits have been published for this residence yet.',{size:10,color:C.muted});
 for(const [at,what] of events){const l=wrap(what,330,10);doc.need(l.length*14+6);doc.rect(44,doc.y+3,6,6,C.brand);doc.text(reportTimestamp(at,tz),58,doc.y,10,C.ink,true);l.forEach((line,k)=>doc.text(line,240,doc.y+k*14,10));doc.y+=l.length*14+6;}
 doc.y+=4;doc.paragraph(`Times are shown in the residence time zone (${tz}).`,{size:8,color:C.muted});
 // Pre-storm condition.
 doc.heading('Pre-storm condition');
 if(!r.pre)doc.paragraph('No published pre-storm visit for this storm.',{color:C.muted});
 else{doc.facts(visitMeta(r.pre,tz));verificationBox(doc,r.pre.verification);if(r.pre.summary){doc.need(30);doc.text('Inspector summary',40,doc.y,9,C.muted,true);doc.y+=14;doc.paragraph(r.pre.summary);}doc.y+=6;answerList(doc,r.pre.answers);doc.y+=8;doc.need((r.pre.photoIds||[]).length?250:40);doc.text('Pre-storm photos',40,doc.y,11,C.brand,true);doc.y+=18;photoGrid(doc,r.pre.photoIds,photos,{prefix:'PRE'});}
 // Post-storm findings.
 doc.heading('Post-storm findings');
 if(!r.post)doc.paragraph('No published post-storm visit for this storm yet.',{color:C.muted});
 else{
  doc.facts([...visitMeta(r.post,tz),['Damage severity',r.severity||'Not assessed']]);verificationBox(doc,r.post.verification);
  if(r.post.summary){doc.need(30);doc.text('Inspector summary',40,doc.y,9,C.muted,true);doc.y+=14;doc.paragraph(r.post.summary);}
  const found=S.findings(r.post.answers),written=(r.post.answers||[]).filter(a=>a.response_type==='text'&&a.status&&a.status!=='unchecked'&&String(a.status).trim());
  doc.y+=6;doc.need(40);doc.text('Damage and items to watch',40,doc.y,11,C.brand,true);doc.y+=18;
  if(found.length)answerList(doc,found);else doc.paragraph('No damage was recorded on the post-storm checklist.',{color:C.pass});
  if(written.length){doc.y+=6;doc.need(40);doc.text('Damage notes recorded on the visit',40,doc.y,11,C.brand,true);doc.y+=18;for(const a of written){doc.need(30);doc.text(a.label,40,doc.y,9,C.muted,true);doc.y+=14;doc.paragraph(a.status);doc.y+=4;}}
  doc.y+=8;doc.need((r.post.photoIds||[]).length?250:40);doc.text('Post-storm photos',40,doc.y,11,C.brand,true);doc.y+=18;photoGrid(doc,r.post.photoIds,photos,{prefix:'POST'});
 }
 // Before and after.
 const pairs=(r.pairs||[]).filter(p=>p.beforeId&&p.afterId);
 if(pairs.length){
  doc.heading('Before and after',260);
  doc.paragraph('Photos are paired by photo spot (the same angle photographed before and after the storm), then by checklist item or by the same photo name. Photos without a match are shown side by side in the order they were taken.',{size:9,color:C.muted});doc.y+=4;
  const how={item:'Same checklist item',name:'Same photo name',order:'Shown in the order taken'};
  for(const pair of pairs){
   const sides=[['BEFORE (PRE-STORM)',photos.get(pair.beforeId)],['AFTER (POST-STORM)',photos.get(pair.afterId)]].map(([title,p])=>{const img=p?doc.image(p.id,p.bytes):null,w=img?Math.min(258,258*Math.min(1,img.width/img.height*180/258)):258,h=img?Math.min(180,w*img.height/img.width):30;return {title,p,img,w,h,cap:[...(p?.name?wrap(p.name,258,8):[]),...(p&&photoTakenAt(p)?wrap(photoTakenAt(p),258,8):[])]};});
   const height=16+Math.max(...sides.map(s=>s.h+s.cap.length*10))+22;doc.need(height);
   doc.text(pair.match==='spot'?clean('Same photo spot'+(pair.spot?': '+pair.spot:'')).slice(0,90):how[pair.match]||how.order,40,doc.y,8,C.muted,true);doc.y+=13;
   sides.forEach((s,j)=>{const x=40+j*274;doc.text(s.title,x,doc.y,8,C.brand,true);if(s.img)doc.draw(s.img,x,doc.y+12,s.w,s.h);else doc.rect(x,doc.y+12,258,s.h,BG.na);let top=doc.y+16+s.h;s.cap.forEach(c=>{doc.text(c,x,top,8,C.muted);top+=10;});});
   doc.y+=height-13;
  }
 }
 // Repair work orders linked to this storm.
 doc.heading('Repair work orders');
 if(!(r.workOrders||[]).length)doc.paragraph('No repair work orders are linked to this storm for this residence.',{color:C.muted});
 for(const w of r.workOrders||[]){const l=wrap(w.title,330,10,true);doc.need(l.length*14+20);l.forEach((line,k)=>doc.text(line,40,doc.y+k*14,10,C.ink,true));doc.text(w.status,400,doc.y,10,C.muted);doc.y+=l.length*14;doc.paragraph(w.vendor?`Vendor: ${w.vendor}`:'Vendor not assigned',{size:9,color:C.muted,gap:4});doc.y+=4;}
 // Notes the inspector wrote for the client (internal notes are never included).
 const notes=[r.pre?.notes&&['Pre-storm visit',r.pre.notes],r.post?.notes&&['Post-storm visit',r.post.notes]].filter(Boolean);
 doc.heading('Notes to the client');
 if(!notes.length)doc.paragraph('No additional notes.',{color:C.muted});
 for(const [label,n] of notes){doc.need(30);doc.text(label,40,doc.y,9,C.muted,true);doc.y+=14;doc.paragraph(n);doc.y+=4;}
 return doc.finish(footerWith(doc,r.company,r.reference));
}

/**
 * Admin storm summary: one row per residence with prep / post status, severity and visit dates.
 * s: {company, companyLogo, timezone, preparedAt, event:{name,typeLabel,statusLabel,expectedImpactAt}, counts, rows:[{name, family, assigned, prep, post, severity, preDate, postDate}]}
 */
export function stormSummaryPdf(s){
 const tz=s.timezone||'America/New_York',doc=new Doc({company:s.company,companyLogo:s.companyLogo,label:'STORM SUMMARY'});
 doc.paragraph(`Storm summary \u2014 ${s.event.name}`,{size:20,strong:true,gap:6});doc.y+=4;
 doc.facts([['Storm',`${s.event.typeLabel} \u00b7 ${s.event.statusLabel}`],['Expected impact',s.event.expectedImpactAt?reportTimestamp(s.event.expectedImpactAt,tz):'Not set'],['Prepared',reportTimestamp(s.preparedAt,tz)]]);
 const c=s.counts;doc.y+=4;doc.need(60);
 [['RESIDENCES',c.total],['SECURED',c.secured],['NO DAMAGE',c.noDamage],['DAMAGE FOUND',c.damageFound]].forEach(([t,n],i)=>{const x=40+i*135;doc.rect(x,doc.y,127,50,i===3&&n?BG.attention:BG.panel);doc.text(String(n),x+12,doc.y+8,19,i===3&&n?C.attention:C.brand,true);doc.text(t,x+12,doc.y+33,8,C.muted,true);});doc.y+=66;
 const cols=[['Residence',40,130],['Assigned',176,74],['Prep',254,92],['Post-storm',350,84],['Severity',438,52],['Visits',494,78]];
 const header=()=>{doc.rect(40,doc.y,532,18,BG.head);cols.forEach(([t,x])=>doc.text(t,x+3,doc.y+5,8,C.muted,true));doc.y+=22;};
 header();
 for(const row of s.rows){
  const cells=[[...wrap(row.name,cols[0][2],9,true),...wrap(row.family||'',cols[0][2],8)],wrap(row.assigned||'Unassigned',cols[1][2],8),wrap(row.prep,cols[2][2],8),wrap(row.post,cols[3][2],8),wrap(row.severity||'\u2014',cols[4][2],8),[...(row.preDate?wrap('Pre '+row.preDate,cols[5][2],8):[]),...(row.postDate?wrap('Post '+row.postDate,cols[5][2],8):[])]];
  const h=Math.max(1,...cells.map(l=>l.length))*11+8;if(doc.y+h>BOTTOM){doc.newPage();header();}
  cells.forEach((lines,i)=>lines.forEach((l,k)=>doc.text(l,cols[i][1]+3,doc.y+k*11,i===0&&k===0?9:8,i===0&&k===0?C.ink:C.muted,i===0&&k===0)));doc.y+=h;doc.rect(40,doc.y-4,532,.6,C.line);
 }
 if(!s.rows.length)doc.paragraph('No residences are on this storm yet.',{color:C.muted});
 return doc.finish(footerWith(doc,s.company,''));
}
// Shared with the insurance visit history certificate (insurance-pdf.mjs) and photo comparisons.
export {Doc,C,BG,BOTTOM,footerWith,photoGrid,verificationBox};
