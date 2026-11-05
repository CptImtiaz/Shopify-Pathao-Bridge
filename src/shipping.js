// The core job: take one Shopify order and book it with a courier
// (Pathao or Steadfast), exactly once.

const { PLANS } = require('./plans');
const { buildPathaoOrder } = require('./pathao/mapper');
const { buildSteadfastOrder } = require('./couriers/steadfast');
const { COURIER_NAMES } = require('./couriers');

function makeShipping({ db, pathao, steadfast = null, admin, fulfillment = null, log = console }) {
  // Each courier: build its payload from the order, then book it.
  const COURIERS = {
    pathao: {
      build: (order, settings) => buildPathaoOrder(order, settings),
      book: async (settings, payload) => {
        const r = await pathao.createOrder(settings, payload);
        return { ...r, amountToCollect: payload.amount_to_collect, trackingCode: null };
      },
    },
    steadfast: {
      build: (order, settings) => buildSteadfastOrder(order, settings),
      book: async (settings, payload) => {
        if (!steadfast) throw new Error('Steadfast is not available');
        const r = await steadfast.createOrder(settings, payload);
        return { ...r, amountToCollect: payload.cod_amount };
      },
    },
  };

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
  // `courier` defaults to the shop's default courier.
  // A courier that didn't answer may still have booked the parcel. Pathao doesn't refuse a
  // second booking of the same order, so these need the merchant's OK before sending again.
  const UNSURE = 'Not confirmed:';
  const isUnsure = (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed? ?out|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(e.message || '')));

  async function sendOrder(shop, order, { courier, confirmed = false } = {}) {
    const settings = await db.getSettings(shop);
    const key = COURIERS[courier] ? courier : COURIERS[settings.default_courier] ? settings.default_courier : 'pathao';
    const c = COURIERS[key];
    const label = COURIER_NAMES[key] || key;

    const before = await db.getShipment(shop, order.id);
    if (before && String(before.error || '').startsWith(UNSURE) && !confirmed) {
      return { ok: false, needsConfirm: true, shipment: before, error: before.error };
    }

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

      await db.finishShipment(shop, order.id, { courier: key });
      const { payload, errors } = c.build(order, settings);
      if (payload && payload.recipient_phone) await db.finishShipment(shop, order.id, { phone: payload.recipient_phone });
      if (errors.length) return await fail('failed', errors.join('. '));

      const result = await c.book(settings, payload);
      const shipment = await db.finishShipment(shop, order.id, {
        status: 'sent',
        courier: key,
        consignment_id: result.consignmentId ? String(result.consignmentId) : null,
        tracking_code: result.trackingCode || null,
        pathao_status: result.status, // courier's own status text (column predates multi-courier)
        delivery_fee: result.deliveryFee,
        amount_to_collect: result.amountToCollect,
        error: null,
        counted: true,
      });

      if (settings.tag_orders) {
        await admin
          .annotateOrder(shop, order.id, { tags: [`${key}-sent`], consignmentId: result.consignmentId, courier: key })
          .catch((e) => log.warn(`[${shop}] could not tag order ${order.name}: ${e.message}`));
      }

      log.info(`[${shop}] ${order.name} -> ${label} consignment ${result.consignmentId}`);
      // Mark fulfilled in Shopify with the courier's tracking (if the shop wants it now).
      if (fulfillment) await fulfillment.sync(shop, order.id);
      return { ok: true, shipment: (await db.getShipment(shop, order.id)) || shipment };
    } catch (e) {
      log.error(`[${shop}] ${order.name} failed: ${e.message}`);
      if (isUnsure(e)) {
        return fail('failed', `${UNSURE} ${label} did not answer in time. Check your ${label} panel before sending again — it may already be booked.`);
      }
      return fail('failed', e.message || 'Unknown error');
    }
  }

  return { sendOrder, limitReached };
}

module.exports = { makeShipping };
