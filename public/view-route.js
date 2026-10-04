/* Refresh keeps you on the current screen.
   The open screen (page, residence + tab, inspection, template, family, arrival, message thread, asset record) is written to the
   URL hash, e.g. /#/residence/<id>/inspections, so a browser refresh, back/forward and a reopened installed app return to it.
   - Pure rules (toHash, parse, resolve, initialRoute) are exported as globalThis.EARoute and unit-tested in Node.
   - In the app this file loads after live.js and hooks its navigation: render() -> recordNavigation() writes the hash
     (pushState for a new screen, replaceState for restores), popstate restores, and the first render after sign-in restores.
   - Dialogs and half-filled forms are never put in the URL: a refresh lands on the page that contains them. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.EARoute=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const PAGES=['dashboard','messages','properties','work','shopping','inspections','requests','arrivals','calendar','documents','maintenance','assets','routes','platform','staff-schedules','staff','workspace','clients','vendors','billing','users','audit','approvals','automation','email-activity','checklist-templates','profile','notifications','storm','insurance','platform-owner','weather','import'];
 // Residence sections (batch 3a). Old tab names in saved links open the section that now holds them.
 const RESIDENCE_TABS=['overview','inspections','services','arrivals','records','people','notes'];
 const TAB_ALIAS={shopping:'arrivals',documents:'records',assets:'records',manual:'records',access_codes:'records',off_site_butler:'people',family:'people'};
 const SAVED_VIEW_MAX_AGE=12*60*60*1000;
 const enc=v=>encodeURIComponent(String(v));
 const dec=v=>{try{return decodeURIComponent(v);}catch{return '';}};
 const blank=()=>({page:'dashboard',propertyId:null,tab:'overview',activeInspection:null,activeAssetInspection:null,activeAssetInspectionRecord:null,assetInspectionReadOnly:false,activeArrival:null,arrivalFilter:'pending',activeClient:null,checklistTemplateId:null,activeMessageThread:null,inspectionUpcomingOnly:false,inspectionSubmittedOnly:false,stormEventId:null,weatherAlertId:null});
 function residenceTabs(role){if(role==='vendor')return ['services'];const t=['overview','inspections','services','arrivals','records','people'];if(role==='admin'||role==='employee')t.push('notes');return t;}
 /** View state -> hash ('' for Overview). Unknown pages and form-only screens map to the page that contains them. */
 function toHash(s){
  const page=s?.page||'dashboard';
  if(page==='dashboard')return '';
  if(page==='property')return s.propertyId?'#/residence/'+enc(s.propertyId)+(s.tab&&s.tab!=='overview'?'/'+enc(s.tab):''):'#/properties';
  if(page==='inspection')return s.activeInspection?'#/inspection/'+enc(s.activeInspection):'#/inspections';
  if(page==='asset-inspection')return s.assetInspectionReadOnly&&s.activeAssetInspection&&s.activeAssetInspectionRecord?'#/asset-inspection/'+enc(s.activeAssetInspection)+'/'+enc(s.activeAssetInspectionRecord):'#/assets';
  if(page==='checklist-editor')return s.checklistTemplateId?'#/checklist-templates/'+enc(s.checklistTemplateId):'#/checklist-templates';
  if(page==='clients')return s.activeClient?'#/clients/'+enc(s.activeClient):'#/clients';
  if(page==='arrivals')return s.activeArrival?'#/arrivals/'+enc(s.activeArrival):s.arrivalFilter==='ready'?'#/arrivals/ready':'#/arrivals';
  if(page==='inspections')return s.inspectionUpcomingOnly?'#/inspections/upcoming':s.inspectionSubmittedOnly?'#/inspections/submitted':'#/inspections';
  if(page==='messages')return s.activeMessageThread?'#/messages/'+enc(s.activeMessageThread):'#/messages';
  if(page==='storm')return s.stormEventId?'#/storm/'+enc(s.stormEventId):'#/storm';
  if(page==='weather')return s.weatherAlertId?'#/weather/'+enc(s.weatherAlertId):'#/weather';
  return PAGES.includes(page)?'#/'+page:'';
 }
 /** Hash -> requested view state (not yet checked against the user's data). Returns null for an empty or unknown hash. */
 function parse(hash){
  const raw=String(hash||'').replace(/^#/,'');if(!raw.startsWith('/'))return null;
  const parts=raw.slice(1).split('?')[0].split('/').filter(Boolean).map(dec);if(!parts.length)return null;
  const [head,a,b]=parts,s=blank();
  if(head==='overview'||head==='dashboard')return s;
  if(head==='residence'&&a){s.page='property';s.propertyId=a;const t=TAB_ALIAS[b]||b;s.tab=t&&RESIDENCE_TABS.includes(t)?t:'overview';return s;}
  if(head==='inspection'&&a){s.page='inspection';s.activeInspection=a;return s;}
  if(head==='asset-inspection'&&a&&b){s.page='asset-inspection';s.activeAssetInspection=a;s.activeAssetInspectionRecord=b;s.assetInspectionReadOnly=true;return s;}
  if(head==='checklist-templates'&&a){s.page='checklist-editor';s.checklistTemplateId=a;return s;}
  if(head==='clients'&&a){s.page='clients';s.activeClient=a;return s;}
  if(head==='arrivals'&&a){s.page='arrivals';if(a==='ready')s.arrivalFilter='ready';else s.activeArrival=a;return s;}
  if(head==='inspections'&&(a==='upcoming'||a==='submitted')){s.page='inspections';s.inspectionUpcomingOnly=a==='upcoming';s.inspectionSubmittedOnly=a==='submitted';return s;}
  if(head==='messages'&&a){s.page='messages';s.activeMessageThread=a;return s;}
  if(head==='storm'){if(a){s.page='storm';s.stormEventId=a;return s;}}
  if(head==='weather'&&a){s.page='weather';s.weatherAlertId=a;return s;}
  if(PAGES.includes(head)){s.page=head;return s;}
  return null;
 }
 /** Check a requested view against what this user can see. Missing records or no access fall back to Overview
     (to the offline visit list when the app is offline). Returns {state, fellBack}. */
 function resolve(requested,data){
  const home=()=>{const s=blank();if(data?.offline)s.page='inspections';return s;};
  if(!requested)return {state:home(),fellBack:false};
  if(!data?.user)return {state:home(),fellBack:true};
  const role=data.user.role,has=(rows,id)=>Array.isArray(rows)&&rows.some(r=>r&&r.id===id);
  const s={...blank(),...requested},bad=()=>({state:home(),fellBack:true});
  if(role==='inspector'&&!['dashboard','inspection','profile','notifications'].includes(s.page))return bad();
  switch(s.page){
   case 'property':{if(!has(data.properties,s.propertyId))return bad();const tabs=residenceTabs(role);if(!tabs.includes(s.tab))s.tab=tabs[0];break;}
   case 'inspection':if(!has(data.inspections,s.activeInspection))return bad();break;
   case 'asset-inspection':if(!has(data.assets,s.activeAssetInspection)||!(data.asset_inspections||[]).some(r=>r.id===s.activeAssetInspectionRecord&&r.asset_id===s.activeAssetInspection))return bad();break;
   case 'checklist-editor':if(role!=='admin'||!has(data.checklistTemplates?.templates,s.checklistTemplateId))return bad();break;
   case 'clients':if(s.activeClient&&(role!=='admin'||!has(data.clients,s.activeClient)))return bad();break;
   case 'arrivals':if(s.activeArrival&&!has(data.arrivals,s.activeArrival))return bad();break;
   case 'insurance':if(role==='vendor'||role==='client')return bad();break;
   case 'platform-owner':if(role!=='admin'||!data.user.platformOwner)return bad();break;
   case 'import':if(role!=='admin')return bad();break;
   case 'storm':if(role==='vendor'||role==='client')return bad();if(s.stormEventId&&!has(data.storm?.events,s.stormEventId))s.stormEventId=null;break;
   // Recent (ended) alerts are not in data, so an alert id is kept and the Weather page checks it with the server.
   case 'weather':if(role==='vendor'||role==='client'||!data.weather)return bad();break;
   default:if(s.page!=='dashboard'&&!PAGES.includes(s.page))return bad();
  }
  return {state:s,fellBack:false};
 }
 /** Which hash to restore on the first screen after sign-in: the URL's own hash, else (installed app reopened from its icon)
     the last screen this user had open on this device in the last 12 hours, else Overview. */
 function initialRoute({hash,search,standalone,saved,userId,now}){
  if(parse(hash))return {hash,from:'url'};
  const launched=standalone||new URLSearchParams(search||'').get('source')==='pwa';
  if(launched&&saved&&saved.userId&&saved.userId===userId&&typeof saved.route==='string'&&Number(now)-Number(saved.at||0)<=SAVED_VIEW_MAX_AGE&&parse(saved.route))return {hash:saved.route,from:'saved'};
  return {hash:'',from:'none'};
 }
 return {PAGES,RESIDENCE_TABS,SAVED_VIEW_MAX_AGE,blank,residenceTabs,toHash,parse,resolve,initialRoute};
});

/* ---------- app glue (browser only; needs live.js globals) ---------- */
if(typeof window!=='undefined'&&typeof document!=='undefined'&&typeof render==='function')(()=>{
 const R=globalThis.EARoute,VIEW_KEY='estateos:last-view';
 let restoredFor=null,mode=null; // mode: 'replace' while restoring (first screen, back/forward), otherwise new screens push
 const current=()=>R.toHash({page,propertyId,tab,activeInspection,activeAssetInspection,activeAssetInspectionRecord,assetInspectionReadOnly,activeArrival,arrivalFilter,activeClient,checklistTemplateId:checklistEditor?.templateId||null,activeMessageThread,inspectionUpcomingOnly,inspectionSubmittedOnly,stormEventId:typeof stormState!=='undefined'&&page==='storm'&&stormState.view==='board'?stormState.eventId:null,weatherAlertId:typeof weatherState!=='undefined'&&page==='weather'?weatherState.alertId:null});
 R.current=current;
 const urlFor=hash=>location.pathname+location.search+hash;
 function apply(s){
  page=s.page;propertyId=s.propertyId;tab=s.tab||'overview';activeInspection=s.activeInspection;activeAssetInspection=s.activeAssetInspection;activeAssetInspectionRecord=s.activeAssetInspectionRecord;assetInspectionReadOnly=!!s.assetInspectionReadOnly;activeArrival=s.activeArrival;arrivalFilter=s.arrivalFilter||'pending';activeClient=s.activeClient;inspectionUpcomingOnly=!!s.inspectionUpcomingOnly;inspectionSubmittedOnly=!!s.inspectionSubmittedOnly;
  checklistEditor=s.page==='checklist-editor'?{templateId:s.checklistTemplateId}:null;
  if(s.page==='storm'&&typeof stormState!=='undefined'){stormState.view=s.stormEventId?'board':'list';stormState.eventId=s.stormEventId||null;stormState.wizard=null;}
  if(s.page==='weather'&&typeof weatherState!=='undefined'&&weatherState.alertId!==(s.weatherAlertId||null)){weatherState.alertId=s.weatherAlertId||null;weatherState.detail=null;}
  if(s.activeMessageThread!==activeMessageThread){activeMessageThread=s.activeMessageThread||null;messageDetail=null;}
  if(activeMessageThread&&!messageDetail){const thread=activeMessageThread;api('messages/thread?id='+encodeURIComponent(thread)).then(detail=>{if(activeMessageThread!==thread)return;messageDetail=detail;render();}).catch(()=>{if(activeMessageThread!==thread)return;activeMessageThread=null;messageDetail=null;mode='replace';render();});}
 }
 function restore(hash,{announce}){
  const {state,fellBack}=R.resolve(R.parse(hash),data);
  apply(state);search='';
  if(fellBack&&announce)setTimeout(()=>toast('That page is no longer available, so you are on '+(data?.offline?'your saved inspections':'the Overview')+'.'),0);
 }
 function readSaved(){try{return JSON.parse(localStorage.getItem(VIEW_KEY)||'null');}catch{return null;}}
 // First render after sign-in (online or offline): restore from the URL, or from the last screen when the installed app reopens.
 const baseOpenLinked=openLinkedInspection;
 openLinkedInspection=function(...args){
  if(data?.user&&restoredFor!==data.user.id){
   restoredFor=data.user.id;mode='replace';
   if(!pendingInspectionLink){// a /login?inspection=<id> alert link wins over a remembered screen
    const standalone=!!(window.matchMedia&&(matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: fullscreen)').matches))||navigator.standalone===true;
    const pick=R.initialRoute({hash:location.hash,search:location.search,standalone,saved:readSaved(),userId:data.user.id,now:Date.now()});
    if(pick.hash)restore(pick.hash,{announce:true});
    else if(data.offline&&page!=='inspection')page='inspections';
   }
  }
  return baseOpenLinked.apply(this,args);
 };
 // Every render records the screen: write it to the URL.
 const baseRecord=recordNavigation;
 recordNavigation=function(...args){
  const result=baseRecord.apply(this,args);
  if(data?.user&&restoredFor===data.user.id){
   const hash=current();
   if(hash!==(location.hash.length>1?location.hash:'')){
    try{
     if(mode==='replace'||navigationRestoring)history.replaceState({...(history.state||{}),ea:1,eaDepth:history.state?.eaDepth||0},'',urlFor(hash));
     else history.pushState({ea:1,eaDepth:(history.state?.eaDepth||0)+1},'',urlFor(hash));
    }catch{}
   }
   mode=null;
  }
  return result;
 };
 // Back / forward (and editing the hash by hand).
 window.addEventListener('popstate',()=>{
  if(!data?.user||restoredFor!==data.user.id)return;
  if(location.hash===current()||(!location.hash&&!current()))return;
  try{if($('modal')?.open)$('modal').close();}catch{}
  alertsOpen=false;mode='replace';
  restore(location.hash,{announce:false});
  render();window.scrollTo(0,0);
 });
 // The in-app Back button follows the browser history when there is one.
 const baseAction=action;
 action=async function(name,key,button){
  if(name==='browser-back'&&(history.state?.eaDepth||0)>0){history.back();return;}
  const result=await baseAction.call(this,name,key,button);
  if(name==='logout'){restoredFor=null;try{localStorage.removeItem(VIEW_KEY);history.replaceState(null,'',location.pathname.startsWith('/client/')?location.pathname:'/login');}catch{}}
  return result;
 };
})();
