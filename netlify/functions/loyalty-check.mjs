// netlify/functions/loyalty-check.mjs
// Public endpoint: given ?email=, returns any loyalty/group discount percentage
// the customer qualifies for. Used to PREVIEW the discount in the UI.
// The authoritative discount is re-checked server-side at checkout, so this
// endpoint is safe to expose (it only reveals a percentage, not points data).
import { json, bad, preflight } from './_shared/db.mjs';
import { loyaltyDiscountForEmail } from './_shared/lightspeed.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    const url = new URL(req.url);
    const email = (url.searchParams.get('email') || '').trim();
    if (!email || email.indexOf('@') < 0) return json({ percent: 0 });
    const d = await loyaltyDiscountForEmail(email);
    return json({ percent: d.percent || 0, groupName: d.percent ? d.groupName : '' });
  } catch (e) {
    return json({ percent: 0 });
  }
};
