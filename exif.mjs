// Minimal JPEG EXIF reader and location stripper for uploaded photos (no dependencies).
// - readExif: DateTimeOriginal (+ OffsetTimeOriginal) and the GPS position/accuracy, when present.
// - stripLocation: empties the EXIF GPS IFD in place and removes XMP packets (which can repeat the position), keeping
//   every other byte (orientation, colour profile) so the photo displays exactly as before.
// Photos taken in the app are re-encoded through a canvas and carry no EXIF; this covers photos uploaded from files.
const XMP = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), XMP_EXT = Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1');
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function segments(buf) {
 if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return [];
 const out = []; let pos = 2;
 while (pos + 4 <= buf.length) {
  if (buf[pos] !== 0xff) break;
  const marker = buf[pos + 1];
  if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
  if (marker === 0xda || marker === 0xd9) break;
  const length = buf.readUInt16BE(pos + 2);
  if (length < 2 || pos + 2 + length > buf.length) break;
  out.push({ marker, start: pos, dataStart: pos + 4, end: pos + 2 + length });
  pos += 2 + length;
 }
 return out;
}
function tiff(buf, seg) {
 if (seg.marker !== 0xe1 || buf.toString('latin1', seg.dataStart, seg.dataStart + 6) !== 'Exif\0\0') return null;
 const base = seg.dataStart + 6, end = seg.end;
 if (base + 8 > end) return null;
 const order = buf.toString('latin1', base, base + 2), le = order === 'II';
 if (!le && order !== 'MM') return null;
 const u16 = o => (o + 2 <= end ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : null);
 const u32 = o => (o + 4 <= end ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : null);
 const w16 = (o, v) => (le ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o));
 return { base, end, u16, u32, w16 };
}
function entries(t, offset) {
 const at = t.base + offset, count = t.u16(at);
 if (count === null || count > 500 || at + 2 + count * 12 > t.end) return null;
 const list = [];
 for (let i = 0; i < count; i++) {
  const e = at + 2 + i * 12, type = t.u16(e + 2), n = t.u32(e + 4), size = (SIZES[type] || 1) * n;
  list.push({ entry: e, tag: t.u16(e), type, count: n, size, value: size <= 4 ? e + 8 : t.base + t.u32(e + 8) });
 }
 return { at, count, list };
}
function rationals(buf, t, e, le) {
 const out = [];
 for (let i = 0; i < e.count; i++) { const o = e.value + i * 8; if (o + 8 > t.end) return null; const a = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o), b = le ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o + 4); out.push(b ? a / b : 0); }
 return out;
}
const ascii = (buf, e) => buf.toString('latin1', e.value, e.value + e.count).replace(/\0.*$/s, '').trim();

/** {dateTimeOriginal:'YYYY:MM:DD HH:MM:SS'|null, offset:'+02:00'|null, lat, lon, accuracy} or null when there is no EXIF. */
export function readExif(buf) {
 for (const seg of segments(buf)) {
  const t = tiff(buf, seg); if (!t) continue;
  const le = buf.toString('latin1', t.base, t.base + 2) === 'II';
  const ifd0 = entries(t, t.u32(t.base + 4)); if (!ifd0) return null;
  const result = { dateTimeOriginal: null, offset: null, lat: null, lon: null, accuracy: null };
  const exifPtr = ifd0.list.find(e => e.tag === 0x8769), gpsPtr = ifd0.list.find(e => e.tag === 0x8825);
  if (exifPtr) {
   const ifd = entries(t, t.u32(exifPtr.entry + 8));
   for (const e of ifd?.list || []) {
    if (e.tag === 0x9003 && e.type === 2 && e.value + e.count <= t.end) result.dateTimeOriginal = ascii(buf, e) || null;
    if (e.tag === 0x9011 && e.type === 2 && e.value + e.count <= t.end) result.offset = /^[+-]\d\d:\d\d$/.test(ascii(buf, e)) ? ascii(buf, e) : null;
   }
  }
  if (gpsPtr) {
   const ifd = entries(t, t.u32(gpsPtr.entry + 8)); const tags = new Map((ifd?.list || []).map(e => [e.tag, e]));
   const ref = tag => (tags.get(tag) ? buf.toString('latin1', tags.get(tag).value, tags.get(tag).value + 1) : '');
   const dms = tag => { const e = tags.get(tag); if (!e || e.type !== 5 || e.count !== 3) return null; const r = rationals(buf, t, e, le); return r ? r[0] + r[1] / 60 + r[2] / 3600 : null; };
   const lat = dms(2), lon = dms(4);
   if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) { result.lat = ref(1) === 'S' ? -lat : lat; result.lon = ref(3) === 'W' ? -lon : lon; }
   const err = tags.get(0x1f); if (err && err.type === 5) { const r = rationals(buf, t, err, le); if (r && Number.isFinite(r[0])) result.accuracy = r[0]; }
  }
  return result;
 }
 return null;
}

/** EXIF DateTimeOriginal as an ISO string. Without an offset tag the wall time is read in `timezone`. */
export function exifTime(exif, timezone = 'America/New_York') {
 const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(exif?.dateTimeOriginal || '');
 if (!m) return null;
 const [y, mo, d, h, mi, s] = m.slice(1).map(Number), wall = Date.UTC(y, mo - 1, d, h, mi, s);
 if (!Number.isFinite(wall)) return null;
 if (exif.offset) { const sign = exif.offset[0] === '-' ? -1 : 1, [oh, om] = exif.offset.slice(1).split(':').map(Number); return new Date(wall - sign * (oh * 60 + om) * 60000).toISOString(); }
 // Wall time in a named zone: correct by the zone's offset at that instant (twice, for DST edges).
 let guess = wall;
 for (let i = 0; i < 2; i++) {
  let parts; try { parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value])); } catch { return null; }
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  guess += wall - asUtc;
 }
 return new Date(guess).toISOString();
}

/** A copy of the JPEG with the GPS IFD emptied and XMP packets removed. Other bytes are untouched. */
export function stripLocation(input) {
 const segs = segments(input); if (!segs.length) return input;
 const buf = Buffer.from(input);
 for (const seg of segs) {
  const t = tiff(buf, seg); if (!t) continue;
  const ifd0 = entries(t, t.u32(t.base + 4)); const gpsPtr = ifd0?.list.find(e => e.tag === 0x8825); if (!gpsPtr) continue;
  const ifd = entries(t, t.u32(gpsPtr.entry + 8)); if (!ifd) continue;
  for (const e of ifd.list) if (e.size > 4 && e.value >= t.base && e.value + e.size <= t.end) buf.fill(0, e.value, e.value + e.size);
  buf.fill(0, ifd.at + 2, ifd.at + 2 + ifd.count * 12); t.w16(ifd.at, 0);
 }
 const drop = segs.filter(s => s.marker === 0xe1 && (buf.subarray(s.dataStart, s.dataStart + XMP.length).equals(XMP) || buf.subarray(s.dataStart, s.dataStart + XMP_EXT.length).equals(XMP_EXT)));
 if (!drop.length) return buf;
 const parts = []; let pos = 0;
 for (const s of drop) { parts.push(buf.subarray(pos, s.start)); pos = s.end; }
 parts.push(buf.subarray(pos));
 return Buffer.concat(parts);
}
