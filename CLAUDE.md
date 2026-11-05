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
  until approved (then `cancelled`). "Refresh status" is always shown; the main Refresh calls
  `POST /api/orders/refresh-active` (up to 20 parcels still on the way, skipped while keys are paused).
- `shipments.courier` says which courier booked an order; `shipments.pathao_status` holds the
  courier's status text for every courier (name predates multi-courier).
- `settings.default_courier` drives Send buttons and auto-send.

## Dashboard tabs
- All = every order (errors and cancelled included), newest first; other tabs filter.
- Wording: an order handed to a courier is "Sent to <Courier>" (pill, order panel), the tab is
  "Sent", cards say "N sent". Never "Booked" in the UI. Steadfast's `in_review` also shows as sent.
- Overview cards follow the Shopify-style date picker (presets + 2-month calendar); `/api/stats`
  takes `from`/`to` (ISO, `to` exclusive) or `range=all`. The Fraud check card counts the loaded
  orders in those dates; clicking it filters the list to High risk.
- Header live pill: one live courier = "<Courier> live"; several = stacked logos + "N couriers live".
- No Hold tab and no draft orders (removed 2026-11-05 at the owner's request; scopes are back to
  orders + fulfillments only). A merchant-driven "hold this order" feature was proposed, not built.
- Errors = must be fixed first: bad phone, missing name/address, courier refused, plan limit.
- Returned = failed delivery / returned. Cancelled = cancelled in Shopify (not sent).
- Merchant notes per order live in `order_notes` (never sent to couriers).
- Before changing the order table, re-run the overlap check (widths 1060–1600): the app
  area inside Shopify admin on a 1366px laptop is ~1060px wide.
