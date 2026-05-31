// netlify/functions/_shared/lightspeed.mjs
// Minimal Lightspeed X-Series (Vend) API client for looking up a customer by
// email and reading their customer GROUP, so the site can apply a group-based
// discount (e.g. "VIP" group → 10% off).
//
// Auth: this uses a long-lived PERSONAL TOKEN (simplest for a single retailer).
// Set these Netlify env vars:
//   LIGHTSPEED_DOMAIN   = your store prefix, e.g. "northwoodgamehaven"
//                         (the part before .retail.lightspeed.app)
//   LIGHTSPEED_TOKEN    = a Personal Token from your Lightspeed developer account
//
// Group→discount mapping is configured via:
//   LOYALTY_GROUP_DISCOUNTS = JSON like {"VIP":10,"Founding Member":15}
//     (group name → percent off). Matching is case-insensitive.
//
// If any of these are unset, loyalty lookups simply return "no discount" so the
// rest of the site keeps working.

function cfg() {
  return {
    domain: process.env.LIGHTSPEED_DOMAIN || '',
    token: process.env.LIGHTSPEED_TOKEN || '',
    map: parseMap(process.env.LOYALTY_GROUP_DISCOUNTS || '')
  };
}
function parseMap(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); const out = {}; for (const k in o) out[k.toLowerCase()] = Number(o[k]) || 0; return out; }
  catch { return {}; }
}

async function lsGet(path, params) {
  const { domain, token } = cfg();
  if (!domain || !token) return null;
  const url = new URL('https://' + domain + '.retail.lightspeed.app/api/2.0/' + path);
  if (params) for (const k in params) url.searchParams.set(k, params[k]);
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
  if (!res.ok) { console.error('[lightspeed]', path, res.status); return null; }
  return res.json().catch(() => null);
}

// Look up a customer by email; return { found, groupId, groupName } or null.
async function findCustomerByEmail(email) {
  if (!email) return null;
  // X-Series search endpoint
  const data = await lsGet('search', { type: 'customers', email: email });
  const list = (data && (data.data || data.customers)) || [];
  const cust = Array.isArray(list) ? list.find(c => (c.email || '').toLowerCase() === email.toLowerCase()) : null;
  if (!cust) return { found: false };
  return { found: true, customer: cust, groupId: cust.customer_group_id || cust.group_id || null };
}

async function groupName(groupId) {
  if (!groupId) return '';
  const data = await lsGet('customer_groups/' + encodeURIComponent(groupId));
  const g = data && (data.data || data);
  return (g && (g.name || g.group_name)) || '';
}

// Public: given an email, return the best group discount as a percent (0 if none).
// Returns { percent, groupName, source } — safe to call even if unconfigured.
export async function loyaltyDiscountForEmail(email) {
  const { domain, token, map } = cfg();
  if (!domain || !token || !Object.keys(map).length) return { percent: 0, groupName: '', source: 'disabled' };
  try {
    const found = await findCustomerByEmail(email);
    if (!found || !found.found) return { percent: 0, groupName: '', source: 'not_found' };
    const gname = await groupName(found.groupId);
    const pct = map[(gname || '').toLowerCase()] || 0;
    return { percent: pct, groupName: gname, source: pct ? 'group' : 'no_match' };
  } catch (e) {
    console.error('[lightspeed] discount lookup failed', e);
    return { percent: 0, groupName: '', source: 'error' };
  }
}
