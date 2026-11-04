// Pathao -> Shopify fulfillment sync.
//
// 1. Fulfil the order in Shopify with the Pathao consignment as tracking
//    number and a Pathao tracking link (ported from Shopify-PathoOrderStatus:
//    releases ON_HOLD fulfillment orders, updates tracking on already-closed
//    ones, skips cancelled ones).
// 2. On every later Pathao status, add a Shopify fulfillment event
//    (Picked up, In transit, Out for delivery, Delivered, Failed...). These show
//    on the order timeline in Shopify admin and on the customer's order status page.
//
// Needs scopes: read/write_merchant_managed_fulfillment_orders + write_fulfillments.

const { steadfastTrackingUrl } = require('../couriers/steadfast');
const { COURIER_NAMES } = require('../couriers');

const TRACKING_COMPANY = 'Pathao';

function trackingUrl(consignmentId, phone) {
  return `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(consignmentId)}${phone ? `&phone=${encodeURIComponent(phone)}` : ''}`;
}

// Tracking info shown on the Shopify order and the customer's order status page.
function trackingFor(shipment) {
  if (shipment.courier === 'steadfast') {
    return { company: 'Steadfast', number: String(shipment.tracking_code || shipment.consignment_id), url: steadfastTrackingUrl(shipment.tracking_code) };
  }
  return { company: TRACKING_COMPANY, number: String(shipment.consignment_id), url: trackingUrl(shipment.consignment_id, shipment.phone) };
}

// Steadfast delivery status -> Shopify FulfillmentEventStatus (null = no event).
// "*_approval_pending" is only the rider's word, so it doesn't move the order yet.
function steadfastEventFor(raw) {
  const s = String(raw || '').toLowerCase();
  if (/approval_pending/.test(s)) return null;
  if (/^partial_delivered$|^delivered$/.test(s)) return 'DELIVERED';
  if (/cancel|return/.test(s)) return 'FAILURE';
  if (/hold|exceptional/.test(s)) return 'DELAYED';
  if (/in_review|pending/.test(s)) return 'CONFIRMED';
  return null;
}

// Courier event / status text -> Shopify FulfillmentEventStatus (null = no event).
function shopifyEventFor(raw, courier = 'pathao') {
  if (courier === 'steadfast') return steadfastEventFor(raw);
  const s = String(raw || '').toLowerCase().replace(/^order\./, '').replace(/[_\s]+/g, '-');
  if (/partial/.test(s)) return 'DELIVERED';
  if (/paid-return|return/.test(s)) return 'FAILURE';
  if (/deliver(y|ed)?-fail|fail.*deliver/.test(s)) return 'ATTEMPTED_DELIVERY';
  if (/delivered/.test(s)) return 'DELIVERED';
  if (/assigned-for-delivery|out-for-delivery/.test(s)) return 'OUT_FOR_DELIVERY';
  if (/in-transit|sorting|hub|transit/.test(s)) return 'IN_TRANSIT';
  if (/^picked|picked-up/.test(s)) return 'CARRIER_PICKED_UP';
  if (/hold/.test(s)) return 'DELAYED';
  if (/pickup-requested|assigned-for-pickup|^created|^pending/.test(s)) return 'CONFIRMED';
  return null;
}

// When should the Shopify order be marked fulfilled?
//   booked: as soon as the parcel is booked with Pathao (like the original script)
//   picked: only once the rider has picked it up
function readyToFulfil(when, raw, courier = 'pathao') {
  if (when !== 'picked') return true;
  // Steadfast has no "picked up" status: once it leaves review ("pending") the parcel is with them.
  if (courier === 'steadfast') return !/in_review/.test(String(raw || '').toLowerCase());
  const ev = shopifyEventFor(raw, courier);
  return ['CARRIER_PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ATTEMPTED_DELIVERY', 'DELIVERED', 'DELAYED'].includes(ev);
}

const FO_FIELDS = `id status fulfillmentHolds { id reason } fulfillments(first: 10) { nodes { id status } }`;

function makeFulfillmentSync({ admin, db, log = console }) {
  const gql = (shop, q, v) => admin.graphql(shop, q, v);

  async function fulfillmentOrders(shop, orderId) {
    const d = await gql(shop, `query FO($id: ID!) { order(id: $id) { id name fulfillmentOrders(first: 20) { nodes { ${FO_FIELDS} } } } }`,
      { id: `gid://shopify/Order/${orderId}` });
    if (!d.order) throw new Error('Order not found in Shopify');
    return d.order.fulfillmentOrders.nodes;
  }

  async function releaseHolds(shop, fo) {
    const ids = (fo.fulfillmentHolds || []).map((h) => h.id);
    const d = await gql(shop, `mutation Rel($id: ID!, $holdIds: [ID!]) { fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) { fulfillmentOrder { ${FO_FIELDS} } userErrors { message } } }`,
      { id: fo.id, holdIds: ids.length ? ids : null });
    const r = d.fulfillmentOrderReleaseHold;
    if (r.userErrors.length) throw new Error(`Could not release hold: ${r.userErrors.map((e) => e.message).join('; ')}`);
    return r.fulfillmentOrder;
  }

  async function createFulfillment(shop, foIds, tracking, notifyCustomer) {
    const d = await gql(shop, `mutation Ful($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { message } } }`,
      { f: { lineItemsByFulfillmentOrder: foIds.map((id) => ({ fulfillmentOrderId: id })), notifyCustomer: Boolean(notifyCustomer), trackingInfo: tracking } });
    const r = d.fulfillmentCreate;
    if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
    return r.fulfillment;
  }

  async function updateTracking(shop, fulfillmentId, tracking) {
    const d = await gql(shop, `mutation Trk($id: ID!, $t: FulfillmentTrackingInput!) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: false) { fulfillment { id } userErrors { message } } }`,
      { id: fulfillmentId, t: tracking });
    const r = d.fulfillmentTrackingInfoUpdate;
    if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
  }

  async function addEvent(shop, fulfillmentId, status, message) {
    const d = await gql(shop, `mutation Ev($e: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $e) { fulfillmentEvent { id status } userErrors { message } } }`,
      { e: { fulfillmentId, status, message, happenedAt: new Date().toISOString() } });
    const r = d.fulfillmentEventCreate;
    if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
  }

  // Fulfil (if not yet) and return the fulfillment id. Mirrors the original
  // script's handling of OPEN / IN_PROGRESS / SCHEDULED / ON_HOLD / CLOSED / CANCELLED.
  async function ensureFulfilled(shop, shipment, settings) {
    if (shipment.shopify_fulfillment_id) return shipment.shopify_fulfillment_id;
    const tracking = trackingFor(shipment);
    let fos = await fulfillmentOrders(shop, shipment.shopify_order_id);
    for (let i = 0; i < fos.length; i++) if (fos[i].status === 'ON_HOLD') fos[i] = await releaseHolds(shop, fos[i]);

    const open = fos.filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status)).map((f) => f.id);
    let fulfillmentId = null;
    if (open.length) {
      fulfillmentId = (await createFulfillment(shop, open, tracking, settings.notify_customer)).id;
    } else {
      // Already fulfilled (e.g. by hand): attach Pathao tracking to the existing fulfillment(s).
      const existing = fos.flatMap((f) => f.fulfillments.nodes).filter((f) => f.status !== 'CANCELLED');
      if (!existing.length) throw new Error(fos.length ? `Nothing to fulfil (fulfillment status: ${fos.map((f) => f.status).join(', ')})` : 'Order has no fulfillment orders');
      for (const f of existing) await updateTracking(shop, f.id, tracking);
      fulfillmentId = existing[0].id;
    }
    await db.finishShipment(shop, shipment.shopify_order_id, { shopify_fulfillment_id: fulfillmentId, sync_error: null });
    log.info(`[${shop}] ${shipment.order_name} fulfilled in Shopify with ${tracking.company} ${shipment.consignment_id}`);
    return fulfillmentId;
  }

  // Called after booking and on every Pathao status webhook. Never throws:
  // problems are saved on the shipment so the dashboard can show them.
  async function sync(shop, orderId, { status } = {}) {
    try {
      const settings = await db.getSettings(shop);
      if (!settings.sync_fulfillment) return { skipped: 'off' };
      let shipment = await db.getShipment(shop, orderId);
      if (!shipment || shipment.status !== 'sent' || !shipment.consignment_id) return { skipped: 'not sent' };
      const raw = status || shipment.pathao_status;
      const courier = shipment.courier || 'pathao';
      const ev = shopifyEventFor(raw, courier);

      if (!shipment.shopify_fulfillment_id) {
        if (/cancel/.test(String(raw).toLowerCase())) return { skipped: 'cancelled before fulfilment' };
        if (!readyToFulfil(settings.fulfill_when, raw, courier)) return { skipped: 'waiting for pickup' };
        await ensureFulfilled(shop, shipment, settings);
        shipment = await db.getShipment(shop, orderId);
      }
      if (ev && ev !== shipment.shopify_event) {
        await addEvent(shop, shipment.shopify_fulfillment_id, ev, `${COURIER_NAMES[courier] || 'Courier'}: ${String(raw).replace(/^order\./, '').replace(/[-_]/g, ' ')}`);
        await db.finishShipment(shop, orderId, { shopify_event: ev, sync_error: null });
      }
      return { ok: true, event: ev };
    } catch (e) {
      const msg = /access denied|ACCESS_DENIED|required access/i.test(e.message)
        ? 'Shopify permission missing: open the app and approve the new fulfillment permissions'
        : e.message;
      log.warn(`[${shop}] fulfillment sync for order ${orderId} failed: ${e.message}`);
      await db.finishShipment(shop, orderId, { sync_error: String(msg).slice(0, 300) }).catch(() => {});
      return { ok: false, error: msg };
    }
  }

  return { sync, ensureFulfilled };
}

module.exports = { makeFulfillmentSync, shopifyEventFor, readyToFulfil, trackingUrl, trackingFor, TRACKING_COMPANY };
