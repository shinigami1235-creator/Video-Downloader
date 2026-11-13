// Instagram titles every post "Video by" and the account: two posts from one account must
// both be saved, a half-written file must be fetched again, and a link pasted twice in a
// row must read as one link.
import { chromium } from 'playwright';
import { rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const DL = '/tmp/ytd-test/downloads';
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
const opens = (f) => /Duration: \d/.test(spawnSync('ffmpeg', ['-hide_banner', '-i', `${DL}/${f}`], { encoding: 'utf8' }).stderr);
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });

// what FFmpeg leaves when it is stopped part way: a header and no index
const half = Buffer.concat([Buffer.from('0000001c667479706973736f6d0000020069736f6d69736f326d703431000000086672656500000000', 'hex'), 'mdat', Buffer.alloc(200000, 7)].map((b) => (typeof b === 'string' ? Buffer.from(b) : b)));
writeFileSync(`${DL}/Video by testuser (IGPOST3).mp4`, half);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const app = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [];
app.on('pageerror', (e) => errors.push(String(e)));
await app.goto('http://localhost:5173/');
await app.waitForSelector('#linkInput');
await app.waitForTimeout(800);
const get = async (link, n) => {
  await app.fill('#linkInput', link);
  await app.click('#lookBtn');
  await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
  await app.click('#downloadBtn');
  await app.waitForFunction((n) => document.querySelectorAll('.item.done, .item.failed').length >= n, n, { timeout: 120000 });
};

// 1. a link pasted twice in a row
await get('https://www.instagram.com/p/IGPOST1/https://www.instagram.com/p/IGPOST1/', 1);
ok((await app.inputValue('#linkInput')) === 'https://www.instagram.com/p/IGPOST1/' || (await app.inputValue('#linkInput')) === '', 'the doubled link was read as one');
// 2. a second post from the same account
await get('https://www.instagram.com/p/IGPOST2/', 2);
let files = readdirSync(DL).filter((f) => f.endsWith('.mp4')).sort();
console.log('files:', files);
ok(files.includes('Video by testuser (IGPOST1).mp4') && files.includes('Video by testuser (IGPOST2).mp4'), 'both posts were saved under their own names');
// 3. a post whose file is already there, half written
await get('https://www.instagram.com/p/IGPOST3/', 3);
const status = await app.textContent('.item .status');
console.log('third:', status);
ok(opens('Video by testuser (IGPOST3).mp4'), 'the half-written file was downloaded again and opens');
ok(!(await app.$$eval('.item.failed', (l) => l.length)), 'nothing failed');
console.log('errors:', errors);
ok(!errors.length, 'no page errors');
await browser.close();
