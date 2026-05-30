// netlify/functions/auto-cancel.mjs
// Scheduled (cron) function: every night, cancel any APPROVED booking that is
// still UNPAID after the day-before-the-booking deadline, and email the guest.
// Schedule is configured in netlify.toml ([functions."auto-cancel"]).
import { sql, ensureSchema } from './_shared/db.mjs';

export default async () => {
  await ensureSchema();
  const now = new Date();
  const rows = await sql`SELECT data FROM bookings WHERE status = 'approved'`;
  let canceled = 0;

  for (const row of rows) {
    const r = row.data;
    if (r.payment === 'paid') continue;
    const deadline = new Date(r.date + 'T00:00:00');
    deadline.setDate(deadline.getDate() - 1);
    deadline.setHours(23, 59, 59);
    if (now <= deadline) continue;

    const merged = { ...r, status: 'rejected', autoCanceled: true };
    await sql`UPDATE bookings SET data = ${JSON.stringify(merged)}::jsonb, status = 'rejected' WHERE id = ${r.id}`;
    canceled++;

    // best-effort guest email
    try {
      const recNote = r.groupId
        ? ` This was occurrence ${r.recIndex} of ${r.recTotal} in your recurring series; your other approved occurrences are NOT affected.`
        : '';
      await sendMail(r.email,
        `Your Northwood Game Haven booking ${r.id} was canceled (unpaid)`,
        `Hi ${r.name},\n\nYour booking ${r.id} for ${r.date} was automatically canceled because payment (including the deposit hold) wasn't received by the day before the booking.${recNote} Please submit a new request if you'd still like to come in.\n\n— NGH 🦦`);
    } catch (e) { console.warn('auto-cancel email failed', e); }
  }
  console.log(`[auto-cancel] canceled ${canceled} unpaid booking(s)`);
  return new Response(`canceled ${canceled}`, { status: 200 });
};

async function sendMail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Northwood Game Haven <bookings@northwoodgamehaven.com>';
  if (!apiKey) { console.log('[auto-cancel] (no RESEND_API_KEY) would email', to); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
}

// Netlify reads this named export to register the cron schedule.
export const config = { schedule: '@daily' };
