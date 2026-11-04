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
1. `SHOPIFY_API_SECRET` must be added in Railway by the owner (app crashes without it).
2. Run `shopify app deploy` so Shopify uses the Railway URLs.
3. Reinstall on the dev store and re-enter Pathao credentials; verify order sending + webhook.
4. Only after Railway is confirmed working: delete the old Vercel project and Neon database
   (ask the owner first — irreversible).
