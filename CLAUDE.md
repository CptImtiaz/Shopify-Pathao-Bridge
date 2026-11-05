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
  - Service `shipbridge` (app) deploys from GitHub branch **`main`**; `railway.json` starts
    `node src/server.js` directly (clean SIGTERM shutdown, no npm noise) with the `/health` check.
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
- Done: Pathao bookings confirmed on Railway (pathao-test #1012–#1014, 2026-11-04) and Steadfast
  (nishi-qolyyvis #1002/#1003, 2026-11-05), both fulfilled in Shopify.
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
  inside Shopify" (permissions box, sync toggle, when to fulfil, email customer, mark paid when delivered,
  unfulfil returned parcels).

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

## Reliability rules (review 2026-11-05)
- Every outbound call (Shopify, couriers, SMS) aborts after 30 s (`httpTimeoutMs`, wrapper in app.js).
- A booking that times out is saved as failed with error `Not confirmed: ...`; `/orders/send` returns
  `needsConfirm` for it until the dashboard resends with `confirm: true` (Pathao accepts duplicates).
- Pathao `order.created` / `order.updated` / `order.paid` are not parcel statuses: they never overwrite
  `pathao_status` (`paid` only sets `courier_message`). Pathao statuses are stored lowercase-hyphen
  (`pathaoSlug` in tracking.js); `pickup-cancelled` counts as finished.
- Courier webhooks answer 404 for shops that never installed / uninstalled (no rows created).
- Order list: first page cached; `GET /api/orders?after=<cursor>` for older pages, `?q=` searches the
  whole store (Shopify order search). Dashboard keeps loaded pages and search hits across live redraws.
- Owner page `/admin` shows recent bookings (no customer data) to trace any order.
- Webhook addresses answer GET with a "ready" page for installed shops (merchants open them in a
  browser and read 404 as "broken"). Steadfast only calls on a parcel
  status change; until then the tracker polls it every minute.
