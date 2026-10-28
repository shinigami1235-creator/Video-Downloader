// After the extension sends something from a site, a link from that site pasted into
// the box carries the same sign-in until the app closes.
import { chromium } from 'playwright';
import { rmSync, readFileSync, existsSync } from 'node:fs';
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
rmSync('/tmp/ytd-test/argv.log', { force: true });
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/appdata/settings.json', { force: true });
rmSync('/tmp/ytd-test/downloads', { recursive: true, force: true });
await fetch('http://127.0.0.1:5174/api/test/state', { method: 'POST', body: JSON.stringify({ clipboard: '', connector: false, sent: [] }) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const app = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await app.goto('http://localhost:5173/');
await app.waitForSelector('#linkInput');
await app.waitForTimeout(800);
const lastArgs = () => JSON.parse(readFileSync('/tmp/ytd-test/argv.log', 'utf8').trim().split('\n').pop());

// a pasted Instagram link before any sign-in goes without one
await app.fill('#linkInput', 'https://www.instagram.com/stories/testuser/');
await app.click('#lookBtn');
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
ok(!lastArgs().includes('--cookies'), 'no sign-in before the extension sent one');
await app.click('#cancelCardBtn');

// the extension sends a story with Instagram cookies
const payload = {
  page: { url: 'https://www.instagram.com/stories/testuser/', title: 'Instagram' },
  items: [{ url: 'http://127.0.0.1:8099/clip.mp4', title: 'Story', kind: 'media' }],
  cookies: [{ domain: '.instagram.com', path: '/', name: 'sessionid', value: 'abc', secure: true, httpOnly: true, expirationDate: 2000000000 }],
};
await fetch('http://127.0.0.1:47821/add', { method: 'POST', headers: { origin: 'chrome-extension://testid', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
await app.click('#downloadBtn');
await app.waitForFunction(() => document.querySelectorAll('.item.done, .item.failed').length >= 1, null, { timeout: 60000 });
const site = '/tmp/ytd-test/cache/sign-in/site-instagram.com.txt';
ok(existsSync(site), 'site sign-in kept after the download finished');

// now a pasted Instagram link carries it
await app.fill('#linkInput', 'https://www.instagram.com/stories/testuser/');
await app.click('#lookBtn');
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
const a = lastArgs();
ok(a[a.indexOf('--cookies') + 1] === site, 'pasted Instagram link uses the remembered sign-in');
await app.click('#cancelCardBtn');

// a link from another site does not
await app.fill('#linkInput', 'https://www.youtube.com/watch?v=TESTVID0001');
await app.click('#lookBtn');
await app.waitForSelector('#card:not([hidden])', { timeout: 20000 });
ok(!lastArgs().includes('--cookies'), 'other sites go without it');
await browser.close();
