// netlify/functions/admin-login.mjs
// POST { code }  ->  { token } if the code matches the ADMIN_CODE env var.
import { json, bad, preflight, issueToken } from './_shared/db.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);

  let body;
  try { body = await req.json(); } catch { return bad('Invalid JSON'); }

  const expected = process.env.ADMIN_CODE;
  if (!expected) return bad('Server not configured: set ADMIN_CODE env var', 500);

  if (!body || body.code !== expected) {
    // small constant-ish delay to blunt brute force
    await new Promise(r => setTimeout(r, 400));
    return bad('Incorrect code', 401);
  }
  return json({ token: issueToken(12) });
};
