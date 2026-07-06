// netlify/functions/event-share.mjs
// Serves a tiny HTML page with event-specific Open Graph tags so that when an
// event link is pasted into Facebook/Instagram/iMessage/etc., the preview card
// shows the event's banner, title, and date. Real browsers are redirected to
// the live calendar deep link.
//
// URL shapes handled:
//   /event/<id>?date=<ds>          (via redirect in netlify.toml — the Share button link)
//   /event/<id>/photo              (serves the event's stored photo as a real image URL,
//                                   so base64/data-URL photos work as og:image)
//   /ngh?event=<id>&date=<ds>      (via query-matched rewrite in netlify.toml — the raw
//   /?event=<id>&date=<ds>          calendar deep link people copy from the address bar)
//
// Crawlers (Facebook, Twitter/X, Discord, Slack, WhatsApp, iMessage, etc.) get the
// OG page. Humans get a 302 to /ngh.html?event=... or /index.html?event=... — the
// .html paths bypass the query-matched rewrite rules, so there is no redirect loop.
import { sql, ensureSchema } from './_shared/db.mjs';

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(t){ if(!t) return ''; var p=String(t).split(':'); var h=+p[0],m=+p[1],ap=h>=12?'PM':'AM',hh=h%12; if(hh===0)hh=12; return hh+':'+(m<10?'0':'')+m+' '+ap; }

const BOT_RE = /facebookexternalhit|facebot|twitterbot|slackbot|linkedinbot|whatsapp|discordbot|telegrambot|pinterest|redditbot|googlebot|bingbot|applebot|skypeuripreview|vkshare|embedly|quora link preview|tumblr|bitlybot|nuzzel|snapchat|iframely|mastodon/i;

export default async (req) => {
  const base = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const wantsPhoto = parts[parts.length - 1] === 'photo';

    // id may be ?id=, ?event= (deep-link rewrites), or a path segment (/event/<id>[/photo])
    let id = url.searchParams.get('id') || url.searchParams.get('event') || '';
    if (!id) id = (wantsPhoto ? parts[parts.length - 2] : parts[parts.length - 1]) || '';
    const ds = url.searchParams.get('date') || '';

    // Which page should humans land on? Deep links from the homepage go back to
    // the homepage; everything else goes to the calendar page. The .html suffix
    // is load-bearing: /ngh and / (with ?event=) rewrite to this function.
    const fromIndex = url.pathname === '/' || url.pathname.startsWith('/index');
    const human = base + (fromIndex ? '/index.html' : '/ngh.html') +
      '?event=' + encodeURIComponent(id) + (ds ? ('&date=' + encodeURIComponent(ds)) : '');

    await ensureSchema();
    const rows = await sql`SELECT data FROM events WHERE id = ${id}`;
    const e = rows.length ? rows[0].data : null;

    // ---- /event/<id>/photo — serve the stored photo as a fetchable image ----
    if (wantsPhoto) {
      if (e && e.photo) {
        if (/^https?:\/\//i.test(e.photo)) {
          return new Response('', { status: 302, headers: { Location: e.photo, 'Cache-Control': 'public, max-age=86400' } });
        }
        const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(e.photo);
        if (m) {
          return new Response(Buffer.from(m[2], 'base64'), {
            status: 200,
            headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' }
          });
        }
      }
      return new Response('', { status: 302, headers: { Location: base + '/logo.png' } });
    }

    // ---- Humans: straight to the live event popup ----
    const ua = req.headers.get('user-agent') || '';
    if (!BOT_RE.test(ua)) {
      return new Response('', { status: 302, headers: { Location: human, 'Cache-Control': 'no-store' } });
    }

    // ---- Crawlers: event-specific Open Graph page ----
    const title = e ? (e.title || 'Northwood Game Haven Event') : 'Northwood Game Haven';
    const when = e ? ((ds || e.date || '') + (e.allDay ? ' · All day' : (e.start ? (' · ' + fmtTime(e.start) + (e.end ? ' – ' + fmtTime(e.end) : '')) : ''))) : '';
    let desc = e ? (e.notes || '') : 'Tournaments, open play, and private game rooms in Chippewa Falls, WI.';
    if (e && e.registration && e.registration.enabled) {
      desc += (desc ? ' ' : '') + (e.registration.cost > 0 ? ('Registration $' + Number(e.registration.cost).toFixed(2) + '. ') : 'Free to register. ');
    }
    desc = (when ? (when + ' — ') : '') + desc;

    // og:image must be a public URL. Hosted photos pass through; data-URL photos
    // are exposed via the /photo endpoint above; otherwise fall back to the logo.
    let img = base + '/logo.png';
    if (e && e.photo) {
      if (/^https?:\/\//i.test(e.photo)) img = e.photo;
      else if (/^data:image\//i.test(e.photo)) img = base + '/event/' + encodeURIComponent(id) + '/photo';
    }

    const canonical = base + '/event/' + encodeURIComponent(id) + (ds ? ('?date=' + encodeURIComponent(ds)) : '');

    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<title>' + esc(title) + ' · Northwood Game Haven</title>' +
      '<meta name="description" content="' + esc(desc) + '">' +
      '<meta property="og:type" content="event">' +
      '<meta property="og:site_name" content="Northwood Game Haven">' +
      '<meta property="og:title" content="' + esc(title) + '">' +
      '<meta property="og:description" content="' + esc(desc) + '">' +
      '<meta property="og:image" content="' + esc(img) + '">' +
      '<meta property="og:url" content="' + esc(canonical) + '">' +
      '<meta name="twitter:card" content="summary_large_image">' +
      '<meta name="twitter:title" content="' + esc(title) + '">' +
      '<meta name="twitter:description" content="' + esc(desc) + '">' +
      '<meta name="twitter:image" content="' + esc(img) + '">' +
      // safety net for bots we don't recognize that still render HTML
      '<meta http-equiv="refresh" content="0; url=' + esc(human) + '">' +
      '<script>location.replace(' + JSON.stringify(human) + ');</scr' + 'ipt>' +
      '</head><body style="font-family:Georgia,serif;text-align:center;padding:40px;color:#2d5a3d;">' +
      '<p>Opening <a href="' + esc(human) + '">' + esc(title) + '</a>…</p>' +
      '</body></html>';

    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  } catch (e) {
    // On any error, just bounce to the calendar (the .html path avoids re-entering this function).
    return new Response('', { status: 302, headers: { Location: base + '/ngh.html' } });
  }
};
