// netlify/functions/promo-digest.mjs
// Scheduled (cron) — daily event-promotion task email.
// Sends the day's promotion task list (same engine as guru-promo.html) to the
// promo inbox every morning. Runs at 12:00 UTC = 6–7 AM Central, and computes
// "today" in America/Chicago so the list matches what the Guru page shows.
//
// Recipient: PROMO_DIGEST_EMAIL env var, defaulting to stash@northwoodgamehaven.com.
// Schedule is configured in netlify.toml ([functions."promo-digest"]) and mirrored
// in the config export below (Netlify reads either).
import { sql, ensureSchema } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { computeTasks, digestBody, chicagoToday, BASE } from './_shared/promo.mjs';

const TO = process.env.PROMO_DIGEST_EMAIL || 'stash@northwoodgamehaven.com';

export default async () => {
  await ensureSchema();
  const date = chicagoToday();
  const result = await computeTasks(sql, date);
  const n = result.today.length + result.overdue.length + result.standing.length;
  try {
    await sendBrandedMail(TO, 'DAILY EVENT PROMOTION TASKS — ' + date, {
      heading: '📣 Daily Event Promotion Tasks',
      bodyText: digestBody(result),
      buttons: [{ label: 'Open the Promotion Task List', url: BASE + '/guru-promo.html', primary: true }]
    });
    console.log('[promo-digest] sent to ' + TO + ' — ' + n + ' task(s) for ' + date);
  } catch (e) {
    console.error('[promo-digest] send failed', e);
  }
  return new Response('promo digest: ' + n + ' task(s)', { status: 200 });
};

// Netlify reads this named export to register the cron schedule.
export const config = { schedule: '0 12 * * *' };
