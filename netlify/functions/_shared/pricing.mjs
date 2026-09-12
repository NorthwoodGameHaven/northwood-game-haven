// netlify/functions/_shared/pricing.mjs
// NGH-BUILD 2026-09-12h — the single source of truth for booking money.
//
// Why this exists: every price a customer paid used to be computed in
// site/booking.html and POSTed to the API, which stored it verbatim. Two
// consequences, both found in the 2026-09-12 live test:
//   • Editing a booking's schedule changed `hours` but NOT `costBooking`, so a
//     Guru shortening 8h → 4h still billed for 8h (and lengthening under-billed).
//   • `PATCH /bookings/:id` accepted {costBooking: 10, …} from a browser console
//     and create-checkout billed it.
// The numbers below mirror site/booking.html exactly as of this build. If the
// two ever disagree, THIS file wins — the client's copy is only a preview.
//
// Deliberately NOT changed here: the military discount is still applied on the
// customer's say-so (`milRequested`) while `milVerified` stays "pending". That
// is existing behaviour, not something this module should silently alter — but
// it does mean a 15% discount is self-served until a Guru checks ID.

export const DEPOSIT = { 1: 40, 2: 80, 3: 100 };   // by number of rooms
export const KARAOKE_DEPOSIT_ADD = 25;
export const BYO_FOOD_FEE = 40;                    // flat, per reservation
export const GURU_HOURLY = 10;                     // per Guru, per hour
export const MIL_DISCOUNT = 0.15;
export const PUBLIC_MIN_HOURS = 4;                 // customers: 4-hour minimum
export const STAFF_MIN_HOURS = 1;                  // in-person bookings: 1 hour up
export const MAX_HOURS = 8;

export function taxRate() {
  const p = process.env.SALES_TAX_PERCENT;
  return (p != null && p !== '') ? Number(p) / 100 : 0.055;   // WI 5% + Chippewa 0.5%
}

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// $10/hour for the first four hours, $5/hour after. Per room.
export function calcRoomCost(hours) {
  const h = Math.max(0, parseInt(hours, 10) || 0);
  return Math.min(h, 4) * 10 + Math.max(h - 4, 0) * 5;
}

function addonQty(b, id) {
  const a = (b.addons || []).find(x => x && x.id === id);
  if (!a) return 0;
  const q = parseInt(a.qty != null ? a.qty : 1, 10);
  return Math.max(1, isFinite(q) ? q : 1);
}
const hasAddon = (b, id) => (b.addons || []).some(x => x && x.id === id);

// Everything money about a booking, derived only from {rooms, hours, addons,
// milRequested}. Returns the same field names the record already uses.
//
// `deposit`: a staff waiver/reduction (adjustDeposit) is preserved — when the
// record carries a `depositBase` that differs from `deposit`, that override
// survives a reprice and only the base is refreshed. Otherwise the deposit is
// recomputed from the rooms.
export function computeBookingMoney(b) {
  const hours = Math.max(0, parseInt(b.hours, 10) || 0);
  const nRooms = Math.min((b.rooms || []).length, 3);

  const rooms = (b.rooms || []).length;
  const bookingTotal = rooms > 0 && hours > 0 ? calcRoomCost(hours) * rooms : 0;

  let addonTotal = 0;
  if (hasAddon(b, 'byofood')) addonTotal += BYO_FOOD_FEE;
  if (hasAddon(b, 'guru')) addonTotal += GURU_HOURLY * hours * addonQty(b, 'guru');

  const depositBase = rooms > 0 ? ((DEPOSIT[nRooms] || 0) + (hasAddon(b, 'karaoke') ? KARAOKE_DEPOSIT_ADD : 0)) : 0;
  const overridden = b.depositBase != null && b.deposit != null && Number(b.deposit) !== Number(b.depositBase);
  const deposit = overridden ? r2(b.deposit) : depositBase;

  const subtotal = r2(bookingTotal + addonTotal);
  const discount = b.milRequested ? r2(subtotal * MIL_DISCOUNT) : 0;
  const costBooking = r2(subtotal - discount);            // the taxable booking charge
  const rate = taxRate();
  const tax = r2(costBooking * rate);
  const totalDue = r2(costBooking + tax + deposit);

  return { subtotal, discount, costBooking, deposit, depositBase, tax, taxRate: rate, totalDue };
}

// Fields the client must never dictate — stripped from any inbound payload.
// `deposit` is NOT in this list: an explicit staff waiver is a sanctioned
// override, handled by computeBookingMoney above.
export const CLIENT_MONEY_FIELDS = ['subtotal', 'discount', 'costBooking', 'tax', 'taxRate', 'totalDue', 'depositBase'];

// A patch that changes any of these changes the price.
export const PRICE_SHAPE_FIELDS = ['hours', 'rooms', 'addons', 'milRequested'];

export function hoursError(hours, { isStaff = false } = {}) {
  const h = parseInt(hours, 10);
  if (!isFinite(h) || h < 1) return 'hours must be a whole number of hours';
  if (h > MAX_HOURS) return 'bookings run to a maximum of ' + MAX_HOURS + ' hours';
  const min = isStaff ? STAFF_MIN_HOURS : PUBLIC_MIN_HOURS;
  if (h < min) return 'there is a ' + PUBLIC_MIN_HOURS + '-hour minimum on play-space bookings';
  return null;
}
