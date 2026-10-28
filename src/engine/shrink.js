// Re-encodes a video so it fits under a size limit, for sending on LINE and
// other chat apps that squash or refuse big files.

import { runProcess } from '../backend/proc.js';
import { stat } from '../backend/index.js';
import { tools } from './tools.js';

/**
 * Picks the video bitrate that lands the file just under limitMB, and a
 * smaller frame when that bitrate is too low for 720p to look sharp.
 */
export function shrinkPlan(durationSec, limitMB) {
  const budgetKbps = (limitMB * 1e6 * 0.94 * 8) / Math.max(1, durationSec) / 1000;
  const audio = budgetKbps < 400 ? 64 : 96;
  const video = Math.min(2500, Math.floor(budgetKbps - audio));
  const height = video >= 900 ? 720 : video >= 450 ? 540 : video >= 220 ? 360 : 240;
  return { video: Math.max(60, video), audio, height, possible: video >= 60 };
}

/** Reads the length of a video from FFmpeg's own report on it. */
export async function probeDuration(path) {
  try {
    await runProcess(tools.ffmpeg, ['-hide_banner', '-i', path], { keep: 60 });
  } catch (e) {
    // ffmpeg exits with an error when given no output, after printing the details
    const line = (e?.tail || []).concat([String(e?.message || '')]).find((l) => /Duration:\s*\d/.test(l));
    const m = line && /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

/**
 * Writes `output`. onProgress(fraction) runs as it goes. Returns false when the
 * original already fits, in which case nothing is written.
 */
export async function shrinkVideo(input, output, { limitMB, duration, signal, onProgress }) {
  const st = await stat(input);
  if (st && st.size <= limitMB * 1e6) return false;
  const length = duration || (await probeDuration(input));
  if (!length) throw new Error('The video length could not be read, so the size could not be worked out.');
  const plan = shrinkPlan(length, limitMB);
  if (!plan.possible) throw new Error(`The video is too long to fit in ${limitMB} MB. Download part of it instead.`);
  const args = [
    '-hide_banner', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-b:v', `${plan.video}k`, '-maxrate', `${Math.round(plan.video * 1.4)}k`, '-bufsize', `${plan.video * 2}k`,
    '-vf', `scale=-2:'min(${plan.height},ih)'`,
    '-c:a', 'aac', '-b:a', `${plan.audio}k`, '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    output,
  ];
  await runProcess(tools.ffmpeg, args, {
    signal,
    keep: 40,
    onLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / length));
    },
  });
  return true;
}
