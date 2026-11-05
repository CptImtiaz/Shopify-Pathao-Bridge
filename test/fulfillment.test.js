const test = require('node:test');
const assert = require('node:assert');
const { startApp, gqlOrder, SHOP } = require('./helpers');
const { shopifyEventFor, readyToFulfil } = require('../src/shopify/fulfillment');

async function ready(t, settings = {}) {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u@x.com', pathao_password: 'p' } });
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77, ...settings } });
  return a;
}
async function pathaoHook(a, body) {
  const { secret, url } = (await a.api('/bootstrap')).data.pathaoWebhook;
  const r = await fetch(a.base + new URL(url).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PATHAO-Signature': secret }, body: JSON.stringify(body) });
  await a.settle();
  return r.status;
}

test('Pathao statuses map to Shopify delivery events', () => {
  assert.equal(shopifyEventFor('order.pickup-requested'), 'CONFIRMED');
  assert.equal(shopifyEventFor('order.picked'), 'CARRIER_PICKED_UP');
  assert.equal(shopifyEventFor('order.at-the-sorting-hub'), 'IN_TRANSIT');
  assert.equal(shopifyEventFor('in-transit'), 'IN_TRANSIT');
  assert.equal(shopifyEventFor('order.assigned-for-delivery'), 'OUT_FOR_DELIVERY');
  assert.equal(shopifyEventFor('order.delivered'), 'DELIVERED');
  assert.equal(shopifyEventFor('order.partial-delivery'), 'DELIVERED');
  assert.equal(shopifyEventFor('order.delivery-failed'), 'ATTEMPTED_DELIVERY');
  assert.equal(shopifyEventFor('order.returned'), 'FAILURE');
  assert.equal(shopifyEventFor('order.on-hold'), 'DELAYED');
  assert.equal(readyToFulfil('picked', 'pickup-requested'), false);
  assert.equal(readyToFulfil('picked', 'picked'), true);
  assert.equal(readyToFulfil('booked', 'Pending'), true);
});

test('booking fulfils the Shopify order with Pathao tracking, webhooks add delivery events once', async (t) => {
  const a = await ready(t);
  a.fake.state.orders['700'] = gqlOrder(700);
  const r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['700'] } })).data.results[0];
  assert.equal(r.ok, true);
  assert.equal(a.fake.state.fulfillments.length, 1);
  const f = a.fake.state.fulfillments[0].input;
  assert.equal(f.trackingInfo.company, 'Pathao');
  assert.equal(f.trackingInfo.number, r.consignmentId);
  assert.equal(f.trackingInfo.url, `https://merchant.pathao.com/tracking?consignment_id=${r.consignmentId}&phone=01712345678`);
  assert.equal(f.notifyCustomer, false);
  assert.deepEqual(a.fake.state.events.map((e) => e.status), ['CONFIRMED']); // booking status "Pending"

  assert.equal(await pathaoHook(a, { event: 'order.picked', consignment_id: r.consignmentId }), 202);
  assert.equal(await pathaoHook(a, { event: 'order.in-transit', consignment_id: r.consignmentId }), 202);
  assert.equal(await pathaoHook(a, { event: 'order.in-transit', consignment_id: r.consignmentId }), 202); // repeat: no duplicate event
  assert.equal(await pathaoHook(a, { event: 'order.delivered', consignment_id: r.consignmentId }), 202);
  assert.deepEqual(a.fake.state.events.map((e) => e.status), ['CONFIRMED', 'CARRIER_PICKED_UP', 'IN_TRANSIT', 'DELIVERED']);
  assert.equal(a.fake.state.fulfillments.length, 1);
  const o = (await a.api('/orders')).data.orders.find((x) => x.id === '700');
  assert.equal(o.shipment.shopifySynced, true);
  assert.equal(o.shipment.shopifyEvent, 'DELIVERED');
});

test('"fulfil on pickup" waits for the rider; on-hold orders are released first', async (t) => {
  const a = await ready(t, { fulfill_when: 'picked', notify_customer: true });
  a.fake.state.orders['701'] = gqlOrder(701);
  a.fake.state.fo['701'] = [{ id: 'gid://shopify/FulfillmentOrder/7011', status: 'ON_HOLD', fulfillmentHolds: [{ id: 'h1', reason: 'OTHER' }], fulfillments: { nodes: [] } }];
  const r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['701'] } })).data.results[0];
  assert.equal(a.fake.state.fulfillments.length, 0);
  await pathaoHook(a, { event: 'order.picked', consignment_id: r.consignmentId });
  assert.deepEqual(a.fake.state.released, ['gid://shopify/FulfillmentOrder/7011']);
  assert.equal(a.fake.state.fulfillments.length, 1);
  assert.equal(a.fake.state.fulfillments[0].input.notifyCustomer, true);
  assert.deepEqual(a.fake.state.events.map((e) => e.status), ['CARRIER_PICKED_UP']);
});

test('already fulfilled by hand: tracking is attached to the existing fulfillment', async (t) => {
  const a = await ready(t);
  a.fake.state.orders['702'] = gqlOrder(702);
  a.fake.state.fo['702'] = [{ id: 'gid://shopify/FulfillmentOrder/7021', status: 'CLOSED', fulfillmentHolds: [], fulfillments: { nodes: [{ id: 'gid://shopify/Fulfillment/99', status: 'SUCCESS' }] } }];
  await a.api('/orders/send', { method: 'POST', body: { ids: ['702'] } });
  assert.equal(a.fake.state.fulfillments.length, 0);
  assert.equal(a.fake.state.trackingUpdates[0].id, 'gid://shopify/Fulfillment/99');
  assert.equal(a.fake.state.events[0].fulfillmentId, 'gid://shopify/Fulfillment/99');
});

test('sync can be turned off; missing permission is reported, booking still succeeds', async (t) => {
  const a = await ready(t, { sync_fulfillment: false });
  a.fake.state.orders['703'] = gqlOrder(703);
  assert.equal((await a.api('/orders/send', { method: 'POST', body: { ids: ['703'] } })).data.results[0].ok, true);
  assert.equal(a.fake.state.fulfillments.length, 0);

  await a.api('/settings', { method: 'POST', body: { sync_fulfillment: true } });
  a.fake.state.fulfillDenied = true;
  a.fake.state.orders['704'] = gqlOrder(704);
  assert.equal((await a.api('/orders/send', { method: 'POST', body: { ids: ['704'] } })).data.results[0].ok, true);
  const o = (await a.api('/orders')).data.orders.find((x) => x.id === '704');
  assert.equal(o.shipment.shopifySynced, false);
  assert.match(o.shipment.syncError, /permission/i);
  const b = (await a.api('/bootstrap')).data;
  assert.equal(b.settings.sync_fulfillment, true);
  assert.ok(Array.isArray(b.permissions.missing));
});

test('orders that failed for missing permission are caught up once access is granted', async (t) => {
  const a = await ready(t);
  a.fake.state.fulfillDenied = true;
  a.fake.state.orders['705'] = gqlOrder(705);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['705'] } });
  assert.equal(a.fake.state.fulfillments.length, 0);
  a.fake.state.fulfillDenied = false;
  a.fake.state.scope = 'write_orders,write_fulfillments,write_merchant_managed_fulfillment_orders';
  await a.db.saveShopTokens(SHOP, { ...(await a.db.getShop(SHOP)), accessTokenEnc: (await a.db.getShop(SHOP)).access_token_enc, accessExpiresAt: (await a.db.getShop(SHOP)).access_expires_at, refreshTokenEnc: (await a.db.getShop(SHOP)).refresh_token_enc, refreshExpiresAt: (await a.db.getShop(SHOP)).refresh_expires_at, scope: a.fake.state.scope });
  const b = (await a.api('/bootstrap')).data;
  assert.deepEqual(b.permissions.missing, []);
  assert.equal(a.fake.state.fulfillments.length, 1);
  const o = (await a.api('/orders')).data.orders.find((x) => x.id === '705');
  assert.equal(o.shipment.shopifySynced, true);
  assert.equal(o.shipment.syncError, null);
});

test('COD standard: delivered marks the Shopify order paid once; partial delivery does not', async (t) => {
  const a = await ready(t);
  a.fake.state.orders['710'] = gqlOrder(710);
  a.fake.state.orders['711'] = gqlOrder(711);
  const [r1, r2] = (await a.api('/orders/send', { method: 'POST', body: { ids: ['710', '711'] } })).data.results;
  assert.deepEqual(a.fake.state.paid || [], [], 'sent but not delivered: payment stays pending');
  await pathaoHook(a, { event: 'order.delivered', consignment_id: r1.consignmentId });
  await pathaoHook(a, { event: 'order.delivered', consignment_id: r1.consignmentId }); // repeat
  await pathaoHook(a, { event: 'order.partial-delivery', consignment_id: r2.consignmentId });
  assert.deepEqual(a.fake.state.paid, ['710']);
  assert.ok((await a.db.getShipment(SHOP, '710')).shopify_paid_at);
});

test('mark paid can be switched off', async (t) => {
  const a = await ready(t, { mark_paid_on_delivery: false });
  a.fake.state.orders['712'] = gqlOrder(712);
  const r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['712'] } })).data.results[0];
  await pathaoHook(a, { event: 'order.delivered', consignment_id: r.consignmentId });
  assert.deepEqual(a.fake.state.paid || [], []);
  assert.equal((await a.api('/bootstrap')).data.settings.mark_paid_on_delivery, false);
});

test('Pathao pickup cancelled after fulfilment: fulfillment undone, order back to Not sent and can be sent again', async (t) => {
  const a = await ready(t);
  a.fake.state.orders['713'] = gqlOrder(713);
  const r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['713'] } })).data.results[0];
  assert.equal(a.fake.state.fulfillments.length, 1);
  await pathaoHook(a, { event: 'order.pickup-cancelled', consignment_id: r.consignmentId });
  assert.deepEqual(a.fake.state.cancelledFulfillments, [a.fake.state.fulfillments[0].id]);
  const s = await a.db.getShipment(SHOP, '713');
  assert.equal(s.status, 'skipped');
  assert.match(s.error, /Pickup cancelled by Pathao/);
  assert.equal(s.shopify_fulfillment_id, null);
  delete a.fake.state.fo['713'];
  const again = (await a.api('/orders/send', { method: 'POST', body: { ids: ['713'] } })).data.results[0];
  assert.equal(again.ok, true);
});

test('returned parcel: fulfillment undone (Unfulfilled again); switch off keeps it fulfilled', async (t) => {
  const a = await ready(t);
  a.fake.state.orders['714'] = gqlOrder(714);
  const r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['714'] } })).data.results[0];
  await pathaoHook(a, { event: 'order.delivery-failed', consignment_id: r.consignmentId });
  assert.deepEqual(a.fake.state.cancelledFulfillments || [], [], 'a failed attempt is not a return');
  await pathaoHook(a, { event: 'order.returned', consignment_id: r.consignmentId });
  assert.equal(a.fake.state.cancelledFulfillments.length, 1);
  const s = await a.db.getShipment(SHOP, '714');
  assert.equal(s.status, 'sent');
  assert.equal(s.pathao_status, 'returned');
  assert.equal(s.shopify_fulfillment_id, null);
  assert.deepEqual(a.fake.state.paid || [], []);

  await a.api('/settings', { method: 'POST', body: { undo_on_return: false } });
  a.fake.state.orders['715'] = gqlOrder(715);
  const r2 = (await a.api('/orders/send', { method: 'POST', body: { ids: ['715'] } })).data.results[0];
  await pathaoHook(a, { event: 'order.returned', consignment_id: r2.consignmentId });
  assert.equal(a.fake.state.cancelledFulfillments.length, 1);
  assert.ok((await a.db.getShipment(SHOP, '715')).shopify_fulfillment_id);
});

test('status helpers: pickup cancelled, came back, fully delivered', () => {
  const { pickupCancelled, cameBack, fullyDelivered } = require('../src/shopify/fulfillment');
  assert.equal(pickupCancelled('Pickup_Cancelled', 'pathao'), true);
  assert.equal(pickupCancelled('pickup-cancelled', 'pathao'), true);
  assert.equal(pickupCancelled('cancelled', 'steadfast'), false);
  assert.equal(cameBack('order.returned', 'pathao'), true);
  assert.equal(cameBack('paid-return', 'pathao'), true);
  assert.equal(cameBack('delivery-failed', 'pathao'), false);
  assert.equal(cameBack('cancelled', 'steadfast'), true);
  assert.equal(cameBack('cancelled_approval_pending', 'steadfast'), false);
  assert.equal(fullyDelivered('delivered', 'steadfast'), true);
  assert.equal(fullyDelivered('delivered_approval_pending', 'steadfast'), false);
  assert.equal(fullyDelivered('partial_delivered', 'steadfast'), false);
  assert.equal(fullyDelivered('order.delivered', 'pathao'), true);
});

test('catch-up on start: older pickup-cancelled / delivered parcels get the Shopify update', async (t) => {
  const a = await ready(t);
  a.fake.state.orders['720'] = gqlOrder(720);
  a.fake.state.orders['721'] = gqlOrder(721);
  const [r1, r2] = (await a.api('/orders/send', { method: 'POST', body: { ids: ['720', '721'] } })).data.results;
  // Statuses saved directly (as if they arrived before this logic existed).
  await a.db.finishShipment(SHOP, '720', { pathao_status: 'pickup-cancelled' });
  await a.db.finishShipment(SHOP, '721', { pathao_status: 'delivered' });
  const n = await a.tracker.catchUp();
  assert.equal(n, 2);
  assert.equal((await a.db.getShipment(SHOP, '720')).status, 'skipped');
  assert.deepEqual(a.fake.state.paid, ['721']);
  assert.equal(await a.tracker.catchUp(), 0, 'nothing left the second time');
  assert.ok(r1.ok && r2.ok);
});
