// Local stand-in for api.weather.gov and Open-Meteo used by the weather tests. Fixtures live in tests/fixtures/weather;
// "{{+6h}}"-style placeholders become ISO times relative to now and "{{day0}}" the UTC date today (+N days for dayN).
import http from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','weather');
export function fixture(name,base=Date.now()){
 const raw=readFileSync(path.join(dir,name),'utf8')
  .replace(/\{\{([+-])(\d+)h\}\}/g,(_,s,n)=>new Date(base+(s==='-'?-1:1)*Number(n)*3600000).toISOString())
  .replace(/\{\{day(\d+)\}\}/g,(_,n)=>new Date(base+Number(n)*86400000).toISOString().slice(0,10));
 return JSON.parse(raw);
}
export async function startMock(){
 const points=fixture('points.json');
 const state={alerts:{},fail:{},failOnce:{},requests:[],meteo:null,grid:fixture('gridpoint-MKX.json')};
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');state.requests.push({path:url.pathname,query:url.search,headers:req.headers});
  const send=(status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/geo+json',...headers});res.end(typeof body==='string'?body:JSON.stringify(body));};
  let m;
  if((m=url.pathname.match(/^\/points\/(-?[\d.]+),(-?[\d.]+)$/))){const p=points[`${Number(m[1])},${Number(m[2])}`];if(!p)return send(404,{title:'Data Unavailable For Requested Point'});
   return send(200,{properties:{gridId:p.grid[0],gridX:p.grid[1],gridY:p.grid[2],forecastZone:`https://api.weather.gov/zones/forecast/${p.zone}`,county:`https://api.weather.gov/zones/county/${p.county}`,fireWeatherZone:`https://api.weather.gov/zones/fire/${p.fire}`,timeZone:p.tz,observationStations:`https://api.weather.gov/gridpoints/${p.grid[0]}/${p.grid[1]},${p.grid[2]}/stations`,relativeLocation:{properties:{state:p.state}}}},{'Cache-Control':'public, max-age=3600'});}
  if(url.pathname==='/alerts/active'){
   const area=url.searchParams.get('area');
   if(area){if(state.failOnce[area]){const code=state.failOnce[area];delete state.failOnce[area];return send(code,{title:'busy'},code===429?{'Retry-After':'0'}:{});}if(state.fail[area])return send(state.fail[area],{title:'Service Unavailable'});return send(200,{type:'FeatureCollection',features:state.alerts[area]||[]});}
   return send(200,{type:'FeatureCollection',features:[]});
  }
  if((m=url.pathname.match(/^\/gridpoints\/([A-Z]+)\/(\d+),(\d+)\/stations$/)))return send(200,{features:[{properties:{stationIdentifier:'K'+m[1]}}]});
  if((m=url.pathname.match(/^\/gridpoints\/([A-Z]+)\/(\d+),(\d+)$/)))return send(200,m[1]==='MKX'?state.grid:{properties:{}});
  if(url.pathname.match(/^\/stations\/[A-Z]+\/observations\/latest$/))return send(200,fixture('observation.json'));
  if(url.pathname.match(/^\/stations\/[A-Z]+\/observations$/))return send(200,{features:[fixture('observation.json')]});
  if(url.pathname==='/v1/forecast'){
   const lats=url.searchParams.get('latitude').split(','),lons=url.searchParams.get('longitude').split(',');
   const day=i=>new Date(Date.now()+i*86400000).toISOString().slice(0,10);
   const one=(lat,lon)=>({latitude:Number(lat),longitude:Number(lon),timezone:'America/Toronto',daily:{time:[0,1,2,3,4,5,6].map(day),temperature_2m_min:[30,18,25,40,40,40,40],temperature_2m_max:[40,30,35,50,50,50,50],apparent_temperature_max:[38,25,30,48,48,48,48],precipitation_sum:[0,0.1,0,0,0,0,0],wind_gusts_10m_max:[10,20,15,10,10,10,10]},current:{time:new Date().toISOString().slice(0,16),temperature_2m:28.4,apparent_temperature:20.1,relative_humidity_2m:80,precipitation:0,weather_code:71,wind_speed_10m:9.6,wind_gusts_10m:18.2}});
   const out=lats.map((lat,i)=>one(lat,lons[i]));
   return res.writeHead(200,{'Content-Type':'application/json'}),res.end(JSON.stringify(out.length===1?out[0]:out));
  }
  send(404,{title:'Not Found'});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,state,setAlerts(map){state.alerts={};for(const [st,files] of Object.entries(map))state.alerts[st]=files.flatMap(f=>fixture(f).features);},close:()=>new Promise(r=>server.close(r)),count:prefix=>state.requests.filter(r=>r.path.startsWith(prefix)).length,reset(){state.requests.length=0;}};
}
