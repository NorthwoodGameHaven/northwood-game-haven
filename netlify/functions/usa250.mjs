// netlify/functions/usa250.mjs
// "USA 250" $5 Store Cash giveaway — entry collection + admin export.
//
//   POST /usa250              { name, phone, email, agree:true }  -> save entry (public)
//   GET  /usa250?status=1                                          -> { open } (public; no counts)
//   GET  /usa250              (Authorization: Bearer <admin token>)-> { entries:[...] } (admin only)
//
// One entry per person: unique on normalized email AND normalized phone.
// The first CAP entries receive the credit; the form hard-closes after CAP.
import { sql, json, bad, preflight, requireAdmin } from './_shared/db.mjs';

const CAP = 50;

async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS usa250_entries (
    seq        SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    email      TEXT NOT NULL,
    agreed     BOOLEAN NOT NULL,
    agreed_text TEXT,
    ip         TEXT,
    submitted  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS usa250_email_uq ON usa250_entries (lower(email))`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS usa250_phone_uq ON usa250_entries (phone)`;
}

const digits = (s) => String(s || '').replace(/\D+/g, '');

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureTable();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    // Public open/closed status — intentionally reveals no counts.
    if (url.searchParams.get('status')) {
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM usa250_entries`;
      return json({ open: count < CAP });
    }
    // Admin: full entry list.
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const rows = await sql`SELECT seq, name, phone, email, agreed, agreed_text, submitted
                           FROM usa250_entries ORDER BY seq ASC`;
    return json({ cap: CAP, count: rows.length, entries: rows });
  }

  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    if (b.hp) return json({ ok: true });               // honeypot: silently drop bots

    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    const emailRaw = String(b.email || '').trim();
    const email = emailRaw.toLowerCase();
    const phone = digits(b.phone);

    if (!name || name.length < 2 || name.length > 80) return bad('Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return bad('Please enter a valid email address.');
    if (phone.length < 10 || phone.length > 15) return bad('Please enter a valid phone number (10 digits).');
    if (b.agree !== true) return bad('You must read and accept the Terms & Conditions to enter.');

    // Hard close at CAP — first 50 only, no entries collected after the promo ends.
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM usa250_entries`;
    if (count >= CAP) return bad('All 50 spots have been claimed — this promotion has ended.', 410);

    // One entry per person (email OR phone already used = duplicate).
    const dup = await sql`SELECT 1 FROM usa250_entries WHERE lower(email) = ${email} OR phone = ${phone} LIMIT 1`;
    if (dup.length) return bad("Looks like you've already entered — one entry per person. See you at the shop!", 409);

    const agreedText = String(b.agreeText || '').slice(0, 1000);
    const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '';
    try {
      await sql`INSERT INTO usa250_entries (name, phone, email, agreed, agreed_text, ip)
                VALUES (${name}, ${phone}, ${emailRaw.toLowerCase()}, true, ${agreedText}, ${ip})`;
    } catch (e) {
      // unique-index race: two tabs / double-click
      return bad("Looks like you've already entered — one entry per person. See you at the shop!", 409);
    }
    return json({ ok: true });
  }

  return bad('Method not allowed', 405);
};

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[usa250] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};
