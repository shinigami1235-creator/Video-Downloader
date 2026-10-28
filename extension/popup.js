// Lists the videos on the open page: players embedded in it, video tags with a
// real file behind them, and streams the page loaded while playing.

import { findApp, sendToApp, cookiesFor } from './common.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let found = [];

// Players yt-dlp reads from their embed address.
const PLAYERS = [
  [/youtube(-nocookie)?\.com\/embed\/([\w-]{11})/i, 'YouTube'],
  [/player\.vimeo\.com\/video\/\d+/i, 'Vimeo'],
  [/fast\.wistia\.(net|com)\/embed/i, 'Wistia'],
  [/players\.brightcove\.net/i, 'Brightcove'],
  [/(cdn|content)\.jwplayer\.com|jwplatform\.com\/players/i, 'JW Player'],
  [/dailymotion\.com\/embed/i, 'Dailymotion'],
  [/facebook\.com\/plugins\/video/i, 'Facebook'],
  [/streamable\.com\/[eo]\//i, 'Streamable'],
  [/loom\.com\/embed/i, 'Loom'],
  [/play\.vidyard\.com/i, 'Vidyard'],
  [/tiktok\.com\/embed/i, 'TikTok'],
  [/instagram\.com\/(p|reel)\/[\w-]+\/embed/i, 'Instagram'],
];

/** Runs inside the page and each frame in it. */
function scanPage() {
  const out = { title: document.title, url: location.href, frames: [], videos: [] };
  for (const f of document.querySelectorAll('iframe[src]')) {
    out.frames.push({ src: f.src, title: f.title || f.getAttribute('aria-label') || '' });
  }
  for (const v of document.querySelectorAll('video, audio')) {
    const sources = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter((s) => s && /^https?:/i.test(s));
    out.videos.push({ src: sources[0] || '', audio: v.tagName === 'AUDIO', poster: v.poster || '', duration: Number.isFinite(v.duration) ? v.duration : 0, title: v.title || v.getAttribute('aria-label') || '' });
  }
  return out;
}

function playerOf(url) {
  for (const [re, name] of PLAYERS) if (re.test(url)) return name;
  return '';
}

function youtubeThumb(url) {
  const m = /(?:embed\/|v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(url);
  return m ? `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` : '';
}

const clock = (s) => {
  s = Math.round(s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

function show(text, info = false) {
  $('msg').textContent = text || '';
  $('msg').className = 'msg' + (info ? ' info' : '');
  $('msg').hidden = !text;
}

async function collect() {
  // ?tab= lets the automated test open the popup as a page aimed at another tab
  const testTab = Number(new URLSearchParams(location.search).get('tab'));
  [tab] = testTab ? [await chrome.tabs.get(testTab)] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/i.test(tab.url)) return [];
  const items = [];
  const add = (x) => {
    if (x.url && !items.some((y) => y.url === x.url)) items.push(x);
  };

  // the page itself is the video on YouTube, TikTok, Instagram, X and similar sites
  if (/youtube\.com\/(watch|shorts)|youtu\.be\/|tiktok\.com\/@[^/]+\/video|instagram\.com\/((p|reel)s?|stories)\/|facebook\.com\/.+\/videos\/|vimeo\.com\/\d+|(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(tab.url)) {
    add({ url: tab.url, title: tab.title, detail: 'This page', thumb: youtubeThumb(tab.url), kind: 'page' });
  }

  let scans = [];
  try {
    scans = (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage })).map((r) => r.result).filter(Boolean);
  } catch {
    // pages such as the Chrome Web Store do not allow scripts
  }
  let players = 0;
  let files = 0;
  for (const s of scans) {
    for (const f of s.frames) {
      const name = playerOf(f.src);
      if (!name) continue;
      players += 1;
      add({ url: f.src, title: f.title && !/^(youtube|vimeo) (video )?player$/i.test(f.title) ? f.title : `${name} video ${players}`, detail: `${name} player`, thumb: youtubeThumb(f.src), kind: 'embed' });
    }
    for (const v of s.videos) {
      if (!v.src) continue;
      files += 1;
      const what = v.audio ? 'Audio file' : 'Video file';
      add({ url: v.src, title: v.title || (files > 1 ? `${tab.title} (${files})` : tab.title), detail: `${what}${v.duration ? ' · ' + clock(v.duration) : ''}`, thumb: v.poster, kind: 'media', duration: v.duration });
    }
  }

  const key = `streams-${tab.id}`;
  const streams = (await chrome.storage.session.get(key))[key] || [];
  streams.forEach((s, i) => {
    add({
      url: s.url,
      title: streams.length > 1 ? `${tab.title} (${i + 1})` : tab.title,
      detail: s.kind + (s.size ? ` · ${Math.round(s.size / 1e6)} MB` : '') + ' · loaded while playing',
      thumb: '',
      kind: 'media',
    });
  });
  return items;
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  for (const [i, x] of found.entries()) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.i = i;
    const th = document.createElement('span');
    th.className = 'thumb';
    if (x.thumb) th.style.backgroundImage = `url("${x.thumb.replace(/"/g, '%22')}")`;
    const name = document.createElement('span');
    name.className = 'name';
    const b = document.createElement('b');
    b.textContent = x.title;
    b.title = x.url;
    const d = document.createElement('span');
    d.textContent = x.detail;
    name.append(b, d);
    label.append(box, th, name);
    li.append(label);
    list.append(li);
  }
  $('pick').hidden = !found.length;
  count();
}

function picked() {
  return [...document.querySelectorAll('#list input')].filter((c) => c.checked).map((c) => found[Number(c.dataset.i)]);
}

function count() {
  const n = picked().length;
  $('count').textContent = `${n} of ${found.length} ticked`;
  $('all').checked = n === found.length;
  $('all').indeterminate = n > 0 && n < found.length;
  $('sendBtn').disabled = !n;
  $('sendBtn').textContent = n > 1 ? `Send ${n} to the app` : 'Send to the app';
}

async function send(items) {
  $('sendBtn').disabled = true;
  $('pageBtn').disabled = true;
  try {
    const page = { url: tab.url, title: tab.title };
    const cookies = $('signIn').checked ? await cookiesFor([tab.url, ...items.map((x) => x.url)]) : [];
    const ok = await sendToApp({ page, items: items.map(({ url, title, thumb, kind, duration }) => ({ url, title, thumb, kind, duration })), cookies });
    if (!ok) throw new Error('closed');
    window.close();
  } catch {
    show('Open the Video Downloader app, then press Send again.');
    $('sendBtn').disabled = !picked().length;
    $('pageBtn').disabled = false;
  }
}

async function main() {
  const { signIn = true } = await chrome.storage.local.get('signIn');
  $('signIn').checked = signIn;
  $('signIn').addEventListener('change', () => chrome.storage.local.set({ signIn: $('signIn').checked }));
  $('all').addEventListener('change', () => {
    for (const c of document.querySelectorAll('#list input')) c.checked = $('all').checked;
    count();
  });
  $('list').addEventListener('change', count);
  $('sendBtn').addEventListener('click', () => send(picked()));
  $('pageBtn').addEventListener('click', () => send([{ url: tab.url, title: tab.title, kind: 'page' }]));

  const [items, port] = await Promise.all([collect(), findApp()]);
  found = items;
  render();
  $('pageBtn').disabled = !tab?.url || !/^https?:/i.test(tab.url);
  if (!port) show('Open the Video Downloader app first.');
  else if (!found.length) show('No video found yet. Play the video for a few seconds and open this again, or press Send the page link.', true);
  else show('');
}

main();
