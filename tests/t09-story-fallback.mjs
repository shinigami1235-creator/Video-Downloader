// A single Instagram story whose story page fails is read again as a post, with the sign-in.
import { chromium } from 'playwright';
import { rmSync, readdirSync } from 'node:fs';
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1; };
const ok = (c, m) => (c ? console.log('ok', m) : fail(m));
rmSync('/tmp/ytd-test/appdata/history.json', { force: true });
rmSync('/tmp/ytd-test/downloads', { recursive: true, force: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const app = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await app.goto('http://localhost:5173/');
await app.waitForSelector('#linkInput');
await app.waitForTimeout(800);
const STORY = 'https://www.instagram.com/stories/testuser/4017064269887659683/';
const payload = { page: { url: STORY, title: 'Stories • Instagram' }, items: [{ url: STORY, title: 'Stories • Instagram', kind: 'page' }],
  cookies: [{ domain: '.instagram.com', path: '/', name: 'sessionid', value: 'abc', secure: true, httpOnly: true, expirationDate: 2000000000 }] };
await fetch('http://127.0.0.1:47821/add', { method: 'POST', headers: { origin: 'chrome-extension://testid', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
await app.waitForSelector('#card:not([hidden])', { timeout: 30000 });
ok((await app.textContent('#title')) === 'Video by testuser', 'story read as a post');
await app.click('#downloadBtn');
await app.waitForFunction(() => document.querySelectorAll('.item.done, .item.failed').length >= 1, null, { timeout: 60000 });
console.log('status:', await app.textContent('.item .status'), readdirSync('/tmp/ytd-test/downloads'));
ok(/^Saved/.test(await app.textContent('.item .status')), 'story saved');
await browser.close();
