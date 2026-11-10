# ShipBridge: BD Courier Sync — project notes for Claude

## Goal
Shopify app that sends Shopify orders to Pathao Courier (Bangladesh). The owner wants to
publish it on the **Shopify App Store as a paid app** and make money from it
(billing plans live in `src/plans.js`; keep `BILLING_TEST=true` until approved).

## Stack
- Node 20 + Express 5, Postgres (`pg`), plain HTML/JS dashboard in `src/views` + `public/`.
- Embedded Shopify app, session-token auth, expiring offline tokens.
- Tests: `npm test` (node:test + pg-mem, fake Shopify/Pathao). Run them before pushing.

## Hosting (moved from Vercel + Neon to Railway on 2026-11-04)
- Railway project `shipbridge-pathao` (id `16500b22-0f21-4363-9e27-da3a908b2186`),
  environment `production`, region Singapore (`asia-southeast1-eqsg3a`).
  - Service `shipbridge` (app) deploys from GitHub branch **`main`**; `railway.json` starts
    `node src/server.js` directly (clean SIGTERM shutdown, no npm noise) with the `/health` check.
  - Service `Postgres` (Railway template, volume in Singapore). Fresh, empty database.
- Public URL: `https://autocourier.nimtechit.com` (custom domain since 2026-11-10; GoDaddy CNAME -> Railway; also in
  `shopify.app.toml` and `APP_URL`). The old `https://shipbridge-production-7b96.up.railway.app` still answers; keep it
  until every store has the new courier callback URLs and the new app version is released.
- Required env vars: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `ENCRYPTION_KEY` (64 hex),
  `APP_URL`, `DATABASE_URL` (`${{Postgres.DATABASE_URL}}`). Optional: `ADMIN_PASSWORD`,
  `BILLING_TEST`, `SMS_FEATURE`, `SUPPORT_EMAIL`, `SUPPORT_WHATSAPP`.
- `ENCRYPTION_KEY` on Railway is new, so data from the old Neon DB is not carried over;
  merchants reinstall and re-enter Pathao credentials.

## Migration status / open items
- Done: `SHOPIFY_API_SECRET` set on Railway; app version with Railway URLs released;
  app opened on `pathao-test.myshopify.com`, Pathao connected, Pathao webhook handshake OK.
- Done: Pathao bookings confirmed on Railway (pathao-test #1012–#1014, 2026-11-04) and Steadfast
  (nishi-qolyyvis #1002/#1003, 2026-11-05), both fulfilled in Shopify.
- Open: only after that, delete the old Vercel project and Neon database
  (ask the owner first — irreversible).
- Rotate the Shopify client secret before launch (it was pasted in chat).
- No permission box in the UI (removed 2026-11-05): scopes come from shopify.app.toml at install;
  `/api/bootstrap` still refreshes the token if a stored scope is missing.

## Architecture decision
One app service + one Postgres on Railway. New couriers (Steadfast, RedX, ...) are modules
in `src/couriers/`, not separate services — cheaper and faster for HTTP-only courier APIs.

## Couriers
- Pathao: `src/pathao/` (OAuth password grant, stores, webhook `/pathao/webhook/:shop`).
- Steadfast (Packzy API `https://portal.packzy.com/api/v1`): `src/couriers/steadfast.js`.
  Api-Key + Secret-Key headers, no token. 10 failed logins in 5 min = 60 min lockout, so
  never retry 401s. Webhook: the Callback URL shown in the app is `/steadfast/webhook/:shop/:key`
  (`settings.steadfast_webhook_key`, 48 hex) and needs NO auth token (owner's request, 2026-11-05);
  a wrong key = 401, not recorded. Old `/steadfast/webhook/:shop` still accepts `X-Signature` =
  HMAC-SHA256(raw body, `steadfast_webhook_token`) or `Authorization: Bearer <token>`.
  `*_approval_pending` statuses are rider-only and don't move the Shopify order.
  Every Steadfast webhook is logged (`steadfast webhook: <type> cid=… status=… order=…`). Any event
  with a status updates the order; `tracking_message` is saved in `shipments.courier_message` and
  shown in the order panel. Events without `consignment_id` are matched by `invoice`.
  Only real delivery statuses (their list) change an order; `cancel_request` only sets a message
  until approved (then `cancelled`).
- Everything updates on its own; NO refresh buttons anywhere (owner's request).
  Live updates: `src/events.js` bus; `GET /api/events` is a streaming (SSE-format) response the
  dashboard reads with fetch (session token header) and reconnects every 3 s if dropped. Any
  `admin.forgetOrders(shop)` publishes an event (wrapped in app.js), so webhooks (orders/create,
  orders/updated, Pathao, Steadfast), the tracker and bookings all redraw open dashboards.
  Webhook first: Pathao sends a test (webhook_integration) when saved in its panel; Steadfast does
  NOT (its portal shows "No deliveries yet" until the first parcel update) -- confirmed 2026-11-05;
  any authenticated courier call sets `*_webhook_at` -> "Live". Once a courier is Live it is NOT
  polled, except Steadfast parcels still `in_review`/`unknown` (removal sends no webhook).
  `src/tracking.js` polls couriers every minute for parcels still on the way (started in
  server.js; `pollStatuses:false` in tests) and when the dashboard loads. Steadfast `unknown`
  for a parcel that was `in_review`/`pending`/`unknown` = removed in the Steadfast panel ->
  shipment back to skipped "Removed in Steadfast", Shopify fulfillment cancelled, not counted.
- Shopify order status follows Shopify's COD standard (2026-11-05, src/shopify/fulfillment.js `sync`):
  sent/picked up = Fulfilled + Payment pending; delivered = `orderMarkAsPaid` once (`shipments.shopify_paid_at`,
  setting `mark_paid_on_delivery`, default on; partial delivery is NOT marked paid); Pathao `pickup-cancelled`
  = fulfillment cancelled + shipment back to skipped "Pickup cancelled by Pathao · send again" (always);
  returned / paid-return (Pathao) or cancelled (Steadfast) = fulfillment cancelled -> Unfulfilled
  (setting `undo_on_return`, default on). "Partially fulfilled" only when some items really weren't shipped.
- Shopify fulfillment is created per fulfillment order (gift cards can't be fulfilled together
  with other items).
- `shipments.courier` says which courier booked an order; `shipments.pathao_status` holds the
  courier's status text for every courier (name predates multi-courier).
- `settings.default_courier` drives Send buttons and auto-send.

## Couriers page
- Left: courier list. Main: hero + exactly three steps per courier, same names for every courier:
  **API configuration**, **Webhook configuration**, **Delivery settings**. Delivery settings is a short
  form (owner's request, like other BD courier apps): "Set <Courier> as default courier" checkbox (always one
  default; changed by ticking another courier), Pathao: pickup store, default parcel weight, default parcel note,
  default delivery type radios Regular / On-demand (Express); Steadfast: default parcel note, delivery type radios
  Home / Point delivery (`delivery_type` 1 only sent for Point). Steadfast's API has no Regular/Express or weight
  field, so those are not offered. Product list (`item_description`), item count (`total_lot`) and a second phone
  (`alternative_phone`, when it differs) always go to Steadfast; no switches. The note for rider is one shared setting. Webhook status shows just "Live".
- Webhook configuration: editable secret (Pathao) + Save; Steadfast shows only the Callback URL + Save
  (`steadfast_webhook_saved: true`), no auth token field. No self-test
  (removed: ShipBridge can't read the courier's portal, so a self-test proved nothing). "Live" only
  from real courier calls. A courier call with the wrong secret/token is refused (401) AND recorded
  (`pathao_webhook_error_at` / `steadfast_webhook_error_at`) -> red warning on the page; cleared
  when the secret/token is changed or a good call arrives.
- Webhook Save = step done (`*_webhook_saved_at`), summary "Saved", next step (Delivery settings)
  opens. No waiting / "not live" notes (owner's request). Summary turns "Live" by itself when the
  courier sends anything (pushed via /api/events). Only the wrong-token warning is shown.
- Hero facts: Pathao = Pickup store, Default, Auto-send, Delivery type; Steadfast = Balance, Default,
  Auto-send, Delivery type (Home/Point). No "Updates" tile (owner's request); Live is the pill in the title.
- Auto-send and the default courier require a *connected* courier (Pathao: account + pickup
  store; Steadfast: keys, not paused). Orders auto-sent while the default isn't connected are
  skipped with "Auto-send: <Courier> (your default courier) is not connected".
- Pathao weight: product weights (REST `grams`), else Shopify `Order.totalWeight`, else the
  "Parcel weight" setting. Steadfast's API has no weight field.
- Right column "Sending rules": default courier, auto-send, hold high-risk, and "Update orders
  inside Shopify" (sync toggle, when to fulfil, email customer, mark paid when delivered,
  unfulfil returned parcels).

## Dashboard tabs
- All = every order (errors and cancelled included), newest first; other tabs filter.
- Wording: an order handed to a courier is "Sent to <Courier>" (pill, order panel), cards say "N sent".
  Tabs (design review 2026-11-05): All, New, Errors, In transit (= sent + picked up + on the way), Delivered,
  Returned, Cancelled. Never "Booked" in the UI. Steadfast's `in_review` also shows as sent.
- Overview cards follow the Shopify-style date picker (presets + 2-month calendar); `/api/stats`
  takes `from`/`to` (ISO, `to` exclusive) or `range=all`. The Fraud check card counts the loaded
  orders in those dates; clicking it filters the list to High risk.
- Setup checklist covers every courier: connect a courier (any), live updates for each connected
  courier, auto-send (asks to pick a connected default first). No Shopify-permission step (granted at install).
- Header live pill: one live courier = "<Courier> live"; several = stacked logos + "N couriers live".
- No Hold tab and no draft orders (removed 2026-11-05 at the owner's request; scopes are back to
  orders + fulfillments only). A merchant-driven "hold this order" feature was proposed, not built.
- Errors = must be fixed first: bad phone, missing name/address, courier refused, plan limit.
- Returned = failed delivery / returned. Cancelled = cancelled in Shopify (not sent).
- Merchant notes per order live in `order_notes` (never sent to couriers).
- Order table columns (2026-11-05): 24px | order 70px | products minmax(118,1.2fr) | customer minmax(110,1fr) |
  payment 84px | fulfillment 92px | status 152px, content and header centred in the column (owner's request;
  fits "Sent to Steadfast" 141px) | fraud minmax(140,1.35fr) | courier 136px.
- Before changing the order table, re-run the overlap check (widths 1060–1600): the app
  area inside Shopify admin on a 1366px laptop is ~1060px wide.

## Content (content report 2026-11-05)
- App name "ShipBridge: BD Courier Sync" (shopify.app.toml; needs `shopify app deploy` to reach Shopify), provider
  "AutoCourier BD" (privacy policy). Privacy contact comes from SUPPORT_EMAIL / SUPPORT_WHATSAPP (default WhatsApp).
- Messages say what happened + what to do, no tech words ("Shopify didn't answer as expected... Try again in a minute").
- Status pills stay short (fit 141px); longer meaning goes in the hover title (Waiting to confirm, Lost or damaged,
  Returned · fee paid, Refused by <Courier>). Uninstall also deletes Steadfast keys.

## Design rules (design review 2026-11-05)
- LOOK = Shopify Polaris (owner's choice 2026-11-05): "Polaris theme" block at the end of app.css overrides the
  base styles. Primary = #303030 (black bevel buttons, toggles, ticks, rings); page #f1f1f1; text #303030 /
  #616161; links #005bd3; badges in Polaris tones (success #cdfee1/#0c5132, attention #ffef9d/#4f4700,
  Payment pending = warning #ffd6a4/#5e4200, critical #fed1d7/#8e0b21, info #e0f0ff/#00527c); radius 8/12px;
  plain-text tabs with grey selected; table headers not uppercase. No indigo anywhere new.
- All text >= 4.5:1 contrast (`--muted` #5f6673; small uppercase labels #4b5563). Re-measure after colour changes.
- Type scale (UI report fixes 2026-11-05): font sizes only 11 / 12 / 13.5 (body) / 15 / 20 / 26 px; weights only
  400 / 600 / 700. Near-duplicate colours merged into one palette (WhatsApp keeps #25D366).
- Overview: under 1250 px only the first row of cards shows until "Show all" (remembered per browser);
  wide screens show all 6. Wording: sentence case buttons, US "fulfill", "3 of 50 orders used this month",
  "Not delivered" card, "Prices in USD, billed by Shopify" on Billing.
- Overview cards are neutral (no coloured stripes); colour only where it means something.
- Fraud: traffic light — low/safe green, medium amber, high red; score shown as x/100.
- Payment cell (owner's choice): amount, yellow "Pending" badge (green "Paid" once delivered), then
  "COD ৳<amount>" line while unpaid.
- Row actions share one button shape (`.assign`; `.assign.warn` red for fixes). To-do step dots are grey.
- Phones (<=640px, owner-approved 2026-11-05): each order row is a card, grid areas
  "chk order pay" / "chk cust pay" / "chk st ful" / "chk prod prod" / "chk fr cr" (status left-aligned with dots and
  parcel no. under the pill; payment = amount, badge, COD line). Header buttons share one row, live pill hidden.
- Phone numbers shown in local format 01XXX-XXXXXX on one line. Header: Billing, WhatsApp (outline,
  green icon), Couriers.

## Performance and cost rules (backend report fixes 2026-11-05)
- `shipments.finished` (kept in step by db.finishShipment from `isFinished` in src/statuses.js) + index
  `shipments_open`; the tracker reads only unfinished parcels and only stores whose courier still needs asking
  (webhook not live, or Steadfast in_review/unknown).
- Courier updates call `admin.touchOrders` (redraw only; /api/orders merges parcel data from Postgres each call).
  `admin.forgetOrders` (refetch from Shopify) only for Shopify order changes: orders webhooks, sending, and
  fulfillment.sync results with `shopifyChanged` (fulfilled, paid, unfulfilled) via `admin.afterCourierUpdate`.
- Order/plan caches are swept every minute; per-store API limit 300 requests/min (API_RATE_PER_MINUTE), live
  stream excluded; versioned courier logos (?v=) cached 1 year. compression >= 1.8.2 (GHSA-vc2v-76pw-4v95).

## Secret safety (pass of 2026-11-05)
- Every credential comes from env vars via src/config.js; no secret literal anywhere (PATHAO_WEBHOOK_INTEGRATION_SECRET
  moved to Railway). `.env*` git-ignored except `.env.example` (placeholders only). Git history checked: clean.
- src/redact.js: all logs (createApp wraps `log`) and API error messages are redacted (own secrets by value,
  connection strings / bearer tokens / key=value credentials by pattern); start-up errors too.
- Browser never receives: courier passwords/secrets, the Steadfast API key (only `api_key_hint` last 4), the legacy
  Steadfast token, encrypted columns. It does receive, by design: Shopify API key (client ID), the Pathao webhook
  secret and the Steadfast callback URL key (the merchant must paste them into the courier portal).

## Reliability rules (review 2026-11-05)
- Every outbound call (Shopify, couriers, SMS) aborts after 30 s (`httpTimeoutMs`, wrapper in app.js).
- A booking that times out is saved as failed with error `Not confirmed: ...`; `/orders/send` returns
  `needsConfirm` for it until the dashboard resends with `confirm: true` (Pathao accepts duplicates).
- Pathao `order.created` / `order.updated` / `order.paid` are not parcel statuses: they never overwrite
  `pathao_status` (`paid` only sets `courier_message`). Pathao statuses are stored lowercase-hyphen
  (`pathaoSlug` in tracking.js); `pickup-cancelled` counts as finished.
- Courier webhooks answer 404 for shops that never installed / uninstalled (no rows created).
- Order list: first page cached; `GET /api/orders?after=<cursor>` for older pages, `POST /api/orders/search {q}`
  searches the whole store (Shopify order search). Dashboard keeps loaded pages and search hits across live redraws.
- Owner page `/admin` shows recent bookings (no customer data) to trace any order.
- Webhook addresses answer GET with a "ready" page for installed shops (merchants open them in a
  browser and read 404 as "broken"). Steadfast only calls on a parcel
  status change; until then the tracker polls it every minute.

## Personal data (audit 2026-11-05)
- Customer data stored: phone (shipments, sms_log, for fraud history), order IDs/numbers, courier status, merchant notes.
  Names/addresses/emails are read from Shopify per request and passed only to the chosen courier (never stored).
- Logs: `redactingLog` also strips BD phone numbers, emails and quoted `Phone "…"` values (src/redact.js `redactPII`);
  owner page errors go through `redactPII`; bad JSON bodies are logged by type only.
- Store search is `POST /api/orders/search` (body), never `?q=` in the URL (access logs).
- Inter is self-hosted in public/assets/fonts (no Google Fonts). No support-ticket collection (`POST /support` removed).
- customers/redact deletes by order IDs only (phone-based deletion built then removed 2026-11-05 at the owner's
  request); data_request logs a record count.
- No merchant "delete customer data" button (built then removed 2026-11-05 at the owner's request); data goes on
  uninstall (shop/redact) and Shopify customer redaction only.
- Pathao password is encrypted (AES-256-GCM), not hashed, because it must be sent to Pathao; the app has no user
  passwords of its own (Shopify session tokens). Steadfast Api-Key is plaintext in DB (useless without the encrypted secret).

## Launch checks (2026-11-05)
- helmet on every response: nosniff, X-Frame-Options DENY, HSTS 1 year, CSP from `csp()` in app.js (scripts: self +
  cdn.shopify.com only; images self + cdn.shopify.com). The app page route replaces CSP with frame-ancestors =
  shop + admin.shopify.com and removes X-Frame-Options (embedded app). Inline <script> is not allowed: keep JS in app.js.
- Errors go through src/errors.js `publicError`: merchant-facing messages shown; internal ones (DB/network/
  programming errors, SQL, file paths) become a generic message. Every error carries `ref` (8 hex), logged as `[ref X]`.
- /admin: 5 password attempts per minute per IP (last X-Forwarded-For hop), then 429.
- Start-up warns if PATHAO_WEBHOOK_INTEGRATION_SECRET or ADMIN_PASSWORD is missing; required vars still stop start-up.
- `POST /api/orders/refresh-active` removed (unused). No CORS headers sent (same-origin only). Postgres has no public
  port/domain on Railway (private network only).
- Cost (2026-11-10): tracker `tick()` rests 5 min when no store has a parcel to ask about (`wake()` on any
  `admin.forgetOrders`); Railway var `NODE_OPTIONS=--max-old-space-size=96` caps the app's memory.
