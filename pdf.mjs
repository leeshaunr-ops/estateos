export function jpegSize(bytes){if(bytes[0]!==255||bytes[1]!==216)throw Error('JPEG required');let pos=2;while(pos<bytes.length){if(bytes[pos++]!==255)continue;let marker=bytes[pos++];while(marker===255)marker=bytes[pos++];if(marker===217||marker===218)break;const length=bytes.readUInt16BE(pos);if([192,193,194].includes(marker)){const height=bytes.readUInt16BE(pos+3),width=bytes.readUInt16BE(pos+5),channels=bytes[pos+7];if(!width||!height||width*height>40000000||![1,3].includes(channels))throw Error('Unsupported JPEG');return {height,width,channels};}if(length<2)break;pos+=length;}throw Error('Invalid JPEG');}
const C={ink:[.15,.19,.20],muted:[.40,.43,.44],brand:[.48,.10,.15],gold:[.73,.59,.35],line:[.87,.87,.84],white:[1,1,1],pass:[.12,.38,.29],monitor:[.57,.36,.02],attention:[.66,.12,.15]};
const backgrounds={pass:[.92,.96,.93],monitor:[1,.95,.72],attention:[1,.88,.88],na:[.95,.95,.94],unchecked:[.95,.95,.94]};
const statusLabel=s=>({pass:'PASS',monitor:'MONITOR',attention:'ATTENTION',na:'N/A',unchecked:'NOT ASSESSED'}[s]||String(s||'').toUpperCase());
function clean(s){return String(s??'').replace(/[–—]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/…/g,'...').replace(/[^\x20-\xff\n]/g,'?');}
function escape(s){return clean(s).replace(/([\\()])/g,'\\$1').replace(/[\r\n]/g,' ');}
function lines(s,width,size=10){const max=Math.max(12,Math.floor(width/(size*.64)));return clean(s).split('\n').flatMap(line=>{const out=[];let current='';for(let word of line.split(/\s+/)){while(word.length>max){if(current){out.push(current);current='';}out.push(word.slice(0,max));word=word.slice(max);}if((current+' '+word).trim().length>max){out.push(current);current=word;}else current=(current+' '+word).trim();}out.push(current);return out;});}
export function reportTimestamp(value,timezone='UTC') {if(!value)return 'Not recorded';try{return new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(value))+' ('+timezone+')';}catch{return 'Not recorded';}}
export function inspectionPdf(report,photos=[]){
 const objects=[];const add=o=>(objects.push(o),objects.length);const catalog=add(''),root=add('');const regular=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),bold=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
 const pages=[];let page,y;
 const rgb=c=>c.join(' ');
 function rect(x,top,w,h,c){page.stream+=`q ${rgb(c)} rg ${x} ${792-top-h} ${w} ${h} re f Q\n`;}
 function text(s,x,top,size=10,color=C.ink,strong=false){page.stream+=`BT /${strong?'F2':'F1'} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${x} ${792-top-size} Tm (${escape(s)}) Tj ET\n`;}
 function newPage(){page={stream:'',images:[]};pages.push(page);rect(0,0,612,74,C.brand);text('EstateAegis',40,22,22,C.white,true);text('PRIVATE RESIDENCE INSPECTION',330,32,9,[.91,.81,.64],true);rect(40,86,532,2,C.gold);y=104;}
 function need(h){if(y+h>730)newPage();}
 function paragraph(value,size=10,color=C.ink,width=508,x=52){for(const line of lines(value,width,size)){need(size+6);text(line,x,y,size,color);y+=size+6;}}
 function heading(title){need(55);y+=10;text(title,40,y,14,C.brand,true);y+=25;}
 newPage();paragraph(report.company||'Residence care',10,C.muted,520,40);paragraph(report.property||'Residence inspection',24,C.ink,520,40);y+=8;
 text('INSPECTION REPORT',40,y,10,C.brand,true);y+=22;
 for(const [label,value] of [['Family',report.client||'Not specified'],['Inspected by',report.inspector||'Not recorded'],['Inspection date',report.date||'Not recorded'],['Completed',reportTimestamp(report.completedAt,report.timezone)],['Report reference',report.id||'Not recorded']]){
  const row=lines(value,390,10);need(row.length*15+9);text(label,40,y,10,C.muted,true);for(const line of row){text(line,162,y,10);y+=15;}y+=5;
 }
 y+=8;need(68);
 for(const [index,status] of ['pass','monitor','attention'].entries()){const x=40+index*180;rect(x,y,172,58,backgrounds[status]);text(String((report.answers||[]).filter(a=>a.status===status).length),x+13,y+8,21,C[status],true);text(statusLabel(status),x+13,y+36,9,C[status],true);}y+=76;
 paragraph('Overall condition: '+(report.overall||'Not recorded'),11,C.ink,520,40);
 heading('Walkthrough checklist');let section='';
 for(const answer of report.answers||[]){
  const title=lines(answer.label,386,11),notes=answer.note?lines(answer.note,488,10):[];
  if(answer.section&&answer.section!==section){need(82);y+=10;section=answer.section;text(section,40,y,11,C.brand,true);y+=22;}
  const h=Math.min(600,Math.max(40,title.length*16+16)+(notes.length?notes.length*15+9:0));need(h+7);
  const bg=backgrounds[answer.status]||backgrounds.na,fg=C[answer.status]||C.muted;
  // Split unusually long observations across pages without clipping.
  const titleHeight=title.length*16+16;rect(40,y,532,Math.min(h,730-y),bg);rect(40,y,4,Math.min(h,730-y),fg);
  text(statusLabel(answer.status),466,y+12,9,fg,true);
  y+=10;for(const line of title){need(18);text(line,52,y,11,C.ink,true);y+=16;}
  if(notes.length){y+=4;for(const line of notes){need(17);text(line,52,y,10,C.muted);y+=15;}}
  y+=15;
 }
 if(photos.length){heading('Photo evidence');for(const [i,photo] of photos.entries()){
  const d=jpegSize(photo.bytes),scale=Math.min(508/d.width,440/d.height),w=d.width*scale,h=d.height*scale;
  need(h+66);text('PHOTO '+(i+1),40,y,9,C.brand,true);y+=19;
  const image=add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${d.width} /Height ${d.height} /ColorSpace /${d.channels===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${photo.bytes.length} >>\nstream\n`),photo.bytes,Buffer.from('\nendstream')]));const name='Im'+image;page.images.push([name,image]);page.stream+=`q ${w} 0 0 ${h} ${40+(532-w)/2} ${792-y-h} cm /${name} Do Q\n`;y+=h+9;paragraph(photo.name||'Inspection evidence',9,C.muted,520,40);y+=12;
 }}
 heading('Notes to the client');paragraph(report.notes||'No additional notes.');
 heading('Inspection summary');paragraph(report.summary||'No summary recorded.');
 const pageIds=[];for(let index=0;index<pages.length;index++){page=pages[index];rect(40,750,532,1,C.line);text('EstateAegis  |  Confidential client report',40,762,8,C.muted);text(`Page ${index+1} of ${pages.length}`,500,762,8,C.muted);const bytes=Buffer.from(page.stream,'latin1'),content=add(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`),bytes,Buffer.from('\nendstream')]));pageIds.push(add(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> /XObject << ${page.images.map(([name,id])=>`/${name} ${id} 0 R`).join(' ')} >> >> /Contents ${content} 0 R >>`));}
 objects[catalog-1]=`<< /Type /Catalog /Pages ${root} 0 R >>`;objects[root-1]=`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id=>id+' 0 R').join(' ')}] >>`;
 const parts=[Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n','latin1')],offsets=[0];let size=parts[0].length;for(const [i,obj] of objects.entries()){offsets.push(size);const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),Buffer.isBuffer(obj)?obj:Buffer.from(obj),Buffer.from('\nendobj\n')]);parts.push(chunk);size+=chunk.length;}
 parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${size}\n%%EOF`));return Buffer.concat(parts);
}
