import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles.css';

import { initBackend, paths, join, invoke, on, readJson, writeJson, openDialog, mkdir, remove, writeText, list, exists } from './backend/index.js';
import { locateTools, missingTools, installTools, SETUP_STEPS, stepSize, updateYtdlp, ytdlpVersion, toolsDir, tools } from './engine/tools.js';
import { lookUp, isYouTube } from './engine/ytdlp.js';
import { MODELS, LANGUAGES } from './engine/transcribe.js';
import { Queue } from './engine/queue.js';

const $ = (id) => document.getElementById(id);
const settingsFile = () => join(paths.appData, 'settings.json');
const cookiesDir = () => join(paths.cache, 'sign-in');
const DAY = 20 * 3600 * 1000;

const settings = {
  folder: '',
  type: 'video',
  height: 1080,
  smallMB: 50,
  thumb: false,
  sponsor: false,
  phone: false,
  subsOn: false,
  limit: 2,
  clipboard: true,
  firefox: false,
  lastUpdate: 0,
  sttLang: 'auto',
  sttModel: 'good',
  sttTranslate: false,
  sttSrt: false,
  sttKeep: false,
  gpu: false,
  sttWords: '',
};

/**
 * What the card shows. One of:
 *  { mode: 'one', info, auth }                     a single looked-up video
 *  { mode: 'list', info?, entries, auth, ytList }   a playlist, a page with several
 *                                                   videos, or several links at once
 */
let current = null;
let lookController = null;
let queue = null;
let connectorUp = false;
let extensionSeen = false;
let lastClip = '';

// ---- small helpers ----------------------------------------------------------

function mb(bytes) {
  if (!bytes) return '';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

export function clock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "1:05", "65" or "1:02:30" in seconds, or NaN. */
export function parseClock(text) {
  const t = String(text).trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return NaN;
  return t.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

function leftText(sec) {
  if (!sec) return '';
  if (sec < 60) return `${Math.round(sec)} s left`;
  if (sec < 3600) return `${Math.round(sec / 60)} min left`;
  return `${(sec / 3600).toFixed(1)} h left`;
}

function show(el, text, kind = '') {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function setSeg(seg, value) {
  for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(value));
}

function onSeg(seg, cb) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(seg, b.dataset.v);
    cb(b.dataset.v);
  });
}

async function saveSettings() {
  await writeJson(settingsFile(), settings).catch(() => {});
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const LINK_RE = /https?:\/\/[^\s"'<>]+/gi;
const looksLikeLink = (t) => /^https?:\/\/\S+$/i.test(t.trim()) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\/\S+$/i.test(t.trim());
const linksIn = (text) => [...new Set((String(text).match(LINK_RE) || []).map((l) => l.replace(/[),.;]+$/, '')))];

function shortLink(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '') + (u.search.length > 1 ? u.search.slice(0, 24) : '');
  } catch {
    return url;
  }
}

// ---- first start: tools -------------------------------------------------------

async function ensureTools() {
  await locateTools();
  if (!missingTools().length) return;
  const overlay = $('setup');
  const list = $('setupList');
  overlay.hidden = false;
  list.innerHTML = SETUP_STEPS.map(
    (s) => `<li data-k="${s.key}"><div class="top-line"><span>${s.name} <span class="dim">${stepSize(s)}</span></span><span class="state">Waiting</span></div><div class="bar"><i></i></div></li>`,
  ).join('');
  for (const s of SETUP_STEPS) if (tools[s.key]) markStep(s.key, 1, 1);

  for (;;) {
    show($('setupMsg'), '');
    $('setupRetry').hidden = true;
    try {
      await installTools(markStep);
      overlay.hidden = true;
      settings.lastUpdate = Date.now();
      await saveSettings();
      return;
    } catch (e) {
      show($('setupMsg'), `The download stopped: ${e?.message || e}. Check the internet connection and press Retry.`);
      $('setupRetry').hidden = false;
      await new Promise((r) => $('setupRetry').addEventListener('click', r, { once: true }));
    }
  }
}

function markStep(key, received, total) {
  const li = document.querySelector(`#setupList li[data-k="${key}"]`);
  if (!li) return;
  const state = li.querySelector('.state');
  const bar = li.querySelector('.bar > i');
  if (received === -1) {
    state.textContent = 'Unpacking';
    bar.style.width = '100%';
  } else if (received === 1 && total === 1) {
    li.classList.add('ready');
    state.textContent = 'Ready';
    bar.style.width = '100%';
  } else {
    const pct = total ? Math.floor((received / total) * 100) : 0;
    state.textContent = total ? `${mb(received)} of ${mb(total)}` : mb(received);
    bar.style.width = pct + '%';
  }
}

// ---- sign-in sent by the extension ---------------------------------------------------

/** Writes the browser's cookies in the Netscape format yt-dlp reads. */
async function writeCookies(cookies, name = '') {
  if (!Array.isArray(cookies) || !cookies.length) return '';
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    if (!c?.name || !c.domain) continue;
    const hostOnly = c.hostOnly || !c.domain.startsWith('.');
    const domain = (c.httpOnly ? '#HttpOnly_' : '') + c.domain;
    const expiry = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
    lines.push([domain, hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expiry, c.name, String(c.value ?? '').replace(/[\r\n\t]/g, '')].join('\t'));
  }
  if (lines.length === 1) return '';
  await mkdir(cookiesDir());
  const file = join(cookiesDir(), name ? `${name}.txt` : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await writeText(file, lines.join('\n') + '\n');
  return file;
}

/** www.instagram.com and .instagram.com both become instagram.com. */
const siteOf = (host) => String(host || '').replace(/^\./, '').toLowerCase().split('.').slice(-2).join('.');

/**
 * The sign-in the extension last sent for each site, kept while the app is open, so a
 * link pasted into the box later carries it too. Cleared when the app starts.
 */
const signedIn = new Map();

async function rememberSignIn(cookies) {
  const bySite = new Map();
  for (const c of cookies || []) {
    if (!c?.domain) continue;
    const site = siteOf(c.domain);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(c);
  }
  for (const [site, list] of bySite) {
    const file = await writeCookies(list, `site-${site}`).catch(() => '');
    if (file) signedIn.set(site, file);
  }
}

function pastedAuth(referer = '', url = '') {
  let site = '';
  try {
    site = siteOf(new URL(url).hostname);
  } catch {
    // no link yet
  }
  if (site && signedIn.has(site)) return { referer, cookiesFile: signedIn.get(site) };
  return { referer, browser: settings.firefox ? 'firefox' : '' };
}

// ---- looking up a link ----------------------------------------------------------

/** "4f1c-9a.mp3" in a link becomes "4f1c-9a". */
function fileStem(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, ''));
  } catch {
    return '';
  }
}

/**
 * yt-dlp reads one Instagram story through the story page, which Instagram changes
 * often. The same story is also a post, read through Instagram's own app interface
 * with the sign-in, so when the story page fails the post link is tried.
 * instagram.com/stories/name/4017064269887659683 becomes instagram.com/p/De_equOkV6j
 */
export function instagramPostUrl(url) {
  const m = /instagram\.com\/stories\/(?!highlights\/)[^/?#]+\/(\d{6,})/i.exec(url);
  if (!m) return '';
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(m[1]);
  let code = '';
  while (n > 0n) {
    code = table[Number(n % 64n)] + code;
    n /= 64n;
  }
  return `https://www.instagram.com/p/${code}/`;
}

async function lookUpWithFallback(url, opts) {
  try {
    return await lookUp(url, opts);
  } catch (e) {
    const alt = instagramPostUrl(url);
    const signedIn = opts.auth?.cookiesFile || opts.auth?.browser;
    if (!alt || !signedIn || e?.name === 'AbortError') throw e;
    try {
      return await lookUp(alt, opts);
    } catch (e2) {
      if (e2?.name === 'AbortError') throw e2;
      throw Object.assign(new Error(e.message), { details: [e.details, e2.details].filter(Boolean).join('\n') });
    }
  }
}

/** The playlist id in a watch link opened from a playlist, or ''. */
function listInLink(url) {
  try {
    const u = new URL(url);
    return /youtube\.com$/.test(u.hostname) && u.searchParams.get('v') ? u.searchParams.get('list') || '' : '';
  } catch {
    return '';
  }
}

async function look(url = $('linkInput').value.trim(), auth = null, fallbackTitle = '') {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  auth ||= pastedAuth('', url);
  lookController?.abort();
  const controller = new AbortController();
  lookController = controller;
  $('lookBtn').disabled = true;
  show($('linkMsg'), 'Reading the link', 'info');
  showDetails('');
  try {
    // a watch link opened from a playlist reads the video and the playlist side by side,
    // and the card opens on the video with a switch to the whole playlist
    if (listInLink(url)) {
      const id = new URL(url).searchParams.get('v');
      const [video, playlist] = await Promise.all([
        lookUp(`https://www.youtube.com/watch?v=${id}`, { signal: controller.signal, auth }),
        lookUp(url, { signal: controller.signal, auth }).catch(() => null),
      ]);
      if (controller !== lookController) return;
      show($('linkMsg'), '');
      const pair = playlist?.kind === 'playlist' && playlist.entries.length > 1 ? { video, playlist, auth } : null;
      return openOne(video, auth, pair);
    }
    const info = await lookUpWithFallback(url, { signal: controller.signal, auth });
    if (controller !== lookController) return;
    show($('linkMsg'), '');
    if (info.kind === 'playlist') {
      // a page with one embedded video comes back as a list of one
      if (!isYouTube(info.site) && info.entries.length === 1 && info.entries[0].url) {
        return look(info.entries[0].url, { ...auth, referer: auth.referer || url }, info.title);
      }
      if (!info.entries.length) throw new Error('No video was found on this page. Play the video in the browser and use the browser extension.');
      openList({
        info,
        title: info.title,
        sub: [info.channel, `${info.count} videos`].filter(Boolean).join(' · '),
        entries: info.entries,
        auth: isYouTube(info.site) ? auth : { ...auth, referer: auth.referer || url },
        ytList: isYouTube(info.site),
      });
    } else {
      // a file a page plays is titled after its file name, so the page's own title reads better
      if (fallbackTitle && (/^(index|master|playlist|video|embed)$/i.test(info.title) || info.title === info.id || info.title === fileStem(url))) {
        info.title = fallbackTitle;
        info.fixedName = true;
      }
      openOne(info, auth);
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    show($('linkMsg'), e?.message || String(e));
    showDetails(e?.details || '');
  } finally {
    if (controller === lookController) $('lookBtn').disabled = false;
  }
}

/** yt-dlp's own words under a failed look-up, behind a Details button. */
function showDetails(text) {
  $('linkDetails').hidden = !text;
  $('linkDetailsText').textContent = text;
  $('linkDetailsText').hidden = true;
}

function closeCard() {
  $('card').hidden = true;
  stopPreview();
  current = null;
}

/** pair: { video, playlist, auth } when the link named a video inside a playlist. */
function openOne(info, auth, pair = null) {
  current = { mode: 'one', info, auth, pair, partMode: 'whole' };
  $('card').hidden = false;
  $('card').classList.remove('list-mode');
  $('thumbBox').hidden = false;
  $('thumb').src = info.thumb || '';
  $('thumb').hidden = !info.thumb;
  $('title').textContent = info.title;
  $('dur').textContent = info.duration ? clock(info.duration) : '';
  $('dur').hidden = !info.duration;
  $('sub').textContent = [info.channel, siteName(info.site)].filter(Boolean).join(' · ');
  $('pickBox').hidden = true;
  showPlaylistSwitch(pair, 'one');
  resetParts(info);
  $('subs').innerHTML = '<option value="">None</option>' + (info.subs || []).map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
  const pref = (info.subs || []).find((s) => /^en/.test(s.code)) || (info.subs || [])[0];
  $('subs').value = settings.subsOn && pref ? pref.code : '';
  renderOptions();
  show($('cardMsg'), info.isLive ? 'This is a live stream. It can be downloaded once the stream ends.' : '');
  $('downloadBtn').disabled = !!info.isLive;
  $('downloadBtn').textContent = 'Download';
}

function showPlaylistSwitch(pair, which) {
  $('playlistRow').hidden = !pair;
  if (!pair) return;
  $('plSeg').querySelector('[data-v="all"]').textContent = `Whole playlist (${pair.playlist.count} videos)`;
  setSeg($('plSeg'), which);
}

function siteName(site) {
  if (!site || /^(generic|youtube)/i.test(site)) return '';
  return site.replace(/IE$/, '');
}

/** A list of videos to tick: a playlist, a page with several videos, or pasted links. */
function openList({ info = null, title, sub, entries, auth, ytList = false, pair = null }) {
  stopPreview();
  current = { mode: 'list', info, entries, auth, ytList, pair };
  $('card').hidden = false;
  $('card').classList.add('list-mode');
  $('thumbBox').hidden = true;
  $('title').textContent = title;
  $('sub').textContent = sub || '';
  $('pickBox').hidden = false;
  $('pickList').innerHTML = entries
    .map(
      (e, i) => `<li><label class="check pick-row"><input type="checkbox" data-i="${i}" checked />
        <span class="pick-thumb">${e.thumb ? `<img src="${esc(e.thumb)}" alt="" loading="lazy" />` : ''}</span>
        <span class="pick-title" title="${esc(e.url)}">${esc(e.title || shortLink(e.url))}</span>
        <span class="dim pick-dur">${e.duration ? clock(e.duration) : ''}</span></label></li>`,
    )
    .join('');
  $('pickAll').checked = true;
  showPlaylistSwitch(pair, 'all');
  $('subs').innerHTML = '<option value="">None</option><option value="en.*">English, where the video has it</option>';
  $('subs').value = settings.subsOn ? 'en.*' : '';
  renderOptions();
  updatePickCount();
  show($('cardMsg'), '');
  $('downloadBtn').disabled = false;
}

function openPlaylist(pair) {
  const p = pair.playlist;
  openList({ info: p, title: p.title, sub: [p.channel, `${p.count} videos`].filter(Boolean).join(' · '), entries: p.entries, auth: pair.auth, ytList: true, pair });
}

function pickedIndexes() {
  return [...$('pickList').querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => Number(c.dataset.i));
}

function updatePickCount() {
  if (!current || current.mode !== 'list') return;
  const n = pickedIndexes().length;
  const total = current.entries.length;
  $('pickCount').textContent = `${n} of ${total} ticked`;
  $('pickAll').checked = n === total;
  $('pickAll').indeterminate = n > 0 && n < total;
  $('downloadBtn').textContent = n > 1 ? `Download ${n}` : 'Download';
  $('downloadBtn').disabled = !n;
}

// ---- parts of a video -----------------------------------------------------------------

let activePart = 0;

function resetParts(info) {
  stopPreview();
  activePart = 0;
  $('partList').innerHTML = '';
  addPartRow(0, info.duration || 0);
  $('chapterList').innerHTML = (info.chapterList || [])
    .map(
      (ch, i) => `<li><label class="check pick-row chapter-row"><input type="checkbox" data-i="${i}" />
        <span class="pick-title">${esc(ch.title)}</span>
        <span class="dim pick-dur">${clock(ch.start)} to ${clock(ch.end)}</span></label></li>`,
    )
    .join('');
  $('joinOn').checked = false;
  setPartMode('whole');
}

function addPartRow(from, to) {
  const li = document.createElement('li');
  li.className = 'part-row';
  li.innerHTML = `<span class="dim part-n"></span>
    <input class="from" type="text" value="${clock(from)}" aria-label="From" />
    <span class="dim">to</span>
    <input class="to" type="text" value="${to ? clock(to) : ''}" aria-label="To" />
    <button type="button" class="ghost small icon-x" title="Remove this part" aria-label="Remove this part">✕</button>`;
  $('partList').append(li);
  numberParts();
  setActivePart($('partList').children.length - 1);
  return li;
}

function numberParts() {
  const rows = [...$('partList').children];
  rows.forEach((li, i) => {
    li.querySelector('.part-n').textContent = `Part ${i + 1}`;
    li.querySelector('.icon-x').hidden = rows.length === 1;
  });
  updateJoinRow();
}

function setActivePart(i) {
  activePart = i;
  [...$('partList').children].forEach((li, k) => li.classList.toggle('active', k === i));
}

function setPartMode(mode) {
  if (!current) return;
  current.partMode = mode;
  setSeg($('partSeg'), mode);
  $('partsBox').hidden = mode !== 'times';
  $('chaptersBox').hidden = mode !== 'chapters';
  if (mode === 'times') startPreview();
  else stopPreview();
  // one file per chapter covers the whole video, so it only goes with Whole video
  $('chapterOn').disabled = mode !== 'whole';
  if (mode !== 'whole') $('chapterOn').checked = false;
  updateJoinRow();
}

function partCount() {
  if (!current || current.mode !== 'one') return 0;
  if (current.partMode === 'times') return $('partList').children.length;
  if (current.partMode === 'chapters') return $('chapterList').querySelectorAll('input:checked').length;
  return 0;
}

function updateJoinRow() {
  $('joinRow').hidden = partCount() < 2;
}

function startPreview() {
  const url = current?.info?.previewUrl;
  $('previewBox').hidden = !url;
  $('previewMsg').hidden = !!url;
  $('previewMsg').textContent = url ? '' : 'This video has no preview here. Type the times instead.';
  if (url && $('preview').getAttribute('src') !== url) $('preview').src = url;
  updatePreviewTime();
}

function stopPreview() {
  const v = $('preview');
  v.pause();
  if (v.getAttribute('src')) {
    v.removeAttribute('src');
    v.load();
  }
}

function updatePreviewTime() {
  $('previewTime').textContent = `At ${clock($('preview').currentTime || 0)}`;
}

function markPart(which) {
  const li = $('partList').children[activePart];
  if (!li) return;
  const t = Math.round($('preview').currentTime || 0);
  li.querySelector(which === 'start' ? '.from' : '.to').value = clock(t);
}

/** Reads the parts the person chose. Returns { sections, join } or { error }. */
function readParts() {
  const c = current;
  if (!c || c.mode !== 'one' || c.partMode === 'whole' || $('partRow').hidden) return { sections: null };
  const dur = c.info.duration || Infinity;
  const join = !$('joinRow').hidden && $('joinOn').checked;
  if (c.partMode === 'chapters') {
    const picked = [...$('chapterList').querySelectorAll('input:checked')].map((x) => c.info.chapterList[Number(x.dataset.i)]);
    if (!picked.length) return { error: 'Tick at least one chapter.' };
    return { sections: picked.map((ch) => ({ from: ch.start, to: Math.min(ch.end, dur), label: ch.title })), join };
  }
  const sections = [];
  for (const [i, li] of [...$('partList').children].entries()) {
    const from = parseClock(li.querySelector('.from').value);
    const to = parseClock(li.querySelector('.to').value);
    const name = $('partList').children.length > 1 ? `Part ${i + 1}: ` : '';
    if (Number.isNaN(from) || Number.isNaN(to)) return { error: `${name}Type the times as minutes and seconds, like 1:05.` };
    if (to <= from) return { error: `${name}The end time has to come after the start time.` };
    if (from >= dur) return { error: `${name}The video is only ${clock(dur)} long.` };
    sections.push({ from, to: Math.min(to, dur) });
  }
  return { sections, join };
}

/** The type for this card. A song with no picture can only be saved as audio. */
function cardType() {
  if (current?.mode === 'one' && current.info.audioOnly && !['mp3', 'm4a', 'transcript'].includes(settings.type)) return 'mp3';
  return settings.type;
}

/** Which rows and choices show depends on the type and on one video or a list. */
function renderOptions() {
  const c = current;
  if (!c) return;
  const one = c.mode === 'one' ? c.info : null;
  const type = cardType();
  const audioOnly = !!one?.audioOnly;
  for (const v of ['video', 'small']) $('typeSeg').querySelector(`[data-v="${v}"]`).hidden = audioOnly;
  setSeg($('typeSeg'), type);
  $('pickBox').hidden = c.mode !== 'list';
  const stt = type === 'transcript';
  $('sttRows').hidden = !stt;
  $('sttLang').value = settings.sttLang;
  $('sttModel').value = settings.sttModel;
  $('sttTranslate').checked = settings.sttTranslate;
  $('sttSrt').checked = settings.sttSrt;
  $('sttKeep').checked = settings.sttKeep;
  $('sttKeep').closest('label').hidden = audioOnly;
  $('qualityRow').hidden = !(type === 'video' || (stt && settings.sttKeep && !audioOnly));
  $('sizeRow').hidden = type !== 'small';
  $('partRow').hidden = !one || !one.duration;
  if ($('partRow').hidden) {
    $('partsBox').hidden = true;
    $('chaptersBox').hidden = true;
    $('joinRow').hidden = true;
  }
  $('chaptersBtn').hidden = !(one && one.chapterList?.length > 1);
  $('subsRow').hidden = stt || (one ? !(one.subs || []).length : false);
  $('sizeLimit').value = String(settings.smallMB);
  renderSizeHint();

  const sel = $('quality');
  if (one && !one.heights.length) {
    sel.innerHTML = '<option value="0">Best available</option>';
  } else if (one) {
    sel.innerHTML = one.heights.map((h) => `<option value="${h.height}">${heightName(h.height)}${h.size ? ' · about ' + mb(h.size) : ''}</option>`).join('');
    const pick = one.heights.find((h) => h.height <= settings.height) || one.heights[one.heights.length - 1];
    if (pick) sel.value = String(pick.height);
  } else {
    // a list has no format details until each video is read, so offer the usual sizes
    const list = [2160, 1440, 1080, 720, 480, 360];
    sel.innerHTML = list.map((h) => `<option value="${h}">${heightName(h)} or the nearest below</option>`).join('');
    sel.value = String(list.find((h) => h <= settings.height) || 1080);
  }

  const yt = one ? isYouTube(one.site) : c.ytList;
  $('thumbOn').checked = settings.thumb;
  $('sponsorOpt').hidden = !yt;
  $('sponsorOn').checked = settings.sponsor;
  $('chapterOpt').hidden = !(one && one.chapters > 1);
  $('chapterOn').checked = false;
  $('chapterOn').disabled = !!one && c.partMode !== 'whole';
  $('phoneOpt').hidden = !connectorUp;
  $('phoneOn').checked = connectorUp && settings.phone;
}

function renderSizeHint() {
  const one = current?.mode === 'one' ? current.info : null;
  const d = one?.duration;
  if (!d || cardType() !== 'small') return ($('sizeHint').textContent = '');
  const kbps = (settings.smallMB * 8e3 * 0.94) / d;
  $('sizeHint').textContent = kbps < 160 ? 'Too long for this size. Pick a bigger limit or download part of it.' : kbps < 600 ? 'Fits at 360p.' : kbps < 1000 ? 'Fits at 540p.' : 'Fits at 720p.';
}

function heightName(h) {
  if (h >= 2160) return `${h}p (4K)`;
  if (h >= 1440) return `${h}p (2K)`;
  if (h >= 1080) return `${h}p (Full HD)`;
  if (h >= 720) return `${h}p (HD)`;
  return `${h}p`;
}

function commonOpts() {
  return {
    type: cardType(),
    height: Number($('quality').value) || 0,
    smallMB: settings.smallMB,
    folder: settings.folder,
    subs: $('subsRow').hidden ? '' : $('subs').value,
    thumb: $('thumbOn').checked,
    sponsor: !$('sponsorOpt').hidden && $('sponsorOn').checked,
    sendToPhone: !$('phoneOpt').hidden && $('phoneOn').checked,
    ...sttOpts(),
  };
}

/** The transcript choices, also used for a file picked from this computer. */
function sttOpts() {
  return {
    language: settings.sttLang,
    model: settings.sttModel,
    translate: settings.sttTranslate,
    srt: settings.sttSrt,
    keepVideo: settings.sttKeep && !current?.info?.audioOnly,
    gpu: paths.platform === 'windows' && settings.gpu,
    words: settings.sttWords,
  };
}

/** Transcribes a video or sound file already on this computer, which stays where it is. */
async function transcribeLocalFile() {
  const file = await openDialog({
    title: 'Pick a video or sound file to transcribe',
    filters: [{ name: 'Video and sound', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma'] }],
  });
  if (!file) return;
  await mkdir(settings.folder).catch(() => {});
  const name = String(file).split(/[\\/]/).pop();
  queue.add({ url: file, title: name, thumb: '' }, { type: 'transcript', folder: settings.folder, localFile: file, ...sttOpts(), keepVideo: false });
}

/**
 * True when the videos in a looked-up list can't be fetched one by one from their own
 * links. Instagram stories come back that way, all sharing the stories page link.
 */
function byIndex(c) {
  if (!c.info?.url) return false;
  const urls = c.entries.map((e) => e.url);
  return urls.some((u) => !u || u === c.info.url) || new Set(urls).size < urls.length;
}

async function startDownload() {
  if (!current) return;
  const c = current;
  const opts = commonOpts();
  const { sections, join, error } = readParts();
  if (error) return show($('cardMsg'), error);
  if (c.mode === 'list' && !pickedIndexes().length) return show($('cardMsg'), 'Tick at least one video.');
  await mkdir(settings.folder).catch(() => {});

  if (c.mode === 'one') {
    const chapters = !$('chapterOpt').hidden && $('chapterOn').checked && !sections;
    queue.add(c.info, { ...opts, sections, join, chapters, auth: c.auth, name: c.info.fixedName ? c.info.title : '' });
  } else {
    const picked = pickedIndexes();
    if (c.ytList || byIndex(c)) {
      // a YouTube playlist, or a list whose videos have no link of their own such as
      // a person's Instagram stories, downloads by number into one folder named after it
      const all = picked.length === c.entries.length;
      queue.add(
        { url: c.info.url, title: c.info.title, thumb: c.entries[picked[0]]?.thumb || c.info.thumb, count: picked.length },
        { ...opts, wholePlaylist: true, playlistItems: all ? null : picked.map((i) => c.entries[i].index), auth: c.auth },
      );
    } else {
      for (const i of picked) {
        const e = c.entries[i];
        queue.add({ url: e.url, title: e.title, thumb: e.thumb, duration: e.duration }, { ...opts, auth: e.auth || c.auth, name: e.fixedName ? e.title : '' });
      }
    }
  }
  closeCard();
  $('linkInput').value = '';
  $('linkInput').focus();
}

/** Several links pasted at once go straight into a list to tick. */
function openPastedLinks(links) {
  $('linkInput').value = '';
  openList({
    title: `${links.length} links`,
    sub: 'Titles show once each download starts.',
    entries: links.map((url) => ({ url, title: '', thumb: '', duration: 0, auth: pastedAuth('', url) })),
    auth: pastedAuth(),
  });
}

// ---- links sent from the browser extension ------------------------------------------

/**
 * payload: { page: { url, title }, items: [{ url, title, thumb, kind }], cookies: [...] }
 * kind is 'page', 'embed' (an iframe player), 'media' (a stream the page loaded) or 'link'.
 */
async function fromExtension(payload) {
  extensionSeen = true;
  const page = payload?.page || {};
  const items = (payload?.items || []).filter((x) => x?.url && /^https?:/i.test(x.url));
  if (!items.length) return;
  const cookiesFile = await writeCookies(payload.cookies).catch(() => '');
  await rememberSignIn(payload.cookies);
  const auth = { referer: page.url && !sameAsPage(items, page) ? page.url : '', cookiesFile };
  if (items.length === 1) {
    const it = items[0];
    $('linkInput').value = it.url;
    return look(it.url, auth, it.kind === 'media' ? it.title || page.title : '');
  }
  openList({
    title: page.title || 'Videos on this page',
    sub: `${items.length} videos sent from the browser`,
    entries: items.map((x) => ({
      url: x.url,
      title: x.title || shortLink(x.url),
      thumb: x.thumb || '',
      duration: x.duration || 0,
      // a stream file has no title of its own, so the name the extension gave it is kept
      fixedName: x.kind === 'media',
      auth: { ...auth, referer: page.url || '' },
    })),
    auth,
  });
}

const sameAsPage = (items, page) => items.length === 1 && items[0].url === page.url;

// ---- the download list -----------------------------------------------------------

function typeName(it) {
  const o = it.opts || {};
  if (o.type === 'mp3') return 'MP3';
  if (o.type === 'm4a') return 'M4A';
  if (o.type === 'small') return `MP4 under ${o.smallMB} MB`;
  if (o.type === 'transcript') return o.srt ? 'TXT and SRT' : 'TXT';
  return o.height ? `MP4 ${o.height}p` : 'MP4';
}

function phoneText(it) {
  if (it.phone === 'sent') return ' · sent to phone';
  if (it.phone === 'failed') return ` · not sent to phone: ${it.phoneError || 'Desktop Connector did not answer'}`;
  return '';
}

function statusText(it) {
  const prefix = it.playlist && it.index ? `Video ${it.index} of ${it.count || '?'} · ` : it.partIndex && it.partCount > 1 ? `Part ${it.partIndex} of ${it.partCount} · ` : '';
  switch (it.status) {
    case 'waiting':
      return 'Waiting';
    case 'downloading': {
      if (!it.total && !it.done) return prefix + 'Starting';
      const parts = [`${Math.floor(it.percent)}%`];
      if (it.total) parts.push(`${mb(it.done)} of ${mb(it.total)}`);
      if (it.speed) parts.push(`${mb(it.speed)}/s`);
      if (it.eta) parts.push(leftText(it.eta));
      return prefix + parts.join(' · ');
    }
    case 'processing':
      return prefix + (it.step || 'Finishing');
    case 'done': {
      if (it.phone === 'sending') return 'Sending to phone';
      if (it.playlist) {
        const n = it.files.length;
        return `Saved ${n} ${n === 1 ? 'file' : 'files'}` + (it.failedCount ? ` · ${it.failedCount} skipped (private or removed)` : '') + phoneText(it);
      }
      if (it.partCount > 1 && it.files.length > 1) return `Saved ${it.files.length} parts as ${typeName(it)}` + (it.failedCount ? ` · ${it.failedCount} failed` : '') + phoneText(it);
      if (it.partCount > 1) return `Saved ${it.partCount} parts joined as ${typeName(it)}` + phoneText(it);
      if (it.opts?.type === 'transcript') return `Saved the transcript (${typeName(it)})` + (it.opts.keepVideo ? ' and the video' : '') + phoneText(it);
      return `Saved as ${typeName(it)}` + phoneText(it);
    }
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return it.error || 'Failed';
    default:
      return '';
  }
}

function buttons(it) {
  if (it.status === 'waiting' || it.status === 'downloading' || it.status === 'processing') {
    return `<button class="small ghost danger" data-a="cancel">Cancel</button>`;
  }
  const b = [];
  if (it.status === 'done' && it.files?.length) {
    if (connectorUp && it.phone !== 'sending') b.push(`<button class="small ghost" data-a="phone">Send to phone</button>`);
    if (!it.playlist && (it.files.length === 1 || it.opts?.type === 'transcript')) b.push(`<button class="small ghost" data-a="open">Open</button>`);
    b.push(`<button class="small ghost" data-a="reveal">Show in folder</button>`);
  }
  if (it.status === 'failed' && it.errorDetails) b.push(`<button class="small ghost" data-a="details">Details</button>`);
  if (it.status === 'failed' || it.status === 'cancelled') b.push(`<button class="small ghost" data-a="retry">Retry</button>`);
  b.push(`<button class="small ghost" data-a="remove" title="Remove from the list">Remove</button>`);
  return b.join('');
}

function itemHtml(it) {
  const name = it.playlist && it.current && ['downloading', 'processing'].includes(it.status) ? `${it.title} · ${it.current}` : it.title;
  return `<div class="mini">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy" />` : ''}</div>
    <div class="info">
      <div class="name" title="${esc(it.title)}">${esc(name)}</div>
      <div class="status">${esc(statusText(it))}</div>
      ${['downloading', 'processing', 'waiting'].includes(it.status) ? `<div class="bar"><i style="width:${it.percent || 0}%"></i></div>` : ''}
    </div>
    <div class="btns">${buttons(it)}</div>`;
}

function renderList(only) {
  const list = $('list');
  if (only) {
    const li = list.querySelector(`li[data-id="${only.id}"]`);
    if (li) {
      li.className = `item ${only.status}`;
      const status = li.querySelector('.status');
      const bar = li.querySelector('.bar > i');
      const nameEl = li.querySelector('.name');
      if (status && bar && li.dataset.status === only.status && nameEl?.textContent === only.title) {
        status.textContent = statusText(only);
        bar.style.width = (only.percent || 0) + '%';
        return;
      }
      li.dataset.status = only.status;
      li.innerHTML = itemHtml(only);
      return;
    }
  }
  list.innerHTML = queue.items.map((it) => `<li class="item ${it.status}" data-id="${it.id}" data-status="${it.status}">${itemHtml(it)}</li>`).join('');
  $('empty').hidden = queue.items.length > 0;
  $('clearBtn').hidden = !queue.items.some((x) => ['done', 'failed', 'cancelled'].includes(x.status));
}

function onListClick(e) {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const id = b.closest('li').dataset.id;
  const it = queue.find(id);
  if (!it) return;
  const a = b.dataset.a;
  if (a === 'cancel') queue.cancel(id);
  else if (a === 'retry') queue.retry(id);
  else if (a === 'remove') queue.remove(id);
  else if (a === 'phone') queue.sendToPhone(it, true);
  else if (a === 'details') {
    const li = b.closest('li');
    let pre = li.querySelector('pre');
    if (pre) return pre.remove();
    pre = document.createElement('pre');
    pre.className = 'details-text';
    pre.textContent = it.errorDetails;
    li.append(pre);
  }
  else if (a === 'open') invoke('open_path', { path: it.files.find((f) => /\.txt$/i.test(f)) || it.files[it.files.length - 1] }).catch(() => {});
  else if (a === 'reveal') invoke('reveal_path', { path: it.files[it.files.length - 1] }).catch(() => {});
}

// ---- the browser extension's folder ---------------------------------------------------

const extensionHome = () => join(paths.documents, 'Video Downloader extension');

async function copyFolder(from, to) {
  await mkdir(to);
  for (const e of await list(from)) {
    if (e.isDir) await copyFolder(join(from, e.name), join(to, e.name));
    else await invoke('fs_copy', { from: join(from, e.name), to: join(to, e.name) });
  }
}

/**
 * The extension ships inside the app, which on a Mac is a sealed bundle the browser's
 * folder picker cannot open. A copy in Documents is the folder the browser loads, and
 * it is refreshed each time so an app update brings the newest extension with it.
 */
async function openExtensionFolder() {
  const from = join(paths.resource, 'extension');
  const to = extensionHome();
  try {
    if (await exists(from)) await copyFolder(from, to);
    await invoke('open_path', { path: to });
  } catch {
    await invoke('open_path', { path: from }).catch(() => {});
  }
}

// ---- settings ---------------------------------------------------------------------

async function openSettings() {
  $('settings').hidden = false;
  setSeg($('limitSeg'), settings.limit);
  $('clipOn').checked = settings.clipboard;
  $('firefoxOn').checked = settings.firefox;
  $('gpuOn').checked = settings.gpu;
  $('sttWords').value = settings.sttWords;
  $('gpuOpt').closest('.row').hidden = paths.platform !== 'windows';
  $('gpuHint').hidden = paths.platform !== 'windows';
  $('extState').textContent = extensionSeen ? 'Connected' : '';
  show($('updateMsg'), '');
  $('version').textContent = (await ytdlpVersion()) || 'not found';
}

async function runUpdate(fromButton) {
  if (fromButton) {
    $('updateBtn').disabled = true;
    show($('updateMsg'), 'Checking for a newer yt-dlp', 'info');
  }
  try {
    const r = await updateYtdlp();
    settings.lastUpdate = Date.now();
    await saveSettings();
    if (fromButton) {
      $('version').textContent = r.version;
      show($('updateMsg'), r.updated ? `Updated to ${r.version}.` : `${r.version} is the newest version.`, 'ok');
    }
  } catch {
    if (fromButton) show($('updateMsg'), 'The update failed. Check the internet connection.');
  } finally {
    if (fromButton) $('updateBtn').disabled = false;
  }
}

// ---- copied links and Desktop Connector ------------------------------------------------

async function checkClipboard() {
  if (!settings.clipboard || $('linkInput').value.trim() || current || !$('settings').hidden) return;
  let text = '';
  try {
    text = (await invoke('clipboard_text')).trim();
  } catch {
    return;
  }
  if (!text || text === lastClip || !looksLikeLink(text) || /\s/.test(text)) return;
  lastClip = text;
  $('linkInput').value = text;
  look(text);
}

async function checkConnector() {
  const was = connectorUp;
  connectorUp = await invoke('connector_running').catch(() => false);
  if (was !== connectorUp) {
    renderList();
    if (current) {
      $('phoneOpt').hidden = !connectorUp;
      $('phoneOn').checked = connectorUp && settings.phone;
    }
  }
}

// ---- drag a link in from the browser -------------------------------------------------

function wireDrop() {
  let depth = 0;
  const hasLink = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'text/uri-list' || t === 'text/plain');
  window.addEventListener('dragenter', (e) => {
    if (!hasLink(e)) return;
    depth += 1;
    $('drop').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $('drop').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasLink(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    const links = linksIn(text);
    if (links.length > 1) return openPastedLinks(links);
    if (links.length === 1) {
      $('linkInput').value = links[0];
      look(links[0]);
    }
  });
}

// ---- start --------------------------------------------------------------------------

async function start() {
  await initBackend();
  Object.assign(settings, await readJson(settingsFile(), {}));
  if (!settings.folder) settings.folder = paths.downloads || join(paths.home, 'Downloads');
  $('folder').textContent = settings.folder;
  $('folder').title = settings.folder;
  // sign-in files from the extension are only kept while the app is open
  await remove(cookiesDir()).catch(() => {});

  queue = new Queue({ limit: settings.limit, onChange: (only) => renderList(only) });
  await queue.loadHistory();
  // anything left half-way when the app closed shows as cancelled with Retry
  for (const it of queue.items) if (!['done', 'failed', 'cancelled'].includes(it.status)) it.status = 'cancelled';
  renderList();

  on('extension-add', (raw) => {
    try {
      fromExtension(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
      // a malformed message from the extension is dropped
    }
  });

  await ensureTools();
  if (Date.now() - (settings.lastUpdate || 0) > DAY) queue.ready = runUpdate(false);
  checkConnector();
  setInterval(checkConnector, 15000);

  $('linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const links = linksIn($('linkInput').value);
    if (links.length > 1) return openPastedLinks(links);
    look();
  });
  $('linkInput').addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const links = linksIn(text);
    if (links.length > 1) {
      e.preventDefault();
      return openPastedLinks(links);
    }
    setTimeout(() => {
      if (looksLikeLink($('linkInput').value)) {
        lastClip = $('linkInput').value.trim();
        look();
      }
    }, 0);
  });
  $('linkInput').addEventListener('input', () => {
    if (!$('linkInput').value.trim()) {
      lookController?.abort();
      $('lookBtn').disabled = false;
      show($('linkMsg'), '');
    }
  });
  $('sttLang').innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  $('sttModel').innerHTML = Object.entries(MODELS)
    .map(([k, m]) => `<option value="${k}">${m.label} · ${m.size}</option>`)
    .join('');
  for (const [id, key] of [['sttLang', 'sttLang'], ['sttModel', 'sttModel']]) {
    $(id).addEventListener('change', () => {
      settings[key] = $(id).value;
      saveSettings();
    });
  }
  for (const [id, key] of [['sttTranslate', 'sttTranslate'], ['sttSrt', 'sttSrt'], ['sttKeep', 'sttKeep']]) {
    $(id).addEventListener('change', () => {
      settings[key] = $(id).checked;
      saveSettings();
      if (id === 'sttKeep') renderOptions();
    });
  }
  $('sttFileBtn').addEventListener('click', transcribeLocalFile);
  $('sttWords').addEventListener('input', () => {
    settings.sttWords = $('sttWords').value;
    saveSettings();
  });
  $('gpuOn').addEventListener('change', () => {
    settings.gpu = $('gpuOn').checked;
    saveSettings();
  });
  onSeg($('typeSeg'), (v) => {
    settings.type = v;
    saveSettings();
    renderOptions();
  });
  onSeg($('plSeg'), (v) => {
    const pair = current?.pair;
    if (!pair) return;
    if (v === 'all') openPlaylist(pair);
    else openOne(pair.video, pair.auth, pair);
  });
  onSeg($('partSeg'), (v) => setPartMode(v));
  $('addPart').addEventListener('click', () => {
    const rows = [...$('partList').children];
    const last = rows[rows.length - 1];
    const from = last ? parseClock(last.querySelector('.to').value) || 0 : 0;
    const li = addPartRow(from, 0);
    li.querySelector('.to').focus();
  });
  $('partList').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const rows = [...$('partList').children];
    if (e.target.closest('.icon-x')) {
      li.remove();
      numberParts();
      setActivePart(Math.min(activePart, $('partList').children.length - 1));
      return;
    }
    setActivePart(rows.indexOf(li));
  });
  $('partList').addEventListener('focusin', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    setActivePart([...$('partList').children].indexOf(li));
    // jump the preview to the time in the box so the spot can be checked
    const t = parseClock(e.target.value);
    if (!$('previewBox').hidden && !Number.isNaN(t) && $('preview').readyState > 0) $('preview').currentTime = t;
  });
  $('chapterList').addEventListener('change', updateJoinRow);
  $('preview').addEventListener('timeupdate', updatePreviewTime);
  $('preview').addEventListener('seeked', updatePreviewTime);
  $('preview').addEventListener('error', () => {
    if (!$('preview').getAttribute('src')) return;
    $('previewBox').hidden = true;
    $('previewMsg').hidden = false;
    $('previewMsg').textContent = 'The preview would not play. Type the times instead.';
  });
  $('markStart').addEventListener('click', () => markPart('start'));
  $('markEnd').addEventListener('click', () => markPart('end'));
  $('pickAll').addEventListener('change', () => {
    for (const c of $('pickList').querySelectorAll('input[type=checkbox]')) c.checked = $('pickAll').checked;
    updatePickCount();
  });
  $('pickList').addEventListener('change', updatePickCount);
  $('quality').addEventListener('change', () => {
    settings.height = Number($('quality').value) || 1080;
    saveSettings();
  });
  $('sizeLimit').addEventListener('change', () => {
    settings.smallMB = Number($('sizeLimit').value) || 50;
    saveSettings();
    renderSizeHint();
  });
  $('subs').addEventListener('change', () => {
    settings.subsOn = !!$('subs').value;
    saveSettings();
  });
  for (const [box, key] of [['thumbOn', 'thumb'], ['sponsorOn', 'sponsor'], ['phoneOn', 'phone']]) {
    $(box).addEventListener('change', () => {
      settings[key] = $(box).checked;
      saveSettings();
    });
  }
  $('folderBtn').addEventListener('click', async () => {
    const dir = await openDialog({ directory: true, title: 'Save downloads to' });
    if (!dir) return;
    settings.folder = dir;
    $('folder').textContent = dir;
    $('folder').title = dir;
    saveSettings();
  });
  $('downloadBtn').addEventListener('click', startDownload);
  $('cancelCardBtn').addEventListener('click', closeCard);
  $('linkDetailsBtn').addEventListener('click', () => ($('linkDetailsText').hidden = !$('linkDetailsText').hidden));
  $('list').addEventListener('click', onListClick);
  $('clearBtn').addEventListener('click', () => queue.clearFinished());
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', () => ($('settings').hidden = true));
  for (const id of ['settings', 'extHelp']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) $(id).hidden = true;
    });
  }
  onSeg($('limitSeg'), (v) => {
    settings.limit = Number(v);
    queue.limit = settings.limit;
    saveSettings();
    queue.pump();
  });
  $('clipOn').addEventListener('change', () => {
    settings.clipboard = $('clipOn').checked;
    saveSettings();
  });
  $('firefoxOn').addEventListener('change', () => {
    settings.firefox = $('firefoxOn').checked;
    saveSettings();
  });
  $('updateBtn').addEventListener('click', () => runUpdate(true));
  $('toolsBtn').addEventListener('click', () => invoke('open_path', { path: toolsDir() }).catch(() => {}));
  $('extBtn').addEventListener('click', () => ($('extHelp').hidden = false));
  $('extClose').addEventListener('click', () => ($('extHelp').hidden = true));
  $('extFolderBtn').addEventListener('click', openExtensionFolder);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('extHelp').hidden) $('extHelp').hidden = true;
      else if (!$('settings').hidden) $('settings').hidden = true;
      else if (current) closeCard();
    }
    if (e.key === 'Enter' && current && !$('card').hidden && document.activeElement !== $('linkInput') && !$('downloadBtn').disabled) {
      if (!['INPUT', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement.type === 'checkbox') startDownload();
    }
  });
  window.addEventListener('focus', () => {
    checkClipboard();
    checkConnector();
  });
  wireDrop();
  $('linkInput').focus();
  checkClipboard();
}

start().catch((e) => {
  document.body.innerHTML = `<p style="padding:24px;color:#e5645f">The app could not start: ${esc(e?.message || e)}</p>`;
});
