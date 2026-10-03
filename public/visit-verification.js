/* GPS and timestamp proof of visit: rules and wording shared by the browser (inspection card, client portal, offline
   flow), the server (check-in/out, report snapshot) and the PDF. Location is only ever captured at check-in,
   check-out and photo events; nothing here tracks continuously. Exposes globalThis.EAVisit. */
(function(root){
 'use strict';
 const DEFAULT_TZ='America/New_York',DEFAULT_RADIUS=150,MAX_ACCURACY_ALLOWANCE=100,SKEW_MS=10*60000,PHOTO_FRESH_MS=10*60000;
 const NOTICE='We record your location only when you check in, check out, and take photos, to prove the visit to the client.';
 const STATUS_LABELS={verified:'Verified',outside_geofence:'Outside residence area',location_unavailable:'Location unavailable',no_residence_location:'Residence location not set',pending:'Not checked in'};
 const STATUS_TONES={verified:'pass',outside_geofence:'fail',location_unavailable:'monitor',no_residence_location:'monitor',pending:'open'};
 const num=v=>v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);
 const validCoord=(lat,lon)=>{lat=num(lat);lon=num(lon);return lat!==null&&lon!==null&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180&&!(lat===0&&lon===0);};
 /** Great-circle distance in metres (haversine, mean Earth radius). */
 function haversine(lat1,lon1,lat2,lon2){
  const R=6371008.8,rad=Math.PI/180,dLat=(lat2-lat1)*rad,dLon=(lon2-lon1)*rad;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)));
 }
 /** One check-in/check-out position against the residence. GPS accuracy widens the area by at most 100 m. */
 function evaluate(position,residence){
  const p=position||{},r=residence||{};
  if(!validCoord(p.lat,p.lon))return {status:'location_unavailable',distance:null};
  if(!validCoord(r.lat,r.lon))return {status:'no_residence_location',distance:null};
  const distance=haversine(+r.lat,+r.lon,+p.lat,+p.lon),radius=num(r.radius)??DEFAULT_RADIUS,allowance=Math.min(Math.max(num(p.accuracy)||0,0),MAX_ACCURACY_ALLOWANCE);
  return {status:distance<=radius+allowance?'verified':'outside_geofence',distance:Math.round(distance)};
 }
 /** The visit's overall status from its check-in and check-out (an admin override always wins). */
 function overallStatus(v){
  if(v&&v.override_at)return 'verified';
  if(!v||!(v.check_in_server_at||v.check_in_device_at))return 'pending';
  const marks=[sideStatus(v,'check_in'),sideStatus(v,'check_out')].filter(Boolean);
  if(marks.includes('outside_geofence'))return 'outside_geofence';
  if(marks.includes('verified'))return 'verified';
  if(marks.includes('no_residence_location'))return 'no_residence_location';
  return 'location_unavailable';
 }
 /** The device clock is off when it differs from the server clock by more than 10 minutes at send time. Queued (offline)
     events are compared at send time only, since their capture time is legitimately earlier than the server time. */
 function clockSkew({deviceAt,serverAt,sentAt,offline}){
  const server=Date.parse(serverAt);if(!Number.isFinite(server))return false;
  const sent=Date.parse(sentAt);if(Number.isFinite(sent))return Math.abs(server-sent)>SKEW_MS;
  if(offline)return false;
  const device=Date.parse(deviceAt);return Number.isFinite(device)&&Math.abs(server-device)>SKEW_MS;
 }
 function validTimezone(tz){if(!tz||typeof tz!=='string')return false;try{new Intl.DateTimeFormat('en-US',{timeZone:tz});return true;}catch{return false;}}
 /** Residence time zone (when an admin or geocoding set one), else the company time zone, else America/New_York. */
 function effectiveTimezone(property,companyTz){
  const p=property||{};
  if(p.timezone_source&&validTimezone(p.timezone))return p.timezone;
  if(validTimezone(companyTz))return companyTz;
  if(validTimezone(p.timezone))return p.timezone;
  return DEFAULT_TZ;
 }
 /** "Oct 2, 2026, 9:14 AM EDT" in the given zone. */
 function formatTime(value,tz,{date=true}={}){
  const at=new Date(value);if(!value||Number.isNaN(at.getTime()))return 'Not recorded';
  const zone=validTimezone(tz)?tz:DEFAULT_TZ;
  return at.toLocaleString('en-US',{timeZone:zone,...(date?{year:'numeric',month:'short',day:'numeric'}:{}),hour:'numeric',minute:'2-digit',timeZoneName:'short'}).replace(/[\u202f\u00a0]/g,' ');
 }
 const zoneAbbreviation=(tz,at=new Date())=>formatTime(at,tz,{date:false}).split(' ').pop();
 function formatDistance(m){m=num(m);if(m===null)return '';return m<1000?Math.round(m)+' m':(m/1000).toFixed(m<10000?1:0)+' km';}
 function formatDuration(seconds){seconds=num(seconds);if(seconds===null||seconds<0)return '';const minutes=Math.round(seconds/60);if(minutes<1)return 'under 1 min';if(minutes<60)return minutes+' min';return Math.floor(minutes/60)+' h'+(minutes%60?' '+(minutes%60)+' min':'');}
 /** The time a check-in/out happened: the device time when it was recorded offline (synced later), else the server time. */
 const eventAt=(v,which)=>v[which+'_offline']?(v[which+'_device_at']||v[which+'_server_at']):(v[which+'_server_at']||v[which+'_device_at']);
 /** A stored check-in/out's status, from the distance and radius recorded with it (no residence lookup needed). */
 function sideStatus(v,which){
  if(!v[which+'_server_at']&&!v[which+'_device_at'])return null;
  if(!validCoord(v[which+'_lat'],v[which+'_lon']))return 'location_unavailable';
  const d=num(v[which+'_distance_m']);if(d===null)return 'no_residence_location';
  return d<=(num(v.radius_m)??DEFAULT_RADIUS)+Math.min(Math.max(num(v[which+'_accuracy_m'])||0,0),MAX_ACCURACY_ALLOWANCE)?'verified':'outside_geofence';
 }
 /**
  * A stored inspection_visits row as the browser/PDF see it. `full` (admins, and the employee who did the visit) adds
  * device vs server times and coordinates; clients never get coordinates.
  */
 function publicVisit(row,{full=false,overrideByName='',checkInName=''}={}){
  if(!row)return null;
  const side=which=>{
   if(!row[which+'_server_at']&&!row[which+'_device_at'])return null;
   const s={at:eventAt(row,which),offline:!!Number(row[which+'_offline']),synced_at:row[which+'_server_at']||null,distance_m:num(row[which+'_distance_m']),accuracy_m:num(row[which+'_accuracy_m']),has_location:validCoord(row[which+'_lat'],row[which+'_lon']),source:row[which+'_source']||null,note:row[which+'_note']||'',status:sideStatus(row,which)};
   if(which==='check_out')s.auto=!!Number(row.check_out_auto);
   if(full)Object.assign(s,{device_at:row[which+'_device_at']||null,server_at:row[which+'_server_at']||null,lat:num(row[which+'_lat']),lon:num(row[which+'_lon'])});
   return s;
  };
  return {status:overallStatus(row),check_in:side('check_in'),check_out:side('check_out'),duration_seconds:num(row.duration_seconds),radius_m:num(row.radius_m),clock_skew:!!Number(row.clock_skew),override:row.override_at?{by_name:overrideByName||'an administrator',reason:row.override_reason||'',at:row.override_at}:null,...(full?{check_in_by:checkInName||''}:{})};
 }
 function locationSentence(s,{prefix='Verified at the residence'}={}){
  if(!s)return '';
  if(s.status==='verified')return `${prefix} (${formatDistance(s.distance_m)}${s.accuracy_m!==null?', GPS accuracy ±'+Math.round(s.accuracy_m)+' m':''})`;
  if(s.status==='outside_geofence')return `Recorded ${formatDistance(s.distance_m)} from the residence${s.note?' - reason: '+s.note:''}`;
  if(s.status==='no_residence_location')return 'Location recorded, but the residence location is not set, so the distance could not be checked';
  return 'Location unavailable (location was off or there was no GPS signal)';
 }
 /**
  * Plain-words description used identically by the PDF box, the client portal and the inspection screen:
  * {status,label,tone,rows:[[label,value]],notes:[...]}.
  */
 function describe(visit,tz){
  const v=visit||{status:'pending'},status=v.override?'verified':(v.status||'pending'),rows=[],notes=[];
  const time=s=>s?formatTime(s.at,tz):'Not recorded';
  const offlineNote=s=>' (recorded offline; '+(s.synced_at?'synced '+formatTime(s.synced_at,tz):'waiting to sync')+')';
  if(v.check_in){rows.push(['Arrived',time(v.check_in)+(v.check_in.offline?offlineNote(v.check_in):'')]);}
  else rows.push(['Arrived','Not checked in']);
  if(v.check_out)rows.push(['Departed',time(v.check_out)+(v.check_out.auto?' (checked out automatically when the report was completed)':v.check_out.offline?offlineNote(v.check_out):'')]);
  else if(v.check_in)rows.push(['Departed','Not checked out']);
  const duration=formatDuration(v.duration_seconds);if(duration)rows.push(['Time on site',duration]);
  if(v.check_in){
   const primary=v.check_in.status==='outside_geofence'||!(v.check_out&&v.check_out.status==='outside_geofence')?v.check_in:v.check_out;
   let location=locationSentence(primary);
   if(v.check_in.status!=='verified'&&v.check_out&&v.check_out.status==='verified'&&primary===v.check_in)location+='; '+locationSentence(v.check_out,{prefix:'verified at the residence at check-out'}).replace(/^./,c=>c.toLowerCase());
   if(v.check_in.status==='verified'&&v.check_out&&v.check_out.status==='outside_geofence')location=locationSentence(v.check_in)+'; check-out '+locationSentence(v.check_out).replace(/^./,c=>c.toLowerCase());
   rows.push(['Location',location]);
  }
  if(v.override)rows.push(['Verified by',`${v.override.by_name}${v.override.reason?' - '+v.override.reason:''}`]);
  if(v.clock_skew)notes.push('The device clock was more than 10 minutes off when this was sent; times recorded offline may be inaccurate.');
  return {status,label:v.override?'Verified by administrator':STATUS_LABELS[status]||'Not checked in',tone:STATUS_TONES[status]||'open',rows,notes,timezone:validTimezone(tz)?tz:DEFAULT_TZ};
 }
 /** A photo is "at the residence" when its own position is inside the residence area. */
 function photoAtResidence(photo,residence){if(!photo)return false;return evaluate({lat:photo.capture_lat??photo.lat,lon:photo.capture_lon??photo.lon,accuracy:photo.capture_accuracy_m??photo.accuracy},residence).status==='verified';}
 const api={DEFAULT_TZ,DEFAULT_RADIUS,SKEW_MS,PHOTO_FRESH_MS,NOTICE,STATUS_LABELS,STATUS_TONES,validCoord,haversine,evaluate,sideStatus,overallStatus,clockSkew,validTimezone,effectiveTimezone,formatTime,zoneAbbreviation,formatDistance,formatDuration,publicVisit,describe,locationSentence,photoAtResidence};
 root.EAVisit=api;
 if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
