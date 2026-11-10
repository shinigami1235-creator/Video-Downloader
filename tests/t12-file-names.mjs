// File names with letters Windows' old code page can't carry (· ｜ ’ and Thai): the app has
// to keep the real name so Open and Show in folder reach the file, and an entry saved the
// old broken way still finds its file.
import { chromium } from 'playwright';
import { rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const DL = '/tmp/ytd-test/downloads';
const HIST = '/tmp/ytd-test/appdata/history.json';
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
const state = async () => (await (await fetch('http://127.0.0.1:5174/api/test/state')).json());
rmSync(DL, { recursive: true, force: true });
rmSync(HIST, { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ clipboard: '', connector: false, sent: [], opened: '', revealed: '' }) });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const app = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [];
app.on('pageerror', (e) => errors.push(String(e)));
await app.goto('http://localhost:5173/');
await app.waitForSelector('#linkInput');
await app.waitForTimeout(800);
await app.fill('#linkInput', 'https://www.facebook.com/reel/5550001');
await app.click('#lookBtn');
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
await app.click('#downloadBtn');
await app.waitForFunction(() => document.querySelectorAll('.item.done, .item.failed').length >= 1, null, { timeout: 120000 });

const files = readdirSync(DL);
console.log('on disk:', files);
const saved = JSON.parse(readFileSync(HIST, 'utf8'));
const items = Array.isArray(saved) ? saved : saved.items;
const path = items[0].files[0];
console.log('in the list:', path);
ok(files.length === 1 && /·.*｜.*ทดสอบ.*’/.test(files[0]), 'the file has its real name');
ok(existsSync(path), 'the list holds the real path');

await app.click('.item button[data-a="open"]');
await app.waitForTimeout(500);
ok((await state()).opened === path, 'Open gets the file');
await app.click('.item button[data-a="reveal"]');
await app.waitForTimeout(500);
ok((await state()).revealed === path, 'Show in folder gets the file');

// an entry saved by an older version, with · turned into the broken-letter mark and Thai dropped
const broken = path.replace('·', '�').replace('ทดสอบ', '').replace('’', '�');
items[0].files = [broken];
writeFileSync(HIST, JSON.stringify(saved));
await app.reload();
await app.waitForSelector('.item button[data-a="open"]');
await app.waitForTimeout(500);
await app.click('.item button[data-a="open"]');
await app.waitForTimeout(800);
ok((await state()).opened === path, 'an old broken entry still opens the right file');
const after = JSON.parse(readFileSync(HIST, 'utf8'));
ok((Array.isArray(after) ? after : after.items)[0].files[0] === path, 'and the list is corrected');

// a transcript of the same link, which goes through FFmpeg and the speech program by name
rmSync(DL, { recursive: true, force: true });
await app.fill('#linkInput', 'https://www.facebook.com/reel/5550001');
await app.click('#lookBtn');
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
await app.click('#typeSeg [data-v="transcript"]');
await app.click('#downloadBtn');
await app.waitForFunction(() => document.querySelectorAll('.item.done, .item.failed').length >= 2, null, { timeout: 180000 });
const tfiles = readdirSync(DL);
const status = await app.textContent('.item .status');
console.log('transcript:', tfiles, status);
ok(tfiles.length === 1 && /ทดสอบ.*\.txt$/.test(tfiles[0]) && /laser/i.test(readFileSync(`${DL}/${tfiles[0]}`, 'utf8')), 'the transcript is saved under the real name');
console.log('errors:', errors);
ok(!errors.length, 'no page errors');
await browser.close();
