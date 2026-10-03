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

test('marketing pages contain nothing the CSP blocks (inline scripts, <style>, style="")', () => {
  for (const file of [...Object.values(MARKETING_PAGES), '404.html']) {
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
  for (const file of [...Object.values(MARKETING_PAGES), '404.html', 'share.html', 'demo-guide.html']) {
    const html = read('public/' + file);
    assert.doesNotMatch(html, /\/ea-shield\.png|apple-touch-icon\.png\?v=ea-shield|https:\/\/estateaegis\.com\/apple-touch-icon/, file + ' still loads the full-size logo');
  }
  assert.doesNotMatch(read('public/live.js'), /\/ea-shield\.png/);
});

test('every local asset linked from the marketing pages exists', async () => {
  const base = await start();
  const urls = new Set();
  for (const file of [...Object.values(MARKETING_PAGES), '404.html'])
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
