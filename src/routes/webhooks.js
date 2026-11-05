// Shopify webhooks (orders, uninstall, billing, mandatory privacy webhooks)
// and the Pathao and Steadfast delivery-status webhooks.

const crypto = require('crypto');
const express = require('express');
const { verifyWebhookHmac, isValidShop } = require('../shopify/auth');
const { safeEqual } = require('../crypto');
const { fromWebhook, autoSendSkipReason, normalizePhone } = require('../pathao/mapper');
const { assessOrder } = require('../fraud');
const { planFromSubscriptionName } = require('../plans');

// Pathao's webhook setup check expects this header on a 202 response.
// Confirm the current value in Pathao's merchant API docs.
const PATHAO_INTEGRATION_HEADER = 'X-Pathao-Merchant-Webhook-Integration-Secret';

// `defer` lets background work run after the response is sent. On an
// always-on server it just lets the promise run.
// Steadfast delivery statuses (their guide). Other events (cancel_request, pickup_request...)
// have their own "status" values that must not be mistaken for a parcel status.
const STEADFAST_DELIVERY_STATUSES = new Set([
  'pending', 'in_review', 'hold', 'delivered_approval_pending', 'partial_delivered_approval_pending',
  'cancelled_approval_pending', 'unknown_approval_pending', 'delivered', 'partial_delivered', 'cancelled',
  'exceptional', 'unknown',
  'partial_delivered_return_proccessing', 'partial_delivered_return_rider_assigned', 'partial_delivered_return_received',
  'cancelled_return_proccessing', 'cancelled_return_rider_assigned', 'cancelled_return_received',
]);

function makeWebhookRouter({ config, db, admin, shipping, fulfillment = null, steadfast = null, notifier, log = console, defer = (p) => p }) {
  const router = express.Router();
  const raw = express.raw({ type: '*/*', limit: '2mb' });

  // Verify HMAC, ack immediately (Shopify wants a fast 200), then work.
  function shopifyWebhook(handler) {
    return [raw, (req, res) => {
      const rawBody = req.body;
      const ok = Buffer.isBuffer(rawBody) && verifyWebhookHmac(rawBody, req.get('X-Shopify-Hmac-Sha256'), config.shopifyApiSecret);
      if (!ok) return res.status(401).send('Invalid HMAC');
      const shop = req.get('X-Shopify-Shop-Domain');
      if (!isValidShop(shop)) return res.status(400).send('Bad shop');
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).send('Bad JSON'); }
      const topic = req.get('X-Shopify-Topic');
      res.status(200).send('OK');
      defer(Promise.resolve()
        .then(() => handler({ shop, topic, payload }))
        .catch((e) => log.error(`[${shop}] webhook ${topic} failed: ${e.stack || e.message}`)));
    }];
  }

  router.post('/webhooks/orders/create', ...shopifyWebhook(async ({ shop, payload }) => {
    if (admin.forgetOrders) admin.forgetOrders(shop);
    const row = await db.getShop(shop);
    if (!row || row.uninstalled_at) return;

    // Pathao booking and confirmation SMS run independently: one failing
    // never stops the other.
    const pathaoJob = (async () => {
      const settings = await db.getSettings(shop);
      const order = fromWebhook(payload);
      let reason = autoSendSkipReason(order, settings);
      if (!reason) {
        const def = settings.default_courier || 'pathao';
        const ready = def === 'steadfast'
          ? Boolean(settings.steadfast_api_key && settings.steadfast_secret_enc && !settings.steadfast_auth_error)
          : Boolean(settings.pathao_client_id && settings.pathao_client_secret_enc && settings.pathao_username && settings.pathao_password_enc && settings.pathao_store_id);
        if (!ready) reason = `Auto-send: ${def === 'steadfast' ? 'Steadfast' : 'Pathao'} (your default courier) is not connected`;
      }
      if (reason) {
        if (settings.auto_send && reason !== 'Order was created before auto-send was turned on') {
          // ("Held: ..." reasons put the order in the dashboard's Hold tab.)
          await db.recordSkip(shop, order.id, order.name, reason);
        }
        return;
      }
      // Hold high-risk orders for the merchant instead of booking them.
      if (settings.hold_risky) {
        const phone = [order.shipping.phone, ...order.fallbackPhones].filter(Boolean).map(normalizePhone).find((p) => p.valid)?.phone;
        const history = phone ? (await db.historyForPhones(shop, [phone])).filter((h) => h.shopify_order_id !== order.id) : [];
        const day = Date.now() - 24 * 3600 * 1000;
        const fraud = assessOrder(order, { history, duplicates: history.filter((h) => h.created_at && new Date(h.created_at).getTime() > day) });
        if (fraud.level === 'high') {
          const why = (fraud.reasons.find((r) => r.level === 'high') || fraud.reasons[0] || {}).text || 'high fraud risk';
          await db.recordSkip(shop, order.id, order.name, `Held for review: ${why}`);
          return;
        }
      }
      await shipping.sendOrder(shop, order);
    })();
    const smsJob = notifier ? notifier.onOrderCreated(shop, payload) : Promise.resolve();

    const results = await Promise.allSettled([pathaoJob, smsJob]);
    results.filter((r) => r.status === 'rejected')
      .forEach((r) => log.error(`[${shop}] orders/create job failed: ${r.reason && r.reason.message}`));
    if (admin.forgetOrders) admin.forgetOrders(shop); // auto-send result is in: redraw
  }));

  // Order changed in Shopify (paid, edited, cancelled...): redraw open dashboards.
  router.post('/webhooks/orders/updated', ...shopifyWebhook(async ({ shop }) => {
    if (admin.forgetOrders) admin.forgetOrders(shop);
  }));

  router.post('/webhooks/app/uninstalled', ...shopifyWebhook(async ({ shop }) => {
    await db.markUninstalled(shop);
    log.info(`[${shop}] uninstalled`);
  }));

  router.post('/webhooks/app_subscriptions/update', ...shopifyWebhook(async ({ shop, payload }) => {
    if (admin.forgetPlan) admin.forgetPlan(shop);
    const sub = payload.app_subscription || {};
    const id = sub.admin_graphql_api_id;
    const status = String(sub.status || '').toUpperCase();
    if (status === 'ACTIVE') {
      await db.setPlan(shop, planFromSubscriptionName(sub.name), id);
    } else {
      const row = await db.getShop(shop);
      if (row && row.subscription_id === id) await db.setPlan(shop, 'free', null);
    }
  }));

  // Mandatory privacy (GDPR) webhooks. Configured as compliance_topics in shopify.app.toml.
  router.post('/webhooks/compliance', ...shopifyWebhook(async ({ shop, topic, payload }) => {
    if (topic === 'customers/data_request') {
      // We store no customer personal data (only order IDs, order names and
      // Pathao consignment IDs), so there is nothing to export beyond those.
      log.info(`[${shop}] customers/data_request received for orders ${JSON.stringify(payload.orders_requested || [])}`);
    } else if (topic === 'customers/redact') {
      await db.redactOrders(shop, (payload.orders_to_redact || []).map(String));
    } else if (topic === 'shop/redact') {
      await db.deleteShopData(shop);
    }
  }));

  // Pathao -> us: delivery status updates. Merchant pastes this URL and the
  // secret shown in the app into Pathao Merchant Panel > Developers > Webhooks.
  router.post('/pathao/webhook/:shop', express.json({ limit: '1mb' }), async (req, res) => {
    const shop = req.params.shop;
    // Echo Pathao's verification challenge if it sends one, else use the configured value.
    const challenge = req.get(PATHAO_INTEGRATION_HEADER) || (req.body && req.body.integration_secret) || config.pathaoIntegrationSecret;
    res.set(PATHAO_INTEGRATION_HEADER, String(challenge));
    if (!isValidShop(shop)) return res.status(404).send('Unknown shop');
    const settings = await db.getSettings(shop);
    const sig = req.get('X-PATHAO-Signature') || '';
    if (!settings.webhook_secret || !safeEqual(sig, settings.webhook_secret)) {
      // Pathao reached this store's address with a different secret: show it on the Couriers page.
      log.warn(`[${shop}] pathao webhook refused: secret does not match`);
      await db.updateSettings(shop, { pathao_webhook_error_at: new Date() }).catch(() => {});
      if (admin.forgetOrders) admin.forgetOrders(shop, 'courier');
      return res.status(401).send('Bad signature');
    }

    const body = req.body || {};
    const event = String(body.event || '');
    await db.updateSettings(shop, { pathao_webhook_at: new Date(), pathao_webhook_error_at: null }).catch(() => {});
    if (event === 'webhook_integration' || !body.consignment_id) { if (admin.forgetOrders) admin.forgetOrders(shop, 'courier'); return res.status(202).send('OK'); }

    const shipment = await db.findShipmentByConsignment(shop, body.consignment_id);
    if (shipment) {
      const status = event.replace(/^order\./, '') || 'updated';
      await db.finishShipment(shop, shipment.shopify_order_id, { pathao_status: status });
      res.status(202).send('OK');
      // Update Shopify after acknowledging Pathao.
      defer((async () => {
        if (fulfillment) await fulfillment.sync(shop, shipment.shopify_order_id, { status });
        if (admin.forgetOrders) admin.forgetOrders(shop);
        if (settings.tag_orders && ['delivered', 'returned', 'delivery-failed'].includes(status)) {
          await admin.annotateOrder(shop, shipment.shopify_order_id, { tags: [`pathao-${status}`] })
            .catch((e) => log.warn(`[${shop}] tag failed: ${e.message}`));
        }
      })().catch((e) => log.error(`[${shop}] pathao webhook follow-up failed: ${e.message}`)));
      return undefined;
    }
    return res.status(202).send('OK');
  });

  // Steadfast -> us: delivery status updates. The merchant pastes this URL and
  // the auth token shown in the app into Steadfast's webhook settings. Steadfast
  // sends `Authorization: Bearer <token>` and `X-Signature` = HMAC-SHA256(raw body, token).
  router.post('/steadfast/webhook/:shop', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const shop = req.params.shop;
    if (!isValidShop(shop)) return res.status(404).json({ status: 'error', message: 'Unknown shop' });
    const settings = await db.getSettings(shop);
    const token = settings.steadfast_webhook_token;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const sig = String(req.get('X-Signature') || '');
    const bearer = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const expected = token ? crypto.createHmac('sha256', token).update(raw).digest('hex') : '';
    const sigOk = Boolean(token && sig && safeEqual(sig.toLowerCase(), expected));
    const bearerOk = Boolean(token && bearer && safeEqual(bearer, token));
    // A signature, when sent, must match; otherwise the bearer token must.
    if (!token || (sig ? !sigOk : !bearerOk)) {
      // Steadfast reached this store's address with a different auth token: show it on the Couriers page.
      log.warn(`[${shop}] steadfast webhook refused: auth token does not match`);
      await db.updateSettings(shop, { steadfast_webhook_error_at: new Date() }).catch(() => {});
      if (admin.forgetOrders) admin.forgetOrders(shop, 'courier');
      return res.status(401).json({ status: 'error', message: 'Bad signature' });
    }

    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ status: 'error', message: 'Invalid JSON' }); }
    await db.updateSettings(shop, { steadfast_webhook_at: new Date(), steadfast_webhook_error_at: null }).catch(() => {});

    // Every event is logged (no customer data), so a missing update can always be traced.
    const type = String(body.notification_type || 'unknown');
    const cid = body.consignment_id != null ? String(body.consignment_id) : '';
    const shipment = cid ? await db.findShipmentByConsignment(shop, cid)
      : body.invoice ? await db.findShipmentByInvoice(shop, body.invoice) : null;
    const given = body.status != null && body.status !== '' ? String(body.status).toLowerCase().trim() : null;
    let status = given && STEADFAST_DELIVERY_STATUSES.has(given) && type !== 'cancel_request' ? given : null;
    let message = String(body.tracking_message || body.message || '').trim().slice(0, 300) || null;
    if (type === 'cancel_request') {
      // Raised: Steadfast is reviewing it. Approved: the parcel is cancelled (and comes back).
      const decided = /approv|accept|confirm|done|complete|cancelled/.test(given || '');
      const refused = /reject|declin|denied/.test(given || '');
      if (decided) status = 'cancelled';
      message = message || (decided ? 'Cancellation approved by Steadfast' : refused ? 'Cancellation request rejected by Steadfast' : 'Cancellation requested · waiting for Steadfast');
    }
    log.info(`[${shop}] steadfast webhook: ${type} cid=${cid || '-'} invoice=${body.invoice || '-'} status=${given || '-'}${status && status !== given ? `->${status}` : ''} order=${shipment ? shipment.order_name : 'not found'}`);
    // Parcel events (delivery_status, tracking_update, consignment_update...) carry a status and/or a message.
    if (!shipment || (!status && !message)) { if (admin.forgetOrders) admin.forgetOrders(shop, 'courier'); return res.json({ status: 'success' }); }

    const fields = {};
    if (status) fields.pathao_status = status; // courier status column (see CLAUDE.md)
    if (message) Object.assign(fields, { courier_message: message, courier_message_at: new Date() });
    if (body.delivery_charge != null && Number.isFinite(Number(body.delivery_charge))) fields.delivery_fee = Number(body.delivery_charge);
    await db.finishShipment(shop, shipment.shopify_order_id, fields);
    res.json({ status: 'success' });
    if (!status) { if (admin.forgetOrders) admin.forgetOrders(shop); return undefined; }

    // Update Shopify after acknowledging Steadfast.
    defer((async () => {
      if (fulfillment) await fulfillment.sync(shop, shipment.shopify_order_id, { status });
      if (admin.forgetOrders) admin.forgetOrders(shop);
      if (settings.tag_orders && ['delivered', 'partial_delivered', 'cancelled'].includes(status)) {
        await admin.annotateOrder(shop, shipment.shopify_order_id, { tags: [`steadfast-${status.replace(/_/g, '-')}`] })
          .catch((e) => log.warn(`[${shop}] tag failed: ${e.message}`));
      }
    })().catch((e) => log.error(`[${shop}] steadfast webhook follow-up failed: ${e.message}`)));
    return undefined;
  });

  return router;
}

module.exports = { makeWebhookRouter, PATHAO_INTEGRATION_HEADER };
