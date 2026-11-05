// Builds the Express app. Kept separate from server.js so tests can inject
// a fake database and fake fetch.

const fs = require('fs');
const path = require('path');
const { makeOwnerRouter } = require('./routes/owner');
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const { makeCipher } = require('./crypto');
const { makeDb } = require('./db');
const { makeTokenManager, isValidShop } = require('./shopify/auth');
const { makeAdmin } = require('./shopify/admin');
const { makePathao } = require('./pathao/client');
const { makeSteadfast } = require('./couriers/steadfast');
const { makeTracker } = require('./tracking');
const { makeBus } = require('./events');
const { makeShipping } = require('./shipping');
const { makeFulfillmentSync } = require('./shopify/fulfillment');
const { makeSmsClient } = require('./sms/sms');
const { makeNotifier } = require('./sms/notifier');
const { makeWebhookRouter } = require('./routes/webhooks');
const { makeApiRouter } = require('./routes/api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

function createApp({ config, pool, fetchImpl: rawFetch = fetch, log = console, defer = (p) => p }) {
  // Every call to Shopify, Pathao, Steadfast or SMS gives up after 30 s, so a courier
  // that stops answering can't leave an order stuck on "Sending".
  const fetchImpl = (url, init = {}) => rawFetch(url, { ...init, signal: init.signal || AbortSignal.timeout(config.httpTimeoutMs || 30000) });
  const cipher = makeCipher(config.encryptionKey);
  const db = makeDb(pool);
  const tokens = makeTokenManager({ config, db, cipher, fetchImpl });
  const admin = makeAdmin({ config, tokens, fetchImpl });
  // Every change to a shop's orders clears the order cache; also tell its open dashboards.
  const bus = makeBus();
  const forgetOrders = admin.forgetOrders;
  admin.forgetOrders = (shop, type = 'orders') => { forgetOrders(shop); bus.publish(shop, type); };
  const pathao = makePathao({ config, db, cipher, fetchImpl });
  const fulfillment = makeFulfillmentSync({ admin, db, log });
  const steadfast = makeSteadfast({ config, cipher, db, fetchImpl });
  const shipping = makeShipping({ db, pathao, steadfast, admin, fulfillment, log });
  const tracker = makeTracker({ db, pathao, steadfast, fulfillment, admin, log });
  const notifier = makeNotifier({ db, cipher, smsClient: makeSmsClient({ fetchImpl, apiUrl: config.smsApiUrl }), log });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Gzip JSON, HTML, JS and CSS. The order list and app.js shrink ~5-8x.
  app.use(compression());

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/admin', makeOwnerRouter({ config, db }));

  // Webhooks need the raw body for HMAC, so mount before any JSON parser.
  app.use(makeWebhookRouter({ config, db, admin, shipping, fulfillment, steadfast, notifier: config.smsFeature ? notifier : null, log, defer }));
  app.use('/api', makeApiRouter({ config, db, tokens, admin, pathao, steadfast, tracker, bus, shipping, fulfillment, notifier, cipher, log }));

  // Static assets (JS/CSS) and public pages (privacy policy).
  // app.js / app.css are referenced as ?v=<content hash>, so browsers can keep
  // them for a year and re-download only when the file actually changes.
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
    maxAge: '1h',
    setHeaders: (res, file) => {
      if (/app\.(js|css)$/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
      // Courier logos can be replaced under the same name: browsers re-check (a quick 304) every visit.
      else if (/[\\/]couriers[\\/]/.test(file)) res.set('Cache-Control', 'no-cache');
    },
  }));
  app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
  // Install is managed by Shopify (shopify.app.toml), so the OAuth callback just
  // sends the merchant into the embedded app.
  app.get('/auth/callback', (req, res) => {
    const shop = String(req.query.shop || '');
    if (!isValidShop(shop)) return res.status(400).send('Missing shop');
    res.redirect(`https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/apps/${config.appHandle}`);
  });

  // Embedded app shell. Shopify loads this inside the admin iframe.
  // One fingerprint for all courier logos, so a new logo gets a new URL.
  const logoVersion = () => {
    const dir = path.join(PUBLIC_DIR, 'assets', 'couriers');
    const h = crypto.createHash('sha1');
    for (const f of fs.readdirSync(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
    return h.digest('hex').slice(0, 10);
  };
  const assetVersion = (name) => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, 'assets', name))).digest('hex').slice(0, 10);
  const shell = fs.readFileSync(path.join(VIEWS_DIR, 'index.html'), 'utf8')
    .replace(/%SHOPIFY_API_KEY%/g, config.shopifyApiKey)
    .replace('/assets/app.css"', `/assets/app.css?v=${assetVersion('app.css')}"`)
    .replace('/assets/app.js"', `/assets/app.js?v=${assetVersion('app.js')}"`)
    .replace(/%LOGO_VERSION%/g, logoVersion());
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

  return { app, db, tracker, bus };
}

module.exports = { createApp };
