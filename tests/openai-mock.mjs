// Local stand-in for the OpenAI Responses API (POST /v1/responses). Scenarios: ok, slow, refusal, malformed,
// incomplete, leaky, missing, timeout, 429 (always), 429-once, 500-once, 401. Records every request for assertions.
import http from 'node:http';
export async function startOpenAiMock(){
 let scenario='ok';const requests=[];let onceUsed=false;
 const visitData=body=>{try{const t=body.input[0].content[0].text;return JSON.parse(t.slice(t.indexOf('{')));}catch{return {items:[]};}};
 const answer=(body,obj,extra={})=>({id:'resp_test',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:typeof obj==='string'?obj:JSON.stringify(obj)}]}],usage:{input_tokens:180,output_tokens:60},...extra});
 const server=http.createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',async()=>{
   let body={};try{body=JSON.parse(raw);}catch{}
   requests.push({path:req.url,auth:req.headers.authorization||'',body,raw});
   const send=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
   const input=visitData(body),flagged=(input.items||[]).filter(i=>i.tone==='fail'||i.tone==='monitor');
   const good={summary:flagged.length?`We checked the home. ${flagged.map(f=>`${f.label}: ${f.note||'noted'}.`).join(' ')} Everything else was in good order.`.replace(/\[[a-z]+\]/g,'').replace(/\.\./g,'.'):'Everything checked during this visit was in good order.',mentioned_items:flagged.map(f=>f.label)};
   switch(scenario){
    case 'ok':return send(200,answer(body,good));
    case 'slow':await new Promise(r=>setTimeout(r,300));return send(200,answer(body,good));
    case 'refusal':return send(200,{status:'completed',model:body.model,output:[{type:'message',content:[{type:'refusal',refusal:'I cannot help with that.'}]}],usage:{input_tokens:150,output_tokens:5}});
    case 'malformed':return send(200,answer(body,'{"summary": "cut off'));
    case 'incomplete':return send(200,answer(body,'{"summary":"x"',{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}));
    case 'leaky':return send(200,answer(body,{summary:'Casey Morgan should call 239-555-0101 about the gate code 4471.',mentioned_items:flagged.map(f=>f.label)}));
    case 'missing':return send(200,answer(body,{summary:'Everything was fine.',mentioned_items:[]}));
    case 'timeout':await new Promise(r=>setTimeout(r,4000));return send(200,answer(body,good));
    case '429':return send(429,{error:{type:'rate_limit_error',code:'rate_limit_exceeded',message:'Slow down'}});
    case '429-once':if(!onceUsed){onceUsed=true;return send(429,{error:{code:'rate_limit_exceeded'}});}return send(200,answer(body,good));
    case '500-once':if(!onceUsed){onceUsed=true;return send(500,{error:{message:'boom'}});}return send(200,answer(body,good));
    case '401':return send(401,{error:{code:'invalid_api_key',message:'Incorrect API key provided: sk-test...'}});
   }
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,requests,set(s){scenario=s;onceUsed=false;},close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(()=>r());})};
}
