// Builds the Express app. Kept separate from server.js so tests can inject
// a fake database and fake fetch.

const fs = require('fs');
const path = require('path');
const { makeOwnerRouter } = require('./routes/owner');
const express = require('express');
const { makeCipher } = require('./crypto');
const { makeDb } = require('./db');
const { makeTokenManager, isValidShop } = require('./shopify/auth');
const { makeAdmin } = require('./shopify/admin');
const { makePathao } = require('./pathao/client');
const { makeShipping } = require('./shipping');
const { makeFulfillmentSync } = require('./shopify/fulfillment');
const { makeSmsClient } = require('./sms/sms');
const { makeNotifier } = require('./sms/notifier');
const { makeWebhookRouter } = require('./routes/webhooks');
const { makeApiRouter } = require('./routes/api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

function createApp({ config, pool, fetchImpl = fetch, log = console, defer = (p) => p }) {
  const cipher = makeCipher(config.encryptionKey);
  const db = makeDb(pool);
  const tokens = makeTokenManager({ config, db, cipher, fetchImpl });
  const admin = makeAdmin({ config, tokens, fetchImpl });
  const pathao = makePathao({ config, db, cipher, fetchImpl });
  const fulfillment = makeFulfillmentSync({ admin, db, log });
  const shipping = makeShipping({ db, pathao, admin, fulfillment, log });
  const notifier = makeNotifier({ db, cipher, smsClient: makeSmsClient({ fetchImpl, apiUrl: config.smsApiUrl }), log });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/admin', makeOwnerRouter({ config, db }));

  // Webhooks need the raw body for HMAC, so mount before any JSON parser.
  app.use(makeWebhookRouter({ config, db, admin, shipping, fulfillment, notifier: config.smsFeature ? notifier : null, log, defer }));
  app.use('/api', makeApiRouter({ config, db, tokens, admin, pathao, shipping, fulfillment, notifier, cipher, log }));

  // Static assets (JS/CSS) and public pages (privacy policy).
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '1h' }));
  app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
  // Install is managed by Shopify (shopify.app.toml), so the OAuth callback just
  // sends the merchant into the embedded app.
  app.get('/auth/callback', (req, res) => {
    const shop = String(req.query.shop || '');
    if (!isValidShop(shop)) return res.status(400).send('Missing shop');
    res.redirect(`https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/apps/${config.appHandle}`);
  });

  // Embedded app shell. Shopify loads this inside the admin iframe.
  const shell = fs.readFileSync(path.join(VIEWS_DIR, 'index.html'), 'utf8').replace(/%SHOPIFY_API_KEY%/g, config.shopifyApiKey);
  app.get(['/', '/app', '/settings', '/couriers', '/sms', '/plans', '/billing', '/support'], (req, res) => {
    const shop = String(req.query.shop || '');
    // Required for embedded apps: only Shopify admin may frame this page.
    const ancestors = isValidShop(shop) ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com';
    res.set('Content-Security-Policy', `frame-ancestors ${ancestors};`);

    // Opened outside the admin (e.g. straight from the install link): bounce into the admin.
    if (isValidShop(shop) && req.query.embedded !== '1' && !req.query.host) {
      return res.redirect(`https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/apps/${config.appHandle}`);
    }
    res.type('html').send(shell);
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, db };
}

module.exports = { createApp };
