// netlify/functions/event-share.mjs
// Serves a tiny HTML page with event-specific Open Graph tags so that when an
// event link is pasted into Facebook/Instagram/iMessage/etc., the preview card
// shows the event's banner, title, and date. Real browsers are redirected to
// the live calendar deep link (/ngh?event=<id>&date=<ds>).
//
// URL shape (via redirect in netlify.toml):  /event/<id>?date=<ds>
import { sql, ensureSchema } from './_shared/db.mjs';

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(t){ if(!t) return ''; var p=String(t).split(':'); var h=+p[0],m=+p[1],ap=h>=12?'PM':'AM',hh=h%12; if(hh===0)hh=12; return hh+':'+(m<10?'0':'')+m+' '+ap; }

export default async (req) => {
  const base = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  try {
    const url = new URL(req.url);
    // id may be a path segment (/event/<id>) or ?id=
    let id = url.searchParams.get('id') || '';
    if (!id) { const parts = url.pathname.split('/').filter(Boolean); id = parts[parts.length - 1] || ''; }
    const ds = url.searchParams.get('date') || '';
    const human = base + '/ngh?event=' + encodeURIComponent(id) + (ds ? ('&date=' + encodeURIComponent(ds)) : '');

    await ensureSchema();
    const rows = await sql`SELECT data FROM events WHERE id = ${id}`;
    const e = rows.length ? rows[0].data : null;

    const title = e ? (e.title || 'Northwood Game Haven Event') : 'Northwood Game Haven';
    const when = e ? ((ds || e.date || '') + (e.allDay ? ' · All day' : (e.start ? (' · ' + fmtTime(e.start) + (e.end ? ' – ' + fmtTime(e.end) : '')) : ''))) : '';
    let desc = e ? (e.notes || '') : 'Tournaments, open play, and private game rooms in Chippewa Falls, WI.';
    if (e && e.registration && e.registration.enabled) {
      desc += (desc ? ' ' : '') + (e.registration.cost > 0 ? ('Registration $' + Number(e.registration.cost).toFixed(2) + '. ') : 'Free to register. ');
    }
    desc = (when ? (when + ' — ') : '') + desc;
    // event banner if it's a real hosted image; SVG data URLs don't work as OG images,
    // so fall back to the logo for those.
    let img = base + '/logo.png';
    if (e && e.photo && /^https?:\/\//i.test(e.photo)) img = e.photo;

    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<title>' + esc(title) + ' · Northwood Game Haven</title>' +
      '<meta name="description" content="' + esc(desc) + '">' +
      '<meta property="og:type" content="event">' +
      '<meta property="og:site_name" content="Northwood Game Haven">' +
      '<meta property="og:title" content="' + esc(title) + '">' +
      '<meta property="og:description" content="' + esc(desc) + '">' +
      '<meta property="og:image" content="' + esc(img) + '">' +
      '<meta property="og:url" content="' + esc(human) + '">' +
      '<meta name="twitter:card" content="summary_large_image">' +
      '<meta name="twitter:title" content="' + esc(title) + '">' +
      '<meta name="twitter:description" content="' + esc(desc) + '">' +
      '<meta name="twitter:image" content="' + esc(img) + '">' +
      // redirect real visitors to the live calendar deep link
      '<meta http-equiv="refresh" content="0; url=' + esc(human) + '">' +
      '<script>location.replace(' + JSON.stringify(human) + ');</scr' + 'ipt>' +
      '</head><body style="font-family:Georgia,serif;text-align:center;padding:40px;color:#2d5a3d;">' +
      '<p>Opening <a href="' + esc(human) + '">' + esc(title) + '</a>…</p>' +
      '</body></html>';

    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  } catch (e) {
    // On any error, just bounce to the calendar.
    return new Response('', { status: 302, headers: { Location: base + '/ngh' } });
  }
};
