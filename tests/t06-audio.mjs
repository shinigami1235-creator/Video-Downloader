// A page that plays an MP3: the extension lists it and the app saves it as audio.
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
const ext = new URL('../extension/', import.meta.url).pathname;
const DL = '/tmp/ytd-test/downloads';
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
rmSync(DL, { recursive: true, force: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ clipboard: '', connector: false, sent: [], lastExtension: '' }) });

// 1. the extension finds the song
const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/ytd-ext-'), {
  executablePath: '/opt/pw-browsers/chromium',
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker');
const id = worker.url().split('/')[2];
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8099/player.html');
await page.evaluate(() => document.querySelector('audio').play().catch(() => {}));
await page.waitForTimeout(2000);
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8099/*' }))[0].id);
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
await popup.waitForFunction(() => !document.querySelector('#pick').hidden || /No video|Open the/.test(document.querySelector('#msg').textContent), null, { timeout: 10000 });
const rows = await popup.$$eval('#list .row', (r) => r.map((x) => x.querySelector('b').textContent + ' | ' + x.querySelector('.name span').textContent));
console.log('popup rows:', rows);
ok(rows.length === 1 && /Audio file/.test(rows[0]), 'popup lists the song as an audio file');
await popup.click('#sendBtn');
await new Promise((r) => setTimeout(r, 800));
await ctx.close();
const st = await (await fetch('http://127.0.0.1:5174/api/test/state')).json();
ok(!!st.lastExtension, 'sent to the app');

// 2. the app opens it as audio only and saves an MP3 named after the page
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const app = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await app.goto('http://localhost:5173/');
await app.waitForSelector('#linkInput');
await app.waitForTimeout(800);
await fetch('http://127.0.0.1:47821/add', { method: 'POST', headers: { origin: 'chrome-extension://testid', 'content-type': 'application/json' }, body: st.lastExtension });
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
ok((await app.textContent('#title')) === 'Song test page', 'card titled after the page');
ok(await app.isHidden('#typeSeg [data-v="video"]'), 'video choice hidden for a song');
ok((await app.getAttribute('#typeSeg [data-v="mp3"]', 'class'))?.includes('on'), 'MP3 picked');
await app.screenshot({ path: new URL('./shots/40-audio.png', import.meta.url).pathname });
await app.click('#downloadBtn');
await app.waitForFunction(() => document.querySelectorAll('.item.done, .item.failed').length >= 1, null, { timeout: 60000 });
console.log('status:', await app.textContent('.item .status'), readdirSync(DL));
ok(readdirSync(DL).includes('Song test page.mp3'), 'saved as Song test page.mp3');
await browser.close();
