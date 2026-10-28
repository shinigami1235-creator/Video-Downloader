// Runs yt-dlp: reads a link's details and downloads with live progress.
// Written to move into the Video Editor later, so it only depends on
// backend/ and tools.js.

import { runProcess } from '../backend/proc.js';
import { tools, baseArgs, ytdlpEnv } from './tools.js';

// ---- sign-in and referer ----------------------------------------------------

/**
 * auth: { referer, cookiesFile, browser }
 * referer: the page a video was embedded in, which private Vimeo embeds check.
 * cookiesFile: sign-in sent by the browser extension. browser: 'firefox'.
 */
export function authArgs(auth = {}) {
  const a = [];
  if (auth.referer) a.push('--referer', auth.referer);
  if (auth.cookiesFile) a.push('--cookies', auth.cookiesFile);
  else if (auth.browser) a.push('--cookies-from-browser', auth.browser);
  return a;
}

// ---- reading a link -------------------------------------------------------

/**
 * Reads a link without downloading. Returns a summary:
 * { kind: 'video' | 'playlist', url, id, title, channel, duration, thumb, site,
 *   heights: [{ height, size }], audioSize, subs, chapters,
 *   count, entries, videoInPlaylist }
 */
export async function lookUp(url, { signal, auth } = {}) {
  const args = [...baseArgs(), ...authArgs(auth), '-J', '--flat-playlist', url];
  let json = null;
  try {
    const r = await runProcess(tools.ytdlp, args, { env: ytdlpEnv(), signal, keep: 50 });
    const line = r.lines.find((l) => l.startsWith('{'));
    json = line ? JSON.parse(line) : null;
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const lines = e?.tail || [String(e?.message || e)];
    throw Object.assign(new Error(plainError(lines)), { details: rawDetails(lines) });
  }
  if (!json) throw new Error('yt-dlp returned nothing for this link.');
  return summarise(json, url);
}

const siteOf = (info) => info.extractor_key || info.ie_key || '';
export const isYouTube = (site) => /^youtube/i.test(site || '');

export function summarise(info, url) {
  if (info._type === 'playlist') {
    const entries = (info.entries || []).filter(Boolean);
    const site = siteOf(info);
    return {
      kind: 'playlist',
      url,
      site,
      id: info.id,
      title: info.title || 'Videos on this page',
      channel: info.uploader || info.channel || '',
      count: info.playlist_count || entries.length,
      thumb: bestThumb(info) || bestThumb(entries[0] || {}),
      duration: entries.reduce((s, e) => s + (e.duration || 0), 0),
      // a watch link opened from a playlist also names one video
      videoInPlaylist: isYouTube(site) ? videoIdFromUrl(url) : null,
      entries: entries.map((e, i) => ({
        index: i + 1,
        id: e.id,
        url: e.url || e.webpage_url || (isYouTube(e.ie_key) && e.id ? `https://www.youtube.com/watch?v=${e.id}` : ''),
        title: e.title || e.id || `Video ${i + 1}`,
        duration: e.duration || 0,
        thumb: bestThumb(e) || (isYouTube(e.ie_key || site) && e.id ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : ''),
      })),
    };
  }
  const formats = info.formats || [];
  const audio = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudio = pickBest(audio.filter((f) => f.ext === 'm4a')) || pickBest(audio);
  const audioSize = sizeOf(bestAudio, info.duration);
  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    if (f.protocol && /m3u8|mhtml/.test(f.protocol) && formats.some((g) => g.height === f.height && /^https?$/.test(g.protocol || ''))) continue;
    const prev = byHeight.get(f.height);
    // prefer H.264 at 1080p and below, the same choice the download makes
    if (!prev || rank(f) > rank(prev)) byHeight.set(f.height, f);
  }
  const heights = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, f]) => {
      const v = sizeOf(f, info.duration);
      const joined = f.acodec && f.acodec !== 'none';
      return { height, size: v ? v + (joined ? 0 : audioSize || 0) : 0 };
    });
  return {
    kind: 'video',
    url,
    site: siteOf(info),
    id: info.id,
    title: info.title || info.id,
    channel: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumb: bestThumb(info),
    isLive: !!info.is_live,
    heights,
    audioSize,
    subs: subtitleChoices(info),
    chapters: (info.chapters || []).length,
    chapterList: (info.chapters || []).map((c, i) => ({ title: c.title || `Chapter ${i + 1}`, start: c.start_time || 0, end: c.end_time || info.duration || 0 })),
    previewUrl: previewOf(formats),
    audioOnly: isAudioOnly(info, formats),
  };
}

const AUDIO_EXT = /^(mp3|m4a|wav|flac|ogg|oga|opus|aac)$/i;

/** True for a song or podcast with no picture, such as an MP3 file a page plays. */
function isAudioOnly(info, formats) {
  if (!formats.length) return AUDIO_EXT.test(info.ext || '');
  return formats.every((f) => f.vcodec === 'none' || (!f.vcodec && (AUDIO_EXT.test(f.ext || '') || (f.acodec && f.acodec !== 'none' && !f.height))));
}

/**
 * A small file with picture and sound together, which the app's own player can
 * play for marking the start and end of a part. YouTube's 360p MP4 is the usual one.
 */
function previewOf(formats) {
  const whole = formats.filter(
    (f) => f.url && f.vcodec !== 'none' && f.acodec !== 'none' && /^https?$/.test(f.protocol || 'https') && /^(mp4|webm|m4v|mov)$/.test(f.ext || ''),
  );
  if (!whole.length) return '';
  const score = (f) => Math.abs((f.height || 360) - 360) + (f.ext === 'mp4' ? 0 : 50);
  return whole.sort((a, b) => score(a) - score(b))[0].url;
}

/**
 * Subtitles a person would pick from: every subtitle the uploader added, plus
 * YouTube's automatic captions in the language the video is spoken in.
 * The full automatic list runs to a hundred machine translations.
 */
export function subtitleChoices(info) {
  const out = [];
  const seen = new Set();
  for (const [code, list] of Object.entries(info.subtitles || {})) {
    if (code === 'live_chat') continue;
    out.push({ code, name: list?.[0]?.name || code, auto: false });
    seen.add(code.split('-')[0]);
  }
  const autos = info.automatic_captions || {};
  const spoken = Object.keys(autos).filter((c) => c.endsWith('-orig'));
  if (!spoken.length && info.language && autos[info.language]) spoken.push(info.language);
  for (const code of spoken) {
    const base = code.replace(/-orig$/, '');
    if (seen.has(base.split('-')[0])) continue;
    const name = (autos[code]?.[0]?.name || base).replace(/\s*\(Original\)\s*/i, '');
    out.push({ code, name: `${name} (automatic)`, auto: true });
    seen.add(base.split('-')[0]);
  }
  if (!seen.has('en') && autos.en) out.push({ code: 'en', name: 'English (automatic translation)', auto: true });
  return out;
}

function rank(f) {
  const h264 = /^avc1/.test(f.vcodec || '') && f.height <= 1080 ? 1e6 : 0;
  return h264 + (f.tbr || 0);
}

function pickBest(list) {
  return list.reduce((best, f) => (!best || (f.tbr || 0) > (best.tbr || 0) ? f : best), null);
}

function sizeOf(f, duration) {
  if (!f) return 0;
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  if (f.tbr && duration) return Math.round((f.tbr * 1000 * duration) / 8);
  return 0;
}

function bestThumb(info) {
  if (info.thumbnail) return info.thumbnail;
  const t = (info.thumbnails || []).filter((x) => x.url);
  if (!t.length) return '';
  const sized = t.filter((x) => x.width && x.width <= 720).sort((a, b) => b.width - a.width);
  return (sized[0] || t[t.length - 1]).url;
}

export function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1) || null;
    if (!/youtube\.com$/.test(u.hostname)) return null;
    return u.searchParams.get('v');
  } catch {
    return null;
  }
}

// ---- building the download command ----------------------------------------

/** Makes a page title safe as a yt-dlp output name. */
function literalName(title) {
  return String(title)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/%/g, '%%')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'video';
}

/**
 * opts: {
 *   type: 'video' | 'small' | 'mp3' | 'm4a', height (0 = best), part: { from, to, label } | null,
 *   wholePlaylist, playlistItems: [1, 3], folder, name (a fixed file name),
 *   subs: language code or '', thumb, chapters, sponsor, auth
 * }
 */
export function downloadArgs(url, opts) {
  const a = [...baseArgs(), ...authArgs(opts.auth)];
  a.push('--newline', '--progress', '--no-mtime', '--no-simulate', '--ignore-errors');
  a.push('--progress-template', 'download:@@P|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.tmpfilename)s');
  a.push('--progress-template', 'postprocess:@@Q|%(progress.status)s|%(progress.postprocessor)s');
  a.push('--print', 'before_dl:@@T|%(playlist_index|)s|%(n_entries|)s|%(duration|)s|%(title)s');
  a.push('--print', 'after_move:@@F|%(filepath)s');
  a.push(opts.wholePlaylist ? '--yes-playlist' : '--no-playlist');
  if (opts.wholePlaylist && opts.playlistItems?.length) a.push('--playlist-items', opts.playlistItems.join(','));

  if (opts.type === 'mp3') {
    a.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail', '--embed-metadata');
  } else if (opts.type === 'm4a') {
    a.push('-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--embed-thumbnail', '--embed-metadata');
  } else {
    // a small video is shrunk by FFmpeg afterwards, so 720p is plenty to start from
    const h = opts.type === 'small' ? 720 : Number(opts.height) || 0;
    // H.264 plays everywhere, including the Video Editor, and YouTube offers it up to 1080p
    const sort = h && h <= 1080 ? `res:${h},vcodec:h264,acodec:aac` : h ? `res:${h},acodec:aac` : 'res,acodec:aac';
    a.push('-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--embed-metadata');
  }

  if (opts.subs) a.push('--write-subs', '--write-auto-subs', '--sub-langs', opts.subs, '--convert-subs', 'srt');
  if (opts.thumb) a.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (opts.sponsor) a.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');

  // the height goes in a video's name so a second download at another quality gets its own file
  const base = opts.name ? literalName(opts.name) : '%(title).150B';
  // a direct stream file may report no height, and then the name goes without one
  let name = opts.type === 'video' ? `${base}%(height& {}p|)s` : base;
  if (opts.part) {
    a.push('--download-sections', `*${opts.part.from}-${opts.part.to}`, '--force-keyframes-at-cuts');
    // a part picked by chapter is named after the chapter
    const span = opts.part.label ? literalName(opts.part.label).slice(0, 80) : `${fileTime(opts.part.from)} to ${fileTime(opts.part.to)}`;
    name = opts.type === 'video' ? `${base} (${span}%(height&, {}p|)s)` : `${base} (${span})`;
  } else if (opts.chapters) {
    a.push('--split-chapters', '-o', `chapter:${name}/%(section_number)02d %(section_title).100B.%(ext)s`);
  }
  const template = opts.wholePlaylist ? `%(playlist_title,playlist_id).100B/%(playlist_index)03d ${name}.%(ext)s` : `${name}.%(ext)s`;
  a.push('-P', opts.folder, '-o', template, url);
  return a;
}

/** 75.5 seconds becomes 1m15s, for file names (Windows does not allow colons). */
function fileTime(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`) + `${String(r).padStart(2, '0')}s`;
}

// ---- reading the progress lines ------------------------------------------

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Turns one output line into an update object, or null for lines with nothing in them. */
export function parseLine(line) {
  if (line.startsWith('@@P|')) {
    const [, status, done, total, estimate, speed, eta, ...rest] = line.split('|');
    return {
      type: 'progress',
      status,
      done: num(done),
      total: num(total) || num(estimate),
      speed: num(speed),
      eta: num(eta),
      tmp: rest.join('|'),
    };
  }
  if (line.startsWith('@@Q|')) {
    const [, status, pp] = line.split('|');
    return { type: 'process', status, step: pp };
  }
  if (line.startsWith('@@T|')) {
    const [, index, count, duration, ...title] = line.split('|');
    return { type: 'item', index: num(index), count: num(count), duration: num(duration), title: title.join('|') };
  }
  if (line.startsWith('@@F|')) return { type: 'file', path: line.slice(4) };
  if (/^ERROR:/.test(line)) return { type: 'error', text: line };
  return null;
}

/** What FFmpeg is doing, in words for the status line. */
export function stepName(pp) {
  if (/Merger/i.test(pp)) return 'Joining video and audio';
  if (/ExtractAudio/i.test(pp)) return 'Converting audio';
  if (/VideoRemuxer|VideoConvertor/i.test(pp)) return 'Converting to MP4';
  if (/EmbedThumbnail/i.test(pp)) return 'Adding the cover picture';
  if (/ThumbnailsConvertor/i.test(pp)) return 'Saving the thumbnail';
  if (/SubtitlesConvertor/i.test(pp)) return 'Saving the subtitles';
  if (/SponsorBlock|ModifyChapters/i.test(pp)) return 'Cutting sponsor segments';
  if (/SplitChapters/i.test(pp)) return 'Splitting into chapters';
  if (/Metadata/i.test(pp)) return 'Adding title and channel';
  if (/FixupM|Fixup/i.test(pp)) return 'Fixing the file';
  return 'Finishing';
}

// ---- errors ---------------------------------------------------------------

/** yt-dlp's own error lines, shown under Details so a failure can be looked into. */
export function rawDetails(lines) {
  const errs = lines.filter((l) => /^(ERROR|WARNING):/.test(l));
  return (errs.length ? errs : lines).slice(-8).join('\n');
}

/** Turns yt-dlp's error output into one plain sentence. */
export function plainError(lines) {
  const all = lines.join('\n');
  const err = [...lines].reverse().find((l) => /^ERROR:/.test(l)) || lines[lines.length - 1] || '';
  if (/DRM/i.test(all)) return 'This video is copy-protected (DRM) and cannot be downloaded.';
  // X hands out a post marked sensitive only to a signed-in account, and without sign-in
  // it either says so or returns the post with its video missing
  if (/\[twitter\]/i.test(all) && /protected tweet/i.test(all)) return 'This post is from a private X account. It downloads only if your X account follows them, sent from the browser extension.';
  if (/\[twitter\]/i.test(all) && /NSFW tweet|No video could be found in this tweet|Syndication endpoint/i.test(all)) {
    return "X hides this video behind a sensitive-content warning, so it needs your X sign-in. Open the post in Edge or Chrome, click the extension's icon and press Send the page link, or turn on Firefox sign-in in Settings.";
  }
  if (/Private video/i.test(all)) return 'This video is private.';
  if (/Video unavailable|This video has been removed|account associated with this video has been terminated/i.test(all)) return 'This video was removed or is unavailable.';
  if (/\[instagram/i.test(all) && /log in|login|registered users|unreachable|rate-limit/i.test(all)) {
    return "Instagram only shows this to signed-in accounts. Open it in Edge, click the extension's icon and press Send the page link. After that, pasted Instagram links work too until the app closes.";
  }
  if (/confirm your age|age-restricted|inappropriate for some users/i.test(all)) return 'This video is only shown to signed-in adults. Turn on Firefox sign-in in Settings, or send it from the browser extension.';
  if (/not a bot/i.test(all)) return 'YouTube is asking this computer to prove it is not a bot. Try again in an hour.';
  if (/members-only|Join this channel/i.test(all)) return 'This video is for channel members only.';
  if (/login required|log in|logged-in|cookies|rate-limit reached/i.test(all)) return 'This site needs you signed in. Send the video from the browser extension, or turn on Firefox sign-in in Settings.';
  if (/Unsupported URL|is not a valid URL|No video formats found/i.test(all)) return 'No video was found at this link.';
  if (/Requested format is not available/i.test(all)) return 'That quality is not offered for this video. Pick another one.';
  if (/could not find firefox|could not find .* cookies database/i.test(all)) return 'Firefox sign-in was not found. Sign in to the site in Firefox, or turn Firefox sign-in off in Settings.';
  if (/getaddrinfo|Failed to resolve|Unable to download webpage|timed out|Connection reset|No route to host/i.test(all)) return 'The site could not be reached. Check the internet connection.';
  if (/No space left|Errno 28/i.test(all)) return 'The drive is full.';
  if (/Permission denied|Errno 13/i.test(all)) return 'Windows blocked writing to the save folder. Pick another folder.';
  if (/HTTP Error 403/i.test(all)) return 'The site refused the download. Press Update yt-dlp in Settings, then retry.';
  if (/ffmpeg not found|ffprobe and ffmpeg not found/i.test(all)) return 'FFmpeg is missing. Restart the app to download it again.';
  return err.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '').trim() || 'yt-dlp stopped with an error.';
}
