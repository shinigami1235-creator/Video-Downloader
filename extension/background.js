// Adds the right-click menu and remembers the video streams each tab loads,
// which the popup lists alongside the players it finds on the page.

import { sendToApp, cookiesFor, isVideoRequest, streamKind, cleanUrl } from './common.js';

const MENU = {
  video: 'Download with Video Downloader',
  link: 'Download this link with Video Downloader',
  page: 'Find videos on this page with Video Downloader',
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'video', title: MENU.video, contexts: ['video', 'audio', 'frame'] });
    chrome.contextMenus.create({ id: 'link', title: MENU.link, contexts: ['link'] });
    chrome.contextMenus.create({ id: 'page', title: MENU.page, contexts: ['page', 'image'] });
  });
});

// ---- streams each tab loads ----------------------------------------------------

const key = (tabId) => `streams-${tabId}`;

async function remember(tabId, entry) {
  const k = key(tabId);
  const list = (await chrome.storage.session.get(k))[k] || [];
  if (list.some((x) => x.url === entry.url)) return;
  list.push(entry);
  await chrome.storage.session.set({ [k]: list.slice(-30) });
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const headers = Object.fromEntries((d.responseHeaders || []).map((h) => [h.name.toLowerCase(), h.value || '']));
    const type = headers['content-type'] || '';
    const range = /\/(\d+)$/.exec(headers['content-range'] || '');
    const size = range ? Number(range[1]) : Number(headers['content-length'] || 0);
    if (!isVideoRequest(d.url, type, size)) return;
    const url = cleanUrl(d.url);
    remember(d.tabId, { url, kind: streamKind(url, type), size, frameUrl: d.frameId ? d.initiator || '' : '', at: Date.now() });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'sub_frame'] },
  ['responseHeaders'],
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) chrome.storage.session.remove(key(tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

// ---- right-click ------------------------------------------------------------------

async function latestStream(tabId) {
  const list = (await chrome.storage.session.get(key(tabId)))[key(tabId)] || [];
  return list[list.length - 1] || null;
}

function notify(message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Video Downloader', message });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const page = { url: tab?.url || info.pageUrl || '', title: tab?.title || '' };
  let item = null;
  if (info.menuItemId === 'link' && info.linkUrl) {
    item = { url: info.linkUrl, title: info.selectionText || '', kind: 'link' };
  } else if (info.menuItemId === 'video') {
    const src = info.srcUrl && /^https?:/i.test(info.srcUrl) ? info.srcUrl : '';
    if (src) item = { url: src, title: page.title, kind: 'media' };
    else if (info.frameUrl && info.frameUrl !== page.url) item = { url: info.frameUrl, title: '', kind: 'embed' };
    else {
      // the player plays a stream it assembles itself, so send the stream it loaded
      const s = tab ? await latestStream(tab.id) : null;
      item = s ? { url: s.url, title: page.title, kind: 'media' } : { url: page.url, title: page.title, kind: 'page' };
    }
  } else {
    item = { url: page.url, title: page.title, kind: 'page' };
  }
  if (!item?.url) return;
  const { signIn = true } = await chrome.storage.local.get('signIn');
  const cookies = signIn ? await cookiesFor([page.url, item.url]) : [];
  try {
    const ok = await sendToApp({ page, items: [item], cookies });
    if (!ok) notify('Open the Video Downloader app, then try again.');
  } catch {
    notify('Open the Video Downloader app, then try again.');
  }
});
