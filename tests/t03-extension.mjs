// Loads the browser extension, opens a page with a video file and a YouTube
// player, and checks the popup lists both and sends them to the app.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
const ext = new URL('../extension/', import.meta.url).pathname;
const shots = new URL('./shots/', import.meta.url).pathname;
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ lastExtension: '' }) });

const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/ytd-ext-'), {
  executablePath: '/opt/pw-browsers/chromium',
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server'],
  viewport: { width: 900, height: 700 },
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker');
const id = worker.url().split('/')[2];
console.log('extension id', id);

const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8099/ext.html');
await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
await page.waitForTimeout(2500);
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8099/*' }))[0].id);
const streams = await worker.evaluate(async (t) => (await chrome.storage.session.get(`streams-${t}`))[`streams-${t}`] || [], tabId);
console.log('streams seen:', streams.map((s) => s.kind + ' ' + s.url));

const popup = await ctx.newPage();
popup.on('pageerror', (e) => fail('popup error ' + e));
await popup.setViewportSize({ width: 400, height: 520 });
await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
await popup.waitForFunction(() => !document.querySelector('#pick').hidden || /No video|Open the/.test(document.querySelector('#msg').textContent), null, { timeout: 10000 });
const rows = await popup.$$eval('#list .name b', (b) => b.map((x) => x.textContent));
console.log('popup rows:', rows, 'msg:', await popup.textContent('#msg'));
ok(rows.length === 2, 'popup lists the video file and the YouTube player');
ok(rows.includes('Procedure walkthrough'), 'player title taken from the iframe');
await popup.screenshot({ path: shots + '20-popup.png' });
await popup.click('#sendBtn');
await new Promise((r) => setTimeout(r, 800));
const st = await (await fetch('http://127.0.0.1:5174/api/test/state')).json();
const sent = st.lastExtension ? JSON.parse(st.lastExtension) : null;
ok(sent && sent.items.length === 2 && sent.page.title === 'Clinic sample page', 'popup sent both videos with the page');
console.log('sent kinds:', sent?.items.map((x) => x.kind), 'cookies:', sent?.cookies?.length);
await ctx.close();
