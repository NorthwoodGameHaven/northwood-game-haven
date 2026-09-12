# Live integration test — findings & fix list
*2026-09-12, run against production (gamehaven.guru + northwoodgamehaven.retail.lightspeed.app). Test booking `NGH-Y3NOS3-349`, customer "ZZ TEST - Lightspeed Integration".*

## Environment verified good (no action)

* Lightspeed OAuth **connected**, token auto-refreshing, API 2.0, catalog cache 1695 products.
* All ten env vars resolve to the right records — the guru page shows **IN USE** against Northwood Game Haven (outlet), Online register, Website user, Online — Stripe; `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT` correctly reads **OPTIONAL**.
* Booking cost preview in the manual-booking modal is correct: 4 h × 1 room = $40.00 fee, tax $2.20 (5.5% — matches `LIGHTSPEED_TAX_ID`), deposit $65.00 untaxed ($40 one-room + $25 karaoke).

## The pricing model, as actually implemented

From live `booking.html`:

```js
function calcRoomCost(hours){ var first=Math.min(hours,4), rest=Math.max(hours-4,0); return first*10 + rest*5; }
var TAX_RATE = 0.055;
var DEPOSIT  = { 1:40, 2:80, 3:100 };   // by number of rooms
var KARAOKE_DEPOSIT_ADD = 25;
```

* **fee** = `calcRoomCost(hours) * rooms.length` + paid add-ons
* **deposit** = `DEPOSIT[min(rooms.length,3)] + (karaoke ? 25 : 0)` — *does not depend on hours*
* **tax** = `round(subtotal * 0.055, 2)`, fee only, never the deposit

Hour ladder: 1 h $10 · 2 h $20 · 3 h $30 · 4 h $40 · 5 h $45 · 6 h $50 · 7 h $55 · 8 h $60.

## FINDING 1 — editing a booking's schedule does not reprice it  ⚠️ real money

**What happens.** The Guru console's *When … ✎ Edit → Save date/time* (`bkSaveWhen()` in `site/booking.html`) persists only:

```js
await Store.updateBooking(id, { date:date, start:start, hours:hours, endLabel:endLabel });
```

`costBooking`, `subtotal`, `tax`, `totalDue` are **stored** on the booking record and are never recomputed. `netlify/functions/create-checkout.mjs` bills straight off the stored value:

```js
let fee = (b.costBooking != null ? b.costBooking : 0);
```

**Proved live.** Changed `NGH-Y3NOS3-349` from 4 h to 1 h. Record afterwards: `hours: 1`, `endLabel: "11:00 AM"` — but `costBooking: 40`, `subtotal: 40`, `tax: 2.20`, `totalDue: 107.20`. A fresh pay-link still came back **$42.20** instead of $10.55.

**Impact.** Any Guru who shortens or lengthens an approved booking charges the customer the *old* duration. Shorten 8 h → 4 h and the customer is overcharged $20; lengthen 4 h → 8 h and NGH loses $20. The confirmation dialog reads "Change schedule … From: 4h To: 1h", which strongly implies the whole booking was updated.

**Fix.** In `bkSaveWhen()`, recompute before the PATCH — the helper already exists in the same file:

```js
var per = calcRoomCost(hours), sub = per * (r.rooms||[]).length;   // + paid add-ons, as computeTotals() does
var tx  = Math.round(sub * TAX_RATE * 100) / 100;
await Store.updateBooking(id, { date, start, hours, endLabel,
  costBooking: sub, subtotal: sub, tax: tx, totalDue: sub + tx + (r.deposit||0) });
```

Deposit needs no change here (rooms don't change in this panel) — but if a room-editing UI is ever added, `DEPOSIT[min(rooms,3)] + karaoke` must be recomputed too, and `depositBase` kept in step so `adjustDeposit()` still reports "reduced from" correctly.

Also re-run the paid-add-on lines the way `computeTotals()` does, so a booking with a paid add-on doesn't lose it.

## FINDING 2 — pricing is client-authored; the API accepts whatever it's sent  ⚠️ design

`PATCH /.netlify/functions/bookings/:id` accepted `{costBooking: 10, subtotal: 10, tax: 0.55, totalDue: 75.55}` straight from the browser console and stored it verbatim. `create-checkout` then billed that number.

Admin auth is required, so this is not a public hole — but every price the customer pays currently originates on the client. Fixing Finding 1 in the browser leaves that property intact.

**Recommended.** Move the fee/tax/deposit math server-side: have the bookings PATCH/POST handler recompute `costBooking`, `subtotal`, `tax`, `totalDue`, `deposit` from `{rooms, hours, addons}` and ignore client-supplied money fields (keep the explicit staff `adjustDeposit` waiver/reduction path as the one sanctioned override, since that is a deliberate discount rather than a computed price). Share one implementation of `calcRoomCost`/`DEPOSIT` between `booking.html` and the function so the two can't drift.

## FINDING 3 — hour options: what Dustin asked for vs. what exists

Requested: staff can book 1, 2, 3, 4+ hours at correct prices; **customers can never book under the 4-hour minimum.**

Current state — mostly already correct:

* Public form `#bk-hours`: options **4–8** only. 4-hour minimum already enforced. ✅ leave alone.
* Manual in-person modal `#mb-hours`: options **1–8**, and `mbCheck()` / the create path both price via `calcRoomCost`, so 1 h correctly quotes $10 + $0.55 tax. ✅ already works.
* The gap is only the **edit** path (Finding 1). Once a booking exists, changing its hours is what breaks.

So the work for this request is Finding 1, plus a server-side guard (Finding 2) that rejects `hours < 4` on the *public* create path while allowing 1–8 from an authenticated staff create — today the 4-hour floor is only a dropdown, so a crafted POST could book 1 hour at customer prices.

## FINDING 4 — `stash2026` is published in `ngh-config.js`  ⚠️ minor

`site/ngh-config.js` (public) ends with:

```js
window.NGH_ADMIN_CODE = "stash2026";
```

Inert today: `booking.html` only honours it when `API_BASE` is empty, and live sets `NGH_API_BASE = "/.netlify/functions"`, so `Store.login()` goes to `/admin-login` against the Netlify `ADMIN_CODE`. But it is a plausible-looking staff code in a public file, and it becomes a live gate the moment anyone unsets `NGH_API_BASE`. Delete the constant and the `|| "stash2026"` fallback in `booking.html`.

## FINDING 5 — refunds do not reverse anything in Lightspeed, and loyalty is never clawed back  ⚠️ real money

Asked for explicitly: *do rewards points apply to a booking, and are they adjusted if the customer is refunded?* Answer as built: **points apply, and nothing adjusts them.**

What exists today:

* `recordSale()` is the only write to Lightspeed. `netlify/functions/_shared/lightspeed.mjs` exports no refund, return, void or reversal function — grep confirms: `recordSale` is the sole sale-writing export.
* Loyalty is applied at sale time. `buildSalePayload()` sets `loyalty_value = price × qty × loyaltyRatio` per line when the customer has loyalty enabled, so a paid booking **does** earn points against the Lightspeed customer record.
* **Registrations** refund automatically (`registrations.mjs` → `refundPaymentIntent`) on cancel or qty reduction. Stripe returns the money; Lightspeed keeps the closed sale *and* the loyalty. The two systems silently diverge.
* **Bookings** have no refund path at all — not in the Guru console, not in the API. A booking refund is a manual action in the Stripe dashboard, and equally leaves the Lightspeed sale and its loyalty standing.

Consequence: refund a $42.20 booking and the customer keeps the loyalty dollars it earned, the sale still counts in Lightspeed revenue reporting, and the books disagree with Stripe.

Buildable — the pieces are already in place:

* The booking record stores what's needed: `feePI` / `depositPI` (Stripe payment intent) and `feePaidCents` / `depositPaidCents`, written by `stripe-webhook.mjs`. `refundPaymentIntent()` already exists in `_shared/stripe.mjs`.
* `ls_sales_log` maps `source_id` → `sale_id`, so the original Lightspeed sale is findable for reversal.

**Fix, in order of value.**

1. Add `refundSale(sourceId, amountCents)` to `_shared/lightspeed.mjs`: look up `sale_id` in `ls_sales_log`, then post a return sale — negative quantities/amounts against the same products, register and payment type, with `loyalty_value` negated so the points come back off. Verify against a real return first; X-Series records returns as a sale with negative line quantities.
2. Wire it into the existing registration refund path so cancels and qty reductions reverse in both systems.
3. Add a booking refund action to the Guru console (fee, deposit, or both) that calls `refundPaymentIntent` then `refundSale`, and marks `feePaid`/`depositPaid` false with a `refunds:[]` audit trail on the record, mirroring `partialRefunds` on registrations.
4. Make it idempotent on `sourceId + ':refund'` in `ls_sales_log`, the same way sales are, so a double-click or Stripe retry can't double-reverse.

Until (1)–(3) exist, any refund needs a manual return rung in Lightspeed to correct both revenue and the customer's loyalty balance. Worth writing into the SOP either way, since staff will refund at the counter too.

## FINDING 6 — every recorded sale books $0 sales tax  ⚠️⚠️ real money, fixed in code

**Proved live.** Booking `NGH-Y3NOS3-349` fee paid $42.20 by card. The Lightspeed sale that resulted:

```
status CLOSED · source_id NGH-Y3NOS3-349:fee · register Online · user Website · payment Online — Stripe
line NGH-KARAOKE  qty 1  price 0.00   tax 0.00  tax_id …e56e
line NGH-ROOM     qty 1  price 42.20  tax 0.00  tax_id …e56e
total_price 42.20 · total_tax 0.00
```

The correct split is price 40.00 + tax 2.20. Instead the **entire gross went in as ex-tax revenue and the tax line is zero**, even though the right `tax_id` is attached to both lines.

**Cause.** `core.taxRateOf()` read `tax.rate`:

```js
const r = Number(tax && tax.rate);   // undefined on X-Series 2.0 → NaN → 0
```

An X-Series 2.0 tax has no top-level `rate`. It carries a `rates[]` array of components — for Northwood, `[{rate:0.05} /*WI State*/, {rate:0.005} /*Chippewa County*/]`. So `getTaxRate()` returned 0, and `splitIncTax(42.20, 0)` = `{price: 42.20, tax: 0}`.

Note the guard in `getTaxRate()` never fired: it *does* prefer `LIGHTSPEED_TAX_ID` and it *did* find the right tax record — the rate extraction is what failed. Setting the env var correctly was necessary but not sufficient.

**Impact.** Sales totals are right, so Stripe and Lightspeed agree on money taken. But Lightspeed's tax liability reporting shows $0 collected on every web sale, which is the number that feeds a sales-tax return. Any web sale recorded before this fix is understated and needs correcting.

**Fixed** in `_shared/lightspeed-core.mjs` — sum `rates[]` when there's no scalar `rate`. `tests/lightspeed.test.mjs` now stubs taxes in the real 2.0 shape, so 5 tests fail if this regresses.

## FINDING 7 — loyalty earns nothing: one store setting, one code bug  ⚠️ fixed in code + needs a Lightspeed change

The test sale recorded `loyalty_value 0` on every line and the customer's balance stayed $0.00. Two independent causes:

**(a) Loyalty is switched off store-wide.** `GET /api/2.0/retailer` returns:

```json
"loyalty": { "enabled": false, "ratio": null, "claim_url": null, … }
```

Nothing can earn points until this is turned on in Lightspeed under **Setup → Loyalty**, and a ratio is set. **This one is Dustin's to do — no code change helps until it's on.**

**(b) The code read the wrong field.** `getRetailer()` read `r.loyalty_ratio` (top-level), which does not exist in 2.0 — the value is nested at `r.loyalty.ratio`. The fallback then tried the legacy `/api/retailer`, which **404s** on this store ("No route found"), so the ratio fell through to `LIGHTSPEED_LOYALTY_RATIO` (unset) and finally 0. So even after enabling loyalty in Lightspeed, sales would still have carried `loyalty_value: 0`.

**Fixed** in `_shared/lightspeed.mjs`: read `loyalty.ratio` first, keep the old field and legacy endpoint as fallbacks, and expose `loyaltyEnabled` so a store with loyalty switched off forces the ratio to 0 rather than guessing. Test mocks now use the nested shape; 5 tests fail without the fix.

**Order of operations:** turn loyalty on in Lightspeed *first*, then deploy — otherwise the fix has nothing to read.

## Note for whoever runs this test again

Claude's browser pane suppresses native dialogs — `confirm()` returns false and `prompt()` throws. Several console actions are gated behind them (`bkSaveWhen`, `reject`, `genPayLink`), so they silently no-op. Drive those through `Store.*` / the function endpoints directly rather than concluding the feature is broken.
