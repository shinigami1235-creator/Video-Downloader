// Runs the whole app in a browser against the stand-in yt-dlp.
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
const shots = new URL('./shots/', import.meta.url).pathname;
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ clipboard: '', connector: false, sent: [] }) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:5173/');
await page.waitForSelector('#linkInput');
await page.waitForTimeout(800);
await page.screenshot({ path: shots + '01-start.png' });

// one video, 720p
await page.fill('#linkInput', 'https://www.youtube.com/watch?v=TESTVID0001');
await page.click('#lookBtn');
await page.waitForSelector('#card:not([hidden])', { timeout: 20000 });
await page.waitForTimeout(400);
console.log('qualities:', await page.$$eval('#quality option', (o) => o.map((x) => x.textContent)));
await page.selectOption('#quality', '720');
await page.screenshot({ path: shots + '02-card.png' });
await page.click('#downloadBtn');
await page.waitForSelector('.item.downloading .bar', { timeout: 15000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: shots + '03-progress.png' });
console.log('progress text:', await page.textContent('.item .status'));
await page.waitForSelector('.item.done', { timeout: 60000 });
console.log('done text:', await page.textContent('.item .status'));

// MP3 of part of it
await page.fill('#linkInput', 'https://www.youtube.com/watch?v=TESTVID0001');
await page.click('#lookBtn');
await page.waitForSelector('#card:not([hidden])');
await page.click('#typeSeg button[data-v="mp3"]');
await page.click('#partSeg button[data-v="times"]');
await page.fill('#partList li:first-child .from', '0:05');
await page.fill('#partList li:first-child .to', '0:15');
await page.screenshot({ path: shots + '04-mp3-part.png' });
await page.click('#downloadBtn');
await page.waitForFunction(() => document.querySelectorAll('.item.done').length >= 2, null, { timeout: 60000 });

// bad times
await page.fill('#linkInput', 'https://www.youtube.com/watch?v=TESTVID0001');
await page.click('#lookBtn');
await page.waitForSelector('#card:not([hidden])');
await page.click('#typeSeg button[data-v="video"]');
await page.click('#partSeg button[data-v="times"]');
await page.fill('#partList li:first-child .from', '0:30');
await page.fill('#partList li:first-child .to', '0:10');
await page.click('#downloadBtn');
console.log('bad time msg:', await page.textContent('#cardMsg'));

// playlist, whole
await page.fill('#linkInput', 'https://www.youtube.com/watch?v=TESTVID0001&list=PLTEST');
await page.click('#lookBtn');
await page.waitForSelector('#playlistRow:not([hidden])', { timeout: 20000 });
await page.click('#plSeg button[data-v="all"]');
await page.waitForSelector('#card.list-mode');
await page.screenshot({ path: shots + '05-playlist.png' });
await page.click('#downloadBtn');
await page.waitForFunction(() => document.querySelectorAll('.item.done').length >= 3, null, { timeout: 90000 });

// private video
await page.fill('#linkInput', 'https://www.youtube.com/watch?v=PRIVATE0001');
await page.click('#lookBtn');
await page.waitForFunction(() => !document.querySelector('#linkMsg').hidden && !document.querySelector('#linkMsg').classList.contains('info'), null, { timeout: 20000 });
console.log('private msg:', await page.textContent('#linkMsg'));

// cancel mid-download

rmSync('/tmp/ytd-test/downloads', { recursive: true, force: true });
await page.fill('#linkInput', 'https://www.youtube.com/watch?v=TESTVID0001');
await page.click('#lookBtn');
await page.waitForSelector('#card:not([hidden])');
await page.selectOption('#quality', '1080');
await page.click('#downloadBtn');
await page.waitForSelector('.item.downloading', { timeout: 15000 });
await page.waitForTimeout(1500);
await page.click('.item.downloading button[data-a="cancel"]');
await page.waitForSelector('.item.cancelled', { timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: shots + '06-list.png', fullPage: true });
console.log('list:', await page.$$eval('.item', (els) => els.map((e) => e.className + ' | ' + e.querySelector('.status').textContent)));

await page.click('#settingsBtn');
await page.waitForTimeout(800);
await page.screenshot({ path: shots + '07-settings.png' });
await page.click('#updateBtn');
await page.waitForTimeout(1500);
console.log('update msg:', await page.textContent('#updateMsg'));
console.log('errors:', errors);
await browser.close();
