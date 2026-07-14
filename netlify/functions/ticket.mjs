// netlify/functions/ticket.mjs
// Customer-facing ticket. Routes (via /ticket/* redirect in netlify.toml):
//   GET /ticket/<code>            -> branded printable ticket page (QR, party,
//                                    paid status, print / Wallet / manage-cancel)
//   GET /ticket/<code>/qr.png     -> the entry QR as a real PNG (email-safe)
//   GET /ticket/<code>/wallet     -> 302 to Google Wallet "Save" link (if configured)
//
// <code> is "<regId>.<hmac-sig>" — unguessable, verified server-side, and
// derived from ADMIN_SECRET so nothing extra is stored. The QR encodes the
// ticket URL itself, so any phone camera opens the ticket and the NGH
// check-in scanner (site/checkin.html) recognizes it.
import { sql, ensureSchema, bad } from './_shared/db.mjs';
import { parseTicketCode, ticketCode, ticketUrl, walletSaveUrl, walletConfigured, money } from './_shared/ticket.mjs';
import QRCode from 'qrcode';

const FOREST = '#2d5a3d', GOLD = '#c79a3b', CREAM = '#f4f1e9';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function html(body, status = 200, extraHeaders) {
  return new Response(body, { status, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}) });
}
function notFoundPage(msg) {
  return html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket</title>'
    + '<body style="font-family:Georgia,serif;background:' + CREAM + ';margin:0;"><div style="max-width:520px;margin:14vh auto;padding:28px 24px;background:#fff;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.12);text-align:center;">'
    + '<div style="font-size:2rem;">🦦</div><h1 style="color:' + FOREST + ';font-size:1.25rem;">' + esc(msg || 'Ticket not found') + '</h1>'
    + '<p style="color:#555;">If you think this is a mistake, reply to your confirmation email or call us.</p>'
    + '<p><a href="https://gamehaven.guru" style="color:' + FOREST + ';font-weight:bold;">Northwood Game Haven →</a></p></div></body>', 404);
}

export default async (req) => {
  try {
    if (req.method !== 'GET') return bad('Method not allowed', 405);
    await ensureSchema();

    const url = new URL(req.url);
    const parts = url.pathname.replace(/^.*\/(?:ticket)\//, '').split('/').filter(Boolean);
    const code = decodeURIComponent(parts[0] || '');
    const sub = (parts[1] || '').toLowerCase();

    const regId = parseTicketCode(code);
    if (!regId) return sub === 'qr.png' ? bad('not found', 404) : notFoundPage('That ticket link is not valid.');

    const rows = await sql`SELECT data FROM registrations WHERE id = ${regId}`;
    if (!rows.length) return sub === 'qr.png' ? bad('not found', 404) : notFoundPage('That ticket no longer exists.');
    const r = rows[0].data;

    // --- QR PNG (kept valid even for canceled regs; the scanner and the
    // ticket page both show the real status) ---
    if (sub === 'qr.png') {
      const png = await QRCode.toBuffer(ticketUrl(regId), { type: 'png', width: 480, margin: 2, color: { dark: '#1a2e20', light: '#ffffff' } });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }

    // --- Google Wallet save link ---
    if (sub === 'wallet') {
      if (r.status === 'canceled') return notFoundPage('This registration was canceled, so the ticket can\u2019t be added to Wallet.');
      const evRows = await sql`SELECT data FROM events WHERE id = ${r.eventId}`;
      const ev = evRows.length ? evRows[0].data : null;
      const save = walletSaveUrl({ reg: r, ev });
      if (!save) return notFoundPage('Google Wallet isn\u2019t set up yet — use the printable ticket or the QR in your email.');
      return new Response('', { status: 302, headers: { Location: save, 'Cache-Control': 'no-store' } });
    }

    // --- Ticket page ---
    const evRows = await sql`SELECT data FROM events WHERE id = ${r.eventId}`;
    const ev = evRows.length ? evRows[0].data : {};
    const qty = Math.max(1, parseInt(r.qty, 10) || 1);
    const names = Array.isArray(r.attendees) && r.attendees.length ? r.attendees : [r.name];
    const canceled = r.status === 'canceled';
    const cost = Number(r.cost) || 0;
    const paid = !!r.feePaid;
    const pendingPaid = url.searchParams.get('paid') === '1' && !paid && !canceled;
    const when = (r.occDate || ev.date || '') + (ev.start ? (' · ' + ev.start + '–' + (ev.end || '')) : '');
    const bd = r.paidBreakdown || r.totals || null;

    let statusChip;
    if (canceled) statusChip = '<span style="background:#fdecea;color:#9a3b2e;border:1px solid #f0c5be;padding:5px 14px;border-radius:50px;font-size:0.8rem;font-weight:bold;">CANCELED — not valid for entry</span>';
    else if (paid) statusChip = '<span style="background:#e7f5e8;color:#2e7d32;border:1px solid #b6dcb8;padding:5px 14px;border-radius:50px;font-size:0.8rem;font-weight:bold;">✅ PAID</span>';
    else if (pendingPaid) statusChip = '<span style="background:#fbf6ea;color:#8a6d1f;border:1px solid #e8d9b0;padding:5px 14px;border-radius:50px;font-size:0.8rem;font-weight:bold;">⏳ Payment received — confirming…</span>';
    else if (cost > 0) statusChip = '<span style="background:#fbf6ea;color:#8a6d1f;border:1px solid #e8d9b0;padding:5px 14px;border-radius:50px;font-size:0.8rem;font-weight:bold;">Payment due before the event</span>';
    else statusChip = '<span style="background:#e7f5e8;color:#2e7d32;border:1px solid #b6dcb8;padding:5px 14px;border-radius:50px;font-size:0.8rem;font-weight:bold;">FREE EVENT</span>';

    const payBtn = (!canceled && !paid && cost > 0)
      ? '<a href="/api/create-checkout?kind=registration&id=' + encodeURIComponent(r.id) + '" class="btn primary">💳 Pay ' + (bd ? money(bd.totalCents) : '') + ' Now</a>' : '';
    const walletBtn = (!canceled && walletConfigured())
      ? '<a href="/ticket/' + esc(ticketCode(r.id)) + '/wallet" class="btn">Add to Google Wallet</a>' : '';

    const paidLine = (paid && bd)
      ? '<div class="row"><span>Paid</span><strong>' + money(bd.totalCents) + '</strong></div>'
        + '<div class="sub">' + qty + ' × ' + money(Math.round((bd.subtotalCents || 0) / qty)) + ' + ' + money(bd.taxCents || 0) + ' tax + ' + money(bd.feeCents || 0) + ' processing fee</div>'
      : (cost > 0 && bd ? '<div class="row"><span>Total due</span><strong>' + money(bd.totalCents) + '</strong></div>'
        + '<div class="sub">' + qty + ' × ' + money(Math.round(cost * 100)) + ' + ' + money(bd.taxCents || 0) + ' tax + ' + money(bd.feeCents || 0) + ' processing fee</div>' : '');

    // Manage section: qty reduction (auto partial refund) + cancel.
    const qtyOptions = Array.from({ length: Math.max(0, qty - 1) }, (_, i) => '<option value="' + (i + 1) + '">' + (i + 1) + '</option>').join('');
    const manage = canceled ? '' :
      '<div id="manage" class="card manage"><h2>Manage this registration</h2>' +
      (qty > 1
        ? '<div class="mrow"><label>Reduce to</label><select id="newqty">' + qtyOptions + '</select><span>ticket' + (qty - 1 === 1 ? '' : 's') + '</span>' +
          '<button class="btn" onclick="reduceQty()">Update</button></div>' +
          '<p class="sub">Released tickets free up spots for others' + (paid ? ' and the difference is refunded to your card automatically' : '') + '.</p>'
        : '') +
      '<button class="btn danger" onclick="cancelReg()">Cancel registration' + (paid ? ' (full refund)' : '') + '</button>' +
      '<div id="mmsg" class="sub"></div></div>';

    const refreshMeta = pendingPaid ? '<meta http-equiv="refresh" content="4">' : '';

    const page = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + refreshMeta +
      '<meta name="robots" content="noindex,nofollow"><title>Your Ticket — ' + esc(r.eventTitle || 'NGH Event') + '</title><style>' +
      'body{font-family:Georgia,serif;background:' + CREAM + ';margin:0;color:#23351f;}' +
      '.wrap{max-width:560px;margin:24px auto 60px;padding:0 14px;}' +
      '.card{background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.10);padding:26px 24px;margin-bottom:16px;}' +
      '.tick{border:2px solid ' + GOLD + ';position:relative;overflow:hidden;text-align:center;}' +
      '.tick:before{content:"";position:absolute;top:0;left:0;right:0;height:8px;background:' + FOREST + ';}' +
      'h1{color:' + FOREST + ';font-size:1.35rem;margin:14px 0 4px;}' +
      '.when{color:#6a6a50;font-size:0.95rem;margin-bottom:10px;}' +
      '.qr{margin:16px auto 6px;max-width:260px;width:100%;border-radius:12px;border:1px solid #ece7d8;}' +
      '.admits{font-size:1.05rem;color:' + FOREST + ';font-weight:bold;margin:8px 0 2px;}' +
      '.names{color:#4a4a35;font-size:0.9rem;margin-bottom:8px;}' +
      '.rid{font-family:monospace;color:#8a8a6a;font-size:0.78rem;letter-spacing:0.04em;}' +
      '.row{display:flex;justify-content:space-between;font-size:0.95rem;margin-top:10px;}' +
      '.sub{color:#8a8a6a;font-size:0.8rem;margin-top:4px;}' +
      '.btn{display:inline-block;background:#fff;border:2px solid #cfe0d4;color:' + FOREST + ';text-decoration:none;font-weight:bold;font-size:0.92rem;padding:11px 22px;border-radius:40px;cursor:pointer;margin:6px 6px 0 0;font-family:Georgia,serif;}' +
      '.btn.primary{background:' + GOLD + ';border-color:' + GOLD + ';color:#1a1a12;}' +
      '.btn.danger{border-color:#c0392b;color:#c0392b;}' +
      '.manage h2{color:' + FOREST + ';font-size:1.05rem;margin:0 0 10px;}' +
      '.mrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;}' +
      '.mrow select{padding:8px 12px;border:1.5px solid #d8e0d4;border-radius:9px;font-size:0.95rem;}' +
      '@media print{.noprint{display:none!important;}body{background:#fff;}.card{box-shadow:none;}}' +
      '</style></head><body><div class="wrap">' +
      '<div class="card tick">' +
      '<div style="margin-top:8px;">' + statusChip + '</div>' +
      '<h1>' + esc(r.eventTitle || ev.title || 'NGH Event') + '</h1>' +
      '<div class="when">' + esc(when) + ' · Northwood Game Haven, 115 W Spring St, Chippewa Falls, WI</div>' +
      '<img class="qr" src="/ticket/' + esc(ticketCode(r.id)) + '/qr.png" alt="Entry QR code">' +
      '<div class="admits">Admits ' + qty + (qty === 1 ? ' person' : ' people') + (Number(r.checkedIn) > 0 ? (' · ' + Number(r.checkedIn) + ' checked in') : '') + '</div>' +
      '<div class="names">' + esc(names.join(' · ')) + '</div>' +
      '<div class="rid">' + esc(r.id) + '</div>' +
      paidLine +
      '<div class="noprint" style="margin-top:14px;">' +
      payBtn +
      '<a href="#" class="btn" onclick="window.print();return false;">🖨️ Print / Save PDF</a>' +
      walletBtn +
      '</div></div>' +
      '<div class="noprint">' + manage + '</div>' +
      '<p class="sub noprint" style="text-align:center;">Show this QR at the door — one scan checks in your whole party.</p>' +
      '</div>' +
      '<script>\n' +
      'var REG_ID=' + JSON.stringify(r.id) + ', TOKEN=' + JSON.stringify(r.cancelToken || '') + ';\n' +
      'function mmsg(t,ok){var m=document.getElementById("mmsg");if(m){m.textContent=t;m.style.color=ok?"#2e7d32":"#9a3b2e";}}\n' +
      'async function reduceQty(){\n' +
      '  var q=document.getElementById("newqty").value;\n' +
      '  if(!confirm("Reduce this registration to "+q+" ticket(s)?"+' + JSON.stringify(paid ? ' The difference will be refunded to your card.' : '') + ')) return;\n' +
      '  mmsg("Updating\\u2026",true);\n' +
      '  try{var res=await fetch("/api/registrations/"+encodeURIComponent(REG_ID)+"?token="+encodeURIComponent(TOKEN),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({qty:parseInt(q,10)})});\n' +
      '    var d=await res.json().catch(function(){return{};});\n' +
      '    if(!res.ok) throw new Error(d.error||"Could not update");\n' +
      '    alert("Updated! "+(d.changed?d.changed.join(". "):"")); location.reload();\n' +
      '  }catch(e){mmsg(e.message||"Something went wrong.",false);}\n' +
      '}\n' +
      'async function cancelReg(){\n' +
      '  if(!confirm("Cancel this registration?"+' + JSON.stringify(paid ? ' Your payment will be refunded automatically.' : '') + ')) return;\n' +
      '  mmsg("Canceling\\u2026",true);\n' +
      '  try{var res=await fetch("/api/registrations/"+encodeURIComponent(REG_ID)+"?token="+encodeURIComponent(TOKEN),{method:"DELETE"});\n' +
      '    var d=await res.json().catch(function(){return{};});\n' +
      '    alert(d&&d.refunded?"Canceled — your payment has been refunded.":"Your registration was canceled."); location.reload();\n' +
      '  }catch(e){mmsg("Something went wrong \\u2014 please contact us.",false);}\n' +
      '}\n' +
      '</script></body></html>';

    return html(page);
  } catch (e) {
    console.error('[ticket] error', e);
    return notFoundPage('Something went wrong loading this ticket.');
  }
};
