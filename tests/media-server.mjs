// Serves tests/media slowly (about 3 MB/s) so the progress bar has something to show.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'media');
http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size;
  const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.webm') ? 'video/webm' : file.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
  let start = 0, end = size - 1, code = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) { start = m[1] ? +m[1] : 0; end = m[2] ? +m[2] : size - 1; code = 206; }
  res.writeHead(code, { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(code === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
  stream.on('data', (chunk) => { stream.pause(); res.write(chunk); setTimeout(() => stream.resume(), 20); });
  stream.on('end', () => res.end());
  req.on('close', () => stream.destroy());
}).listen(8099, '127.0.0.1');
