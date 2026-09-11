import {createHash} from 'node:crypto';
export async function sendInspectionEmail({to,report,pdf},{env=process.env,fetcher=fetch}={}){
 if(!to)return {emailStatus:'not_requested'};
 if(!env.RESEND_API_KEY)return {emailStatus:'not_configured'};
 if(pdf.length>25*1024*1024)return {emailStatus:'too_large'};
 const payload={from:env.EMAIL_FROM||'EstateAegis <notifications@estateaegis.com>',to:[to],subject:'Inspection report - '+report.property,
 text:`Your completed inspection report for ${report.property} is attached.\n\nInspection date: ${report.date}\nInspector: ${report.inspector}\n\nEstateAegis\nThe smarter way to manage private residences.`,
 attachments:[{filename:'EstateAegis-Inspection-'+report.id+'.pdf',content:pdf.toString('base64'),content_type:'application/pdf'}]};
 try{const response=await fetcher('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':createHash('sha256').update('inspection:'+report.id+':'+to).digest('hex')},body:JSON.stringify(payload)});if(!response.ok)return {emailStatus:'failed'};const body=await response.json();return {emailStatus:body.id?'sent':'failed'};}catch{return {emailStatus:'failed'};}
}
