// netlify/functions/email-test.mjs
// DIAGNOSTIC ENDPOINT — visit from any browser/phone:
//   https://gamehaven.guru/.netlify/functions/email-test
//
// It reports your email-related configuration and (if a Resend key is present)
// performs ONE real send to your own admin address, returning the EXACT Resend
// status code and response body so you can see precisely what's wrong
// (missing key, unverified domain, wrong "from", etc.).
//
// SAFETY: it can only ever email your own ADMIN_EMAIL (stash@…). A caller
// cannot use it to send mail to arbitrary addresses.
import { json, preflight } from './_shared/db.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();

  const apiKey = process.env.RESEND_API_KEY || '';
  const from = process.env.MAIL_FROM || 'Northwood Game Haven <bookings@northwoodgamehaven.com>';
  const siteUrl = process.env.SITE_URL || '(not set — defaults to https://gamehaven.guru)';
  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';

  const report = {
    checkedAt: new Date().toISOString(),
    config: {
      RESEND_API_KEY: apiKey ? ('set (' + apiKey.slice(0, 5) + '…, length ' + apiKey.length + ')') : 'NOT SET ❌',
      MAIL_FROM: from,
      ADMIN_EMAIL: adminEmail,
      SITE_URL: siteUrl,
      ADMIN_CODE: process.env.ADMIN_CODE ? 'set' : 'NOT SET',
      ADMIN_SECRET: process.env.ADMIN_SECRET ? 'set' : 'not set (falls back to ADMIN_CODE)',
      NETLIFY_DATABASE_URL: process.env.NETLIFY_DATABASE_URL ? 'set' : 'NOT SET ❌'
    },
    sendTest: null,
    hints: []
  };

  if (!apiKey) {
    report.sendTest = 'SKIPPED — RESEND_API_KEY is not set, so no email can be sent. This is almost certainly your problem.';
    report.hints.push('Set RESEND_API_KEY in Netlify → Site configuration → Environment variables, then redeploy (env changes need a new deploy).');
    return json(report);
  }

  // Perform a real send to the admin address only.
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [adminEmail],
        subject: 'NGH email test ✅',
        text: 'This is a Northwood Game Haven email-system test sent at ' + new Date().toLocaleString() +
              '. If you received this, Resend is configured correctly.'
      })
    });
    const status = res.status;
    let bodyText = await res.text();
    let parsed; try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
    report.sendTest = { httpStatus: status, ok: res.ok, response: parsed };

    if (status === 200 || status === 201) {
      report.hints.push('✅ Resend accepted the message. Check the ' + adminEmail + ' inbox (and spam). If it is not there, the issue is mailbox/forwarding, not the app.');
    } else if (status === 401 || status === 403) {
      report.hints.push('Resend rejected the API key or the sending identity. Verify the key is a LIVE key, and that the domain in MAIL_FROM is VERIFIED in the Resend dashboard (Domains → status must say "Verified").');
    } else if (status === 422) {
      report.hints.push('Resend 422 usually means the "from" address/domain is not verified, or the address is malformed. Either verify ' + from + ' in Resend, or temporarily set MAIL_FROM to "Acme <onboarding@resend.dev>" to confirm sending works.');
    } else {
      report.hints.push('Unexpected status. Read the "response" field above for the exact Resend error message.');
    }
  } catch (e) {
    report.sendTest = { error: String(e && e.message ? e.message : e) };
    report.hints.push('The request to Resend threw before completing — likely a network/permission issue in the function.');
  }

  return json(report);
};
