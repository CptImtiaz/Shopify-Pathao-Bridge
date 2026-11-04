const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, gqlDraft, SHOP } = require('./helpers');

async function shop(t) {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77 } });
  return a;
}

test('open draft orders are listed (on hold) with id "d<id>" and the full total as COD', async (t) => {
  const a = await shop(t);
  a.fake.state.drafts['10'] = gqlDraft(10);
  a.fake.state.drafts['11'] = gqlDraft(11, { status: 'COMPLETED' });
  const r = (await a.api('/orders?fresh=1')).data;
  assert.equal(r.draftsError, null);
  assert.equal(r.drafts.length, 1);
  const d = r.drafts[0];
  assert.equal(d.id, 'd10');
  assert.equal(d.draft, true);
  assert.equal(d.name, '#D10');
  assert.equal(d.cod, 693.45);
  assert.equal(d.customer, 'Karine Ruby');
  assert.equal(d.shipment, null);
});

test('without draft-order permission the order list still works and says why', async (t) => {
  const a = await shop(t);
  a.fake.state.draftsDenied = true;
  const r = await a.api('/orders?fresh=1');
  assert.equal(r.status, 200);
  assert.equal(r.data.draftsError, 'permission');
  assert.deepEqual(r.data.drafts, []);
});

test('sending a draft completes it into an order and books COD from the draft, even if Shopify marks it paid', async (t) => {
  const a = await shop(t);
  a.fake.state.drafts['12'] = gqlDraft(12);
  await a.api('/orders/d12/note', { method: 'POST', body: { note: 'Deliver after 5pm' } });
  const r = await a.api('/orders/send', { method: 'POST', body: { ids: ['d12'], courier: 'pathao' } });
  const res = r.data.results[0];
  assert.equal(res.ok, true, res.error);
  assert.equal(res.id, 'd12');
  assert.equal(res.orderId, '7001');
  assert.equal(a.fake.state.drafts['12'].status, 'COMPLETED');
  const booked = JSON.parse(a.fake.calls.find((c) => c.url.endsWith('/aladdin/api/v1/orders')).body);
  assert.equal(booked.amount_to_collect, 693, 'COD from the draft, not 0');
  assert.equal(booked.merchant_order_id, '#7001');
  const s = await a.db.getShipment(SHOP, '7001');
  assert.equal(s.status, 'sent');
  // The note moved to the new order.
  assert.equal((await a.db.notesForOrders(SHOP, ['7001']))[0].note, 'Deliver after 5pm');
  assert.equal((await a.db.notesForOrders(SHOP, ['d12'])).length, 0);
  // A completed draft can't be sent twice.
  const again = await a.api('/orders/send', { method: 'POST', body: { ids: ['d12'], courier: 'pathao' } });
  assert.match(again.data.results[0].error, /already completed/);
});

test('draft completion works on API versions without paymentPending', async (t) => {
  const a = await shop(t);
  a.fake.state.paymentPendingRemoved = true;
  a.fake.state.drafts['13'] = gqlDraft(13);
  const r = await a.api('/orders/send', { method: 'POST', body: { ids: ['d13'], courier: 'pathao' } });
  assert.equal(r.data.results[0].ok, true, r.data.results[0].error);
});
