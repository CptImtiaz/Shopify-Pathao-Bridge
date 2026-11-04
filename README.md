# ShipBridge for Pathao: Shopify App

A public Shopify app that sends Shopify orders to **Pathao Courier** (Bangladesh): automatically when an order is placed, or in bulk from a dashboard inside Shopify admin. Built from the original `Shopify-Pathao-Bridge` single-store script.

## What changed from the original bridge

| Original script | This app |
|---|---|
| One hard-coded store (`SHOP=wellessia`) | Any merchant can install it from the App Store |
| Your Pathao login in env vars | Each merchant enters **their own** Pathao credentials (encrypted, AES-256-GCM) |
| Duplicate protection in memory (lost on restart) | Database lock per order, safe across restarts and multiple servers |
| "Server start" cutoff for old orders | "Auto-send since" date per merchant, so redeploys never resend orders |
| `/shopify/orders`, `/shopify/customers` open to anyone with the URL | Every API call needs a signed Shopify session token |
| No UI | Embedded dashboard: orders list, send/retry, settings, plans |
| No billing | Free (50 orders/month) + Pro ($9.99/month, 7-day trial) via Shopify Billing API |

It also fixes the main complaints in reviews of Pathao's own Shopify app (rated about 2 stars):
- Phone numbers like `+880 880 17…` or `+880 017…` are cleaned up automatically.
- Cash to collect uses Shopify's **outstanding balance**, so edited, partially paid and POS orders send the right amount.
- On retry, the latest order is fetched from Shopify, so edits are picked up.
- Bad orders are caught with a clear message **before** they reach Pathao. Examples: invalid phone, missing address, zero weight.

## Project layout

```
src/
  server.js            start-up for always-on servers (Railway etc.)
  pool.js              Postgres connection (Neon/Railway/Supabase)
  views/index.html     embedded app shell
  app.js               Express app wiring, embedded shell + CSP header
  config.js            env vars
  plans.js             pricing plans (edit prices/limits here)
  crypto.js            AES-256-GCM for secrets at rest
  db.js                Postgres schema + queries
  shipping.js          send one order to Pathao exactly once
  shopify/auth.js      session tokens, token exchange (expiring offline tokens), refresh, webhook HMAC
  shopify/admin.js     GraphQL: orders, tags/metafields, billing
  pathao/client.js     Pathao Merchant API (per-merchant tokens, stores, create order, status)
  pathao/mapper.js     Shopify order -> Pathao payload (phone, COD, weight, validation)
  routes/api.js        JSON API for the dashboard
  routes/webhooks.js   orders/create, app/uninstalled, billing, GDPR, Pathao status webhook
railway.json           Railway build/start + /health check
public/                dashboard JS/CSS, privacy policy
shopify.app.toml       app config: scopes, webhooks (push with Shopify CLI)
test/                  30 automated tests with fake Shopify + Pathao
```

## Run the tests

```bash
npm install
npm test
```

## Launch checklist

### 1. Deploy on Railway (current setup)
1. Push this folder to a **new** GitHub repo. Don't reuse the old one: see the security note at the bottom.
2. In Railway: **New Project → Deploy from GitHub repo**, then **+ New → Database → PostgreSQL**.
3. In the service's **Variables**, set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `ENCRYPTION_KEY`, `APP_URL`, `DATABASE_URL`, `BILLING_TEST=true` (and optionally `ADMIN_PASSWORD`). The app refuses to start if any required one is missing. `DATABASE_URL` can reference the Postgres plugin (`${{Postgres.DATABASE_URL}}`). Generate `ENCRYPTION_KEY` with `openssl rand -hex 32` and keep a backup.
4. **Settings → Networking → Generate domain**. That URL is your `APP_URL`.

### 2. Create the Shopify app
1. Create a free Shopify Partner account at partners.shopify.com and a **development store**.
2. Install Shopify CLI (`npm i -g @shopify/cli`), then in this folder run:
   ```bash
   shopify app config link      # create a new app, or pick the one you created
   ```
3. Edit `shopify.app.toml`: set `client_id`, `application_url` and `redirect_urls` to your Railway URL.
4. Push the config (scopes + webhooks): `shopify app deploy`.
5. Copy the app's Client ID / Secret into Railway as `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`.
6. In the Partner Dashboard → your app → **API access → Protected customer data**: request access to **name, phone and address** (needed because orders contain them). Explain: "Used only to create delivery orders in the merchant's own Pathao account; not stored."

### 3. Test on your dev store
1. Install the app on the dev store from the Partner Dashboard.
2. Use **Pathao sandbox** credentials (environment = Sandbox) and create a test order with a Bangladesh address and phone number.
3. Try: Save & test connection → choose a store → auto-send on → place an order → see it appear as **Sent**.
4. Try upgrading to Pro. With `BILLING_TEST=true` the charge is free.
5. Optional: put the Callback URL + Secret from section 3 of the dashboard into Pathao's Webhook integration page.

### 4. Submit to the App Store
Partner Dashboard → your app → **Distribution → Public (Shopify App Store)**, then fill in the listing:
- **App name**: avoid putting another company's brand first. "ShipBridge for Pathao Courier" is safer than "Pathao Sync". If you can, ask Pathao for permission to use their name.
- **Icon** 1200×1200, 3–6 **screenshots** (1600×900) of the dashboard, and a short **screencast** of install → connect → order sent.
- **Privacy policy URL**: `https://<APP_URL>/privacy`. First fill in the `[YOUR COMPANY NAME]`, `[DATE]` and `[SUPPORT EMAIL]` placeholders in `public/privacy.html`.
- **Pricing**: Free plan + Pro $9.99/month, 7-day trial (matches `src/plans.js`).
- **Testing instructions for the reviewer**: give working **Pathao sandbox** credentials so they can send a test order.
- Set `BILLING_TEST=false` in Railway once the app is approved.

Review usually takes a few weeks, and the first submission often gets change requests. Fix them and resubmit.

## SMS notifications (SSL Wireless)

Merged from `Shopify-ISMS-Bridge`. Each merchant can send customers an order-confirmation SMS through their own SSL Wireless SMS Plus account. This runs independently of Pathao: an SMS failure never blocks a booking, and the other way round.

- **Settings** are in the dashboard under *SMS notifications*: on/off, API token (encrypted), SID, message template, and a test-SMS button.
- **"Send SMS for":** *All orders*, *Online store orders only* (`source_name = web`), or *Manual orders only* (`shopify_draft_order`, i.e. orders created in the Shopify admin).
- **Template placeholders:** `{{name}}`, `{{order_number}}`, `{{items}}`, `{{total}}`, `{{currency}}`. The default is the Bangla confirmation text from the original bridge.
- **Once per order:** each order gets one SMS (logged in `sms_log`); duplicate webhooks are ignored, and orders placed before SMS was switched on are skipped.
- **Status on orders:** the orders list shows *SMS sent*, *SMS failed: reason* or *No SMS: reason*.
- **IP whitelisting:** if your SSL Wireless account only accepts whitelisted server IPs, the host's changing outbound IPs may be rejected. Ask SSL Wireless to allow your API token without IP restriction, or host on a server with a fixed outbound IP.
- Code: `src/sms/sms.js` (provider + template + source filter), `src/sms/notifier.js` (when to send).

## Things to double-check with Pathao
- **Webhook handshake**: Pathao's panel expects the header `X-Pathao-Merchant-Webhook-Integration-Secret` on a `202` response. The app echoes Pathao's value, or uses `PATHAO_WEBHOOK_INTEGRATION_SECRET`. Check the value in Pathao's current docs if registration fails.
- **City/zone**: like your original script, orders are sent with the full address only and no city/zone IDs. This worked for your store. If Pathao starts requiring zones, add a zone picker (the API has `city-list` / `zone-list` endpoints).

## Security note about the old repo
The original `Shopify-Pathao-Bridge` repo contains a committed `env` file with Shopify credentials. Its server also exposes order and customer data (`/shopify/orders`, `/shopify/customers`) and an order-creation endpoint, all without authentication. **Rotate the Shopify client secret and your Pathao API secret/password, make the repo private, and shut that server down** once this app replaces it.

## Shopify status sync (Pathao → Shopify)

Merged from Shopify-PathoOrderStatus. When a parcel is booked (or picked up, per
setting) the Shopify order is fulfilled with tracking company "Pathao", the
consignment ID as tracking number and `https://merchant.pathao.com/tracking?...`
as tracking URL. ON_HOLD fulfillment orders are released first; orders already
fulfilled by hand get the tracking attached. Each Pathao webhook then adds a
Shopify fulfillment event (CONFIRMED, CARRIER_PICKED_UP, IN_TRANSIT,
OUT_FOR_DELIVERY, ATTEMPTED_DELIVERY, DELIVERED, DELAYED, FAILURE).

Extra scopes: `write_fulfillments`, `write_merchant_managed_fulfillment_orders`
(plus their read_ scopes). Release a new app version with these scopes; stores
approve them the next time they open the app.
