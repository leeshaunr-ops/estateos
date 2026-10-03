/* EstateAegis readable dates for the signed-in app (browser: window.EAFormat; Node tests: require/import).
   Plain words instead of machine dates: "Thu, Oct 8", "Thu, Oct 8 · 3:00 PM", "Today · 2:15 PM".
   - 'YYYY-MM-DD' is a calendar day (never shifted by time zone).
   - 'YYYY-MM-DDTHH:MM' with no zone is a wall-clock time as entered (shown as is).
   - A timestamp with Z or an offset is converted to the viewer's local time. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.EAFormat=api;})(typeof self!=='undefined'?self:globalThis,function(){
 'use strict';
 const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],LWD=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
 const MO=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 const pad=n=>String(n).padStart(2,'0');
 const fromDate=d=>({y:d.getFullYear(),m:d.getMonth()+1,d:d.getDate(),hh:d.getHours(),mm:d.getMinutes(),time:true});
 /** Parse into wall-clock parts {y,m,d,hh,mm,time}; null when empty or not a date. */
 function parse(value){
  if(value===null||value===undefined||value==='')return null;
  if(value instanceof Date)return isNaN(value)?null:fromDate(value);
  if(typeof value==='number'){const d=new Date(value);return isNaN(d)?null:fromDate(d);}
  const s=String(value).trim();let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return {y:+m[1],m:+m[2],d:+m[3],hh:0,mm:0,time:false};
  m=s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if(m){if(m[7]){const d=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}${m[7].toUpperCase()==='Z'?'Z':m[7].length===5?m[7].slice(0,3)+':'+m[7].slice(3):m[7]}`);return isNaN(d)?null:fromDate(d);}return {y:+m[1],m:+m[2],d:+m[3],hh:+m[4],mm:+m[5],time:true};}
  const d=new Date(s);return isNaN(d)?null:fromDate(d);
 }
 const key=p=>`${p.y}-${pad(p.m)}-${pad(p.d)}`;
 /** Local calendar day 'YYYY-MM-DD' of a value (for grouping and comparisons). */
 function dayKey(value){const p=parse(value);return p?key(p):'';}
 function todayKey(now=new Date()){return key(fromDate(now));}
 const serial=k=>{const [y,m,d]=k.split('-').map(Number);return Date.UTC(y,m-1,d)/86400000;};
 const weekday=p=>new Date(Date.UTC(p.y,p.m-1,p.d)).getUTCDay();
 /** Days from today to the value's day (negative = past). */
 function daysFrom(value,today=todayKey()){const k=dayKey(value);return k?serial(k)-serial(dayKey(today)):null;}
 /** "3:00 PM" */
 function time(value){const p=parse(value);if(!p||!p.time)return '';const h=p.hh%12||12;return `${h}:${pad(p.mm)} ${p.hh<12?'AM':'PM'}`;}
 /** "Thu, Oct 8" (+ ", 2027" outside the current year). relative:true gives Today / Tomorrow / Yesterday. long:true gives "Thursday, October 8". */
 function date(value,{today=todayKey(),relative=false,weekday:wd=true}={}){
  const p=parse(value);if(!p)return value?String(value):'';
  if(relative){const n=daysFrom(key(p),today);if(n===0)return 'Today';if(n===1)return 'Tomorrow';if(n===-1)return 'Yesterday';}
  const year=String(p.y)!==String(today).slice(0,4)?`, ${p.y}`:'';
  return `${wd?WD[weekday(p)]+', ':''}${MO[p.m-1]} ${p.d}${year}`;
 }
 /** "Thu, Oct 8 · 3:00 PM" (time only when the value has one). */
 function dateTime(value,opts={}){const p=parse(value);if(!p)return value?String(value):'';const t=time(value);return date(value,opts)+(t?' · '+t:'');}
 /** For "when did this happen" stamps: "Today · 2:15 PM", "Yesterday · 9:05 AM", "Thu, Oct 1 · 9:05 AM". */
 function stamp(value,opts={}){return dateTime(value,{relative:true,...opts});}
 /** Heading for an agenda day: "Today · Saturday, October 3", "Monday, October 5". */
 function dayHeading(value,{today=todayKey()}={}){const p=parse(value);if(!p)return '';const LMO=['January','February','March','April','May','June','July','August','September','October','November','December'];const n=daysFrom(key(p),today);const base=`${LWD[weekday(p)]}, ${LMO[p.m-1]} ${p.d}${String(p.y)!==String(today).slice(0,4)?', '+p.y:''}`;return n===0?'Today · '+base:n===1?'Tomorrow · '+base:n===-1?'Yesterday · '+base:base;}
 /** "Overdue 2 days" / "Due today" / "Due tomorrow" / "Due Thu, Oct 8" for a due date. */
 function due(value,{today=todayKey(),done=false}={}){const n=daysFrom(value,today);if(n===null)return '';if(!done&&n<0)return `Overdue ${-n} day${n===-1?'':'s'}`;if(n===0)return 'Due today';if(n===1)return 'Due tomorrow';return 'Due '+date(value,{today});}
 return {parse,dayKey,todayKey,daysFrom,time,date,dateTime,stamp,dayHeading,due};
});
