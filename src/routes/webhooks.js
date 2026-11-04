// Shopify webhooks (orders, uninstall, billing, mandatory privacy webhooks)
// and the Pathao delivery-status webhook.

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
function makeWebhookRouter({ config, db, admin, shipping, fulfillment = null, notifier, log = console, defer = (p) => p }) {
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
      const reason = autoSendSkipReason(order, settings);
      if (reason) {
        if (settings.auto_send && reason !== 'Order was created before auto-send was turned on') {
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
    if (!settings.webhook_secret || !safeEqual(sig, settings.webhook_secret)) return res.status(401).send('Bad signature');

    const body = req.body || {};
    const event = String(body.event || '');
    await db.updateSettings(shop, { pathao_webhook_at: new Date() }).catch(() => {});
    if (event === 'webhook_integration' || !body.consignment_id) return res.status(202).send('OK');

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

  return router;
}

module.exports = { makeWebhookRouter, PATHAO_INTEGRATION_HEADER };
