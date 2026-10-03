// Readable dates for the signed-in app (public/app-format.js): no machine dates such as "2026-10-08 15:00:00.000Z".
process.env.TZ='America/New_York';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../public/app-format.js';
const F=globalThis.EAFormat,today='2026-10-03';
test('calendar days are never shifted by time zone',()=>{
 assert.equal(F.date('2026-10-08',{today}),'Thu, Oct 8');
 assert.equal(F.dayKey('2026-10-08'),'2026-10-08');
 assert.equal(F.date('2027-01-02',{today}),'Sat, Jan 2, 2027','adds the year outside the current one');
});
test('wall-clock times without a zone are shown as entered; timestamps with a zone use local time',()=>{
 assert.equal(F.dateTime('2026-10-08T15:00',{today}),'Thu, Oct 8 · 3:00 PM');
 assert.equal(F.dateTime('2026-10-08 15:00:00.000Z',{today}),'Thu, Oct 8 · 11:00 AM');
 assert.equal(F.dateTime('2026-10-08T15:00:00-04:00',{today}),'Thu, Oct 8 · 3:00 PM');
 assert.equal(F.time('2026-10-08T00:05'),'12:05 AM');assert.equal(F.time('2026-10-08T12:30'),'12:30 PM');
 assert.equal(F.dateTime('2026-10-08',{today}),'Thu, Oct 8','no time part for a plain day');
});
test('relative words, due dates and agenda headings',()=>{
 assert.equal(F.date('2026-10-03',{today,relative:true}),'Today');
 assert.equal(F.date('2026-10-04',{today,relative:true}),'Tomorrow');
 assert.equal(F.date('2026-10-02',{today,relative:true}),'Yesterday');
 assert.equal(F.stamp('2026-10-03T14:15',{today}),'Today · 2:15 PM');
 assert.equal(F.due('2026-10-01',{today}),'Overdue 2 days');assert.equal(F.due('2026-10-02',{today}),'Overdue 1 day');
 assert.equal(F.due('2026-10-03',{today}),'Due today');assert.equal(F.due('2026-10-09',{today}),'Due Fri, Oct 9');
 assert.equal(F.due('2026-10-01',{today,done:true}),'Due Thu, Oct 1');
 assert.equal(F.dayHeading('2026-10-03',{today}),'Today · Saturday, October 3');
 assert.equal(F.daysFrom('2026-10-10',today),7);
});
test('empty and unknown values never throw',()=>{
 for(const v of [null,undefined,'']){assert.equal(F.date(v),'');assert.equal(F.dateTime(v),'');assert.equal(F.time(v),'');}
 assert.equal(F.dateTime('not a date'),'not a date');
 assert.equal(F.parse(new Date('2026-10-03T12:00:00')).d,3);
});
import {readFileSync} from 'node:fs';
test('the shell ships the shared app files (served, cached by the service worker, in the shell version)',()=>{
 const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');const html=read('public/live.html'),sw=read('public/sw.js'),server=read('server.mjs');
 assert.match(html,/<script src="\/app-format\.js\?v=[^"]+"><\/script>(<script[^>]*><\/script>)*<script src="\/live\.js/,'dates load before live.js');
 assert.match(html,/<link rel="stylesheet" href="\/overview\.css\?v=[^"]+"><link rel="stylesheet" href="\/app\.css\?v=[^"]+">/,'app.css loads after overview.css');
 for(const f of ['app-format.js','app.css']){assert.ok(sw.includes(`'/${f}'`),'service worker caches '+f);assert.match(server,new RegExp(`SHELL_FILES = \\[[^\\]]*'${f.replace('.','\\.')}'`),'shell version covers '+f);assert.ok(server.includes(`'/${f}':'${f}'`),'served: '+f);}
 assert.doesNotMatch(read('public/app.css'),/overflow(-[xy])?:\s*(auto|scroll)/,'no scrolling boxes in the shared app styles');
});
