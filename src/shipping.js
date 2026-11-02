// The core job: take one Shopify order and book it with Pathao, exactly once.

const { PLANS } = require('./plans');
const { buildPathaoOrder } = require('./pathao/mapper');

function makeShipping({ db, pathao, admin, log = console }) {
  async function limitReached(shop) {
    const row = await db.getShop(shop);
    const plan = PLANS[(row && row.plan) || 'free'] || PLANS.free;
    if (!plan.monthlyOrderLimit) return null;
    const used = await db.countSentThisMonth(shop);
    return used >= plan.monthlyOrderLimit
      ? `Monthly limit reached on the ${plan.name} plan (${plan.monthlyOrderLimit} orders). Upgrade to keep sending.`
      : null;
  }

  // `order` is a normalised order from mapper.fromWebhook / fromGraphql.
  async function sendOrder(shop, order) {
    const settings = await db.getSettings(shop);

    const claimed = await db.claimShipment(shop, order.id, order.name);
    if (!claimed) {
      const existing = await db.getShipment(shop, order.id);
      return { ok: false, duplicate: true, shipment: existing };
    }

    const fail = async (status, error) => {
      const shipment = await db.finishShipment(shop, order.id, { status, error, order_name: order.name });
      return { ok: false, shipment };
    };

    try {
      if (order.cancelled) return await fail('skipped', 'Order is cancelled');

      const limitMsg = await limitReached(shop);
      if (limitMsg) return await fail('skipped', limitMsg);

      const { payload, errors } = buildPathaoOrder(order, settings);
      if (errors.length) return await fail('failed', errors.join('. '));

      const result = await pathao.createOrder(settings, payload);
      const shipment = await db.finishShipment(shop, order.id, {
        status: 'sent',
        consignment_id: result.consignmentId ? String(result.consignmentId) : null,
        pathao_status: result.status,
        delivery_fee: result.deliveryFee,
        amount_to_collect: payload.amount_to_collect,
        error: null,
        counted: true,
      });

      if (settings.tag_orders) {
        admin
          .annotateOrder(shop, order.id, { tags: ['pathao-sent'], consignmentId: result.consignmentId })
          .catch((e) => log.warn(`[${shop}] could not tag order ${order.name}: ${e.message}`));
      }

      log.info(`[${shop}] ${order.name} -> Pathao consignment ${result.consignmentId}`);
      return { ok: true, shipment };
    } catch (e) {
      log.error(`[${shop}] ${order.name} failed: ${e.message}`);
      return fail('failed', e.message || 'Unknown error');
    }
  }

  return { sendOrder, limitReached };
}

module.exports = { makeShipping };
