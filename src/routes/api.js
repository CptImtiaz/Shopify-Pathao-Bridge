// JSON API used by the embedded admin UI. Every request carries an App Bridge
// session token (App Bridge adds `Authorization: Bearer <token>` to fetch()
// calls automatically), so no cookies are needed.

const crypto = require('crypto');
const express = require('express');
const { verifySessionToken, AuthError } = require('../shopify/auth');
const { fromGraphql, normalizePhone } = require('../pathao/mapper');
const { assessOrder } = require('../fraud');
const { summarise, RANGES } = require('../stats');
const { PLANS, intervalFromSubscriptionName } = require('../plans');
const { DEFAULT_TEMPLATE, SOURCES } = require('../sms/sms');
const { listCouriers, AVAILABLE } = require('../couriers');

function makeApiRouter({ config, db, tokens, admin, pathao, steadfast = null, shipping, fulfillment = null, notifier, cipher, log = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));
  const webhooksChecked = new Set();

  // ---- auth middleware ----
  router.use(async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const payload = verifySessionToken(token, { apiKey: config.shopifyApiKey, apiSecret: config.shopifyApiSecret });
      req.shop = payload.shop;
      req.opts = { sessionToken: token };
      // Make sure we hold a valid offline token (does token exchange on first visit).
      await tokens.getAccessToken(req.shop, req.opts);
      next();
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 500;
      // Tell App Bridge to fetch a fresh session token and retry.
      if (status === 401) res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
      res.status(status).json({ error: e.message });
    }
  });

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      log.error(`[${req.shop}] ${req.method} ${req.path}: ${e.message}`);
      res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message });
    }
  };

  // Scopes this version needs. Stores that installed before an upgrade keep
  // their old token until they approve the new permissions in Shopify.
  const REQUIRED_SCOPES = ['write_orders', 'write_fulfillments', 'write_merchant_managed_fulfillment_orders'];
  function missingScopes(scope) {
    if (!scope) return { missing: [], known: false };
    const have = new Set(String(scope).split(',').map((x) => x.trim()));
    return { missing: REQUIRED_SCOPES.filter((x) => !have.has(x)), known: true };
  }

  // If the stored token predates newly approved scopes, swap it for a fresh one.
  async function currentPermissions(req) {
    let p = missingScopes((await db.getShop(req.shop))?.scope);
    if (p.missing.length && req.opts?.sessionToken) {
      try { await tokens.exchange(req.shop, req.opts.sessionToken); p = missingScopes((await db.getShop(req.shop))?.scope); } catch (e) { log.warn(`[${req.shop}] token refresh for scopes failed: ${e.message}`); }
    }
    // Once access is granted, catch up orders that couldn't be updated before.
    if (p.known && !p.missing.length && fulfillment) {
      const ids = await db.pendingShopifySync(req.shop);
      for (const id of ids) await fulfillment.sync(req.shop, id);
    }
    return p;
  }

  function publicSettings(s) {
    return {
      pathao_env: s.pathao_env,
      pathao_client_id: s.pathao_client_id || '',
      pathao_username: s.pathao_username || '',
      has_client_secret: Boolean(s.pathao_client_secret_enc),
      has_password: Boolean(s.pathao_password_enc),
      pathao_store_id: s.pathao_store_id,
      pathao_store_name: s.pathao_store_name || null,
      auto_send: s.auto_send,
      delivery_type: s.delivery_type,
      item_type: s.item_type,
      default_weight: Number(s.default_weight),
      skip_tag: s.skip_tag,
      only_cod: s.only_cod,
      tag_orders: s.tag_orders,
      hold_risky: s.hold_risky !== false,
      sync_fulfillment: s.sync_fulfillment !== false,
      fulfill_when: s.fulfill_when || 'booked',
      notify_customer: Boolean(s.notify_customer),
      default_note: s.default_note || '',
      default_courier: s.default_courier || 'pathao',
      connected: pathao.hasCredentials(s),
      steadfast: {
        api_key: s.steadfast_api_key || '',
        has_secret: Boolean(s.steadfast_secret_enc),
        connected: Boolean(s.steadfast_api_key && s.steadfast_secret_enc),
        auth_error: s.steadfast_auth_error || null,
      },
      sms: {
        available: Boolean(config.smsFeature),
        enabled: s.sms_enabled,
        configured: Boolean(s.sms_token_enc && s.sms_sid),
        has_token: Boolean(s.sms_token_enc),
        sid: s.sms_sid || '',
        source: s.sms_source || 'web',
        template: s.sms_template || DEFAULT_TEMPLATE,
        sources: Object.entries(SOURCES).map(([key, v]) => ({ key, label: v.label })),
      },
    };
  }

  async function syncPlan(shop, opts, { fresh = true } = {}) {
    try {
      const { plan, subscription } = await admin.activePlanCached(shop, opts, { fresh });
      await db.setPlan(shop, plan, subscription ? subscription.id : null);
      return { plan, subscription };
    } catch (e) {
      log.warn(`[${shop}] plan sync failed: ${e.message}`);
      const row = await db.getShop(shop);
      return { plan: (row && row.plan) || 'free', subscription: null };
    }
  }

  // ---- bootstrap: everything the UI needs on load ----
  router.get('/bootstrap', wrap(async (req) => {
    let settings = await db.getSettings(req.shop);
    if (!settings.webhook_secret || !settings.steadfast_webhook_token) {
      settings = await db.updateSettings(req.shop, {
        webhook_secret: settings.webhook_secret || crypto.randomBytes(16).toString('hex'),
        steadfast_webhook_token: settings.steadfast_webhook_token || crypto.randomBytes(24).toString('hex'),
      });
    }
    // Webhooks only need checking once per shop per server start, not on every page load.
    const webhookCheck = webhooksChecked.has(req.shop)
      ? Promise.resolve({ ok: true })
      : admin.ensureWebhooks(req.shop, req.opts).then(
        (created) => { webhooksChecked.add(req.shop); if (created.length) log.info(`[${req.shop}] registered webhooks: ${created.join(', ')}`); return { ok: true }; },
        (e) => { log.error(`[${req.shop}] webhook registration failed: ${e.message}`); return { ok: false, error: e.message }; }
      );
    const [{ plan, subscription }, webhooks] = await Promise.all([syncPlan(req.shop, req.opts, { fresh: req.query.fresh === '1' }), webhookCheck]);
    const [used, stats, permissions] = await Promise.all([db.countSentThisMonth(req.shop), db.monthStats(req.shop), currentPermissions(req)]);
    return {
      shop: req.shop,
      settings: publicSettings(settings),
      plan,
      trialEndsOrRenews: subscription ? subscription.currentPeriodEnd : null,
      usage: { used, limit: PLANS[plan].monthlyOrderLimit },
      stats,
      couriers: listCouriers(settings, { pathao }),
      plans: Object.values(PLANS),
      pathaoWebhook: { url: `${config.appUrl}/pathao/webhook/${req.shop}`, secret: settings.webhook_secret, lastAt: settings.pathao_webhook_at || null, live: Boolean(settings.webhook_secret && settings.pathao_webhook_at) },
      steadfastWebhook: { url: `${config.appUrl}/steadfast/webhook/${req.shop}`, token: settings.steadfast_webhook_token, lastAt: settings.steadfast_webhook_at || null, live: Boolean(settings.steadfast_webhook_at) },
      webhooks,
      permissions,
    };
  }));

  // ---- settings ----
  router.post('/settings', wrap(async (req) => {
    const b = req.body || {};
    const current = await db.getSettings(req.shop);
    const f = {};

    if (b.pathao_env !== undefined) f.pathao_env = b.pathao_env === 'sandbox' ? 'sandbox' : 'production';
    if (b.pathao_client_id !== undefined) f.pathao_client_id = String(b.pathao_client_id).trim() || null;
    if (b.pathao_username !== undefined) f.pathao_username = String(b.pathao_username).trim() || null;
    if (b.pathao_client_secret) f.pathao_client_secret_enc = cipher.encrypt(String(b.pathao_client_secret).trim());
    if (b.pathao_password) f.pathao_password_enc = cipher.encrypt(String(b.pathao_password));
    const credsChanged = ['pathao_env', 'pathao_client_id', 'pathao_username', 'pathao_client_secret_enc', 'pathao_password_enc']
      .some((k) => k in f && f[k] !== current[k]);
    if (credsChanged) Object.assign(f, { pathao_token_enc: null, pathao_refresh_enc: null, pathao_token_expires_at: null });

    // ---- Steadfast ----
    // Keys are saved through /steadfast/connect (checked with Steadfast first).
    if (b.steadfast_disconnect) {
      Object.assign(f, { steadfast_api_key: null, steadfast_secret_enc: null, steadfast_auth_error: null });
      // Don't leave auto-send pointing at a courier that can no longer book.
      if ((current.default_courier || 'pathao') === 'steadfast') Object.assign(f, { default_courier: 'pathao', auto_send: false });
    }
    if (b.steadfast_webhook_token !== undefined) {
      const w = String(b.steadfast_webhook_token).trim();
      if (w.length < 16 || w.length > 200 || /\s/.test(w)) throw Object.assign(new Error('Auth token must be 16–200 characters, without spaces'), { status: 400 });
      f.steadfast_webhook_token = w;
    }

    if (b.default_courier !== undefined) {
      if (!AVAILABLE.includes(b.default_courier)) throw Object.assign(new Error('That courier is not available yet'), { status: 400 });
      f.default_courier = b.default_courier;
    }
    if (b.pathao_store_id !== undefined) {
      const id = b.pathao_store_id === '' || b.pathao_store_id === null ? null : Number(b.pathao_store_id);
      if (id !== null && !Number.isInteger(id)) throw Object.assign(new Error('Please choose a valid Pathao store'), { status: 400 });
      f.pathao_store_id = id;
    }
    if (b.pathao_store_name !== undefined) f.pathao_store_name = b.pathao_store_name ? String(b.pathao_store_name).slice(0, 120) : null;
    if (b.delivery_type !== undefined) f.delivery_type = Number(b.delivery_type) === 12 ? 12 : 48;
    if (b.item_type !== undefined) f.item_type = Number(b.item_type) === 1 ? 1 : 2;
    if (b.default_weight !== undefined) {
      const w = Number(b.default_weight);
      if (!(w >= 0.5 && w <= 10)) throw Object.assign(new Error('Default weight must be between 0.5 and 10 kg'), { status: 400 });
      f.default_weight = w;
    }
    if (b.skip_tag !== undefined) f.skip_tag = String(b.skip_tag).trim().slice(0, 40);
    if (b.only_cod !== undefined) f.only_cod = Boolean(b.only_cod);
    if (b.tag_orders !== undefined) f.tag_orders = Boolean(b.tag_orders);
    if (b.hold_risky !== undefined) f.hold_risky = Boolean(b.hold_risky);
    if (b.sync_fulfillment !== undefined) f.sync_fulfillment = Boolean(b.sync_fulfillment);
    if (b.fulfill_when !== undefined) f.fulfill_when = b.fulfill_when === 'picked' ? 'picked' : 'booked';
    if (b.notify_customer !== undefined) f.notify_customer = Boolean(b.notify_customer);
    // ---- Pathao webhook secret (merchant can set their own) ----
    if (b.webhook_secret !== undefined) {
      const w = String(b.webhook_secret).trim();
      if (w.length < 8 || w.length > 100 || /\s/.test(w)) throw Object.assign(new Error('Secret key must be 8–100 characters, without spaces'), { status: 400 });
      f.webhook_secret = w;
    }
    if (b.default_note !== undefined) {
      const n = String(b.default_note).trim();
      if (n.length > 200) throw Object.assign(new Error('Default note is too long (max 200 characters)'), { status: 400 });
      if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(n)) throw Object.assign(new Error('Default note cannot contain emoji'), { status: 400 });
      f.default_note = n || null;
    }

    // ---- SMS ----
    if (b.sms_token) f.sms_token_enc = cipher.encrypt(String(b.sms_token).trim());
    if (b.sms_sid !== undefined) f.sms_sid = String(b.sms_sid).trim() || null;
    if (b.sms_source !== undefined) {
      if (!SOURCES[b.sms_source]) throw Object.assign(new Error('Unknown SMS order source'), { status: 400 });
      f.sms_source = b.sms_source;
    }
    if (b.sms_template !== undefined) {
      const t = String(b.sms_template).trim();
      if (t.length > 600) throw Object.assign(new Error('SMS message is too long (max 600 characters)'), { status: 400 });
      f.sms_template = t || null;
    }
    if (b.sms_enabled !== undefined) {
      if (b.sms_enabled && !config.smsFeature) throw Object.assign(new Error('SMS notifications are coming soon'), { status: 400 });
      f.sms_enabled = Boolean(b.sms_enabled);
      const hasToken = f.sms_token_enc || current.sms_token_enc;
      const hasSid = f.sms_sid !== undefined ? f.sms_sid : current.sms_sid;
      if (f.sms_enabled && !(hasToken && hasSid)) {
        throw Object.assign(new Error('Add your SSL Wireless API token and SID before turning SMS on'), { status: 400 });
      }
      if (f.sms_enabled && !current.sms_enabled) f.sms_since = new Date();
    }

    if (b.auto_send !== undefined) {
      f.auto_send = Boolean(b.auto_send);
      // Only orders created after auto-send is switched on get sent automatically
      // (replaces the old "server start" cutoff, so redeploys never resend old orders).
      if (f.auto_send && !current.auto_send) f.auto_send_since = new Date();
    }
    // Auto-send books with the default courier, so that courier has to be ready.
    {
      const next = { ...current, ...f };
      const def = next.default_courier || 'pathao';
      if (def === 'steadfast' && !(next.steadfast_api_key && next.steadfast_secret_enc)) {
        if (b.default_courier !== undefined) throw Object.assign(new Error('Connect Steadfast before making it your default courier'), { status: 400 });
        if (f.auto_send) throw Object.assign(new Error('Connect Steadfast before turning on auto-send'), { status: 400 });
      }
      if (def === 'pathao' && f.auto_send && !next.pathao_store_id) {
        throw Object.assign(new Error('Choose a Pathao store before turning on auto-send'), { status: 400 });
      }
    }

    const saved = await db.updateSettings(req.shop, f);
    return { settings: publicSettings(saved), couriers: listCouriers(saved, { pathao }) };
  }));

  // ---- Pathao connection test + store list ----
  router.post('/pathao/test', wrap(async (req) => {
    const settings = await db.getSettings(req.shop);
    try {
      await pathao.token(settings, { force: true });
      const stores = await pathao.listStores(await db.getSettings(req.shop));
      return { ok: true, stores };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }));

  // ---- Steadfast: check keys with Steadfast first, save only if they work ----
  router.post('/steadfast/connect', wrap(async (req) => {
    if (!steadfast) throw new Error('Steadfast is not available');
    const b = req.body || {};
    const current = await db.getSettings(req.shop);
    const apiKey = String(b.api_key || '').trim();
    const secret = String(b.secret_key || '').trim();
    if (!apiKey) throw Object.assign(new Error('Enter your Steadfast API key'), { status: 400 });
    if (/\s/.test(apiKey) || /\s/.test(secret)) throw Object.assign(new Error('Keys cannot contain spaces. Copy them again from the Steadfast portal.'), { status: 400 });
    const secretEnc = secret ? cipher.encrypt(secret) : current.steadfast_secret_enc;
    if (!secretEnc) throw Object.assign(new Error('Enter your Steadfast secret key'), { status: 400 });
    const trial = { ...current, steadfast_api_key: apiKey, steadfast_secret_enc: secretEnc };
    let balance;
    try {
      ({ balance } = await steadfast.balance(trial, { probe: true }));
    } catch (e) {
      log.warn(`[${req.shop}] steadfast connect failed: ${e.message}`);
      throw Object.assign(new Error(e.message), { status: 400 });
    }
    const saved = await db.updateSettings(req.shop, { steadfast_api_key: apiKey, steadfast_secret_enc: secretEnc, steadfast_auth_error: null });
    log.info(`[${req.shop}] steadfast connected`);
    return { ok: true, balance, settings: publicSettings(saved), couriers: listCouriers(saved, { pathao }) };
  }));

  // ---- Steadfast balance (also re-checks saved keys) ----
  router.post('/steadfast/test', wrap(async (req) => {
    try {
      if (!steadfast) throw new Error('Steadfast is not available');
      const settings = await db.getSettings(req.shop);
      if (settings.steadfast_auth_error) return { ok: false, error: settings.steadfast_auth_error };
      const { balance } = await steadfast.balance(settings);
      return { ok: true, balance };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }));

  // ---- orders ----
  router.get('/stats', wrap(async (req) => {
    const range = RANGES.includes(req.query.range) ? req.query.range : 'month';
    // Date picker: from/to are ISO timestamps from the merchant's browser (their own midnight).
    const date = (v) => { const d = v ? new Date(String(v)) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
    const from = date(req.query.from), to = date(req.query.to);
    if (from && to && from >= to) throw Object.assign(new Error('The start date must be before the end date'), { status: 400 });
    return summarise(await db.shipmentsForStats(req.shop), { range, from, to });
  }));

  router.get('/orders', wrap(async (req) => {
    const orders = await admin.listRecentOrdersCached(req.shop, req.opts, 50, { rich: true, fresh: req.query.fresh === '1' });
    const norm = orders.map(fromGraphql);
    const phoneOf = (n) => [n.shipping.phone, ...n.fallbackPhones].filter(Boolean).map(normalizePhone).find((p) => p.valid)?.phone || null;
    const phones = norm.map(phoneOf);
    const history = await db.historyForPhones(req.shop, phones);
    const ids = orders.map((o) => String(o.legacyResourceId));
    const [shipments, smsRows, notes] = await Promise.all([db.shipmentsForOrders(req.shop, ids), db.smsForOrders(req.shop, ids), db.notesForOrders(req.shop, ids)]);
    const byId = new Map(shipments.map((s) => [s.shopify_order_id, s]));
    const noteById = new Map(notes.map((n) => [n.shopify_order_id, n.note]));
    const smsById = new Map(smsRows.map((s) => [s.shopify_order_id, s]));
    return {
      orders: orders.map((o, idx) => {
        const n = norm[idx];
        const s = byId.get(n.id);
        const phone = phones[idx];
        const day = 24 * 3600 * 1000;
        const fraud = assessOrder(n, {
          history: phone ? history.filter((h) => h.phone === phone && h.shopify_order_id !== n.id) : [],
          duplicates: phone ? norm.filter((m, j) => j !== idx && phones[j] === phone && !m.cancelled
            && Math.abs(new Date(m.createdAt) - new Date(n.createdAt)) < day) : [],
        });
        return {
          id: n.id,
          name: n.name,
          createdAt: n.createdAt,
          customer: n.shipping.name || n.fallbackName || '',
          phone: n.shipping.phone || n.fallbackPhones.find(Boolean) || '',
          city: n.shipping.city || '',
          address: [n.shipping.address1, n.shipping.address2, n.shipping.city].filter(Boolean).join(', '),
          phoneNormalized: phone,
          total: n.total,
          currency: o.totalPriceSet?.shopMoney?.currencyCode || '',
          cod: n.outstanding != null ? n.outstanding : n.paid ? 0 : n.total,
          financial: o.displayFinancialStatus || null,
          fulfillment: o.displayFulfillmentStatus || null,
          items: n.items.map((i) => `${i.title} x${i.quantity}`).join(', '),
          itemCount: n.items.reduce((t, i) => t + i.quantity, 0),
          products: n.items.slice(0, 4).map((i) => ({ title: i.title, quantity: i.quantity, image: i.image })),
          fraud,
          cancelled: n.cancelled,
          source: n.source || null,
          note: noteById.get(n.id) || null,
          sms: smsById.has(n.id) ? { status: smsById.get(n.id).status, error: smsById.get(n.id).error } : null,
          shipment: s ? {
            status: s.status, courier: s.courier || 'pathao', consignmentId: s.consignment_id, trackingCode: s.tracking_code || null, pathaoStatus: s.pathao_status,
            courierMessage: s.courier_message || null, courierMessageAt: s.courier_message_at || null,
            error: s.error, deliveryFee: s.delivery_fee == null ? null : Number(s.delivery_fee), updatedAt: s.updated_at,
            shopifySynced: Boolean(s.shopify_fulfillment_id), shopifyEvent: s.shopify_event || null, syncError: s.sync_error || null,
          } : null,
        };
      }),
    };
  }));

  router.post('/orders/send', wrap(async (req) => {
    const ids = [...new Set((req.body?.ids || []).map(String))].filter((id) => /^\d+$/.test(id)).slice(0, 50);
    if (!ids.length) throw Object.assign(new Error('No orders selected'), { status: 400 });
    const courier = req.body?.courier || (await db.getSettings(req.shop)).default_courier || 'pathao';
    if (!AVAILABLE.includes(courier)) throw Object.assign(new Error(`${courier} is not available yet`), { status: 400 });
    const settings = await db.getSettings(req.shop);
    if (courier === 'pathao' && !pathao.hasCredentials(settings)) throw Object.assign(new Error('Connect your Pathao account in Couriers first'), { status: 400 });
    if (courier === 'steadfast' && !(steadfast && steadfast.hasCredentials(settings))) throw Object.assign(new Error('Connect your Steadfast account in Couriers first'), { status: 400 });

    const results = [];
    for (const id of ids) {
      try {
        const o = await admin.getOrder(req.shop, id, req.opts);
        if (!o) { results.push({ id, ok: false, error: 'Order not found' }); continue; }
        const r = await shipping.sendOrder(req.shop, fromGraphql(o), { courier });
        results.push({ id, ok: r.ok, duplicate: Boolean(r.duplicate), error: r.shipment?.error || null, consignmentId: r.shipment?.consignment_id || null });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    admin.forgetOrders(req.shop);
    return { results };
  }));

  // Merchant's own note on an order (shown on hold orders). Empty text removes it.
  router.post('/orders/:id/note', wrap(async (req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('Unknown order'), { status: 400 });
    const note = String(req.body?.note || '').trim();
    if (note.length > 500) throw Object.assign(new Error('Note is too long (max 500 characters)'), { status: 400 });
    await db.setNote(req.shop, req.params.id, note || null);
    return { note: note || null };
  }));

  router.post('/orders/:id/refresh', wrap(async (req) => {
    const s = await db.getShipment(req.shop, req.params.id);
    if (!s || !s.consignment_id) throw Object.assign(new Error('Order has not been sent to a courier'), { status: 404 });
    const settings = await db.getSettings(req.shop);
    let status;
    if (s.courier === 'steadfast') {
      status = (await steadfast.statusByCid(settings, s.consignment_id)).status || s.pathao_status;
    } else {
      const info = await pathao.orderInfo(settings, s.consignment_id);
      status = info.order_status_slug || info.order_status || s.pathao_status;
    }
    await db.finishShipment(req.shop, req.params.id, { pathao_status: status });
    if (fulfillment) await fulfillment.sync(req.shop, req.params.id, { status });
    admin.forgetOrders(req.shop);
    return { pathaoStatus: status };
  }));

  // ---- SMS log ----
  router.get('/sms/log', wrap(async (req) => ({
    items: (await db.listSms(req.shop, 50)).map((r) => ({
      orderId: r.shopify_order_id, orderName: r.order_name, status: r.status, error: r.error,
      phone: r.phone ? r.phone.replace(/^(\d{5})\d{4}(\d{4})$/, '$1••••$2') : null, at: r.updated_at || r.created_at,
    })),
  })));

  // ---- SMS test ----
  router.post('/sms/test', wrap(async (req) => notifier.sendTest(req.shop, req.body?.phone)));

  // ---- billing ----
  router.get('/billing', wrap(async (req) => {
    const [{ plan, subscription }, used, history] = await Promise.all([
      syncPlan(req.shop, req.opts),
      db.countSentThisMonth(req.shop),
      admin.billingHistory(req.shop, req.opts).catch((e) => { log.warn(`[${req.shop}] billing history failed: ${e.message}`); return []; }),
    ]);
    const handle = req.shop.replace('.myshopify.com', '');
    return {
      plan,
      interval: subscription ? intervalFromSubscriptionName(subscription.name) : null,
      subscription: subscription ? { name: subscription.name, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd, trialDays: subscription.trialDays, test: subscription.test } : null,
      usage: { used, limit: PLANS[plan].monthlyOrderLimit },
      plans: Object.values(PLANS),
      history,
      shopifyBillingUrl: `https://admin.shopify.com/store/${handle}/settings/billing`,
      testMode: Boolean(config.billingTest),
    };
  }));

  router.post('/billing/subscribe', wrap(async (req) => {
    const plan = req.body?.plan;
    const interval = req.body?.interval === 'yearly' ? 'yearly' : 'monthly';
    if (!PLANS[plan] || PLANS[plan].price <= 0) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    admin.forgetPlan(req.shop); // merchant comes back from Shopify's approve page: re-check the plan
    return { confirmationUrl: await admin.createSubscription(req.shop, plan, req.opts, interval) };
  }));

  // ---- support ----
  const TOPICS = ['setup', 'orders', 'delivery', 'billing', 'other'];
  router.get('/support', wrap(async (req) => ({
    tickets: (await db.listTickets(req.shop)).map((t) => ({ id: t.id, topic: t.topic, message: t.message, orderName: t.order_name, status: t.status, createdAt: t.created_at })),
    contact: { email: config.supportEmail || null, whatsapp: config.supportWhatsapp || null },
  })));
  router.post('/support', wrap(async (req) => {
    const b = req.body || {};
    const email = String(b.email || '').trim();
    const message = String(b.message || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw Object.assign(new Error('Enter a valid email so we can reply'), { status: 400 });
    if (message.length < 10) throw Object.assign(new Error('Tell us a little more (at least 10 characters)'), { status: 400 });
    const topic = TOPICS.includes(b.topic) ? b.topic : 'other';
    const t = await db.createTicket(req.shop, { email, topic, message: message.slice(0, 4000), orderName: b.order_name ? String(b.order_name).slice(0, 40) : null });
    log.info(`[${req.shop}] support ticket #${t.id} (${topic})`);
    return { id: t.id };
  }));

  router.post('/billing/cancel', wrap(async (req) => {
    const { subscription } = await syncPlan(req.shop, req.opts);
    if (subscription) await admin.cancelSubscription(req.shop, subscription.id, req.opts);
    await db.setPlan(req.shop, 'free', null);
    admin.forgetPlan(req.shop);
    return { plan: 'free' };
  }));

  return router;
}

module.exports = { makeApiRouter };
