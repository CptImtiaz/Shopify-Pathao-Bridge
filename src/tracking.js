// Keeps parcel statuses up to date without the merchant pressing anything.
//
// Couriers push most changes by webhook, but some never arrive (e.g. a parcel
// removed in the Steadfast panel while "In review" sends nothing). So the
// server also asks the couriers itself:
//   - every few minutes, for every shop with parcels still on the way;
//   - when a merchant opens the dashboard (at most once a minute per shop).

const { COURIER_NAMES } = require('./couriers');

// Final statuses: nothing more will happen to these parcels.
const DONE = /^(order\.)?(delivered|partial[_-]delivered|cancelled|returned|paid[_-]return|cancelled_return_received|partial_delivered_return_received)$/i;

function makeTracker({ db, pathao, steadfast, fulfillment = null, admin = null, log = console }) {
  const lastRun = new Map();

  // A parcel removed in the Steadfast panel (only possible while it is in review)
  // is answered with "unknown". Put the order back to "Not sent" so it can be sent again.
  async function markRemoved(shop, s) {
    if (s.shopify_fulfillment_id && fulfillment && fulfillment.cancelFulfillment) {
      await fulfillment.cancelFulfillment(shop, s.shopify_fulfillment_id)
        .catch((e) => log.warn(`[${shop}] ${s.order_name}: could not undo the Shopify fulfillment: ${e.message}`));
    }
    const name = COURIER_NAMES[s.courier] || 'the courier';
    await db.finishShipment(shop, s.shopify_order_id, {
      status: 'skipped', error: `Removed in ${name} · send again when ready`, counted: false,
      consignment_id: null, tracking_code: null, pathao_status: null, delivery_fee: null,
      courier_message: null, courier_message_at: null,
      shopify_fulfillment_id: null, shopify_event: null, sync_error: null,
    });
    log.info(`[${shop}] ${s.order_name} was removed in ${name}: back to Not sent`);
    return 'removed';
  }

  // Ask the courier for one parcel's status and save it. Returns the new status.
  async function refreshShipment(shop, s, settings) {
    let status;
    if (s.courier === 'steadfast') {
      if (!steadfast || settings.steadfast_auth_error) return s.pathao_status; // paused: don't burn login attempts
      status = (await steadfast.statusByCid(settings, s.consignment_id)).status || s.pathao_status;
      // (also catches parcels already saved as "unknown" by an earlier check)
      if (status === 'unknown' && /^(in_review|pending|unknown)$/.test(String(s.pathao_status || ''))) return markRemoved(shop, s);
    } else {
      const info = await pathao.orderInfo(settings, s.consignment_id);
      status = info.order_status_slug || info.order_status || s.pathao_status;
    }
    if (status !== s.pathao_status) {
      await db.finishShipment(shop, s.shopify_order_id, { pathao_status: status });
      log.info(`[${shop}] ${s.order_name} ${s.courier} status ${s.pathao_status || '-'} -> ${status} (checked)`);
    }
    if (fulfillment) await fulfillment.sync(shop, s.shopify_order_id, { status });
    return status;
  }

  // Check every parcel of a shop that is still on the way (newest first).
  async function refreshActive(shop, { limit = 30 } = {}) {
    lastRun.set(shop, Date.now());
    const settings = await db.getSettings(shop);
    const list = (await db.activeShipments(shop, 200)).filter((s) => !DONE.test(String(s.pathao_status || ''))).slice(0, limit);
    let changed = 0, failed = 0;
    for (const s of list) {
      try { if ((await refreshShipment(shop, s, settings)) !== s.pathao_status) changed += 1; }
      catch (e) { failed += 1; log.warn(`[${shop}] status check ${s.order_name} failed: ${e.message}`); }
    }
    if (changed && admin && admin.forgetOrders) admin.forgetOrders(shop);
    return { checked: list.length, changed, failed };
  }

  // Dashboard opened: check in the background, at most once a minute per shop.
  function refreshSoon(shop) {
    if (Date.now() - (lastRun.get(shop) || 0) < 60000) return;
    lastRun.set(shop, Date.now());
    refreshActive(shop).catch((e) => log.warn(`[${shop}] background status check failed: ${e.message}`));
  }

  async function pollAll() {
    for (const shop of await db.shopsWithActiveShipments()) {
      await refreshActive(shop).catch((e) => log.warn(`[${shop}] status poll failed: ${e.message}`));
    }
  }

  function start(everyMs = 60 * 1000) {
    const timer = setInterval(() => pollAll().catch((e) => log.warn(`status poll failed: ${e.message}`)), everyMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  return { refreshShipment, refreshActive, refreshSoon, pollAll, start };
}

module.exports = { makeTracker, DONE };
