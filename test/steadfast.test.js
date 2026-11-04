const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startApp, gqlOrder, SHOP } = require('./helpers');
const { buildSteadfastOrder, invoiceFor } = require('../src/couriers/steadfast');
const { shopifyEventFor, readyToFulfil } = require('../src/shopify/fulfillment');

const order = (extra = {}) => ({
  id: '1', name: '#1001', note: '', tags: [], paid: false, total: 1060, outstanding: 1060, cancelled: false,
  shipping: { name: 'Jahid {Hasan}', phone: '+880 1712-345678', address1: 'House 3; Road 9', address2: 'Dhanmondi', city: 'Dhaka' },
  fallbackName: '', fallbackPhones: [], items: [{ title: 'Panjabi', quantity: 2, grams: 0 }],
  ...extra,
});

async function steadfastShop(t) {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  const r = await a.api('/steadfast/connect', { method: 'POST', body: { api_key: 'sf_key', secret_key: 'sf_secret' } });
  assert.equal(r.status, 200, r.data.error);
  return a;
}

function sfHook(a, payload, { token, tamper = false, bearerOnly = false } = {}) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', token).update(tamper ? body + ' ' : body).digest('hex');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'Steadfast-Webhook/1.0' };
  if (!bearerOnly) headers['X-Signature'] = sig;
  return fetch(`${a.base}/steadfast/webhook/${SHOP}`, { method: 'POST', headers, body });
}

test('steadfast payload: clean phone, stripped characters, COD, unique invoice', () => {
  const { payload, errors } = buildSteadfastOrder(order(), { default_note: 'Call first' });
  assert.deepEqual(errors, []);
  assert.equal(payload.invoice, '1001');
  assert.equal(payload.recipient_phone, '01712345678');
  assert.equal(payload.recipient_name, 'Jahid Hasan');
  assert.equal(payload.recipient_address, 'House 3 Road 9, Dhanmondi, Dhaka');
  assert.equal(payload.cod_amount, 1060);
  assert.equal(payload.note, 'Call first');
  assert.equal(payload.item_description, 'Panjabi x 2');
  assert.equal(buildSteadfastOrder(order({ paid: true, outstanding: 0 })).payload.cod_amount, 0);
  assert.match(buildSteadfastOrder(order({ shipping: { phone: '123' }, fallbackPhones: [] })).errors.join(' '), /not a valid/);
  assert.equal(invoiceFor({ id: '77', name: '' }), '77');
});

test('steadfast statuses map to Shopify events; rider-only statuses wait for confirmation', () => {
  assert.equal(shopifyEventFor('in_review', 'steadfast'), 'CONFIRMED');
  assert.equal(shopifyEventFor('pending', 'steadfast'), 'CONFIRMED');
  assert.equal(shopifyEventFor('delivered_approval_pending', 'steadfast'), null);
  assert.equal(shopifyEventFor('delivered', 'steadfast'), 'DELIVERED');
  assert.equal(shopifyEventFor('partial_delivered', 'steadfast'), 'DELIVERED');
  assert.equal(shopifyEventFor('cancelled', 'steadfast'), 'FAILURE');
  assert.equal(shopifyEventFor('hold', 'steadfast'), 'DELAYED');
  assert.equal(readyToFulfil('picked', 'in_review', 'steadfast'), false);
  assert.equal(readyToFulfil('picked', 'pending', 'steadfast'), true);
  assert.equal(shopifyEventFor('order.delivered'), 'DELIVERED'); // Pathao unchanged
});

test('steadfast connect: test shows balance, wrong keys are reported, courier shows connected', async (t) => {
  const a = await steadfastShop(t);
  const ok = await a.api('/steadfast/test', { method: 'POST' });
  assert.deepEqual(ok.data, { ok: true, balance: 1520.5 });
  const boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.couriers.find((c) => c.key === 'steadfast').status, 'connected');
  assert.equal(boot.settings.steadfast.connected, true);
  assert.equal(boot.settings.steadfast.has_secret, true);
  assert.equal(JSON.stringify(boot).includes('sf_secret'), false, 'secret never sent to the browser');
  assert.match(boot.steadfastWebhook.url, /\/steadfast\/webhook\/demo-store\.myshopify\.com$/);
  assert.ok(boot.steadfastWebhook.token.length >= 32);

  // Wrong keys are checked with Steadfast first and never saved over working ones.
  const bad = await a.api('/steadfast/connect', { method: 'POST', body: { api_key: 'sf_key', secret_key: 'wrong' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /rejected the API key or secret key \(Steadfast said: "Unauthenticated\."\)/);
  assert.equal((await a.api('/steadfast/test', { method: 'POST' })).data.ok, true, 'old keys still work');
  assert.equal((await a.api('/steadfast/connect', { method: 'POST', body: { api_key: 'sf key', secret_key: 'x' } })).status, 400);
});

test('steadfast 401 while booking: pauses Steadfast calls until keys are re-entered', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['810'] = gqlOrder(810);
  a.fake.state.orders['811'] = gqlOrder(811);
  // Keys revoked in the Steadfast portal after connecting.
  await a.db.updateSettings(SHOP, { steadfast_api_key: 'revoked' });
  let r = await a.api('/orders/send', { method: 'POST', body: { ids: ['810'], courier: 'steadfast' } });
  assert.match(r.data.results[0].error, /rejected the API key/);
  const calls = () => a.fake.calls.filter((c) => c.url.includes('packzy')).length;
  const before = calls();
  r = await a.api('/orders/send', { method: 'POST', body: { ids: ['811'], courier: 'steadfast' } });
  assert.match(r.data.results[0].error, /Re-enter your keys/);
  assert.equal(calls(), before, 'no second failed login sent to Steadfast');
  const boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.couriers.find((c) => c.key === 'steadfast').status, 'needs_keys');
  assert.ok(boot.settings.steadfast.auth_error);

  // Re-entering working keys clears the pause.
  assert.equal((await a.api('/steadfast/connect', { method: 'POST', body: { api_key: 'sf_key', secret_key: 'sf_secret' } })).status, 200);
  r = await a.api('/orders/send', { method: 'POST', body: { ids: ['811'], courier: 'steadfast' } });
  assert.equal(r.data.results[0].ok, true, r.data.results[0].error);
});

test('send with Steadfast: books once, saves consignment + tracking code, fulfils with Steadfast tracking', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['800'] = gqlOrder(800);
  const r = await a.api('/orders/send', { method: 'POST', body: { ids: ['800'], courier: 'steadfast' } });
  assert.equal(r.data.results[0].ok, true, r.data.results[0].error);
  assert.equal(a.fake.state.steadfastOrders.length, 1);
  const sent = a.fake.state.steadfastOrders[0];
  assert.equal(sent.invoice, '800');
  assert.equal(sent.recipient_phone, '01712345678');
  const call = a.fake.calls.find((c) => c.url.endsWith('/create_order'));
  assert.equal(call.headers['Api-Key'], 'sf_key');
  assert.equal(call.headers['Secret-Key'], 'sf_secret');

  const s = await a.db.getShipment(SHOP, '800');
  assert.equal(s.courier, 'steadfast');
  assert.equal(s.consignment_id, '5001');
  assert.equal(s.tracking_code, 'SF5001');
  assert.equal(s.pathao_status, 'in_review');
  const f = a.fake.state.fulfillments[0];
  assert.equal(f.input.trackingInfo.company, 'Steadfast');
  assert.equal(f.input.trackingInfo.url, 'https://steadfast.com.bd/t/SF5001');
  assert.ok(a.fake.calls.some((c) => c.body && c.body.includes('steadfast-sent')), 'order tagged steadfast-sent');

  // Duplicate send is refused locally, never reaches Steadfast.
  const again = await a.api('/orders/send', { method: 'POST', body: { ids: ['800'], courier: 'steadfast' } });
  assert.equal(again.data.results[0].duplicate, true);
  assert.equal(a.fake.state.steadfastOrders.length, 1);

  // Status refresh asks Steadfast by consignment id.
  a.fake.state.steadfastStatus['5001'] = 'delivered';
  const ref = await a.api('/orders/800/refresh', { method: 'POST' });
  assert.equal(ref.data.pathaoStatus, 'delivered');
  assert.ok(a.fake.state.events.some((e) => e.status === 'DELIVERED' && /^Steadfast:/.test(e.message)));

  const list = (await a.api('/orders?fresh=1')).data.orders.find((o) => o.id === '800');
  assert.equal(list.shipment.courier, 'steadfast');
  assert.equal(list.shipment.trackingCode, 'SF5001');
});

test('steadfast refusal is saved on the order; not connected gives a clear error', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  a.fake.state.orders['801'] = gqlOrder(801);
  const no = await a.api('/orders/send', { method: 'POST', body: { ids: ['801'], courier: 'steadfast' } });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Connect your Steadfast account/);

  await a.api('/steadfast/connect', { method: 'POST', body: { api_key: 'sf_key', secret_key: 'sf_secret' } });
  a.fake.state.steadfastFail = { recipient_address: ['The recipient address field is required.'] };
  const r = await a.api('/orders/send', { method: 'POST', body: { ids: ['801'], courier: 'steadfast' } });
  assert.equal(r.data.results[0].ok, false);
  assert.match(r.data.results[0].error, /recipient_address/);
  assert.equal((await a.db.getShipment(SHOP, '801')).status, 'failed');
});

test('steadfast webhook: signature checked, status saved, Shopify updated; wrong signature refused', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['802'] = gqlOrder(802);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['802'], courier: 'steadfast' } });
  const token = (await a.api('/bootstrap')).data.steadfastWebhook.token;
  const event = { notification_type: 'delivery_status', consignment_id: 5001, invoice: '802', cod_amount: 990, status: 'delivered', delivery_charge: 100 };

  assert.equal((await sfHook(a, event, { token, tamper: true })).status, 401);
  assert.equal((await sfHook(a, event, { token: 'x'.repeat(48) })).status, 401);
  assert.equal((await a.db.getShipment(SHOP, '802')).pathao_status, 'in_review');

  const ok = await sfHook(a, event, { token });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: 'success' });
  await a.settle();
  const s = await a.db.getShipment(SHOP, '802');
  assert.equal(s.pathao_status, 'delivered');
  assert.equal(Number(s.delivery_fee), 100);
  assert.ok(a.fake.state.events.some((e) => e.status === 'DELIVERED'));
  assert.equal((await a.api('/bootstrap')).data.steadfastWebhook.live, true);

  // Bearer-only (no signature) is accepted; other event types are acknowledged.
  assert.equal((await sfHook(a, { notification_type: 'payment_request' }, { token, bearerOnly: true })).status, 200);
});

test('steadfast as default courier: auto-send books new orders with Steadfast; disconnect falls back', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  assert.equal((await a.api('/settings', { method: 'POST', body: { default_courier: 'steadfast' } })).status, 400);
  await a.api('/steadfast/connect', { method: 'POST', body: { api_key: 'sf_key', secret_key: 'sf_secret' } });
  const r = await a.api('/settings', { method: 'POST', body: { default_courier: 'steadfast', auto_send: true, hold_risky: false } });
  assert.equal(r.status, 200, r.data.error);
  await new Promise((res) => setTimeout(res, 20));

  const payload = { id: 803, name: '#803', created_at: new Date(Date.now() + 1000).toISOString(), financial_status: 'pending',
    total_price: '500', total_outstanding: '500', tags: '', shipping_address: { name: 'Mim', phone: '01812345678', address1: 'Road 2, Mirpur 10', city: 'Dhaka' },
    line_items: [{ title: 'Shirt', quantity: 1, grams: 300 }] };
  assert.equal(await a.webhook('/webhooks/orders/create', payload, 'orders/create'), 200);
  await a.settle();
  const s = await a.db.getShipment(SHOP, '803');
  assert.equal(s.status, 'sent', s.error);
  assert.equal(s.courier, 'steadfast');
  assert.equal(a.fake.state.steadfastOrders[0].cod_amount, 500);

  const d = await a.api('/settings', { method: 'POST', body: { steadfast_disconnect: true } });
  assert.equal(d.data.settings.default_courier, 'pathao');
  assert.equal(d.data.settings.auto_send, false);
  assert.equal(d.data.settings.steadfast.connected, false);
});
