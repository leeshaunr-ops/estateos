// Weather data providers for severe-weather alerts. All outbound weather traffic goes through here.
// - National Weather Service (api.weather.gov): free, no key, needs a User-Agent with contact details. Used for
//   residence points (zones and forecast grid), active alerts, raw gridpoint forecasts and station observations.
// - Open-Meteo: optional forecast provider. The customer endpoint (OPEN_METEO_API_KEY) is the commercial one; the free
//   endpoint is non-commercial, so it is only used for local development and tests (never on Render).
// Only rounded coordinates leave the server (4 decimals for NWS points, 2 for Open-Meteo). No names or contact details.
import './public/weather-core.js';
const W=globalThis.EAWeather;
export const DEFAULT_NWS_USER_AGENT='(estateaegis.com, help@estateaegis.com)';
const lastSeg=u=>{const s=String(u||'').replace(/\/+$/,'');const i=s.lastIndexOf('/');return i>=0?s.slice(i+1):s||null;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

/** Which forecast provider to use. nws_grid unless open_meteo is chosen and allowed (key set, or local/dev without a key). */
export function forecastProviderName(env=process.env){
 const want=String(env.WEATHER_FORECAST_PROVIDER||'nws_grid').toLowerCase();
 if(want!=='open_meteo')return {name:'nws_grid',warning:want==='nws_grid'?'':`Unknown WEATHER_FORECAST_PROVIDER "${want}", using nws_grid.`};
 if(env.OPEN_METEO_API_KEY)return {name:'open_meteo',customer:true,warning:''};
 if(env.RENDER||env.NODE_ENV==='production')return {name:'nws_grid',warning:'WEATHER_FORECAST_PROVIDER=open_meteo needs OPEN_METEO_API_KEY on hosted servers (the free endpoint is non-commercial). Using nws_grid.'};
 return {name:'open_meteo',customer:false,warning:''};
}

/** Small JSON-over-HTTP helper with a per-URL cache that honours Cache-Control max-age, and retry with backoff. */
function httpClient({fetcher=globalThis.fetch,headers={},retryDelayMs=2000,timeoutMs=15000,counter}){
 const cache=new Map();
 return async function getJson(url,{cacheable=true,retries=2}={}){
  const hit=cacheable&&cache.get(url);if(hit&&hit.until>Date.now())return hit.value;
  let lastErr;
  for(let attempt=0;attempt<=retries;attempt++){
   if(counter)counter.requests++;
   let res;
   try{res=await fetcher(url,{headers,signal:AbortSignal.timeout(timeoutMs)});}
   catch(e){lastErr=new Error(`Weather request failed (${e.name==='TimeoutError'?'timeout':'network'})`);if(attempt<retries){await wait(retryDelayMs*(attempt+1));continue;}throw lastErr;}
   if(res.status===429||res.status>=500){
    const ra=Number(res.headers.get('retry-after'));lastErr=Object.assign(new Error(`Weather service returned ${res.status}`),{status:res.status});
    if(attempt<retries){await wait(Number.isFinite(ra)&&ra>0?Math.min(ra*1000,30000):retryDelayMs*(attempt+1)*(1+Math.random()*.25));continue;}
    throw lastErr;
   }
   if(res.status===404){await res.text().catch(()=>'');return {notFound:true};}
   if(!res.ok){await res.text().catch(()=>'');throw Object.assign(new Error(`Weather service returned ${res.status}`),{status:res.status});}
   const value=await res.json();
   const cc=res.headers.get('cache-control')||'',m=cc.match(/max-age=(\d+)/);
   if(cacheable&&m&&!/no-store|no-cache/.test(cc))cache.set(url,{value,until:Date.now()+Math.min(Number(m[1]),3600)*1000});
   if(cache.size>2000)cache.clear();
   return value;
  }
  throw lastErr;
 };
}

/** One NWS alert feature -> a flat record used by the grouping rules. */
export function normalizeAlert(f){
 const p=f?.properties||{};
 const event=String(p.event||'').trim(),ends=p.ends||p.expires||null;
 return {id:String(p.id||f?.id||''),event,category:W.categoryOf(event),level:W.levelOf(event),status:p.status||'',message_type:p.messageType||'',severity:p.severity||'',urgency:p.urgency||'',certainty:p.certainty||'',
  headline:p.headline||'',description:p.description||'',instruction:p.instruction||'',sender_name:p.senderName||'',area_desc:p.areaDesc||'',
  sent_at:p.sent||null,effective_at:p.effective||null,onset_at:p.onset||p.effective||null,expires_at:p.expires||null,ends_at:ends,
  refs:(p.references||[]).map(r=>String(r.identifier||r['@id']||'')).filter(Boolean),vtec:p.parameters?.VTEC||[],ugc:(p.geocode?.UGC||[]).map(String),geometry:f?.geometry&&['Polygon','MultiPolygon'].includes(f.geometry.type)?f.geometry:null};
}

export function createNwsClient({env=process.env,fetcher=globalThis.fetch,counter={requests:0}}={}){
 const base=String(env.NWS_BASE_URL||'https://api.weather.gov').replace(/\/+$/,'');
 const userAgent=String(env.NWS_USER_AGENT||DEFAULT_NWS_USER_AGENT);
 const getJson=httpClient({fetcher,counter,headers:{'User-Agent':userAgent,Accept:'application/geo+json'},retryDelayMs:Number(env.WEATHER_RETRY_DELAY_MS??2000)});
 const r4=v=>W.round(v,4);
 return {
  counter,userAgent,
  /** Residence point -> zones, grid and stations URL. {supported:false} outside NWS coverage (404). */
  async points(lat,lon){
   const body=await getJson(`${base}/points/${r4(lat)},${r4(lon)}`);
   if(body.notFound)return {supported:false};
   const p=body.properties||{};
   return {supported:true,state:p.relativeLocation?.properties?.state||null,forecastZone:lastSeg(p.forecastZone),countyZone:lastSeg(p.county),fireZone:lastSeg(p.fireWeatherZone),gridId:p.gridId||null,gridX:p.gridX??null,gridY:p.gridY??null,stationsUrl:p.observationStations||null,timeZone:p.timeZone||null};
  },
  async activeByState(state){const b=await getJson(`${base}/alerts/active?area=${encodeURIComponent(state)}&status=actual`,{cacheable:false});return (b.features||[]).map(normalizeAlert);},
  async activeByPoint(lat,lon){const b=await getJson(`${base}/alerts/active?point=${r4(lat)},${r4(lon)}&status=actual`,{cacheable:false});return (b.features||[]).map(normalizeAlert);},
  async gridpoint(gridId,x,y){const b=await getJson(`${base}/gridpoints/${encodeURIComponent(gridId)}/${x},${y}`);return b.notFound?null:(b.properties||null);},
  async station(gridId,x,y){const b=await getJson(`${base}/gridpoints/${encodeURIComponent(gridId)}/${x},${y}/stations`);return b.notFound?null:(b.features?.[0]?.properties?.stationIdentifier||null);},
  /** Observation nearest to `at` (latest when at is within 90 minutes of now). */
  async observation(stationId,at){
   const t=Date.parse(at||'')||Date.now();
   if(Math.abs(Date.now()-t)<=90*60000){const b=await getJson(`${base}/stations/${encodeURIComponent(stationId)}/observations/latest`,{cacheable:false});return b.notFound?null:observationOut(b.properties);}
   const q=`start=${encodeURIComponent(new Date(t-90*60000).toISOString())}&end=${encodeURIComponent(new Date(t+90*60000).toISOString())}`;
   const b=await getJson(`${base}/stations/${encodeURIComponent(stationId)}/observations?${q}`,{cacheable:false});
   const list=(b.features||[]).map(f=>f.properties).filter(Boolean).sort((a,c)=>Math.abs(Date.parse(a.timestamp)-t)-Math.abs(Date.parse(c.timestamp)-t));
   return list.length?observationOut(list[0]):null;
  }
 };
}

function observationOut(p){
 if(!p)return null;
 const v=x=>x&&x.value!=null?x:null;
 const temp=v(p.temperature),feels=v(p.heatIndex)||v(p.windChill)||temp;
 return {temp_f:temp?round1(W.toF(temp.value,temp.unitCode)):null,feels_like_f:feels?round1(W.toF(feels.value,feels.unitCode)):null,humidity:v(p.relativeHumidity)?Math.round(p.relativeHumidity.value):null,
  wind_mph:v(p.windSpeed)?round1(W.toMph(p.windSpeed.value,p.windSpeed.unitCode)):null,gust_mph:v(p.windGust)?round1(W.toMph(p.windGust.value,p.windGust.unitCode)):null,
  precip_last_hour_in:v(p.precipitationLastHour)?Math.round(W.toIn(p.precipitationLastHour.value,p.precipitationLastHour.unitCode)*100)/100:null,conditions:p.textDescription||'',observed_at:p.timestamp||null,source:'nws'};
}
const round1=v=>v==null||!Number.isFinite(v)?null:Math.round(v*10)/10;

export function createOpenMeteoClient({env=process.env,fetcher=globalThis.fetch,counter={requests:0}}={}){
 const key=env.OPEN_METEO_API_KEY||'';
 const base=String(key?(env.OPEN_METEO_CUSTOMER_BASE_URL||'https://customer-api.open-meteo.com'):(env.OPEN_METEO_BASE_URL||'https://api.open-meteo.com')).replace(/\/+$/,'');
 const getJson=httpClient({fetcher,counter,headers:{Accept:'application/json'},retryDelayMs:Number(env.WEATHER_RETRY_DELAY_MS??2000)});
 const withKey=q=>key?`${q}&apikey=${encodeURIComponent(key)}`:q;
 const r2=v=>W.round(v,2);
 const DAILY='temperature_2m_min,temperature_2m_max,apparent_temperature_max,precipitation_sum,wind_gusts_10m_max';
 const UNITS='temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';
 return {
  counter,
  /** Daily forecasts for up to 50 points per request. points: [{lat,lon}] -> [{lat_r,lon_r,timezone,days}] in order. */
  async daily(points,days=7){
   const out=[];
   for(let i=0;i<points.length;i+=50){
    const batch=points.slice(i,i+50);
    const q=`latitude=${batch.map(p=>r2(p.lat)).join(',')}&longitude=${batch.map(p=>r2(p.lon)).join(',')}&daily=${DAILY}&timezone=auto&forecast_days=${days}&${UNITS}`;
    const b=await getJson(withKey(`${base}/v1/forecast?${q}`));
    const list=Array.isArray(b)?b:[b];
    batch.forEach((p,k)=>{const x=list[k]||{};out.push({lat_r:r2(p.lat),lon_r:r2(p.lon),timezone:x.timezone||null,days:W.openMeteoDaily(x.daily)});});
   }
   return out;
  },
  /** Conditions at one point at a time (current when recent, else the matching hour from the last two days). */
  async conditions(lat,lon,at){
   const t=Date.parse(at||'')||Date.now();
   const vars='temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m';
   if(Math.abs(Date.now()-t)<=90*60000){
    const b=await getJson(withKey(`${base}/v1/forecast?latitude=${r2(lat)}&longitude=${r2(lon)}&current=${vars}&timezone=UTC&${UNITS}`),{cacheable:false});
    const c=b.current||{};return {temp_f:round1(c.temperature_2m),feels_like_f:round1(c.apparent_temperature),humidity:c.relative_humidity_2m??null,wind_mph:round1(c.wind_speed_10m),gust_mph:round1(c.wind_gusts_10m),precip_last_hour_in:c.precipitation??null,conditions:W.wmoText(c.weather_code),observed_at:c.time?new Date(c.time+'Z').toISOString():null,source:'open_meteo'};
   }
   const b=await getJson(withKey(`${base}/v1/forecast?latitude=${r2(lat)}&longitude=${r2(lon)}&hourly=${vars}&past_days=2&forecast_days=1&timezone=UTC&${UNITS}`),{cacheable:false});
   const h=b.hourly||{},times=(h.time||[]).map(x=>Date.parse(x+'Z'));if(!times.length)return null;
   let k=0;times.forEach((x,i)=>{if(Math.abs(x-t)<Math.abs(times[k]-t))k=i;});
   return {temp_f:round1(h.temperature_2m?.[k]),feels_like_f:round1(h.apparent_temperature?.[k]),humidity:h.relative_humidity_2m?.[k]??null,wind_mph:round1(h.wind_speed_10m?.[k]),gust_mph:round1(h.wind_gusts_10m?.[k]),precip_last_hour_in:h.precipitation?.[k]??null,conditions:W.wmoText(h.weather_code?.[k]),observed_at:new Date(times[k]).toISOString(),source:'open_meteo'};
  }
 };
}
