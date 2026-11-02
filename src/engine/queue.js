// The download list. Runs up to `limit` downloads at once, keeps the last
// finished ones in history.json, and cleans up half-written files on cancel.

import { paths, join, exists, remove, readJson, writeJson, writeText, mkdir, rename, basename, invoke } from '../backend/index.js';
import { runProcess, newJobId } from '../backend/proc.js';
import { tools, ytdlpEnv, toolsDir } from './tools.js';
import { downloadArgs, parseLine, plainError, rawDetails, stepName } from './ytdlp.js';
import { shrinkVideo } from './shrink.js';
import { transcribeFile } from './transcribe.js';

const HISTORY_KEEP = 60;
const historyFile = () => join(paths.appData, 'history.json');
const FINISHED = ['done', 'failed', 'cancelled'];

/** A title made safe as a Windows file name. */
const safeName = (t) => String(t || 'video').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';

export class Queue {
  constructor({ limit = 2, onChange }) {
    this.items = [];
    this.limit = limit;
    this.onChange = onChange || (() => {});
    this.ready = Promise.resolve();
  }

  async loadHistory() {
    const saved = await readJson(historyFile(), []);
    this.items = (Array.isArray(saved) ? saved : []).map((it) => ({ ...it, controller: null }));
    this.onChange();
  }

  saveHistory() {
    const done = this.items
      .filter((it) => FINISHED.includes(it.status))
      .slice(0, HISTORY_KEEP)
      .map(({ controller, tmpFiles, ...rest }) => rest);
    writeJson(historyFile(), done).catch(() => {});
  }

  /**
   * info: { url, title, thumb, count, duration }
   * opts: as in downloadArgs(), plus smallMB and sendToPhone.
   */
  add(info, opts) {
    const item = {
      id: newJobId('item'),
      url: info.url,
      title: info.title || info.url,
      // a link added without being looked up takes its title from yt-dlp
      titleFromLink: !info.title,
      thumb: info.thumb || '',
      duration: info.duration || 0,
      playlist: !!opts.wholePlaylist,
      count: opts.wholePlaylist ? opts.playlistItems?.length || info.count || 0 : 0,
      opts,
      status: 'waiting',
      percent: 0,
      done: 0,
      total: 0,
      speed: 0,
      eta: 0,
      step: '',
      index: 0,
      files: [],
      failedCount: 0,
      phone: '',
      error: '',
      addedAt: Date.now(),
    };
    this.items.unshift(item);
    this.onChange();
    this.pump();
    return item;
  }

  find(id) {
    return this.items.find((x) => x.id === id);
  }

  retry(id) {
    const it = this.find(id);
    if (!it) return;
    Object.assign(it, { status: 'waiting', percent: 0, error: '', errorDetails: '', step: '', files: [], failedCount: 0, index: 0, partIndex: 0, phone: '' });
    this.onChange();
    this.pump();
  }

  cancel(id) {
    const it = this.find(id);
    if (!it) return;
    if (it.status === 'waiting') {
      it.status = 'cancelled';
      this.onChange();
      this.saveHistory();
    } else it.controller?.abort();
  }

  remove(id) {
    const it = this.find(id);
    if (!it || !FINISHED.includes(it.status)) return;
    this.items = this.items.filter((x) => x !== it);
    this.forgetSignIn(it);
    this.onChange();
    this.saveHistory();
  }

  clearFinished() {
    for (const it of this.items) if (FINISHED.includes(it.status)) this.forgetSignIn(it);
    this.items = this.items.filter((x) => !FINISHED.includes(x.status));
    this.onChange();
    this.saveHistory();
  }

  /** Deletes the sign-in file the browser extension sent with a download. */
  forgetSignIn(it) {
    const file = it.opts?.auth?.cookiesFile;
    // a site's remembered sign-in stays for the next pasted link
    if (file && !/[\\/]site-[^\\/]+$/.test(file)) remove(file).catch(() => {});
  }

  get running() {
    return this.items.filter((x) => x.status === 'downloading' || x.status === 'processing').length;
  }

  pump() {
    while (this.running < this.limit) {
      // the same video twice at once would write the same file, so a repeat waits its turn
      const busy = new Set(this.items.filter((x) => x.status === 'downloading' || x.status === 'processing').map((x) => x.url));
      const next = [...this.items].reverse().find((x) => x.status === 'waiting' && !busy.has(x.url));
      if (!next) return;
      next.status = 'downloading';
      this.run(next);
    }
  }

  async run(it) {
    await this.ready;
    const controller = new AbortController();
    it.controller = controller;
    it.tmpFiles = new Set();
    it.startedAt = Date.now();
    this.onChange();
    const errors = [];
    let lastPaint = 0;
    const paint = (force) => {
      const now = Date.now();
      if (force || now - lastPaint > 200) {
        lastPaint = now;
        this.onChange(it);
      }
    };
    const small = it.opts.type === 'small';
    const transcript = it.opts.type === 'transcript';
    const local = it.opts.localFile || '';
    // with Keep the video on, the video downloads as usual and is transcribed where it lands
    const keep = transcript && !!it.opts.keepVideo;
    const sections = it.opts.sections?.length ? it.opts.sections : null;
    const joining = !!(sections && sections.length > 1 && it.opts.join);
    // a small video, parts to join and the sound for a transcript download into a work
    // folder first, and only the finished file lands in the save folder
    const workDir = small || joining || (transcript && !keep) ? toolsDir('work', it.id) : null;
    const base = keep ? { ...it.opts, type: 'video' } : it.opts;
    // each part is its own yt-dlp run so it can carry its own file name
    const runs = local ? [] : sections ? sections.map((part) => ({ ...base, part, sections: null })) : [base];
    it.partCount = sections ? sections.length : 0;
    try {
      if (workDir) await mkdir(workDir);
      if (local) it.files = [local];
      for (const [k, opts] of runs.entries()) {
        it.partIndex = sections ? k + 1 : 0;
        const before = errors.length;
        try {
          await this.runYtdlp(it, downloadArgs(it.url, workDir ? { ...opts, folder: workDir } : opts), controller.signal, errors, paint);
        } catch (e) {
          if (e?.name === 'AbortError' || !sections) throw e;
          // one part failing still leaves the others
          if (errors.length === before) errors.push(String(e?.tail?.slice(-1)[0] || e?.message || e));
          it.failedCount += 1;
        }
      }
      if (!it.files.length && errors.length) throw Object.assign(new Error('failed'), { tail: errors });
      if (joining && it.files.length > 1) await this.joinParts(it, workDir, controller.signal, paint);
      if (transcript) await this.transcribeAll(it, { keepSource: keep || !!local, signal: controller.signal, paint });
      else if (small) await this.shrinkAll(it, workDir, controller.signal, paint);
      else if (workDir) await this.moveOut(it);
      if (it.opts.sendToPhone) await this.sendToPhone(it, true);
      it.status = 'done';
      it.percent = 100;
      this.forgetSignIn(it);
    } catch (e) {
      if (e?.name === 'AbortError') {
        it.status = 'cancelled';
        await this.cleanUp(it);
      } else if (it.playlist && it.files.length && !e?.shrink) {
        // yt-dlp exits with an error when some videos in a playlist were skipped
        it.status = 'done';
        it.percent = 100;
      } else {
        it.status = 'failed';
        const lines = errors.length ? errors : e?.tail || [String(e?.message || e)];
        it.error = e?.shrink ? e.message : plainError(lines);
        it.errorDetails = rawDetails(lines);
      }
    } finally {
      if (workDir) remove(workDir).catch(() => {});
      it.controller = null;
      it.finishedAt = Date.now();
      this.onChange();
      this.saveHistory();
      this.pump();
    }
  }

  /** One yt-dlp run, feeding its progress into the item. */
  runYtdlp(it, args, signal, errors, paint) {
    return runProcess(tools.ytdlp, args, {
      env: ytdlpEnv(),
      signal,
      keep: 80,
      onLine: (line) => {
        const u = parseLine(line);
        if (!u) return;
        if (u.type === 'item') {
          it.index = u.index;
          if (u.count && it.playlist) it.count = u.count;
          if (u.duration) it.duration = u.duration;
          if (it.playlist) it.current = u.title;
          else if (it.titleFromLink && u.title) it.title = u.title;
          it.percent = 0;
          paint(true);
        } else if (u.type === 'progress') {
          it.status = 'downloading';
          it.step = '';
          if (u.tmp) it.tmpFiles.add(u.tmp);
          it.done = u.done;
          it.total = u.total;
          it.speed = u.speed;
          it.eta = u.eta;
          it.percent = u.total ? Math.min(100, (u.done / u.total) * 100) : it.percent;
          paint();
        } else if (u.type === 'process' && u.status === 'started') {
          it.status = 'processing';
          it.step = stepName(u.step);
          paint(true);
        } else if (u.type === 'file') {
          it.files.push(u.path);
          paint(true);
        } else if (u.type === 'error') {
          errors.push(u.text);
          if (it.playlist) it.failedCount += 1;
        }
      },
    });
  }

  /** Puts the parts end to end in one file without re-encoding them. */
  async joinParts(it, workDir, signal, paint) {
    it.status = 'processing';
    it.step = `Joining ${it.files.length} parts`;
    it.partIndex = 0;
    paint(true);
    const ext = (it.files[0].match(/\.[^.\\/]+$/) || ['.mp4'])[0];
    const list = join(workDir, 'parts.txt');
    await writeText(list, it.files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const out = join(workDir, `${safeName(it.title)} (${it.files.length} parts)${ext}`);
    const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy'];
    if (/\.(mp4|m4a|mov)$/i.test(ext)) args.push('-movflags', '+faststart');
    args.push(out);
    try {
      await runProcess(tools.ffmpeg, args, { signal, keep: 30 });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw Object.assign(new Error('FFmpeg could not join the parts.'), { shrink: true });
    }
    it.files = [out];
  }

  /** Moves finished files from the work folder to the save folder. */
  async moveOut(it) {
    await mkdir(it.opts.folder);
    const out = [];
    for (const f of it.files) {
      const dest = join(it.opts.folder, basename(f));
      await rename(f, dest).catch(async () => {
        await invoke('fs_copy', { from: f, to: dest });
      });
      out.push(dest);
    }
    it.files = out;
  }

  /**
   * Turns the speech in each downloaded file into a .txt (and .srt) in the save folder.
   * The sound itself sits in the work folder and goes when the download finishes, unless
   * it is a kept video or a file that was already on this computer.
   */
  async transcribeAll(it, { keepSource, signal, paint }) {
    const o = it.opts;
    const out = [];
    for (const [i, file] of it.files.entries()) {
      // "Clinic tour 1080p.mp4" becomes "Clinic tour"
      let name = basename(file).replace(/\.[^.]+$/, '').replace(/ \d{3,4}p$/, '');
      if (o.translate) name += ' (English)';
      const prefix = it.files.length > 1 ? `File ${i + 1} of ${it.files.length} · ` : '';
      it.status = 'processing';
      it.percent = 0;
      try {
        const written = await transcribeFile(file, join(o.folder, safeName(name)), {
          model: o.model,
          language: o.language,
          translate: o.translate,
          srt: o.srt,
          gpu: o.gpu,
          words: o.words,
          signal,
          onProgress: (f, step) => {
            it.percent = f * 100;
            it.step = prefix + (step === 'Listening' ? `Listening · ${Math.floor(f * 100)}%` : step + (f > 0 && f < 1 ? ` · ${Math.floor(f * 100)}%` : ''));
            paint();
          },
        });
        out.push(...written);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw Object.assign(new Error(e?.message || String(e)), { shrink: true });
      }
    }
    it.transcriptFiles = out;
    it.files = keepSource ? [...it.files, ...out] : out;
  }

  /** Shrinks each downloaded video into the save folder under the size limit. */
  async shrinkAll(it, workDir, signal, paint) {
    const limit = Number(it.opts.smallMB) || 50;
    const out = [];
    await mkdir(it.opts.folder);
    for (const [i, file] of it.files.entries()) {
      const name = basename(file).replace(/\.[^.]+$/, '');
      const dest = join(it.opts.folder, `${name} (${limit} MB).mp4`);
      it.status = 'processing';
      it.step = `Shrinking to ${limit} MB`;
      it.percent = 0;
      paint(true);
      try {
        const shrunk = await shrinkVideo(file, dest, {
          limitMB: limit,
          duration: it.files.length === 1 && !it.opts.part ? it.duration : 0,
          signal,
          onProgress: (f) => {
            it.percent = f * 100;
            it.step = `Shrinking to ${limit} MB · ${Math.floor(f * 100)}%`;
            paint();
          },
        });
        if (!shrunk) {
          // already under the limit, so the download itself is the file
          const keep = join(it.opts.folder, `${name}.mp4`);
          await rename(file, keep).catch(async () => {
            await invoke('fs_copy', { from: file, to: keep });
          });
          out.push(keep);
        } else out.push(dest);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw Object.assign(new Error(e?.message?.startsWith('ffmpeg') ? 'FFmpeg could not shrink the video.' : e?.message || String(e)), { shrink: true });
      }
      if (i === it.files.length - 1) it.percent = 100;
    }
    it.files = out;
  }

  /** Hands the finished files to Desktop Connector for the phone to download. */
  async sendToPhone(it, quiet = false) {
    if (!it.files?.length) return;
    it.phone = 'sending';
    it.step = 'Sending to phone';
    this.onChange(it);
    try {
      for (const f of it.files) await invoke('connector_send', { path: f });
      it.phone = 'sent';
    } catch (e) {
      it.phone = 'failed';
      it.phoneError = String(e?.message || e);
      if (!quiet) throw e;
    } finally {
      it.step = '';
      this.onChange();
      this.saveHistory();
    }
  }

  /** Deletes the .part files a cancelled download leaves behind. */
  async cleanUp(it) {
    // give Windows a moment to release the files after the process is stopped
    await new Promise((r) => setTimeout(r, 600));
    for (const tmp of it.tmpFiles || []) {
      for (const p of [tmp, tmp + '.ytdl', tmp.replace(/\.part$/, '') + '.ytdl']) {
        try {
          if (await exists(p)) await remove(p);
        } catch {
          // still locked; yt-dlp resumes from it next time
        }
      }
    }
  }
}
