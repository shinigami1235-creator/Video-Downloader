// Several parts, joining, chapters, the preview player and playlist links.
import { chromium } from 'playwright';
import { rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const shots = new URL('./shots/', import.meta.url).pathname;
const VID = 'https://www.youtube.com/watch?v=TESTVID0001';
const DL = '/tmp/ytd-test/downloads';
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
const length = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

rmSync(DL, { recursive: true, force: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ clipboard: '', connector: false, sent: [] }) });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
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
const waitDone = (n) => page.waitForFunction((n) => document.querySelectorAll('.item.done, .item.failed').length >= n, n, { timeout: 120000 });
const seek = (t) => page.evaluate((t) => new Promise((r) => { const v = document.querySelector('#preview'); v.addEventListener('seeked', r, { once: true }); v.currentTime = t; }), t);

// 1. two parts marked on the preview, kept as two files
await lookup(VID);
await page.click('#partSeg button[data-v="times"]');
await page.waitForFunction(() => document.querySelector('#preview').readyState >= 1, null, { timeout: 15000 });
ok(!(await page.isHidden('#previewBox')), 'preview player shows');
await seek(5);
await page.click('#markStart');
await seek(12);
await page.click('#markEnd');
const row1 = await page.$$eval('#partList li:first-child input', (i) => i.map((x) => x.value));
ok(row1.join(' ') === '0:05 0:12', 'marked times ' + row1.join(' '));
await page.click('#addPart');
ok((await page.inputValue('#partList li:nth-child(2) .from')) === '0:12', 'new part starts where the last ended');
ok(await page.isHidden('#joinRow') === false, 'join option shows with two parts');
await page.fill('#partList li:nth-child(2) .to', '0:08');
await page.click('#downloadBtn');
ok(/^Part 2: The end time/.test(await page.textContent('#cardMsg')), 'bad part named in the message');
await page.fill('#partList li:nth-child(2) .to', '0:20');
await page.screenshot({ path: shots + '30-parts.png' });
await page.click('#downloadBtn');
await waitDone(1);
let files = readdirSync(DL);
console.log('files:', files);
ok(files.length === 2 && files.every((f) => / to /.test(f)), 'two part files');
ok(/Saved 2 parts/.test(await page.textContent('.item .status')), 'status says 2 parts');

// 2. the same two parts joined
rmSync(DL, { recursive: true, force: true });
await lookup(VID);
await page.click('#partSeg button[data-v="times"]');
await page.fill('#partList li:first-child .from', '0:05');
await page.fill('#partList li:first-child .to', '0:12');
await page.click('#addPart');
await page.fill('#partList li:nth-child(2) .from', '0:20');
await page.fill('#partList li:nth-child(2) .to', '0:28');
await page.check('#joinOn');
await page.click('#downloadBtn');
await waitDone(2);
files = readdirSync(DL);
console.log('files:', files, 'status:', await page.textContent('.item .status'));
ok(files.length === 1 && /2 parts/.test(files[0]), 'one joined file');
const len = files[0] ? length(`${DL}/${files[0]}`) : 0;
ok(len > 13 && len < 17, 'joined file is about 15 s long: ' + len);

// 3. chapters, as MP3
rmSync(DL, { recursive: true, force: true });
await lookup(VID);
await page.click('#typeSeg button[data-v="mp3"]');
await page.click('#partSeg button[data-v="chapters"]');
const chapters = await page.$$eval('#chapterList .pick-title', (t) => t.map((x) => x.textContent));
ok(chapters.join('|') === 'Intro|Steps', 'chapter list');
await page.click('#downloadBtn');
ok((await page.textContent('#cardMsg')) === 'Tick at least one chapter.', 'needs a chapter');
await page.check('#chapterList li:nth-child(1) input');
await page.check('#chapterList li:nth-child(2) input');
await page.screenshot({ path: shots + '31-chapters.png' });
await page.click('#downloadBtn');
await waitDone(3);
files = readdirSync(DL).sort();
console.log('files:', files);
ok(files.join('|') === 'clip (Intro).mp3|clip (Steps).mp3', 'one MP3 per chapter, named after it');
await page.click('#typeSeg button[data-v="video"]').catch(() => {});

// 4. a video opened from a playlist
await lookup('https://www.youtube.com/watch?v=TESTVID0001&list=PLTEST');
ok(!(await page.isHidden('#playlistRow')) && !(await page.isHidden('#partRow')), 'video card with playlist switch and parts');
ok((await page.textContent('#plSeg [data-v="all"]')) === 'Whole playlist (2 videos)', 'switch names the playlist size');
await page.screenshot({ path: shots + '32-playlist-video.png' });
await page.click('#plSeg [data-v="all"]');
ok((await page.$$eval('#pickList li', (l) => l.length)) === 2, 'whole playlist lists both');
await page.click('#plSeg [data-v="one"]');
ok((await page.textContent('#title')) === 'Clinic tour test clip', 'back to the one video');

console.log('errors:', errors);
await browser.close();
