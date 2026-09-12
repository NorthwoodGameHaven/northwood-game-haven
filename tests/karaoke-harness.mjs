// NGH-BUILD 2026-09-11a
// tests/karaoke-harness.mjs — local dev/test server that runs the REAL
// netlify/functions/karaoke.mjs and companion.mjs against the in-memory db
// stand-in from _karaoke-hooks.mjs, plus static files from site/.
//   node --import ./tests/_register-karaoke.mjs tests/karaoke-harness.mjs   (PORT env, default 8888)
// Guru admin code for /api/admin-login is 1234. Seeds three songs with synced
// (made-up) lyrics so the TV/phone lyric renderers have something to show.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.env.PORT) || 8888;
const karaoke = (await import('../netlify/functions/karaoke.mjs')).default;
const companion = (await import('../netlify/functions/companion.mjs')).default;

// ---- seed catalog ----
function mkLyrics(lines) { // [text, startMs] -> TimedLyrics with evenly spread words
  const out = [];
  lines.forEach(([text, t], i) => { const end = lines[i + 1] ? lines[i + 1][1] : t + 4000; const toks = text.split(' '); const per = (end - t) / toks.length; out.push({ t, end, text, words: toks.map((w, k) => ({ t: Math.round(t + k * per), end: Math.round(t + (k + 1) * per), text: w + (k < toks.length - 1 ? ' ' : '') })) }); });
  return { lines: out, meta: { offset: 0 } };
}
const D = globalThis.__kdb;
const seed = [
  { id: 'local:test1', title: 'Otter Slide', artist: 'The Stash Band', ms: 40000, lyrics: mkLyrics([['Down by the river where the otters play', 4000], ['We stack the boxes and we roll all day', 8000], ['Sing it loud in the Haven tonight', 12000], ['Every room is glowing bright', 16000], ['Otter slide, otter slide', 22000], ['Bring your dice and bring your pride', 26000], ['Otter slide, otter slide', 30000], ['Karaoke battle side by side', 34000]]) },
  { id: 'local:test2', title: 'Meeple Moon', artist: 'Chippewa Choir', ms: 32000, lyrics: mkLyrics([['Meeple moon is rising over Spring Street', 3000], ['Shuffle up the deck and feel the beat', 7000], ['Roll the dice and take your turn', 11000], ['There is always one more game to learn', 15000], ['Meeple moon, meeple moon', 21000], ['The Depths are calling, see you soon', 25000]]) },
  { id: 'local:test3', title: 'Twenty-Sided Heart', artist: 'Dungeon Dwellers', ms: 28000, lyrics: null, cdg: 'http://192.168.1.50:8766/media/Dungeon%20Dwellers%20-%20Twenty-Sided%20Heart.cdg' }
];
for (const s of seed) D.songs.set(s.id, { id: s.id, provider: 'local', title: s.title, artist: s.artist, duration_ms: s.ms, data: { media: { audio: null, cdg: s.cdg || null }, lyrics: s.lyrics || undefined, durationMs: s.ms }, updated_at: new Date().toISOString() });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function toRequest(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : null;
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  return new Request('http://localhost:' + PORT + req.url, { method: req.method, headers, body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body });
}
async function send(res, r) { const buf = Buffer.from(await r.arrayBuffer()); const h = {}; r.headers.forEach((v, k) => { h[k] = v; }); res.writeHead(r.status, h); res.end(buf); }

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/karaoke')) return send(res, await karaoke(await toRequest(req)));
    if (u.pathname.startsWith('/api/companion')) return send(res, await companion(await toRequest(req)));
    if (u.pathname === '/api/tv/time' || u.pathname === '/api/trivia/time') return send(res, new Response(JSON.stringify({ serverNow: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
    if (u.pathname === '/api/tv/qr.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (u.pathname === '/api/admin-login') { const r = await toRequest(req); const b = await r.json().catch(() => ({})); return send(res, new Response(JSON.stringify(b.code === '1234' ? { token: 'admin-ok' } : { error: 'bad code' }), { status: b.code === '1234' ? 200 : 401, headers: { 'Content-Type': 'application/json' } })); }
    if (u.pathname === '/api/tv/admin/overview') return send(res, new Response(JSON.stringify({ devices: [], channels: [{ id: 'all', version: 3, data: globalThis.__tvPush || { mode: 'slideshow', slides: [{ url: '/brand/crest.png', dur: 10 }] } }] }), { headers: { 'Content-Type': 'application/json' } }));
    if (u.pathname.startsWith('/api/tv/admin/channel/')) { const r = await toRequest(req); globalThis.__tvPush = await r.json().catch(() => null); return send(res, new Response(JSON.stringify({ ok: true, pushed: globalThis.__tvPush }), { headers: { 'Content-Type': 'application/json' } })); }
    if (u.pathname === '/api/events') return send(res, new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
    if (u.pathname === '/api/trivia/active') return send(res, new Response(JSON.stringify({ id: null }), { headers: { 'Content-Type': 'application/json' } }));
    if (u.pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not mocked"}'); }
    // static (+ /fixtures/* → tests/fixtures for the synthetic CD+G track)
    let p = u.pathname.startsWith('/fixtures/') ? path.join(ROOT, 'tests', decodeURIComponent(u.pathname)) : path.join(SITE, decodeURIComponent(u.pathname)); if (p.endsWith('/')) p += 'index.html';
    let real; try { real = fs.realpathSync(p); } catch { res.writeHead(404); return res.end('not found'); }
    if (fs.statSync(real).isDirectory()) { real = path.join(real, 'index.html'); if (!fs.existsSync(real)) { res.writeHead(404); return res.end(); } }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(real).pipe(res);
  } catch (e) { console.error('[harness]', req.url, e); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
}).listen(PORT, () => console.log('karaoke harness on http://localhost:' + PORT + '  (admin code 1234)'));
