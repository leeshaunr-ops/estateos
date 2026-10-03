import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Public marketing site: CSP-safe pages, icons and logo files, demo vs trial wording, the HTML 404 page and HSTS.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = file => readFileSync(path.join(root, file), 'utf8');
const servers = [];
async function start(env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'estateos-website-'));
  const proc = spawn(process.execPath, ['server.mjs'], {cwd: root, env: {...process.env, PORT: '0', ESTATEOS_DATA_DIR: dir, ...env}, windowsHide: true});
  let log = '';
  proc.stderr.on('data', chunk => { log += chunk; });
  const base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    proc.once('exit', code => reject(Error('Server exited: ' + code + ' ' + log)));
    setTimeout(() => reject(Error('Startup timeout')), 10000).unref();
  });
  servers.push({proc, dir});
  return base;
}
after(async () => {
  for (const {proc, dir} of servers) {
    if (!proc.killed) { proc.kill(); await new Promise(resolve => proc.once('exit', resolve)); }
    rmSync(dir, {recursive: true, force: true});
  }
});

const MARKETING_PAGES = {
  '/': 'marketing.html', '/faq': 'faq.html', '/demo': 'demo.html', '/pricing': 'signup.html', '/about': 'about.html',
  '/home-watch-software': 'home-watch-software.html', '/inspection-report-software': 'inspection-report-software.html',
  '/private-residence-management': 'private-residence-management.html', '/resources': 'resources.html',
  '/home-watch-checklist': 'home-watch-checklist.html', '/arrival-preparation-checklist': 'arrival-preparation-checklist.html',
  '/example-workflow': 'example-workflow.html', '/login': 'live.html'
};
// Legal and policy pages: same header, logo, favicon and footer as the marketing pages, but they keep their own wording
// (terms.html names Florida for governing law, so they stay out of the marketing copy checks).
const LEGAL_PAGES = {'/terms': 'terms.html', '/privacy': 'privacy.html', '/refunds': 'refunds.html', '/security': 'security.html'};

test('marketing pages contain nothing the CSP blocks (inline scripts, <style>, style="")', () => {
  for (const file of [...Object.values(MARKETING_PAGES), ...Object.values(LEGAL_PAGES), '404.html']) {
    const html = read('public/' + file);
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].filter(m => !/type="application\/ld\+json"/.test(m[1]));
    assert.equal(inlineScripts.length, 0, file + ' has an inline script');
    assert.doesNotMatch(html, /<style[\s>]/, file + ' has an inline <style>');
    assert.doesNotMatch(html, /\sstyle="/, file + ' has a style attribute');
    assert.doesNotMatch(html, /resident\.css/, file + ' links the unserved resident.css');
  }
  assert.match(read('public/faq.html'), /<script src="\/faq\.js" defer><\/script>/);
});

test('demo vs trial wording: no mailto demo requests or "contact us for pricing" copy', () => {
  for (const file of Object.values(MARKETING_PAGES)) {
    const html = read('public/' + file);
    assert.doesNotMatch(html, /mailto:sales@estateaegis\.com\?subject=EstateAegis%20demo/, file);
    assert.doesNotMatch(html, /demo login information|Request demo access|Contact us for demo|contacting sales for access/i, file);
  }
  const home = read('public/marketing.html');
  assert.match(home, /Free 7-day demo workspace\. No credit card required\./);
  assert.match(home, /What’s the difference between the free demo and the 30-day trial\?/);
  assert.match(home, /Launch pricing · save \$20\/month/);
  assert.match(home, /Plans start at \$59\/month \(launch pricing\) and include 2 admin\/staff users and 10 GB of storage\./);
  assert.doesNotMatch(home, /launch pricing with two team accounts/);
  for (const file of ['home-watch-software.html', 'inspection-report-software.html', 'private-residence-management.html', 'about.html', 'resources.html', 'home-watch-checklist.html', 'arrival-preparation-checklist.html', 'example-workflow.html'])
    assert.match(read('public/' + file), /href="\/demo">Start your free demo →<\/a>/, file + ' links its demo button to /demo');
  const title = home.match(/<title>([^<]+)<\/title>/)[1];
  const description = home.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.match(title, /Home Watch/);
  assert.match(description, /home watch/i);
  assert.ok(description.length <= 155, 'meta description is ' + description.length + ' characters');
});

test('logo and favicon files are small, served, and the 519 KB original is not used on public pages', async () => {
  const base = await start();
  const expected = {'/favicon.ico': ['image/x-icon', 16000], '/favicon-32.png': ['image/png', 6000], '/apple-touch-icon.png': ['image/png', 20000], '/ea-shield-80.png': ['image/png', 15000], '/ea-shield-120.png': ['image/png', 20000], '/fonts/inter-latin-var.woff2': ['font/woff2', 90000]};
  for (const [url, [type, maxBytes]] of Object.entries(expected)) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-type'), type, url);
    const size = (await res.arrayBuffer()).byteLength;
    assert.ok(size > 0 && size <= maxBytes, `${url} is ${size} bytes`);
  }
  for (const file of [...Object.values(MARKETING_PAGES), ...Object.values(LEGAL_PAGES), '404.html', 'share.html', 'demo-guide.html']) {
    const html = read('public/' + file);
    assert.doesNotMatch(html, /\/ea-shield\.png|apple-touch-icon\.png\?v=ea-shield|https:\/\/estateaegis\.com\/apple-touch-icon/, file + ' still loads the full-size logo');
  }
  assert.doesNotMatch(read('public/live.js'), /\/ea-shield\.png/);
});

test('every local asset linked from the marketing pages exists', async () => {
  const base = await start();
  const urls = new Set();
  for (const file of [...Object.values(MARKETING_PAGES), ...Object.values(LEGAL_PAGES), '404.html'])
    for (const [, url] of read('public/' + file).matchAll(/(?:href|src)="(\/[^"#?]*)/g)) urls.add(url);
  for (const url of urls) {
    const res = await fetch(base + url, {method: 'HEAD'});
    assert.equal(res.status, 200, url);
  }
});

test('unknown pages get the branded HTML 404; /api keeps JSON; FAQ script is served', async () => {
  const base = await start();
  const page = await fetch(base + '/no-such-page');
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  const html = await page.text();
  assert.match(html, /We couldn’t find that page\./);
  assert.match(html, /href="\/demo"/);
  const head = await fetch(base + '/features', {method: 'HEAD'});
  assert.equal(head.status, 404);
  const api = await fetch(base + '/api/no-such-endpoint');
  assert.match(api.headers.get('content-type'), /^application\/json/);
  assert.ok(api.status === 401 || api.status === 404, 'api status ' + api.status);
  const post = await fetch(base + '/no-such-page', {method: 'POST', headers: {Origin: base, 'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(post.status, 404);
  assert.match(post.headers.get('content-type'), /^application\/json/);
  const faq = await fetch(base + '/faq.js');
  assert.equal(faq.status, 200);
  assert.match(faq.headers.get('content-type'), /javascript/);
  assert.match(await faq.text(), /faqSearch/);
});

test('HSTS is sent only when the server runs with secure cookies (production)', async () => {
  const local = await start();
  assert.equal((await fetch(local + '/')).headers.get('strict-transport-security'), null);
  const production = await start({ESTATEOS_SECURE_COOKIES: '1'});
  for (const url of ['/', '/faq', '/favicon.ico', '/no-such-page'])
    assert.equal((await fetch(production + url)).headers.get('strict-transport-security'), 'max-age=31536000', url);
});

test('homepage refresh: new sections, nav links, open FAQ, and no placeholder or real-storm copy', () => {
  const home = read('public/marketing.html');
  for (const id of ['whats-new', 'storm-season', 'features', 'trust', 'tutorial', 'pricing', 'faq', 'contact'])
    assert.match(home, new RegExp(`<section[^>]*\\bid="${id}"`), 'missing section #' + id);
  const nav = home.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
  assert.match(nav, /href="#whats-new">What’s new<\/a>/);
  assert.match(nav, /href="#storm-season">Storm season<\/a>/);
  const header = home.match(/<header class="site-header has-menu">([\s\S]*?)<\/header>/)[1];
  const demoButtons = [...header.matchAll(/<a class="button primary nav-cta[^"]*" href="([^"]+)">Start free demo<\/a>/g)];
  assert.ok(demoButtons.length >= 1, 'header has a Start free demo button');
  for (const [, href] of demoButtons) assert.equal(href, '/demo');
  assert.match(home, /<link rel="stylesheet" href="\/refresh\.css"><link rel="stylesheet" href="\/home-refresh\.css">/, 'home-refresh.css loads after refresh.css');
  assert.match(home, /Built for the way home watch actually works\./);
  assert.match(home, /When severe weather is coming, every home is accounted for\./);
  assert.match(home, /Hurricanes, winter storms, floods and severe thunderstorms/);
  assert.match(home, /Your clients trust you with their homes\. We take that seriously\./);
  assert.match(home, /A Visit verification box shows arrival, departure and GPS distance\./);
  // Every FAQ answer stays in the HTML and is visible on tablet and desktop: no <details>, and all five questions from the quick-fix pass remain.
  // On phones (760px and below) home-compact.js may turn them into tap-to-expand rows; see the compact phone homepage test.
  assert.doesNotMatch(home, /<details|<summary/);
  assert.equal([...home.matchAll(/<div class="faq-item">/g)].length, 5);
  for (const q of ['Can we use our own company branding?', 'What can clients and vendors see?', 'Can we try it before deciding?', 'What’s the difference between the free demo and the 30-day trial?', 'What does it cost, and how do we get support?'])
    assert.ok(home.includes(`<h3>${q}</h3>`), 'FAQ question missing: ' + q);
  // No fake social proof, mockup notes, launch-pricing duration or real storm / owner names.
  assert.doesNotMatch(home, /PLACEHOLDER|NOT FOR LAUNCH|testimonial|Owner to confirm|mockup|<blockquote/i);
  assert.doesNotMatch(home, /launch pricing (ends|lasts|through|until|for \d)/i);
  assert.doesNotMatch(home, /Milton|Nadine|Shaun|Lee family/i);
});

test('homepage images are optimized, sized, lazy below the fold, and served with image types', async () => {
  const base = await start();
  const home = read('public/marketing.html');
  const imgs = [...home.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(imgs.length >= 13, 'homepage has ' + imgs.length + ' images');
  const heroEnd = home.indexOf('<div class="value-strip">');
  const urls = new Set([home.match(/poster="([^"]+)"/)[1]]);
  for (const tag of imgs) {
    const src = tag.match(/\bsrc="([^"]+)"/)[1];
    assert.match(tag, /\bwidth="\d+"/, src + ' needs a width');
    assert.match(tag, /\bheight="\d+"/, src + ' needs a height');
    assert.match(tag, /\balt="/, src + ' needs alt text');
    if (home.indexOf(tag) > heroEnd && !/ea-shield/.test(src)) assert.match(tag, /loading="lazy"/, src + ' is below the fold and should lazy-load');
    urls.add(src);
  }
  let total = 0;
  for (const url of urls) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /^image\//, url);
    const size = (await res.arrayBuffer()).byteLength;
    if (url.startsWith('/img/')) {
      assert.equal(res.headers.get('content-type'), 'image/webp', url);
      assert.ok(size <= 60000, `${url} is ${size} bytes`);
      total += size;
    }
  }
  assert.ok(total <= 400000, 'homepage /img total is ' + total + ' bytes');
  for (const bad of ['/img/missing.webp', '/img/..%2Fserver.mjs', '/img/Hero.WEBP'])
    assert.equal((await fetch(base + bad)).status, 404, bad);
  const css = await fetch(base + '/home-refresh.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const text = await css.text();
  assert.match(text, /\.demo-section \.button\.light\{background:#fbf5e8;border-color:#fbf5e8;color:#7e202b\}/, 'final CTA button stays cream on wine');
  // Accessibility colours from the quick-fix pass are not regressed.
  assert.doesNotMatch(text, /#8b7754|#7b858d/);
  assert.doesNotMatch(text, /legal-links\{[^}]*justify-content:center/);
});

test('nationwide positioning: no Florida-only marketing copy, and share tags match the hero', () => {
  // Legal pages (terms.html: governing law and venue) may name Florida; marketing copy speaks to companies across the US.
  for (const file of [...Object.values(MARKETING_PAGES), '404.html', 'share.html', 'demo-guide.html', 'faq.js'])
    assert.doesNotMatch(read('public/' + file), /Florida/i, file + ' has Florida-only marketing copy');
  const home = read('public/marketing.html');
  assert.match(home, /<p class="eyebrow">For home watch &amp; estate management companies across the US<\/p>/);
  assert.doesNotMatch(home, /Hurricane season|id="hurricane"|href="#hurricane"/);
  const hero = 'Home watch and estate management software, under your brand.';
  assert.ok(home.includes(`<meta property="og:title" content="${hero}">`), 'og:title uses the hero wording');
  assert.ok(home.includes(`<meta name="twitter:title" content="${hero} | EstateAegis">`), 'twitter:title uses the hero wording');
  const og = home.match(/<meta property="og:description" content="([^"]+)"/)[1];
  assert.equal(home.match(/<meta name="twitter:description" content="([^"]+)"/)[1], og);
  assert.match(og, /across the US/);
  assert.match(home.match(/<meta name="description" content="([^"]+)"/)[1], /across the US/);
  assert.match(home, /"areaServed": \{"@type":"Country","name":"United States"\}/);
});

test('storm report image uses credited real photos', () => {
  const credits = read('public/img/CREDITS.md');
  assert.match(credits, /storm-report-page\.webp/);
  for (const source of ['https://commons.wikimedia.org/wiki/File:Missing_shingles_(37075099182).jpg', 'https://commons.wikimedia.org/wiki/File:FEMA_-_44325_-_Blue_tarp_on_a_tornado_damaged_home_in_Oklahoma.jpg'])
    assert.ok(credits.includes(source), 'credit missing for ' + source);
  assert.match(credits, /Public domain/);
  assert.match(read('public/marketing.html'), /<div class="storm-shot bottom"><img src="\/img\/storm-report-page\.webp"/);
});

// Pages that share the marketing header and get the one-row phone header with a menu button (marketing.css + site-menu.js).
const MENU_PAGES = ['marketing.html', 'about.html', 'faq.html', 'resources.html', 'signup.html', 'home-watch-software.html', 'inspection-report-software.html',
  'private-residence-management.html', 'home-watch-checklist.html', 'arrival-preparation-checklist.html', 'example-workflow.html', '404.html',
  ...Object.values(LEGAL_PAGES)];

test('phone header: compact Log in / Free demo / menu button markup, an external menu script and no inline script', async () => {
  for (const file of MENU_PAGES) {
    const html = read('public/' + file);
    const header = html.match(/<header class="site-header has-menu">([\s\S]*?)<\/header>/)?.[1];
    assert.ok(header, file + ' has the shared header with the phone menu');
    const actions = header.match(/<div class="header-actions">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(actions, file + ' has the phone header actions');
    assert.match(actions, /<a class="header-login" href="\/login">Log in<\/a>/, file);
    assert.match(actions, /<a class="button primary nav-cta-phone" href="\/demo">Free demo<\/a>/, file);
    const toggle = actions.match(/<button class="menu-toggle"[^>]*>/)?.[0];
    assert.ok(toggle, file + ' has a menu button');
    assert.match(toggle, /type="button"/, file);
    assert.match(toggle, /aria-expanded="false"/, file);
    assert.match(toggle, /aria-controls="site-menu"/, file);
    assert.match(toggle, /aria-label="Open menu"/, file);
    const panel = header.match(/<nav class="site-menu" id="site-menu" aria-label="Menu" hidden>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(panel, file + ' has a hidden, labelled menu panel');
    const links = [...panel.matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)].map(m => m[1]);
    assert.deepEqual(links, ['What’s new', 'Storm season', 'Pricing', 'FAQ', 'Log in'], file + ' menu links');
    assert.match(panel, /<a class="menu-login" href="\/login">Log in<\/a>/, file);
    assert.equal([...html.matchAll(/id="site-menu"/g)].length, 1, file + ' has one #site-menu');
    assert.equal([...html.matchAll(/<script src="\/site-menu\.js" defer><\/script>/g)].length, 1, file + ' loads site-menu.js once, deferred');
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].filter(m => !/type="application\/ld\+json"/.test(m[1]));
    assert.equal(inlineScripts.length, 0, file + ' has an inline script');
    assert.doesNotMatch(header, /\son[a-z]+="/, file + ' header has an inline event handler');
  }
  // The homepage menu stays on the page; the other pages link back to the homepage sections.
  assert.match(read('public/marketing.html'), /<nav class="site-menu"[^>]*><a href="#whats-new">What’s new<\/a><a href="#storm-season">Storm season<\/a><a href="#pricing">Pricing<\/a><a href="#faq">FAQ<\/a>/);
  assert.match(read('public/about.html'), /<nav class="site-menu"[^>]*><a href="\/#whats-new">What’s new<\/a><a href="\/#storm-season">Storm season<\/a><a href="\/pricing">Pricing<\/a><a href="\/faq">FAQ<\/a>/);
  assert.match(read('public/faq.html'), /<a href="\/faq" aria-current="page">FAQ<\/a>/);
  const css = read('public/marketing.css');
  assert.match(css, /@media\(max-width:760px\)\{[\s\S]*\.site-header\.has-menu>nav:not\(\.site-menu\)/, 'phones hide the full navigation');
  assert.match(css, /@media\(max-width:389px\)\{\s*\.site-header \.header-login\{display:none\}/, 'the narrowest phones move Log in into the menu');
  const base = await start();
  const res = await fetch(base + '/site-menu.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /aria-expanded/);
});

test('phone menu script: opens and closes the panel, and closes on a link tap, Escape and an outside tap', async () => {
  const {runInNewContext} = await import('node:vm');
  const listeners = target => { const map = {}; target.addEventListener = (type, fn) => { (map[type] ||= []).push(fn); }; target.fire = (type, event = {}) => { for (const fn of map[type] || []) fn({preventDefault() {}, ...event}); }; return target; };
  const attrs = {'aria-expanded': 'false', 'aria-controls': 'site-menu', 'aria-label': 'Open menu'};
  const classes = new Set();
  const header = {classList: {toggle: (name, on) => on ? classes.add(name) : classes.delete(name)}, contains: node => node === toggle || node === panel || node === link};
  listeners(header);
  const toggle = listeners({getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value; }, closest: () => header, focus() { document.activeElement = toggle; }});
  const panel = listeners({hidden: true});
  const link = {closest: selector => selector === 'a' ? link : null};
  const outside = {closest: () => null};
  const media = listeners({});
  const document = listeners({activeElement: null, querySelector: selector => selector === '.site-header .menu-toggle' ? toggle : null, getElementById: id => id === 'site-menu' ? panel : null});
  runInNewContext(read('public/site-menu.js'), {document, matchMedia: () => media});
  const open = () => { toggle.fire('click'); assert.equal(attrs['aria-expanded'], 'true'); assert.equal(panel.hidden, false); assert.ok(classes.has('menu-open')); assert.equal(attrs['aria-label'], 'Close menu'); };
  const closed = why => { assert.equal(attrs['aria-expanded'], 'false', why); assert.equal(panel.hidden, true, why); assert.ok(!classes.has('menu-open'), why); assert.equal(attrs['aria-label'], 'Open menu', why); };
  open(); toggle.fire('click'); closed('toggle again');
  open(); panel.fire('click', {target: link}); closed('link tap');
  open(); document.activeElement = link; document.fire('keydown', {key: 'Escape'}); closed('Escape'); assert.equal(document.activeElement, toggle, 'Escape returns focus to the menu button');
  open(); document.fire('pointerdown', {target: link}); assert.equal(panel.hidden, false, 'a tap inside the header keeps it open');
  document.fire('pointerdown', {target: outside}); closed('outside tap');
  open(); header.fire('focusout', {relatedTarget: outside}); closed('focus left the header');
  open(); media.fire('change', {matches: true}); closed('grew past the phone layout');
});

test('compact phone homepage: phone-only CSS, an external tap-to-expand script, and content kept in the HTML', async () => {
  const home = read('public/marketing.html');
  assert.equal([...home.matchAll(/<script src="\/home-compact\.js" defer><\/script>/g)].length, 1, 'homepage loads home-compact.js once, deferred');
  const inlineScripts = [...home.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].filter(m => !/type="application\/ld\+json"/.test(m[1]));
  assert.equal(inlineScripts.length, 0, 'homepage has an inline script');
  // Collapsed and hidden content is still in the page: the FAQ answers, the What's new lists and the pricing fine print.
  for (const text of ['The <strong>free 7-day demo</strong> is a private practice workspace', 'Field staff only see a checklist once you publish it', 'Additional admin/staff users: $15 each/month.', 'Talk to a real person.'])
    assert.ok(home.includes(text), 'missing from the HTML: ' + text);
  // Every compact rule lives in a phone media query, so tablet and desktop are untouched.
  const css = read('public/home-refresh.css');
  const block = css.slice(css.indexOf('/* Compact phone homepage'));
  assert.match(block, /^\/\* Compact phone homepage[\s\S]*?\*\/\n@media\(max-width:760px\)\{/, 'compact rules start with the phone media query');
  let depth = 0, outside = '';
  const rules = block.slice(block.indexOf('*/') + 2);
  for (const ch of rules) { if (ch === '{') depth++; if (depth === 0) outside += ch; if (ch === '}') depth--; }
  assert.doesNotMatch(outside.replace(/@media\([^)]*\)( and \([^)]*\))*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''), /[{}a-z]/i, 'no compact rule outside a phone media query');
  for (const query of rules.match(/@media[^{]*/g)) assert.match(query, /max-width:760px/, query);
  assert.doesNotMatch(block, /overflow(-[xy])?:(auto|scroll)|scroll-snap/, 'no scrolling boxes or carousels');
  const js = read('public/home-compact.js');
  assert.match(js, /matchMedia\('\(max-width: 760px\)'\)/);
  assert.match(js, /aria-expanded/);
  assert.match(js, /aria-controls/);
  const base = await start();
  const res = await fetch(base + '/home-compact.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('legal pages: shared header with the shield logo, favicons, the homepage footer, and their legal wording unchanged', async () => {
  const home = read('public/marketing.html');
  const footer = home.match(/<footer class="site-footer wrap" aria-label="EstateAegis footer">[\s\S]*?<\/footer>/)[0];
  const logo = '<a class="brand" href="/" aria-label="EstateAegis home"><img class="ea-brand-icon" src="/ea-shield-80.png" srcset="/ea-shield-80.png 2x, /ea-shield-120.png 3x" alt="" width="40" height="40">EstateAegis</a>';
  const headings = {'terms.html': ['LEGAL', 'Terms of Service'], 'privacy.html': ['LEGAL', 'Privacy Policy'], 'refunds.html': ['BILLING', 'Refund &amp; Cancellation Policy'], 'security.html': ['TRUST', 'Security']};
  for (const [route, file] of Object.entries(LEGAL_PAGES)) {
    const html = read('public/' + file);
    const head = html.slice(0, html.indexOf('</head>'));
    for (const icon of ['<link rel="icon" href="/favicon.ico" sizes="48x48">', '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">', '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">'])
      assert.ok(head.includes(icon), file + ' is missing ' + icon);
    assert.match(head, /<link rel="stylesheet" href="\/marketing\.css"><link rel="stylesheet" href="\/refresh\.css">/, file + ' uses the marketing styles');
    assert.ok(head.includes(`<link rel="canonical" href="https://estateaegis.com${route}">`), file + ' canonical');
    const header = html.match(/<header class="site-header has-menu">[\s\S]*?<\/header>/)[0];
    assert.ok(header.startsWith('<header class="site-header has-menu">' + logo), file + ' header starts with the shield logo');
    assert.equal(html.split('<header').length, 2, file + ' has one header');
    assert.doesNotMatch(html, /brand-mark|>EA</, file + ' still has the old EA text logo');
    assert.equal([...html.matchAll(/<footer\b/g)].length, 1, file + ' has one footer');
    assert.ok(html.includes(footer), file + ' uses the homepage footer');
    assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
    const main = html.match(/<main id="main" class="wrap section resource-content">([\s\S]*?)<\/main>/)?.[1];
    assert.ok(main, file + ' keeps its content in <main id="main">');
    assert.ok(main.startsWith(`<p class="eyebrow">${headings[file][0]}</p><h1>${headings[file][1]}</h1>`), file + ' heading');
    assert.ok(html.indexOf('</header>') < html.indexOf('<main') && html.indexOf('</main>') < html.indexOf('<footer'), file + ' order: header, main, footer');
  }
  // The legal wording itself is unchanged (spot checks of each page).
  assert.match(read('public/terms.html'), /These Terms govern the EstateAegis website and private residence management software operated by EstateAegis, LLC/);
  assert.match(read('public/privacy.html'), /<h2>Information we handle<\/h2>/);
  assert.match(read('public/refunds.html'), /An authorized workspace administrator may cancel in the billing portal/);
  assert.match(read('public/security.html'), /EstateAegis, LLC is committed to protecting the residence and household information entrusted to the service\./);
  for (const file of ['terms.html', 'privacy.html', 'refunds.html']) assert.match(read('public/' + file), /<p>Effective September 14, 2026<\/p>/, file);
  // The footer links every legal page, and each one is served as HTML under the site CSP.
  for (const route of Object.keys(LEGAL_PAGES)) assert.ok(footer.includes(`<a href="${route}">`), 'footer links ' + route);
  const base = await start();
  for (const route of Object.keys(LEGAL_PAGES)) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get('content-type'), /^text\/html/, route);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/, route);
    assert.match(await res.text(), /<script src="\/site-menu\.js" defer><\/script>/, route);
  }
});
