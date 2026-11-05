# ShipBridge for Pathao — project notes for Claude

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
  - Service `shipbridge` (app) deploys from GitHub branch **`main`**; `railway.json` sets
    `npm start` and the `/health` check.
  - Service `Postgres` (Railway template, volume in Singapore). Fresh, empty database.
- Public URL: `https://shipbridge-production-7b96.up.railway.app` (also in `shopify.app.toml`).
- Required env vars: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `ENCRYPTION_KEY` (64 hex),
  `APP_URL`, `DATABASE_URL` (`${{Postgres.DATABASE_URL}}`). Optional: `ADMIN_PASSWORD`,
  `BILLING_TEST`, `SMS_FEATURE`, `SUPPORT_EMAIL`, `SUPPORT_WHATSAPP`.
- `ENCRYPTION_KEY` on Railway is new, so data from the old Neon DB is not carried over;
  merchants reinstall and re-enter Pathao credentials.

## Migration status / open items
- Done: `SHOPIFY_API_SECRET` set on Railway; app version with Railway URLs released;
  app opened on `pathao-test.myshopify.com`, Pathao connected, Pathao webhook handshake OK.
- Open: confirm a real test order arrives via `orders/create` and books with Pathao.
- Open: only after that, delete the old Vercel project and Neon database
  (ask the owner first — irreversible).
- Rotate the Shopify client secret before launch (it was pasted in chat).

## Architecture decision
One app service + one Postgres on Railway. New couriers (Steadfast, RedX, ...) are modules
in `src/couriers/`, not separate services — cheaper and faster for HTTP-only courier APIs.

## Couriers
- Pathao: `src/pathao/` (OAuth password grant, stores, webhook `/pathao/webhook/:shop`).
- Steadfast (Packzy API `https://portal.packzy.com/api/v1`): `src/couriers/steadfast.js`.
  Api-Key + Secret-Key headers, no token. 10 failed logins in 5 min = 60 min lockout, so
  never retry 401s. Webhook `/steadfast/webhook/:shop`: `X-Signature` = HMAC-SHA256(raw body,
  per-shop auth token shown in the app), or `Authorization: Bearer <token>`.
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
  Webhook first: Pathao and Steadfast both send a test when the webhook is saved in their panel;
  any authenticated courier call sets `*_webhook_at` -> "Live". Once a courier is Live it is NOT
  polled, except Steadfast parcels still `in_review`/`unknown` (removal sends no webhook).
  `src/tracking.js` polls couriers every minute for parcels still on the way (started in
  server.js; `pollStatuses:false` in tests) and when the dashboard loads. Steadfast `unknown`
  for a parcel that was `in_review`/`pending`/`unknown` = removed in the Steadfast panel ->
  shipment back to skipped "Removed in Steadfast", Shopify fulfillment cancelled, not counted.
- Shopify fulfillment is created per fulfillment order (gift cards can't be fulfilled together
  with other items).
- `shipments.courier` says which courier booked an order; `shipments.pathao_status` holds the
  courier's status text for every courier (name predates multi-courier).
- `settings.default_courier` drives Send buttons and auto-send.

## Couriers page
- Left: courier list. Main: hero + exactly three steps per courier, same names for every courier:
  **API configuration**, **Webhook configuration**, **Delivery settings** (Pathao: pickup store,
  delivery type, parcel weight, note; Steadfast: delivery type home/hub (`delivery_type` 1 only sent
  for hub), product list (`item_description`, on by default), item count (`total_lot`), second phone
  (`alternative_phone`), note). The note for rider is one shared setting. Webhook status shows just "Live".
- Webhook configuration: editable secret (Pathao) / auth token (Steadfast) + Save. No self-test
  (removed: ShipBridge can't read the courier's portal, so a self-test proved nothing). "Live" only
  from real courier calls. A courier call with the wrong secret/token is refused (401) AND recorded
  (`pathao_webhook_error_at` / `steadfast_webhook_error_at`) -> red warning on the page; cleared
  when the secret/token is changed or a good call arrives.
- Auto-send and the default courier require a *connected* courier (Pathao: account + pickup
  store; Steadfast: keys, not paused). Orders auto-sent while the default isn't connected are
  skipped with "Auto-send: <Courier> (your default courier) is not connected".
- Pathao weight: product weights (REST `grams`), else Shopify `Order.totalWeight`, else the
  "Parcel weight" setting. Steadfast's API has no weight field.
- Right column "Sending rules": default courier, auto-send, hold high-risk, and "Update orders
  inside Shopify" (permissions box, sync toggle, when to fulfil, email customer).

## Dashboard tabs
- All = every order (errors and cancelled included), newest first; other tabs filter.
- Wording: an order handed to a courier is "Sent to <Courier>" (pill, order panel), the tab is
  "Sent", cards say "N sent". Never "Booked" in the UI. Steadfast's `in_review` also shows as sent.
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
- Before changing the order table, re-run the overlap check (widths 1060–1600): the app
  area inside Shopify admin on a 1366px laptop is ~1060px wide.
