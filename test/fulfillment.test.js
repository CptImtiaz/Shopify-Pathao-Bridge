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
