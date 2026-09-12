// netlify/functions/_shared/review-account.mjs — NGH-BUILD 2026-09-12z
// ---------------------------------------------------------------------
// The Google Play review account, kept as a pure module: no database, no
// Lightspeed, no network. Two reasons it lives here rather than inside
// account.mjs.
//
// 1. The browser test can import it. The risk with invented data is not that
//    it is wrong but that it is shaped wrong — one renamed field and the
//    reviewer opens Rewards to a blank card. tests/e2e-pages.mjs feeds THESE
//    objects through the real page, so a mismatch fails a test instead of a
//    review.
// 2. Env is read per call, not at import. Turning the account off in the
//    Netlify UI takes effect on the next invocation, and nothing depends on
//    when a lambda happened to cold-start.
//
// Sign-in is a six-digit code emailed to the customer. Google's reviewer has
// no access to our inboxes, so without a fixed-code account the whole Rewards
// screen is unreachable to them — and "App access" is a required section of
// the listing, so we cannot claim there is no login.
//
// Set neither env var and every function here is inert. Nothing is hardcoded
// in the repo; the account can be switched off without a deploy. Everything it
// shows is invented below and never reaches the POS, so guessing the code wins
// you a page of fiction.

export function reviewEmail() { return String(process.env.PLAY_REVIEW_EMAIL || '').trim().toLowerCase(); }
export function reviewCode() { return String(process.env.PLAY_REVIEW_CODE || '').replace(/\D/g, ''); }

// Half-configured is the dangerous state — an address with no code, or a code
// the app's six-digit input could never accept — so it resolves to off.
export function reviewOn() { return !!(reviewEmail() && reviewCode().length === 6); }
export function reviewId() { return 'review:' + reviewEmail(); }
export function isReviewEmail(e) { return reviewOn() && e === reviewEmail(); }
export function isReviewSession(s) { return reviewOn() && !!s && s.id === reviewId(); }

export function reviewCustomer() {
  return {
    id: reviewId(), first_name: 'Play', last_name: 'Reviewer', email: reviewEmail(),
    phone: '(715) 555-0100', mobile: '(715) 555-0100', customer_code: 'NGH-0000',
    loyalty_balance: 8.75, balance: 0, customer_group: 'Haven Regulars',
    enable_loyalty: true, do_not_email: false
  };
}

// Matches, field for field, what GET /me builds for a real customer.
export function reviewBundle() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); };
  return {
    customer: reviewCustomer(),
    loyalty: { ratio: 0.05, currency: 'USD' },
    purchases: [
      { id: 'demo-1', date: iso(-4), status: 'CLOSED', invoice: '8871', total: 32.47, totalTax: 1.69, loyalty: 1.62,
        items: [{ productId: 'demo-a', name: 'Pokémon TCG: Booster Pack', qty: 3, price: 14.97 },
                { productId: 'demo-b', name: 'Haven Root Beer Float', qty: 1, price: 5.5 }] },
      { id: 'demo-2', date: iso(-18), status: 'CLOSED', invoice: '8790', total: 44.99, totalTax: 2.34, loyalty: 2.25,
        items: [{ productId: 'demo-c', name: 'Commander Deck', qty: 1, price: 44.99 }] }
    ],
    bookings: [
      { id: 'demo-bk', date: day(9), start: '18:00', hours: 2, endLabel: '8:00 PM', rooms: ['The Holt'],
        status: 'confirmed', payment: 'stripe', feePaid: true, depositPaid: true,
        costBooking: 120, deposit: 50, birthdayParty: true }
    ],
    registrations: [
      { id: 'demo-reg', eventId: 'demo-ev', eventTitle: 'Commander Night', occDate: day(3), qty: 1,
        status: 'confirmed', feePaid: true, payment: 'stripe', ticketUrl: null }
    ],
    orders: []
  };
}
