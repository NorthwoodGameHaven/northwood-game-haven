// netlify/functions/_shared/auto-cancel.mjs — NGH-BUILD 2026-09-12p — TOMBSTONE
//
// THIS FILE IS DEAD. DELETE IT. It is safe to `git rm` and nothing imports it.
//
// It used to be a full, mis-filed copy of the scheduled auto-cancel function.
// Netlify only schedules functions in netlify/functions/, not in _shared/, so
// this copy never ran — but it did receive a bug fix on 2026-09-10c that the
// live function did not get, and for a day everyone believed the fix was
// deployed. It was not. Bookings kept being cancelled.
//
// It could not even load if something tried: its imports are written as
// './_shared/db.mjs' from inside _shared/, which resolves to
// _shared/_shared/db.mjs.
//
// The one and only auto-cancel is netlify/functions/auto-cancel.mjs.
// Its rules, as of 2026-09-12p:
//   • the deposit never cancels anybody, ever — it can only spare a booking
//   • nothing is cancelled until the booking's END time has passed
//   • guests are only emailed within 48h of that
//   • AUTO_CANCEL_ENABLED=0 turns cancelling off entirely
//
// If you are reading this because you went looking for auto-cancel logic:
// you are in the wrong file, and that is exactly why this tombstone exists.
throw new Error('netlify/functions/_shared/auto-cancel.mjs is dead code — use netlify/functions/auto-cancel.mjs');
