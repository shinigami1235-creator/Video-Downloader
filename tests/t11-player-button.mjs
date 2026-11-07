// The Download button the extension puts on videos: it shows on hover, sends the
// video's file, sends the player's own page for a player in a frame, and goes away
// when switched off in the popup.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
const ext = new URL('../extension/', import.meta.url).pathname;
const shots = new URL('./shots/', import.meta.url).pathname;
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
const state = async () => (await (await fetch('http://127.0.0.1:5174/api/test/state')).json());
const lastSent = async () => { const s = await state(); return s.lastExtension ? JSON.parse(s.lastExtension) : null; };
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ lastExtension: '' }) });

const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/ytd-ext-'), {
  executablePath: '/opt/pw-browsers/chromium',
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server'],
  viewport: { width: 900, height: 700 },
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker');

// the button is the last thing on the page, in a closed shadow root
const button = (p) => p.evaluate(() => {
  const h = [...document.documentElement.children].find((e) => e.style.zIndex === '2147483647');
  return h ? { shown: h.style.display !== 'none', transform: h.style.transform } : null;
});

const extId = worker.url().split('/')[2];
const cmds = await worker.evaluate(() => chrome.commands.getAll());
ok(cmds.some((c) => c.name === 'toggle-button' && /Shift\+D|⇧D/.test(c.shortcut || '')), 'Alt+Shift+D switches the button: ' + JSON.stringify(cmds.map((c) => c.shortcut)));

// 0. off until switched on
const page = await ctx.newPage();
page.on('pageerror', (e) => fail('page error ' + e));
await page.goto('http://127.0.0.1:8099/ext.html');
await page.waitForTimeout(800);
const box = await page.locator('video').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
ok(!(await button(page))?.shown, 'no button before it is switched on');
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8099/*' }))[0].id);
let popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
await popup.waitForTimeout(800);
ok(!(await popup.isChecked('#playerButton')), 'the popup shows it off');
await popup.check('#playerButton');
await popup.close();
await page.mouse.move(5, 650);

// 1. a video file on the page
let b = await button(page);
ok(!b?.shown, 'the button waits for the mouse');
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
b = await button(page);
ok(b?.shown, 'the button shows over the video: ' + b?.transform);
await page.screenshot({ path: shots + '70-player-button.png', clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 } });
await page.mouse.move(box.x + 40, box.y + 25);
await page.mouse.click(box.x + 40, box.y + 25);
await page.waitForTimeout(1200);
let sent = await lastSent();
console.log('sent:', JSON.stringify(sent?.items), sent?.page);
ok(sent?.items?.[0]?.kind === 'media' && /clip\.mp4$/.test(sent.items[0].url), 'the video file went to the app');
ok(sent?.page?.title === 'Clinic sample page', 'with the page it sits on');
await page.mouse.move(5, 650);
await page.waitForTimeout(1700);
ok(!(await button(page))?.shown, 'the button goes once the mouse leaves');

// 2. a player in a frame on another site
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ lastExtension: '' }) });
await page.goto('http://127.0.0.1:8099/frame.html');
await page.waitForTimeout(1000);
const fbox = await page.locator('iframe').boundingBox();
await page.mouse.move(fbox.x + 200, fbox.y + 150);
await page.waitForTimeout(400);
await page.mouse.move(fbox.x + 45, fbox.y + 25);
await page.mouse.click(fbox.x + 45, fbox.y + 25);
await page.waitForTimeout(1200);
sent = await lastSent();
console.log('sent:', JSON.stringify(sent?.items));
ok(sent?.items?.[0]?.kind === 'embed' && /inner\.html$/.test(sent.items[0].url), "the player's own page went to the app");

// 3. switched off in the popup
popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
await popup.waitForTimeout(800);
await popup.screenshot({ path: shots + '71-popup-switch.png' });
await popup.uncheck('#playerButton');
await popup.close();
await page.goto('http://127.0.0.1:8099/ext.html');
await page.waitForTimeout(800);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
ok(!(await button(page))?.shown, 'no button once switched off');
await ctx.close();
