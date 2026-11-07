// Adds the right-click menu, answers the Download button on players and remembers the
// video streams each tab loads, which the popup lists alongside the players it finds.

import { sendToApp, cookiesFor, isVideoRequest, streamKind, cleanUrl } from './common.js';

const MENU = {
  video: 'Download with Video Downloader',
  link: 'Download this link with Video Downloader',
  page: 'Find videos on this page with Video Downloader',
  button: 'Show the Download button on videos',
};

// the Download button on players is off until switched on here, in the popup or with Alt+Shift+D
const buttonOn = async () => (await chrome.storage.local.get('playerButton')).playerButton === true;
const setButton = (on) => chrome.storage.local.set({ playerButton: on });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'video', title: MENU.video, contexts: ['video', 'audio', 'frame'] });
    chrome.contextMenus.create({ id: 'link', title: MENU.link, contexts: ['link'] });
    chrome.contextMenus.create({ id: 'page', title: MENU.page, contexts: ['page', 'image'] });
    buttonOn().then((on) =>
      chrome.contextMenus.create({ id: 'button', title: MENU.button, type: 'checkbox', checked: on, contexts: ['all'] }),
    );
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'playerButton' in changes) {
    chrome.contextMenus.update('button', { checked: changes.playerButton.newValue === true }, () => void chrome.runtime.lastError);
  }
});

chrome.commands.onCommand.addListener(async (name) => {
  if (name === 'toggle-button') setButton(!(await buttonOn()));
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

/** Works out what to send for a video the user picked: its file, the player's frame, or the page. */
async function itemForVideo({ src, frameUrl, page, tabId }) {
  if (src && /^https?:/i.test(src)) return { url: src, title: page.title, kind: 'media' };
  if (frameUrl && frameUrl !== page.url) return { url: frameUrl, title: '', kind: 'embed' };
  // the player plays a stream it assembles itself, so send the stream it loaded
  const s = tabId != null ? await latestStream(tabId) : null;
  return s ? { url: s.url, title: page.title, kind: 'media' } : { url: page.url, title: page.title, kind: 'page' };
}

/** Sends one item with the browser's sign-in. Returns false when the app is closed. */
async function send(page, item) {
  const { signIn = true } = await chrome.storage.local.get('signIn');
  const cookies = signIn ? await cookiesFor([page.url, item.url]) : [];
  try {
    return await sendToApp({ page, items: [item], cookies });
  } catch {
    return false;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'button') return setButton(!!info.checked);
  const page = { url: tab?.url || info.pageUrl || '', title: tab?.title || '' };
  let item = null;
  if (info.menuItemId === 'link' && info.linkUrl) {
    item = { url: info.linkUrl, title: info.selectionText || '', kind: 'link' };
  } else if (info.menuItemId === 'video') {
    item = await itemForVideo({ src: info.srcUrl, frameUrl: info.frameUrl, page, tabId: tab?.id });
  } else {
    item = { url: page.url, title: page.title, kind: 'page' };
  }
  if (!item?.url) return;
  if (!(await send(page, item))) notify('Open the Video Downloader app, then try again.');
});

// ---- the Download button on players (player.js) ------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'player-download' || !sender.tab) return false;
  (async () => {
    const tab = sender.tab;
    const page = { url: tab.url || '', title: tab.title || msg.title || '' };
    const frameUrl = sender.frameId ? sender.url || '' : '';
    const item = await itemForVideo({ src: msg.src, frameUrl, page, tabId: tab.id });
    reply({ ok: !!item?.url && (await send(page, item)) });
  })();
  return true;
});
