#!/usr/bin/env node
// ngh-karaoke-player.mjs — NGH-BUILD 2026-09-11a
// Rack-PC karaoke playback service + local library server + catalog importer.
// Runs beside ngh-rack-player (same machine, its own NSSM service).
//
//   node ngh-karaoke-player.mjs            follow the active Karaoke session and play backing tracks via mpv
//   node ngh-karaoke-player.mjs import     scan mediaDir (MP3+G / MP3+LRC), push metadata + lyrics to gamehaven.guru
//   node ngh-karaoke-player.mjs devices    list mpv audio devices (pick the X-USB OUT 5-6 one for config.json)
//   node ngh-karaoke-player.mjs test <file>  play one file for 10 s through the configured device
//
// config.json (same folder):
// {
//   "site": "https://gamehaven.guru",
//   "playerKey": "<KARAOKE_PLAYER_KEY env value on Netlify>",
//   "adminCode": "<Guru admin code — only needed for `import`>",
//   "name": "rack",
//   "mpv": "C:\\NGH\\mpv\\mpv.com",
//   "audioDevice": "wasapi/{xxxxxxxx-....}",            // from `devices` — X-USB OUT 5-6
//   "mediaDir": "C:\\NGH\\karaoke\\media",
//   "servePort": 8766,
//   "mediaBaseUrl": "http://192.168.1.50:8766/media",   // this PC's LAN address — TVs/phones on venue WiFi fetch CDG here
//   "volume": 100,
//   "ipcPipe": "\\\\.\\pipe\\ngh-karaoke"
// }
// Timing model: the site schedules nowPlaying.startAt in server epoch ms. We keep a
// clock offset from /api/karaoke/time and start mpv so that audio begins at startAt
// (if we're late, we seek to the elapsed position). Pause/resume/seek arrive as a
// new `seq` with a recomputed startAt.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.NGH_KARAOKE_CONFIG || path.join(HERE, 'config.json');
const cfg = Object.assign({
  site: 'https://gamehaven.guru', playerKey: '', adminCode: '', name: 'rack', mpv: 'mpv', audioDevice: 'auto',
  mediaDir: path.join(HERE, 'media'), servePort: 8766, mediaBaseUrl: '', volume: 100,
  ipcPipe: process.platform === 'win32' ? '\\\\.\\pipe\\ngh-karaoke' : '/tmp/ngh-karaoke.sock'
}, fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {});
const API = cfg.site.replace(/\/$/, '') + '/api/karaoke';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status + ' ' + url));
  return j;
}

// ---------------------------------------------------------------- clock
let offset = 0;
async function syncClock() {
  const s = [];
  for (let i = 0; i < 3; i++) { const t0 = Date.now(); try { const j = await getJSON(API + '/time'); const t1 = Date.now(); s.push(j.serverNow + (t1 - t0) / 2 - t1); } catch {} }
  if (s.length) { s.sort((a, b) => a - b); offset = s[Math.floor(s.length / 2)]; }
}
const serverNow = () => Date.now() + offset;

// ---------------------------------------------------------------- mpv control
let mpv = null, ipc = null, ipcBuf = '', reqId = 0, pending = new Map(), current = { entryId: null, seq: null, file: null }, ended = false, lastPos = 0, lastError = null;
function ipcSend(cmd) {
  return new Promise((resolve) => {
    if (!ipc || ipc.destroyed) return resolve(null);
    const id = ++reqId; pending.set(id, resolve);
    ipc.write(JSON.stringify({ command: cmd, request_id: id }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 1500);
  });
}
function connectIpc(tries) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      const sock = net.connect(cfg.ipcPipe);
      sock.on('connect', () => { ipc = sock; ipcBuf = ''; resolve(true); });
      sock.on('data', (d) => { ipcBuf += d.toString(); let i; while ((i = ipcBuf.indexOf('\n')) >= 0) { const line = ipcBuf.slice(0, i); ipcBuf = ipcBuf.slice(i + 1); try { const m = JSON.parse(line); if (m.request_id && pending.has(m.request_id)) { pending.get(m.request_id)(m); pending.delete(m.request_id); } else if (m.event === 'end-file') { ended = true; } } catch {} } });
      sock.on('error', () => { if (n < tries) setTimeout(() => attempt(n + 1), 250); else resolve(false); });
    };
    attempt(0);
  });
}
async function startMpv(file, startSec) {
  await stopMpv();
  ended = false;
  const args = ['--no-config', '--no-video', '--really-quiet', '--keep-open=no', '--idle=no',
    '--audio-device=' + cfg.audioDevice, '--volume=' + (cfg.volume || 100), '--input-ipc-server=' + cfg.ipcPipe,
    '--start=' + Math.max(0, startSec).toFixed(3), file];
  lastError = null;
  const child = spawn(cfg.mpv, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  mpv = child;
  child.on('error', (e) => { lastError = 'mpv failed to start: ' + e.message + ' (check "mpv" path in config.json)'; log(lastError); ended = true; if (mpv === child) mpv = null; });
  child.stderr.on('data', d => { const s = d.toString().trim(); if (s) log('[mpv]', s); });
  child.on('exit', (code) => { log('mpv exited', code); ended = true; if (mpv === child) mpv = null; if (ipc) { ipc.destroy(); ipc = null; } });
  if (lastError) return;
  const ok = await connectIpc(20);
  if (!ok) log('warning: could not connect to mpv IPC');
}
async function stopMpv() {
  if (ipc) { try { await ipcSend(['quit']); } catch {} try { ipc.destroy(); } catch {} ipc = null; }
  if (mpv) { try { mpv.kill(); } catch {} mpv = null; }
  await sleep(50);
}
async function mpvPos() { const r = await ipcSend(['get_property', 'time-pos']); return r && typeof r.data === 'number' ? r.data : null; }

// ---------------------------------------------------------------- media resolution
function localPathFor(url) {
  if (!url) return null;
  if (cfg.mediaBaseUrl && url.startsWith(cfg.mediaBaseUrl)) {
    const rel = decodeURIComponent(url.slice(cfg.mediaBaseUrl.length)).replace(/^\/+/, '');
    const p = path.join(cfg.mediaDir, rel); if (fs.existsSync(p)) return p;
  }
  if (/^[a-zA-Z]:\\|^\//.test(url) && fs.existsSync(url)) return url;
  return url; // remote URL: mpv streams it
}

// ---------------------------------------------------------------- main loop
let sessionCode = null, version = 0, state = null, status = 'idle', lastBeat = 0, lastActiveCheck = 0;
async function heartbeat() {
  if (!sessionCode) return;
  try {
    const pos = mpv ? await mpvPos() : null; if (pos != null) lastPos = pos * 1000;
    const body = { key: cfg.playerKey, name: cfg.name, status, position: Math.round(lastPos), entryId: current.entryId, device: cfg.audioDevice, error: lastError };
    const j = await getJSON(API + '/sessions/' + sessionCode + '/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (status === 'ended') { status = 'idle'; current = { entryId: null, seq: null, file: null }; }
    return j;
  } catch (e) { log('heartbeat failed', e.message); }
}
async function follow() {
  const t = Date.now();
  if (!sessionCode || t - lastActiveCheck > 15000) {
    lastActiveCheck = t;
    try { const a = await getJSON(API + '/active'); if (a.code !== sessionCode) { sessionCode = a.code || null; version = 0; state = null; log('session', sessionCode || 'none'); if (!sessionCode) { await stopMpv(); status = 'idle'; } } } catch (e) { log('active check failed', e.message); }
  }
  if (!sessionCode) return;
  try {
    const j = await getJSON(API + '/sessions/' + sessionCode + '/state?v=' + version);
    if (!j.unchanged) { version = j.version; state = j; await applyState(); }
  } catch (e) { log('poll failed', e.message); }
  // detect natural end
  if (mpv === null && current.entryId && status === 'playing') {
    if (lastError) { status = 'error'; }
    else { status = 'ended'; log('song ended', current.entryId); await heartbeat(); }
  }
}
async function applyState() {
  const np = state.nowPlaying;
  if (!np) { if (current.entryId) { await stopMpv(); current = { entryId: null, seq: null, file: null }; status = 'idle'; } return; }
  if (np.seq === current.seq && np.entryId === current.entryId) return;
  const audio = np.media && np.media.audio;
  if (!audio) { await stopMpv(); current = { entryId: np.entryId, seq: np.seq, file: null }; status = 'no-media'; log('no media for', np.title); return; }
  current = { entryId: np.entryId, seq: np.seq, file: localPathFor(audio) };
  if (np.pausedAt) { if (ipc) await ipcSend(['set_property', 'pause', true]); status = 'paused'; return; }
  const wait = np.startAt - serverNow();
  status = 'preloaded';
  log('play', np.title, 'in', Math.round(wait), 'ms ->', current.file);
  if (wait > 150) { await sleep(wait - 120); }
  const elapsed = Math.max(0, (serverNow() - np.startAt) / 1000);
  await startMpv(current.file, elapsed);
  status = 'playing';
}

// ---------------------------------------------------------------- hosted CD+G uploads
// Browsers load gamehaven.guru over HTTPS and can't fetch this PC's http:// LAN URLs,
// so every CD+G that enters the queue is uploaded to /api/karaoke/media/<id>/cdg.
let lastMediaCheck = 0; const uploaded = new Set();
async function uploadNeededCdg() {
  if (!sessionCode || Date.now() - lastMediaCheck < 5000) return;
  lastMediaCheck = Date.now();
  let list;
  try { list = (await getJSON(API + '/media/needed?session=' + sessionCode, { headers: { 'x-karaoke-key': cfg.playerKey } })).songs || []; }
  catch (e) { log('media check failed', e.message); return; }
  for (const s of list) {
    if (uploaded.has(s.id)) continue;
    const file = localPathFor(s.cdg);
    if (!file || !fs.existsSync(file)) { log('cdg not found locally for', s.id, s.cdg); uploaded.add(s.id); continue; }
    const buf = fs.readFileSync(file);
    if (buf.length > 4 * 1024 * 1024) { log('cdg too large to host (>4 MB):', file); uploaded.add(s.id); continue; }
    try {
      await getJSON(API + '/media/' + encodeURIComponent(s.id) + '/cdg', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-karaoke-key': cfg.playerKey }, body: JSON.stringify({ b64: buf.toString('base64') }) });
      uploaded.add(s.id); log('hosted cdg for', s.id, (buf.length / 1024).toFixed(0) + ' KB');
    } catch (e) { log('cdg upload failed', s.id, e.message); }
  }
}

// ---------------------------------------------------------------- media server (LAN)
function serveMedia() {
  const root = path.resolve(cfg.mediaDir);
  const types = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.cdg': 'application/octet-stream', '.lrc': 'text/plain; charset=utf-8', '.mp4': 'video/mp4' };
  http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!req.url.startsWith('/media/')) { res.writeHead(404); return res.end(); }
    const rel = decodeURIComponent(req.url.slice(7).split('?')[0]);
    const p = path.resolve(root, rel);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(p).size, ct = types[path.extname(p).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': ct, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else { res.writeHead(200, { 'Content-Type': ct, 'Content-Length': size, 'Accept-Ranges': 'bytes' }); fs.createReadStream(p).pipe(res); }
  }).listen(cfg.servePort, () => log('media server on :' + cfg.servePort + ' ->', root));
}

// ---------------------------------------------------------------- importer
function ts(str) { const p = str.split(':').map(Number); if (p.some(isNaN)) return null; return p.length === 2 ? Math.round((p[0] * 60 + p[1]) * 1000) : Math.round(((p[0] * 60 + p[1]) * 60 + p[2]) * 1000); }
function parseLRC(text) {
  const meta = {}, lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/^\[([a-zA-Z]+):(.*)\]$/); if (m) { meta[m[1].toLowerCase()] = m[2].trim(); continue; }
    const times = []; let rest = line, tm;
    while ((tm = rest.match(/^\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/))) { times.push(ts(tm[1].replace(/:(\d{1,3})$/, '.$1'))); rest = rest.slice(tm[0].length); }
    if (!times.length) continue;
    const words = []; const re = /<(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)>([^<]*)/g; let wm, any = false;
    while ((wm = re.exec(rest))) { any = true; if (wm[2].trim()) words.push({ t: ts(wm[1].replace(/:(\d{1,3})$/, '.$1')), text: wm[2] }); }
    const plain = any ? rest.replace(/<[^>]*>/g, '') : rest;
    for (const t of times) { const l = { t, text: plain.trim() }; if (any) l.words = words.map(w => ({ t: w.t, text: w.text })); lines.push(l); }
  }
  lines.sort((a, b) => a.t - b.t);
  const off = Number(meta.offset) || 0; lines.forEach(l => { l.t -= off; if (l.words) l.words.forEach(w => { w.t -= off; }); });
  return { lines, meta: { title: meta.ti, artist: meta.ar, offset: 0 } };
}
function durationMs(file) {
  try { const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }); const d = parseFloat(r.stdout); if (d > 0) return Math.round(d * 1000); } catch {}
  try { const r = spawnSync(cfg.mpv, ['--no-config', '--ao=null', '--vo=null', '--quiet', '--end=0.05', '--term-playing-msg=NGHDUR=${=duration}', file], { encoding: 'utf8', timeout: 15000 }); const m = String(r.stdout || '').match(/NGHDUR=([\d.]+)/); if (m) return Math.round(parseFloat(m[1]) * 1000); } catch {}
  return null;
}
function walk(dir) { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }
async function importLibrary() {
  if (!cfg.adminCode) throw new Error('adminCode missing in config.json');
  if (!cfg.mediaBaseUrl) throw new Error('mediaBaseUrl missing in config.json (e.g. http://<rack-ip>:8766/media)');
  const login = await getJSON(cfg.site + '/api/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cfg.adminCode }) });
  const token = login.token;
  const root = path.resolve(cfg.mediaDir);
  const files = walk(root).filter(f => /\.(mp3|m4a|ogg|flac|wav|mp4)$/i.test(f));
  log('found', files.length, 'audio files');
  const songs = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const base = f.replace(/\.[^.]+$/, ''); const cdg = fs.existsSync(base + '.cdg') ? base + '.cdg' : fs.existsSync(base + '.CDG') ? base + '.CDG' : null; const lrc = fs.existsSync(base + '.lrc') ? base + '.lrc' : null;
    const name = path.basename(base); let artist = '', title = name;
    const m = name.match(/^(.*?)\s+-\s+(.*)$/); if (m) { artist = m[1].trim(); title = m[2].trim(); }
    title = title.replace(/\s*\[(karaoke|instrumental)[^\]]*\]\s*/i, '').replace(/\s*\((karaoke|instrumental)[^)]*\)\s*/i, '').trim();
    const urlFor = (p) => cfg.mediaBaseUrl.replace(/\/$/, '') + '/' + path.relative(root, p).split(path.sep).map(encodeURIComponent).join('/');
    const song = { id: 'local:' + crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16), provider: 'local', title, artist, durationMs: durationMs(f), media: { audio: urlFor(f), cdg: cdg ? urlFor(cdg) : null } };
    if (lrc) { try { const L = parseLRC(fs.readFileSync(lrc, 'utf8')); if (L.lines.length) { song.lyrics = L; if (!song.artist && L.meta.artist) song.artist = L.meta.artist; } } catch (e) { log('bad lrc', lrc, e.message); } }
    songs.push(song); if (songs.length % 25 === 0) log('scanned', songs.length);
  }
  let up = 0;
  for (let i = 0; i < songs.length; i += 50) {
    const j = await getJSON(API + '/catalog', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ songs: songs.slice(i, i + 50) }) });
    up += j.upserted || 0; log('uploaded', up, '/', songs.length);
  }
  log('done —', up, 'songs in the Haven library');
}

// ---------------------------------------------------------------- entry
const mode = process.argv[2] || 'run';
if (mode === 'devices') {
  const r = spawnSync(cfg.mpv, ['--no-config', '--audio-device=help'], { encoding: 'utf8' }); console.log(r.stdout || r.stderr);
} else if (mode === 'test') {
  const f = process.argv[3]; if (!f) { console.error('usage: test <file>'); process.exit(1); }
  await startMpv(f, 0); await sleep(10000); await stopMpv(); process.exit(0);
} else if (mode === 'import') {
  importLibrary().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
} else {
  log('ngh-karaoke-player starting — site', cfg.site, '— device', cfg.audioDevice);
  serveMedia();
  await syncClock(); setInterval(syncClock, 60000);
  (async function loop() { for (;;) { try { await follow(); await uploadNeededCdg(); } catch (e) { log('loop error', e.message); } if (Date.now() - lastBeat > 2000) { lastBeat = Date.now(); await heartbeat(); } await sleep(state && state.nowPlaying ? 1000 : 2000); } })();
}
