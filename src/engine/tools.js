// Finds and installs the three programs the downloader runs:
// yt-dlp (reads YouTube), Deno (lets yt-dlp solve YouTube's player scripts)
// and FFmpeg (joins the video and audio and converts to MP3).
// Everything goes into the app's local data folder on the first start.
// FFmpeg already downloaded by the Video Editor is used instead of a second copy.

import { paths, join, exists, list, mkdir, invoke, on, remove, dirname } from '../backend/index.js';
import { newJobId, runProcess } from '../backend/proc.js';

export const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
export const DENO_URL = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';
// same builds the Video Editor uses, newest release first and the master build as a fallback
export const FFMPEG_URLS = [
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];

// Mac: yt-dlp's own Mac build, Deno for the chip in the Mac, and the FFmpeg builds the
// Video Editor's Mac app uses
const MAC_YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
const macDenoUrl = () => `https://github.com/denoland/deno/releases/latest/download/deno-${paths.arch === 'aarch64' ? 'aarch64' : 'x86_64'}-apple-darwin.zip`;
const macFfmpegUrl = (name) => `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${paths.arch === 'aarch64' ? 'arm64' : 'amd64'}/release/${name}.zip`;

export const tools = { ytdlp: null, deno: null, ffmpeg: null };

const isWin = () => paths.platform === 'windows';
const isMac = () => paths.platform === 'macos';
const exe = (n) => (isWin() ? n + '.exe' : n);
export const toolsDir = (...p) => join(paths.cache, 'tools', ...p);
// %LOCALAPPDATA%\com.cygnussolutions.videoeditor\tools\ffmpeg
const editorFfmpegDir = () => join(dirname(paths.cache), 'com.cygnussolutions.videoeditor', 'tools', 'ffmpeg');

export async function findFile(dir, name, depth = 4) {
  if (!(await exists(dir))) return null;
  let entries = [];
  try {
    entries = await list(dir);
  } catch {
    return null;
  }
  for (const e of entries) if (!e.isDir && e.name.toLowerCase() === name.toLowerCase()) return join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDir) {
      const r = await findFile(join(dir, e.name), name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

export async function locateTools() {
  tools.ytdlp = await findFile(toolsDir(), exe('yt-dlp'), 0);
  tools.deno = await findFile(toolsDir('deno'), exe('deno'), 1);
  tools.ffmpeg =
    (await findFile(toolsDir('ffmpeg'), exe('ffmpeg'))) || (await findFile(editorFfmpegDir(), exe('ffmpeg')));
  // Linux uses the programs installed on the system
  if (!isWin() && !isMac()) {
    tools.ytdlp ||= 'yt-dlp';
    tools.deno ||= 'deno';
    tools.ffmpeg ||= 'ffmpeg';
  }
  return tools;
}

export const missingTools = () => ['ytdlp', 'deno', 'ffmpeg'].filter((k) => !tools[k]);

export function downloadTo(url, dest, onProgress) {
  const jobId = newJobId('dl');
  const off = on('download-progress', (p) => {
    if (p.jobId === jobId) onProgress?.(p.received, p.total);
  });
  return invoke('download', { jobId, url, dest }).finally(off);
}

async function downloadAndUnzip(urls, folder, onProgress) {
  const dir = toolsDir(folder);
  await mkdir(dir);
  const zip = join(dir, 'download.zip');
  let lastErr = null;
  for (const url of [].concat(urls)) {
    try {
      await downloadTo(url, zip, onProgress);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  onProgress?.(-1, -1);
  await invoke('unzip', { zipPath: zip, destDir: dir });
  await remove(zip);
}

export const SETUP_STEPS = [
  { key: 'ytdlp', name: 'yt-dlp', size: 'about 18 MB', macSize: 'about 35 MB' },
  { key: 'deno', name: 'Deno', size: 'about 45 MB', macSize: 'about 45 MB' },
  { key: 'ffmpeg', name: 'FFmpeg', size: 'about 190 MB', macSize: 'about 60 MB' },
];

export const stepSize = (s) => (isMac() ? s.macSize : s.size);

/** Downloads whatever is missing. onStep(key, received, total) reports progress, -1 while unpacking. */
export async function installTools(onStep) {
  await mkdir(toolsDir());
  await locateTools();
  if (!tools.ytdlp) {
    const dest = toolsDir(exe('yt-dlp'));
    await downloadTo(isMac() ? MAC_YTDLP_URL : YTDLP_URL, dest, (r, t) => onStep('ytdlp', r, t));
    if (isMac()) await invoke('fs_make_executable', { path: dest });
  }
  onStep('ytdlp', 1, 1);
  if (!tools.deno) await downloadAndUnzip(isMac() ? macDenoUrl() : DENO_URL, 'deno', (r, t) => onStep('deno', r, t));
  onStep('deno', 1, 1);
  if (!tools.ffmpeg) {
    if (isMac()) {
      // yt-dlp needs FFprobe beside FFmpeg on a Mac, where they come as two downloads
      await downloadAndUnzip(macFfmpegUrl('ffmpeg'), 'ffmpeg', (r, t) => onStep('ffmpeg', r, t));
      await downloadAndUnzip(macFfmpegUrl('ffprobe'), 'ffmpeg', (r, t) => onStep('ffmpeg', r, t));
    } else await downloadAndUnzip(FFMPEG_URLS, 'ffmpeg', (r, t) => onStep('ffmpeg', r, t));
  }
  onStep('ffmpeg', 1, 1);
  await locateTools();
  const left = missingTools();
  if (left.length) throw new Error(`${left.join(', ')} downloaded but the program was not found inside it.`);
}

/** Environment for every yt-dlp run: UTF-8 output so titles in any language come through. */
export const ytdlpEnv = () => ({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });

/** Arguments every yt-dlp run shares. */
export function baseArgs() {
  const a = ['--color', 'never', '--no-warnings', '--cache-dir', toolsDir('cache')];
  if (tools.deno) a.push('--js-runtimes', `deno:${tools.deno}`);
  if (tools.ffmpeg && /[\\/]/.test(tools.ffmpeg)) a.push('--ffmpeg-location', dirname(tools.ffmpeg));
  return a;
}

export async function ytdlpVersion() {
  try {
    const r = await runProcess(tools.ytdlp, ['--version'], { env: ytdlpEnv() });
    return r.lines.filter(Boolean).pop()?.trim() || '';
  } catch {
    return '';
  }
}

/**
 * Updates yt-dlp to the newest release. Returns { updated, version }.
 * yt-dlp replaces its own program file, which works since it sits in the app's own folder.
 */
export async function updateYtdlp() {
  if (!isWin() && !isMac()) return { updated: false, version: await ytdlpVersion() };
  const r = await runProcess(tools.ytdlp, ['-U'], { env: ytdlpEnv() });
  const text = r.lines.join('\n');
  const updated = /Updated yt-dlp to/i.test(text);
  return { updated, version: await ytdlpVersion() };
}
