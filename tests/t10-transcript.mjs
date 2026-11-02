// Transcripts: from a link with the sound thrown away, with the video kept, and from a
// file on this computer, which stays where it is. Runs the real whisper.cpp with the
// tiny model standing in for the Good one.
import { chromium } from 'playwright';
import { rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
const DL = '/tmp/ytd-test/downloads';
const TALK = 'https://www.youtube.com/watch?v=TESTTALK01';
const LOCAL = new URL('./media/talk.mp4', import.meta.url).pathname;
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
rmSync(DL, { recursive: true, force: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ clipboard: '', connector: false, sent: [] }) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const app = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
const errors = [];
app.on('pageerror', (e) => errors.push(String(e)));
await app.goto('http://localhost:5173/');
await app.waitForSelector('#linkInput');
await app.waitForTimeout(800);
const lookup = async () => {
  await app.fill('#linkInput', TALK);
  await app.click('#lookBtn');
  await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
};
const waitDone = (n) => app.waitForFunction((n) => document.querySelectorAll('.item.done, .item.failed').length >= n, n, { timeout: 120000 });
const workLeft = () => (existsSync('/tmp/ytd-test/cache/tools/work') ? readdirSync('/tmp/ytd-test/cache/tools/work').filter((d) => !d.startsWith('.')) : []);

// 1. a link, keeping only the transcript
await lookup();
await app.click('#typeSeg [data-v="transcript"]');
ok(!(await app.isHidden('#sttRows')), 'transcript choices show');
ok(await app.isHidden('#qualityRow'), 'quality hidden while the video is not kept');
await app.screenshot({ path: new URL('./shots/60-transcript.png', import.meta.url).pathname });
await app.click('#downloadBtn');
await app.waitForFunction(() => /Listening|Preparing/.test(document.querySelector('.item .status')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
await waitDone(1);
let status = await app.textContent('.item .status');
let files = readdirSync(DL);
console.log('status:', status, 'files:', files);
ok(files.length === 1 && files[0] === 'talk.txt', 'only the transcript is left');
const text = readFileSync(`${DL}/talk.txt`, 'utf8');
console.log('transcript:', JSON.stringify(text));
ok(/clinic/i.test(text) && /treatment/i.test(text), 'the words were heard');
ok(workLeft().length === 0, 'the downloaded sound was deleted: ' + workLeft());

// 2. keeping the video, with subtitles and a word to fix
rmSync(DL, { recursive: true, force: true });
await app.click('#settingsBtn');
await app.fill('#sttWords', 'Claude\ntreatment = therapy');
await app.screenshot({ path: new URL('./shots/61-words.png', import.meta.url).pathname });
await app.click('#settingsClose');
await lookup();
await app.click('#typeSeg [data-v="transcript"]');
await app.check('#sttKeep');
await app.check('#sttSrt');
ok(!(await app.isHidden('#qualityRow')), 'quality shows when the video is kept');
await app.click('#downloadBtn');
await waitDone(2);
files = readdirSync(DL).sort();
console.log('files:', files, await app.textContent('.item .status'));
ok(files.includes('talk.mp4') && files.includes('talk.txt') && files.includes('talk.srt'), 'video, text and subtitles saved');
const fixed = readFileSync(`${DL}/talk.txt`, 'utf8') + readFileSync(`${DL}/talk.srt`, 'utf8');
ok(/therapy/.test(fixed) && !/treatment/i.test(fixed), 'treatment was swapped for therapy in the text and the subtitles');
await app.click('#settingsBtn');
await app.fill('#sttWords', '');
await app.click('#settingsClose');

// 3. a file already on this computer
rmSync(DL, { recursive: true, force: true });
await app.evaluate((p) => (window.__testDialogs = [p]), LOCAL);
await app.click('#sttFileBtn');
await waitDone(3);
files = readdirSync(DL).sort();
console.log('files:', files, await app.textContent('.item .status'));
ok(files.includes('talk.txt'), 'transcript of the local file saved');
ok(existsSync(LOCAL), 'the original file is still there');
ok(!files.includes('talk.mp4'), 'the original was not copied into the save folder');
console.log('errors:', errors);
await browser.close();
