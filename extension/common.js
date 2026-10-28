// Shared by the background worker and the popup.

export const PORTS = [47821, 47822, 47823, 47824, 47825];

/** The port the app answers on, or 0 when the app is closed. */
export async function findApp() {
  const saved = (await chrome.storage.session.get('port')).port;
  const order = saved ? [saved, ...PORTS.filter((p) => p !== saved)] : PORTS;
  for (const port of order) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 700);
      const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: ctrl.signal });
      clearTimeout(timer);
      const body = await res.json();
      if (body?.app === 'video-downloader' || body?.app === 'youtube-downloader') {
        await chrome.storage.session.set({ port });
        return port;
      }
    } catch {
      // nothing on this port
    }
  }
  return 0;
}

/** Hands links to the app. Returns false when the app is closed. */
export async function sendToApp(payload) {
  const port = await findApp();
  if (!port) return false;
  const res = await fetch(`http://127.0.0.1:${port}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

/** The cookies the browser would send to these addresses, so the app is signed in the same way. */
export async function cookiesFor(urls) {
  const out = new Map();
  for (const url of new Set(urls.filter((u) => /^https?:/i.test(u || '')))) {
    try {
      for (const c of await chrome.cookies.getAll({ url })) out.set(`${c.domain}|${c.path}|${c.name}`, c);
    } catch {
      // an address the browser will not give cookies for
    }
  }
  return [...out.values()];
}

/** True for a request that carries a whole video, a whole song or a stream's playlist, rather than one piece of it. */
export function isVideoRequest(url, contentType = '', size = 0) {
  if (/googlevideo\.com|\.ytimg\.com|doubleclick|googlesyndication|imasdk/i.test(url)) return false;
  if (/\.(ts|m4s|aac|vtt|webvtt|key)(\?|$)/i.test(url) || /[?&](range|bytestart)=|\/seg[-_]?\d|\/segment|\/chunk|\/frag/i.test(url)) return false;
  const type = contentType.toLowerCase();
  if (/mpegurl|dash\+xml/.test(type) || /\.(m3u8|mpd)(\?|$)/i.test(url)) return true;
  // short clips are usually ads and previews
  if (/^video\//.test(type) || /\.(mp4|webm|m4v|mov)(\?|$)/i.test(url)) return !size || size > 400 * 1024;
  // short sounds are usually button clicks and notification chimes
  if (isAudio(url, type)) return !size || size > 150 * 1024;
  return false;
}

export function isAudio(url, contentType = '') {
  return /^audio\//i.test(contentType) || /\.(mp3|m4a|wav|flac|ogg|oga|opus)(\?|$)/i.test(url);
}

export function streamKind(url, contentType = '') {
  if (/mpegurl/i.test(contentType) || /\.m3u8/i.test(url)) return 'HLS stream';
  if (/dash\+xml/i.test(contentType) || /\.mpd/i.test(url)) return 'DASH stream';
  if (isAudio(url, contentType)) return 'Audio file';
  return 'Video file';
}

/** Drops the parts of an address that change on every request. */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const k of ['range', 'bytestart', 'byteend', '_', 't']) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}
