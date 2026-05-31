// netlify/functions/_shared/email.mjs
// Sends branded HTML emails (with logo) via Resend, with a plain-text fallback.
// Logo is referenced by public URL (most reliable across mail clients).

const LOGO_URL = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '') + '/logo.png';
const FOREST = '#2d5a3d', GOLD = '#c79a3b', DARK = '#1a1a12';

// Convert a plain-text body into simple HTML paragraphs, auto-linking URLs.
function textToHtml(text) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text)
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:' + FOREST + ';">$1</a>')
    .split('\n').map(line => line.trim() === '' ? '<div style="height:10px;"></div>' : '<div>' + line + '</div>').join('');
}

// Build the full branded HTML wrapper. `buttons` is an optional array of
// { label, url, primary } rendered as nice call-to-action buttons.
export function renderEmail({ heading, bodyText, buttons }) {
  const btnHtml = (buttons || []).map(b => {
    const bg = b.primary ? GOLD : '#ffffff';
    const color = b.primary ? DARK : FOREST;
    const border = b.primary ? GOLD : '#cfe0d4';
    return '<tr><td style="padding:6px 0;">' +
      '<a href="' + b.url + '" style="display:inline-block;background:' + bg + ';color:' + color +
      ';border:2px solid ' + border + ';text-decoration:none;font-family:Georgia,serif;font-weight:bold;' +
      'font-size:15px;padding:12px 26px;border-radius:40px;">' + b.label + '</a></td></tr>';
  }).join('');

  return '<!doctype html><html><body style="margin:0;padding:0;background:#f4f1e8;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e8;padding:24px 0;"><tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.08);">' +
    // header with logo
    '<tr><td align="center" style="background:' + FOREST + ';padding:22px 20px;">' +
    '<img src="' + LOGO_URL + '" alt="Northwood Game Haven" width="120" style="display:block;border:0;outline:none;max-width:120px;height:auto;">' +
    '</td></tr>' +
    // heading
    (heading ? ('<tr><td style="padding:24px 30px 0;"><h1 style="font-family:Georgia,serif;color:' + FOREST + ';font-size:22px;margin:0;">' + heading + '</h1></td></tr>') : '') +
    // body
    '<tr><td style="padding:16px 30px 8px;font-family:Arial,Helvetica,sans-serif;color:#3a3a30;font-size:15px;line-height:1.6;">' +
    textToHtml(bodyText) + '</td></tr>' +
    // buttons
    (btnHtml ? ('<tr><td style="padding:8px 30px 20px;"><table cellpadding="0" cellspacing="0">' + btnHtml + '</table></td></tr>') : '') +
    // footer
    '<tr><td style="padding:18px 30px;background:#faf8f2;border-top:1px solid #ece7d8;font-family:Arial,sans-serif;color:#8a8a6a;font-size:12px;line-height:1.5;">' +
    'Northwood Game Haven · 115 W Spring St, Chippewa Falls, WI 54729<br>' +
    '<a href="' + (process.env.SITE_URL || 'https://gamehaven.guru') + '" style="color:' + GOLD + ';">gamehaven.guru</a>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

// Send a branded email. Falls back to plain text automatically.
export async function sendBrandedMail(to, subject, { heading, bodyText, buttons }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Northwood Game Haven <bookings@northwoodgamehaven.com>';
  if (!apiKey) { console.log('[email] RESEND_API_KEY not set; logging only:', to, subject); return { ok: true, simulated: true }; }
  const html = renderEmail({ heading, bodyText, buttons });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text: bodyText })
  });
  if (!res.ok) { const detail = await res.text(); console.error('[email] Resend error', res.status, detail); return { ok: false }; }
  return { ok: true };
}
