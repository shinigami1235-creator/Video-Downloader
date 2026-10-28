// Subtitles, thumbnail, chapters, small video, several links, copied links,
// send to phone, a page with several videos, and links from the extension.
import { chromium } from 'playwright';
import { readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
const shots = new URL('./shots/', import.meta.url).pathname;
const VID = 'https://www.youtube.com/watch?v=TESTVID0001';
const BIG = 'https://www.youtube.com/watch?v=TESTVID0003';
const state = (body) => fetch('http://127.0.0.1:5174/api/test/state', body ? { method: 'POST', body: JSON.stringify(body) } : {}).then((r) => r.json());
const lastArgs = () => JSON.parse(readFileSync('/tmp/ytd-test/argv.log', 'utf8').trim().split('\n').pop());
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));

rmSync('/tmp/ytd-test/downloads', { recursive: true, force: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
await state({ clipboard: '', connector: false, sent: [] });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5173/');
await page.waitForSelector('#linkInput');
await page.waitForTimeout(600);
const lookup = async (url) => {
  await page.fill('#linkInput', url);
  await page.click('#lookBtn');
  await page.waitForSelector('#card:not([hidden])', { timeout: 20000 });
};
const doneCount = () => page.$$eval('.item.done', (e) => e.length);
const waitDone = (n, t = 90000) => page.waitForFunction((n) => document.querySelectorAll('.item.done').length >= n, n, { timeout: t });

// 1. subtitles, thumbnail and chapters
await lookup(VID);
const subs = await page.$$eval('#subs option', (o) => o.map((x) => x.textContent));
ok(subs.join('|') === 'None|English|Thai (automatic)', 'subtitle choices ' + subs.join('|'));
ok(!(await page.isHidden('#chapterOpt')), 'chapter option shows for a video with chapters');
ok(!(await page.isHidden('#sponsorOpt')), 'sponsor option shows for YouTube');
ok(await page.isHidden('#phoneOpt'), 'send to phone hidden while Desktop Connector is closed');
await page.selectOption('#subs', 'en');
await page.check('#thumbOn');
await page.check('#chapterOn');
await page.screenshot({ path: shots + '10-options.png' });
await page.click('#downloadBtn');
await waitDone(1);
let a = lastArgs();
ok(a.includes('--write-subs') && a[a.indexOf('--sub-langs') + 1] === 'en', 'subtitles passed to yt-dlp');
ok(a.includes('--write-thumbnail'), 'thumbnail passed');
ok(a.includes('--split-chapters'), 'chapters passed');

// part switches chapters off
await lookup(VID);
await page.check('#chapterOn');
await page.click('#partSeg button[data-v="times"]');
ok(await page.isDisabled('#chapterOn'), 'part disables chapters');
await page.click('#cancelCardBtn');

// 2. small video
await lookup(BIG);
await page.click('#typeSeg button[data-v="small"]');
await page.selectOption('#sizeLimit', '25');
console.log('size hint:', await page.textContent('#sizeHint'));
await page.click('#downloadBtn');
await page.waitForFunction(() => /Shrinking/.test(document.querySelector('.item .status')?.textContent || ''), null, { timeout: 60000 });
await page.screenshot({ path: shots + '11-shrinking.png' });
await waitDone(2, 180000);
const small = readdirSync('/tmp/ytd-test/downloads').find((f) => /25 MB/.test(f));
ok(small && statSync('/tmp/ytd-test/downloads/' + small).size < 25e6, `small file ${small} ${small && statSync('/tmp/ytd-test/downloads/' + small).size}`);
ok(!readdirSync('/tmp/ytd-test/downloads').includes('big.mp4'), 'full size original not left in the save folder');

// 3. several links at once, back as normal video
await lookup(VID);
await page.click('#typeSeg button[data-v="video"]');
await page.click('#cancelCardBtn');
await page.focus('#linkInput');
await page.evaluate((t) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  document.querySelector('#linkInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, `${VID}\nhttps://www.youtube.com/watch?v=TESTVID0002`);
await page.waitForSelector('#card.list-mode:not([hidden])');
ok((await page.textContent('#title')) === '2 links', 'two pasted links open a list');
await page.screenshot({ path: shots + '12-links.png' });
await page.click('#downloadBtn');
await page.waitForFunction(() => document.querySelectorAll('.item.done, .item.failed').length >= 4, null, { timeout: 90000 }).catch(() => {});
console.log('after links:', await page.$$eval('.item', (els) => els.map((e) => e.className + ' | ' + e.querySelector('.status').textContent)));

// 4. copied link pickup
await state({ clipboard: VID });
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForSelector('#card:not([hidden])', { timeout: 20000 });
ok((await page.inputValue('#linkInput')) === VID, 'copied link filled in');
await page.click('#cancelCardBtn');
await page.fill('#linkInput', '');

// 5. send to phone
await state({ connector: true });
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForSelector('.item.done button[data-a="phone"]', { timeout: 20000 });
await page.click('.item.done button[data-a="phone"]');
await page.waitForFunction(() => /sent to phone/.test(document.querySelector('.item.done .status').textContent), null, { timeout: 10000 });
ok((await state()).sent.length >= 1, 'file handed to Desktop Connector');

// 6. a page with two videos, one ticked
await state({ clipboard: '' });
await lookup('http://127.0.0.1:8099/page.html');
await page.waitForSelector('#card.list-mode');
ok((await page.$$eval('#pickList li', (l) => l.length)) === 2, 'page with two videos lists both');
await page.uncheck('#pickList li:nth-child(2) input');
ok((await page.textContent('#pickCount')) === '1 of 2 ticked', 'tick count');
await page.screenshot({ path: shots + '13-page-list.png' });
await page.click('#downloadBtn');
await waitDone(5);
a = lastArgs();
ok(a.includes('--referer'), 'embedded video carries the page as referer');

// 7. a message from the extension
const payload = {
  page: { url: 'http://127.0.0.1:8099/ext.html', title: 'Clinic sample page' },
  items: [
    { url: 'http://127.0.0.1:8099/clip.mp4', title: 'Clinic sample page (video 1)', kind: 'media', thumb: 'http://127.0.0.1:8099/thumb.jpg' },
    { url: VID, title: 'Procedure walkthrough', kind: 'embed' },
  ],
  cookies: [{ domain: '.example.com', path: '/', name: 'sid', value: 'abc', secure: true, httpOnly: true, expirationDate: 2000000000 }],
};
const r = await fetch('http://127.0.0.1:47821/add', { method: 'POST', headers: { origin: 'chrome-extension://testid', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
ok(r.ok, 'extension message accepted');
await page.waitForFunction(() => document.querySelector('#title').textContent === 'Clinic sample page', null, { timeout: 10000 });
ok((await page.$$eval('#pickList li', (l) => l.length)) === 2, 'extension list shows both videos');
await page.screenshot({ path: shots + '14-from-extension.png' });
await page.click('#downloadBtn');
await waitDone(7);
a = JSON.parse(readFileSync('/tmp/ytd-test/argv.log', 'utf8').trim().split('\n').slice(-2)[0]);
const all = readFileSync('/tmp/ytd-test/argv.log', 'utf8');
ok(/--cookies/.test(all), 'sign-in file passed to yt-dlp');
ok(readdirSync('/tmp/ytd-test/downloads').some((f) => f.startsWith('Clinic sample page (video 1)')), 'stream saved under the name the extension gave it');
const forbidden = await fetch('http://127.0.0.1:47821/add', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
ok(forbidden.status === 403, 'a web page cannot send links');

await page.screenshot({ path: shots + '15-list.png', fullPage: true });
console.log('files:', readdirSync('/tmp/ytd-test/downloads'));
console.log('errors:', errors);
await browser.close();
