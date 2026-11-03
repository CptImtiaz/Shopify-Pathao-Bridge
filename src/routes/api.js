// JSON API used by the embedded admin UI. Every request carries an App Bridge
// session token (App Bridge adds `Authorization: Bearer <token>` to fetch()
// calls automatically), so no cookies are needed.

const crypto = require('crypto');
const express = require('express');
const { verifySessionToken, AuthError } = require('../shopify/auth');
const { fromGraphql } = require('../pathao/mapper');
const { PLANS } = require('../plans');
const { DEFAULT_TEMPLATE, SOURCES } = require('../sms/sms');
const { listCouriers, AVAILABLE } = require('../couriers');

function makeApiRouter({ config, db, tokens, admin, pathao, shipping, notifier, cipher, log = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));

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
      default_note: s.default_note || '',
      default_courier: s.default_courier || 'pathao',
      connected: pathao.hasCredentials(s),
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

  async function syncPlan(shop, opts) {
    try {
      const { plan, subscription } = await admin.activePlan(shop, opts);
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
    if (!settings.webhook_secret) {
      settings = await db.updateSettings(req.shop, { webhook_secret: crypto.randomBytes(16).toString('hex') });
    }
    const [{ plan, subscription }, webhooks] = await Promise.all([
      syncPlan(req.shop, req.opts),
      admin.ensureWebhooks(req.shop, req.opts).then(
        (created) => { if (created.length) log.info(`[${req.shop}] registered webhooks: ${created.join(', ')}`); return { ok: true }; },
        (e) => { log.error(`[${req.shop}] webhook registration failed: ${e.message}`); return { ok: false, error: e.message }; }
      ),
    ]);
    const [used, stats] = await Promise.all([db.countSentThisMonth(req.shop), db.monthStats(req.shop)]);
    return {
      shop: req.shop,
      settings: publicSettings(settings),
      plan,
      trialEndsOrRenews: subscription ? subscription.currentPeriodEnd : null,
      usage: { used, limit: PLANS[plan].monthlyOrderLimit },
      stats,
      couriers: listCouriers(settings, { pathao }),
      plans: Object.values(PLANS),
      pathaoWebhook: { url: `${config.appUrl}/pathao/webhook/${req.shop}`, secret: settings.webhook_secret },
      webhooks,
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
      if (f.auto_send && !(f.pathao_store_id || current.pathao_store_id)) {
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

  // ---- orders ----
  router.get('/orders', wrap(async (req) => {
    const orders = await admin.listRecentOrders(req.shop, req.opts, 50);
    const ids = orders.map((o) => String(o.legacyResourceId));
    const [shipments, smsRows] = await Promise.all([db.shipmentsForOrders(req.shop, ids), db.smsForOrders(req.shop, ids)]);
    const byId = new Map(shipments.map((s) => [s.shopify_order_id, s]));
    const smsById = new Map(smsRows.map((s) => [s.shopify_order_id, s]));
    return {
      orders: orders.map((o) => {
        const n = fromGraphql(o);
        const s = byId.get(n.id);
        return {
          id: n.id,
          name: n.name,
          createdAt: n.createdAt,
          customer: n.shipping.name || n.fallbackName || '',
          phone: n.shipping.phone || n.fallbackPhones.find(Boolean) || '',
          city: n.shipping.city || '',
          total: n.total,
          currency: o.totalPriceSet?.shopMoney?.currencyCode || '',
          cod: n.outstanding != null ? n.outstanding : n.paid ? 0 : n.total,
          financial: o.displayFinancialStatus || null,
          fulfillment: o.displayFulfillmentStatus || null,
          items: n.items.map((i) => `${i.title} x${i.quantity}`).join(', '),
          itemCount: n.items.reduce((t, i) => t + i.quantity, 0),
          cancelled: n.cancelled,
          sms: smsById.has(n.id) ? { status: smsById.get(n.id).status, error: smsById.get(n.id).error } : null,
          shipment: s ? {
            status: s.status, courier: s.courier || 'pathao', consignmentId: s.consignment_id, pathaoStatus: s.pathao_status,
            error: s.error, deliveryFee: s.delivery_fee == null ? null : Number(s.delivery_fee),
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
    if (!pathao.hasCredentials(settings)) throw Object.assign(new Error('Connect your Pathao account in Settings first'), { status: 400 });

    const results = [];
    for (const id of ids) {
      try {
        const o = await admin.getOrder(req.shop, id, req.opts);
        if (!o) { results.push({ id, ok: false, error: 'Order not found' }); continue; }
        const r = await shipping.sendOrder(req.shop, fromGraphql(o));
        results.push({ id, ok: r.ok, duplicate: Boolean(r.duplicate), error: r.shipment?.error || null, consignmentId: r.shipment?.consignment_id || null });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    return { results };
  }));

  router.post('/orders/:id/refresh', wrap(async (req) => {
    const s = await db.getShipment(req.shop, req.params.id);
    if (!s || !s.consignment_id) throw Object.assign(new Error('Order has not been sent to Pathao'), { status: 404 });
    const info = await pathao.orderInfo(await db.getSettings(req.shop), s.consignment_id);
    const status = info.order_status_slug || info.order_status || s.pathao_status;
    await db.finishShipment(req.shop, req.params.id, { pathao_status: status });
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
  router.post('/billing/subscribe', wrap(async (req) => {
    const plan = req.body?.plan;
    if (!PLANS[plan] || PLANS[plan].price <= 0) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    return { confirmationUrl: await admin.createSubscription(req.shop, plan, req.opts) };
  }));

  router.post('/billing/cancel', wrap(async (req) => {
    const { subscription } = await syncPlan(req.shop, req.opts);
    if (subscription) await admin.cancelSubscription(req.shop, subscription.id, req.opts);
    await db.setPlan(req.shop, 'free', null);
    return { plan: 'free' };
  }));

  return router;
}

module.exports = { makeApiRouter };
