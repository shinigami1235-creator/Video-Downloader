// Speech to text with whisper.cpp, which runs on this computer with no account.
// The program and its speech models are the same ones the Video Editor uses for
// captions, and copies the editor already downloaded are used instead of new ones.

import { paths, join, exists, mkdir, remove, readText, writeText, dirname } from '../backend/index.js';
import { runProcess } from '../backend/proc.js';
import { tools, toolsDir, findFile, downloadTo, downloadAndUnzip } from './tools.js';

const WHISPER_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-bin-x64.zip';
const WHISPER_GPU_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-cublas-12.4.0-bin-x64.zip';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export const MODELS = {
  fast: { file: 'ggml-base.bin', size: '148 MB', label: 'Fast' },
  good: { file: 'ggml-small-q5_1.bin', size: '190 MB', label: 'Good' },
  best: { file: 'ggml-large-v3-turbo-q5_0.bin', size: '574 MB', label: 'Best' },
};

export const LANGUAGES = [
  ['auto', 'Detect it'],
  ['en', 'English'],
  ['th', 'Thai'],
  ['tl', 'Filipino'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['vi', 'Vietnamese'],
  ['id', 'Indonesian'],
  ['ms', 'Malay'],
  ['hi', 'Hindi'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ar', 'Arabic'],
];

const isWin = () => paths.platform === 'windows';
const isMac = () => paths.platform === 'macos';
const editorTools = (...p) => join(dirname(paths.cache), 'com.cygnussolutions.videoeditor', 'tools', ...p);

/** whisper-cli: the Mac app carries its own, Windows downloads it once. */
async function locateWhisper(gpu) {
  if (isMac()) {
    const p = join(paths.resource, '..', 'MacOS', 'whisper-cli');
    return (await exists(p)) ? p : null;
  }
  if (!isWin()) return (await findFile(toolsDir('whisper'), 'whisper-cli', 2)) || 'whisper-cli';
  const folder = gpu ? 'whisper-cuda' : 'whisper';
  return (await findFile(toolsDir(folder), 'whisper-cli.exe')) || (await findFile(editorTools(folder), 'whisper-cli.exe'));
}

async function locateModel(file) {
  for (const dir of [toolsDir('whisper', 'models'), editorTools('whisper', 'models')]) {
    const p = join(dir, file);
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * Makes sure whisper-cli and the speech model are here. onDownload(label, received, total)
 * reports the first-time downloads. Returns { bin, model }.
 */
export async function ensureWhisper(modelKey, { gpu = false, onDownload } = {}) {
  let bin = await locateWhisper(gpu);
  if (!bin) {
    if (!isWin()) throw new Error('The speech program is missing from this copy of the app. Download the app again from the Releases page.');
    await downloadAndUnzip(gpu ? WHISPER_GPU_URL : WHISPER_URL, gpu ? 'whisper-cuda' : 'whisper', (r, t) =>
      onDownload?.(r < 0 ? 'Unpacking the speech program' : 'Downloading the speech program', r, t),
    );
    bin = await locateWhisper(gpu);
    if (!bin) throw new Error('The speech program downloaded but whisper-cli was not found in it.');
  }
  const m = MODELS[modelKey] || MODELS.good;
  let model = await locateModel(m.file);
  if (!model) {
    await mkdir(toolsDir('whisper', 'models'));
    model = toolsDir('whisper', 'models', m.file);
    await downloadTo(HF + m.file, model, (r, t) => onDownload?.(`Downloading the ${m.label.toLowerCase()} speech model (${m.size})`, r, t));
  }
  return { bin, model };
}

/**
 * Reads the Words to get right box. A plain line is a word to listen for; a line like
 * "Flaude = Claude" also swaps every Flaude in the transcript for Claude.
 * Returns { listen: ['Claude', ...], fixes: [[/\bFlaude\b/gi, 'Claude'], ...] }.
 */
export function readWords(text) {
  const listen = [];
  const fixes = [];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const line of String(text || '').split(/\r?\n|,/)) {
    const [from, to] = line.split(/\s*(?:=|->|→)\s*/).map((w) => w.trim());
    const word = to || from;
    if (!word) continue;
    if (!listen.includes(word)) listen.push(word);
    if (to && from) fixes.push([new RegExp(`(?<![\\p{L}\\p{N}])${esc(from)}(?![\\p{L}\\p{N}])`, 'giu'), to]);
  }
  // a listed word written in other capitals, like GiD or claude, takes the listed spelling
  for (const w of listen) fixes.push([new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'giu'), w]);
  return { listen, fixes };
}

const applyFixes = (text, fixes) => fixes.reduce((t, [re, to]) => t.replace(re, to), text);

/** Segments into paragraphs, starting a new one after a pause of 1.5 seconds or more. */
export function toParagraphs(segments) {
  const paras = [];
  let cur = [];
  let lastEnd = null;
  for (const s of segments) {
    const text = (s.text || '').trim();
    // whisper writes sounds it hears as [Music] or (applause)
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue;
    if (lastEnd != null && s.from - lastEnd >= 1.5 && cur.length) {
      paras.push(cur.join(' '));
      cur = [];
    }
    cur.push(text);
    lastEnd = s.to;
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras.join('\n\n');
}

/**
 * Writes outBase.txt (and outBase.srt when srt is on) from the speech in `input`,
 * which can be any video or audio file. Returns the files written.
 * onProgress(fraction, step) runs as it goes.
 */
export async function transcribeFile(input, outBase, { model = 'good', language = 'auto', translate = false, srt = false, gpu = false, words = '', signal, onProgress } = {}) {
  const w = await ensureWhisper(model, {
    gpu,
    onDownload: (label, r, t) => onProgress?.(t > 0 ? r / t : 0, label),
  });
  const work = toolsDir('work', `stt-${Date.now().toString(36)}`);
  await mkdir(work);
  const wav = join(work, 'sound.wav');
  const base = join(work, 'out');
  try {
    onProgress?.(0, 'Preparing the sound');
    await runProcess(tools.ffmpeg, ['-hide_banner', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal, keep: 30 }).catch((e) => {
      if (e?.name === 'AbortError') throw e;
      throw new Error('This file has no sound to transcribe.');
    });
    const threads = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    const args = ['-m', w.model, '-f', wav, '-l', language || 'auto', '-oj', '-of', base, '-t', String(threads), '-pp'];
    if (srt) args.push('-osrt');
    if (translate) args.push('-tr');
    const { listen, fixes } = readWords(words);
    // whisper spells names the way it last saw them, so the list goes in front of every stretch it hears
    if (listen.length) args.push('--prompt', listen.join(', ') + '.', '--carry-initial-prompt');
    onProgress?.(0, 'Listening');
    await runProcess(w.bin, args, {
      signal,
      keep: 40,
      onLine: (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m) onProgress?.(Number(m[1]) / 100, 'Listening');
      },
    }).catch((e) => {
      if (e?.name === 'AbortError') throw e;
      throw new Error('The speech program stopped with an error.');
    });
    const json = JSON.parse(await readText(base + '.json'));
    const segments = (json.transcription || []).map((s) => ({
      text: s.text,
      from: (s.offsets?.from || 0) / 1000,
      to: (s.offsets?.to || 0) / 1000,
    }));
    const text = applyFixes(toParagraphs(segments), fixes);
    if (!text) throw new Error('No speech was found in it.');
    const out = [outBase + '.txt'];
    await mkdir(dirname(outBase));
    await writeText(out[0], text + '\n');
    if (srt) {
      await writeText(outBase + '.srt', applyFixes(await readText(base + '.srt'), fixes));
      out.push(outBase + '.srt');
    }
    return out;
  } finally {
    remove(work).catch(() => {});
  }
}
