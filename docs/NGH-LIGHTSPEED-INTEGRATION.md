# NGH ↔ Lightspeed Retail X-Series integration spec
*NGH-BUILD 2026-09-11a. Read with NGH-APP-ARCHITECTURE.md. Lightspeed Retail X-Series = the POS formerly called Vend. The online shop (northwoodgamehaven.company.site) is Lightspeed eCom E-Series and is NOT touched by this build.*

## 1. What the integration does

| Feature | How |
|---|---|
| **Rewards account in the app** (`/app/account.html`) | Customer signs in with the email on their X-Series customer record (6-digit code emailed via Resend). The app shows loyalty balance (X-Series loyalty is a dollar balance), customer group, customer code (for staff lookup at the register), recent purchases, upcoming bookings/registrations, and lets them edit name/phone/email. New customers can sign up — that creates the X-Series customer with loyalty enabled. |
| **Order ahead for pickup** (`/app/shop.html`) | Browses a Neon-cached copy of the X-Series catalog (products, prices incl. tax, images, on-hand stock at the outlet). Cart → order. **Pay online** (Stripe Checkout; on success the order is written to X-Series as a *closed* sale with the "Online — Stripe" payment type, on the customer's account, earning loyalty) or **Pay at pickup** (written to X-Series as a *parked* sale with note `ORDER AHEAD NGH-xxxx`; staff retrieve it at the register and take payment there — Lightspeed Payments, cash, loyalty, whatever). Staff see orders in the Guru Hub queue (`/app/shop-orders.html`, admin). |
| **Bookings & registrations recorded in Lightspeed** | `stripe-webhook.mjs` gains a hook: when a booking part or registration is marked paid, `recordSale()` writes a closed sale to X-Series (service products `NGH-ROOM`, `NGH-DEPOSIT`, `NGH-KARAOKE`, `NGH-EVENT` by SKU) against the customer (matched/created by email), paid with the "Online — Stripe" payment type, with `loyalty_value` so the customer earns loyalty on bookings. Sales carry `source_id = <bookingId>:<part>` / `<registrationId>` for idempotency. |
| **Pay on account (Lightspeed Payments link)** | `create-checkout.mjs` accepts `method=onaccount`: the same sale is written as an **on-account** sale (state `closed`, payment type "On Account") and the customer is told to expect a pay link / pay at the counter. From Sell → Sales history a Guru clicks *Email receipt with pay link* (Lightspeed Payments; requires "online payments" enabled under Setup → On-account). X-Series has **no API to take a card-not-present payment or to create a pay link** (verified against the Payments API docs and the On-account pay-link article), so Stripe remains the online card processor. |
| **Loyalty discount at checkout** | Unchanged (`loyalty-check.mjs`, `LOYALTY_GROUP_DISCOUNTS`) but now runs through the shared OAuth client. |

## 2. Auth: OAuth 2.0 (one-time store connection)

Developer portal: developers.retail.lightspeed.app → organisation *Northwood Game Haven* → application *Online Booking*.
* **Redirect URL must be** `https://gamehaven.guru/api/lightspeed/callback` (change it in the portal — `/booking` is not a callback).
* Env vars (Netlify): `LIGHTSPEED_CLIENT_ID`, `LIGHTSPEED_CLIENT_SECRET`, optional `LIGHTSPEED_DOMAIN` (store prefix; also learned from the callback), `LIGHTSPEED_API_VERSION` (default `2.0`; switch to a date version such as `2026-07` once verified — 0.9/2.0 are deprecated but live), `LIGHTSPEED_OUTLET_ID`, `LIGHTSPEED_REGISTER_ID`, `LIGHTSPEED_USER_ID` (the "Website" user to attribute sales to), `LIGHTSPEED_PAYMENT_TYPE_ONLINE` (the "Online — Stripe" payment type id), `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT`, `LIGHTSPEED_TAX_ID` (WI sales tax id), `LIGHTSPEED_SKU_ROOM`, `LIGHTSPEED_SKU_DEPOSIT`, `LIGHTSPEED_SKU_KARAOKE`, `LIGHTSPEED_SKU_EVENT` (default `NGH-ROOM` …). The Guru "Lightspeed" page (`/app/guru-lightspeed.html`) lists outlets/registers/users/payment types/taxes so the ids can be copied into env vars, and shows connection health.
* Flow: Guru Hub → "Connect Lightspeed" → `GET /api/lightspeed/connect` (admin) → 302 to `https://secure.retail.lightspeed.app/connect?response_type=code&client_id=…&redirect_uri=…&state=<signed>&scope=<scopes>` → owner clicks Allow → `GET /api/lightspeed/callback?code&domain_prefix&state` → function verifies `state` (HMAC, 10-min), POSTs `https://{domain_prefix}.retail.lightspeed.app/api/1.0/token` (form-encoded: code, client_id, client_secret, grant_type=authorization_code, redirect_uri) → stores `{access_token, refresh_token, expires, domain_prefix}` in Neon table `integration_tokens (provider='lightspeed')` → redirects to `/app/guru-lightspeed.html?connected=1`.
* Scopes requested: `customers:read customers:write products:read inventory:read sales:read sales:write payment_types:read taxes:read registers:read outlets:read users:read retailer:read`.
* Refresh: access tokens expire (`expires` epoch seconds). The client refreshes when < 120 s remain; refresh **rotates** both tokens, so after a 401 the client re-reads the row (another instance may have refreshed) before refreshing itself. A `LIGHTSPEED_TOKEN` personal token (Plus plan) still works as a bypass if set.

## 3. API surface used (X-Series)

Base: `https://{domain_prefix}.retail.lightspeed.app/api/{version}/…`, `Authorization: Bearer …`.
* `GET search?type=customers&email=` · `GET customers/{id}` · `POST customers` (`first_name,last_name,email,phone,mobile,enable_loyalty,customer_group_id,do_not_email`) · `PUT customers/{id}`.
* `GET products?page_size=…&after=<version>` (cursor by version; `include_images=true`), `GET search?type=products&name=…`, `GET inventory?page_size=…&after=…` (`product_id, outlet_id, current_amount`), `GET product_types`, `GET brands`, `GET taxes`, `GET payment_types`, `GET outlets`, `GET registers`, `GET users`, `GET retailer` (loyalty_ratio, currency).
* `GET search?type=sales&customer_id=…&page_size=20` for purchase history.
* **Sale creation:** `POST /api/register_sales` (legacy 0.9 body per Lightspeed's "Synchronizing sales from external systems" guide): `{ source_id, register_id, user_id, customer_id, state:'closed'|'parked', note, sale_date, register_sale_products:[{product_id, quantity, price (ex-tax unit), tax, tax_id, loyalty_value}], register_sale_payments:[{retailer_payment_type_id, amount, payment_date}] }`. Loyalty redemption = a payment whose payment type has `payment_type_id == 106`.

## 4. Neon tables added

```
integration_tokens  provider TEXT PK, data JSONB, updated_at
ls_products         id TEXT PK, data JSONB, version BIGINT, updated_at          (catalog cache; synced by GET /api/shop/sync (admin) or the scheduled function every 30 min)
ls_inventory        product_id TEXT, outlet_id TEXT, current_amount NUMERIC, PRIMARY KEY(product_id, outlet_id)
shop_orders         id TEXT PK ('ORD-xxxx'), data JSONB, status TEXT, created_at   (status: new|paid|parked|ready|picked_up|canceled)
login_codes         email TEXT PK, code_hash TEXT, expires_at, attempts INT
ls_sales_log        source_id TEXT PK, sale_id TEXT, kind TEXT, created_at       (idempotency for recordSale)
```

## 5. Function routes (netlify.toml aliases)

```
/api/lightspeed/connect            GET  admin   → 302 to Lightspeed consent screen
/api/lightspeed/callback           GET  public  ← OAuth redirect
/api/lightspeed/status             GET  admin   {connected, domain, expires, outlet…, reference lists}
/api/lightspeed/disconnect         POST admin

/api/account/start                 POST public  {email} → emails a 6-digit code (creates nothing yet)   rate-limited 3/10min per email+IP
/api/account/verify                POST public  {email, code} → {session, customer|null}  (null = no X-Series customer yet → app shows sign-up)
/api/account/signup                POST public  {session, first_name, last_name, phone, marketing:bool} → creates customer → {customer}
/api/account/me                    GET  session {customer:{id, first_name, last_name, email, phone, mobile, customer_code, loyalty_balance, balance, customer_group, enable_loyalty}, loyalty:{ratio, currency}, purchases:[…], bookings:[…], registrations:[…], orders:[…]}
/api/account/me                    PUT  session {first_name,last_name,phone,email,do_not_email}
/api/account/logout                POST session

/api/shop/catalog                  GET  public  {products:[{id,name,sku,price,priceExTax,image,thumb,type,brand,stock,tags,description}], types:[…], brands:[…], syncedAt}   (cached JSON, ETag)
/api/shop/product/:id              GET  public
/api/shop/sync                     POST admin   pulls products+inventory into Neon (also scheduled)
/api/shop/orders                   POST public  {session?, name,email,phone, items:[{id,qty}], pickupAt, note, pay:'online'|'pickup'} → {order, checkoutUrl?}
/api/shop/orders/:id               GET  public(with order token) | admin
/api/shop/orders                   GET  admin   queue
/api/shop/orders/:id/status        POST admin   {status:'ready'|'picked_up'|'canceled'}
```
Session token format: `<customerId>.<expMs>.<hmac(ADMIN_SECRET, customerId|exp)>` in header `X-NGH-Session`.

## 6. Where Stripe still lives
`create-checkout.mjs` (bookings, registrations, and now shop orders `kind:'order'`) and `stripe-webhook.mjs`. The webhook's new `recordSale` hook is fire-and-forget with logging; a failed Lightspeed write never blocks marking the payment paid (retry via the Guru Lightspeed page "Replay unsynced").

## 7. As built (NGH-BUILD 2026-09-11a) — differences from the plan above

* **Personal token shortcut.** If `LIGHTSPEED_TOKEN` (+ `LIGHTSPEED_DOMAIN`) is already set in Netlify from the loyalty-discount build, every feature uses it and the OAuth connect step is optional. OAuth tokens, once connected, take priority.
* **Sale body field.** Sales are posted to the legacy `POST https://{domain}.retail.lightspeed.app/api/register_sales` with `status` = `CLOSED` (paid online), `SAVED` (order-ahead, pay at pickup — appears under Retrieve Sale), or `ONACCOUNT`. `LIGHTSPEED_ONACCOUNT_STATUS=CLOSED` flips the on-account status without a code change if your register rejects it. Line `price` is ex-tax per unit (5 dp) with `tax` per unit and `tax_id`; `loyalty_value` is price × qty × loyalty ratio when the customer has loyalty on.
* **On-account in one click.** `create-checkout` accepts `part=both` with `method=onaccount` and writes fee + deposit as two ONACCOUNT sales (`<id>:fee`, `<id>:deposit`), one combined email. The Guru Console shows "🧾 Fee + deposit on account"; approval emails get a "Put it on my Haven account (pay in store)" button — both only when `window.NGH_LIGHTSPEED_ONACCOUNT = true`.
* **Auto-cancel.** The nightly job now spares bookings with any payment (fee or deposit) or on-account parts. The 2026-09-10c partial-payment guard had been committed to `_shared/auto-cancel.mjs`, which Netlify never runs; the scheduled `netlify/functions/auto-cancel.mjs` still had the fully-paid-only check until this build.
* **Refunds.** Stripe refunds stay automatic. On-account registrations that get canceled are flagged in the staff email ("void it in Lightspeed Sales history") because X-Series has no API to void another app's on-account sale safely.
* **Order-ahead pickup times** are stored as ISO (`pickupAt`) plus a store-time label (`pickupLabel`, America/Chicago) used in emails and the parked-sale note.
* **Extra optional env vars:** `LIGHTSPEED_TAX_ID_NONE` (deposit line), `LIGHTSPEED_CUSTOMER_GROUP_ID` (group for app sign-ups), `LIGHTSPEED_SKU_FEE` (record the Stripe processing fee as its own line), `LIGHTSPEED_REDIRECT_URI` (override the callback URL), `LIGHTSPEED_LOYALTY_RATIO` (fallback if the retailer endpoint doesn't return one).
* **CORS.** `account.mjs` and `shop.mjs` send their own CORS headers that allow `X-NGH-Session` (the shared `db.mjs` helper only allows `Content-Type, Authorization`).

### Assumptions to verify against the live store (first connection)
1. `register_sales` accepts `status` values `CLOSED` / `SAVED` / `ONACCOUNT` and returns `register_sale.id`.
2. 2.0 list responses are `{data:[…], version:{min,max}}` and the version cursor with `after=` is exclusive.
3. Products expose `price_including_tax`/`price_excluding_tax`, `has_inventory`, `active`, `images[0].url`; inventory rows expose `product_id, outlet_id, current_amount`.
4. Tax `rate` is a fraction (0.055); retailer `loyalty_ratio` is available from `retailer`.
5. `search?type=products&sku=` finds the service products by exact SKU; `search?type=sales&customer_id=` returns `line_items`.
The Guru Lightspeed page's "Replay unsynced" re-runs any sale that failed, so a wrong assumption costs a fix + replay, not lost data.

## 8. Taking card payments *through* Lightspeed (phase 2 option)

X-Series itself can't charge a card from an API. The one Lightspeed-native route for online card payments is **Lightspeed eCom (E-Series)** with **Lightspeed Payments** enabled: its payments are recorded in both merchant portals and as sales in X-Series sales history. The build path would be: an E-Series API app → create a hidden, single-use product for the booking/registration amount → send the guest to that product's checkout → an order-paid webhook marks the booking paid. Before building it, confirm (a) northwoodgamehaven.company.site is on E-Series with Lightspeed Payments turned on, (b) hidden products can be bought by direct link, and (c) you're OK that refunds must then be done in Retail POS (E-Series can't refund Lightspeed Payments), which removes the automatic refunds the event system does today.

## 9. Live store reference (verified 2026-09-12, store `northwoodgamehaven`)

Resolved from the connected store. These are resource IDs, not secrets, but they belong in Netlify env vars, not in code.

| Env var | Value | What it is |
|---|---|---|
| `LIGHTSPEED_OUTLET_ID` | `021b1f22-6802-11f1-f909-2a220b9b3b9c` | Northwood Game Haven (only outlet) |
| `LIGHTSPEED_REGISTER_ID` | `021b1f22-6802-11f1-e846-3c3d4556e39a` | **Online register** — keeps web sales off the two floor tills (TCG & Event `…303e01f083f1`, Main Retail `…2a220bacb097`) |
| `LIGHTSPEED_USER_ID` | `521a3fae-b529-49d4-bb24-c6cfdc5e7920` | the **Website** user (no email set, so nobody can log in as it) |
| `LIGHTSPEED_PAYMENT_TYPE_ONLINE` | `dd70e4fe-6a8c-4bb7-8a30-fbcf701c2bc6` | **Online — Stripe** (Other payment method, type_id 3, no gateway) |
| `LIGHTSPEED_TAX_ID` | `021b1f22-6802-11f1-e846-303e01b4e56e` | **CHIPPEWA FALLS City Sales Tax (5.500%)** — a group of WI State 5% + Chippewa County 0.5% |
| `LIGHTSPEED_TAX_ID_NONE` | `021b1f22-6802-11f1-f909-2a220b998c40` | built-in **No Tax** 0% (the store default), used for the deposit line |
| `LIGHTSPEED_ONACCOUNT` | `true` | switches on the pay-on-account path (see below) |
| `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT` | *deliberately unset* | X-Series has **no** on-account payment type — on-account is a sale *status*. Leave it unset. |

Service products created 2026-09-12 (inventory tracking off, price $0 — the website sends the real amount, and the line `tax_id` comes from env, so the products' own tax default is cosmetic):

| SKU | Name | Product ID |
|---|---|---|
| `NGH-ROOM` | Room booking (website) | `f7bc4dff-3bd3-4f3d-8974-74f144c92ac8` |
| `NGH-DEPOSIT` | Refundable deposit (website) | `4394dded-fb15-4bb5-a1d7-e4a580a058f1` |
| `NGH-KARAOKE` | Karaoke add-on (website) | `0e1ccd9c-1f20-4e9a-94f5-aa9bac3a4b42` |
| `NGH-EVENT` | Event registration (website) | `4e6206d9-9462-41b1-8f1a-ff8a504baed9` |

### Assumption 5 was wrong — fixed in NGH-BUILD 2026-09-12a
`GET search?type=products&sku=<sku>` **does not match a SKU containing a hyphen.** Verified live against this store: `sku=10022` returns the product, `sku=NGH-ROOM` returns `[]` while `q=NGH-ROOM` returns it. Every service SKU is hyphenated, so `findProductBySku()`'s API fallback would have failed on all four — meaning any booking or registration sale written before the first `shop-sync` populated `ls_products` would have thrown `product SKU NGH-ROOM not found in Lightspeed`. `_shared/lightspeed.mjs` now tries `sku=` first and falls back to the free-text `q=` search, matching the SKU exactly client-side. `tests/lightspeed.test.mjs` stubs the quirk (hyphenated `sku=` returns empty), so the suite fails if the fallback is ever removed — 7 of 36 tests fail without it.

Also confirmed live: assumption 3 (products expose `price_excluding_tax`, `has_inventory`, `active`) and assumption 4 (tax `rate` is a fraction — 0.05 / 0.005). Product writes from the admin session require the `X-XSRF-TOKEN` header; the OAuth API path is unaffected.

### On-account is a sale status, not a payment type — fixed in NGH-BUILD 2026-09-12a
Turned on 2026-09-12: Setup → On-account now has *Allow on-account balance* = **Yes, with no balance limit** (pre-existing) and *Online payments* = **Yes** (needed for "Email receipt with pay link").

`GET /api/2.0/payment_types` on the live store afterwards returns only Store Credit, Online payments, Other Payment Method, Gift Card, lspayments (Online), Lightspeed Payments, Cash and our Online — Stripe. **There is no On Account type**, so `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT` can never be filled in. Two things depended on it and both were wrong:

1. `recordSale()` threw `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT not set` before posting any on-account sale. Removed — an ONACCOUNT sale now posts with an empty `register_sale_payments`, which is how the legacy endpoint takes it (the amount lands on the customer's account balance). `buildSalePayload` still adds a payment line if the var *is* set, for a store that made a custom type.
2. `create-checkout.mjs` used that same var as the on/off switch for the whole feature, so on-account could never be switched on. The switch is now **`LIGHTSPEED_ONACCOUNT`** (`1`/`true`/`yes`), with the old var still honoured for back-compat.

Covered by `tests/lightspeed.test.mjs` (the flag alone enables checkout; the sale posts `status: ONACCOUNT` with `register_sale_payments: []`). Still unverified against the live API: whether `POST /api/register_sales` accepts `status: ONACCOUNT` with no payments — the $1 test booking is what confirms it. If it rejects, set `LIGHTSPEED_ONACCOUNT_STATUS=CLOSED` (already supported) and the sale posts closed instead.
