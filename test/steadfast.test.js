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

test('steadfast "Account is not active!" is reported as an inactive account, not wrong keys', () => {
  const { makeSteadfast } = require('../src/couriers/steadfast');
  const sf = makeSteadfast({ config: {}, cipher: { decrypt: (x) => x }, fetchImpl: async () => new Response(JSON.stringify({ message: 'Account is not active!' }), { status: 401 }) });
  return sf.balance({ steadfast_api_key: 'k', steadfast_secret_enc: 's' }, { probe: true }).then(
    () => assert.fail('should throw'),
    (e) => { assert.match(e.message, /account is not active yet/); assert.doesNotMatch(e.message, /rejected the API key/); }
  );
});

test('steadfast webhook: tracking updates save the message; events are logged; invoice-only events still match', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['820'] = gqlOrder(820);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['820'], courier: 'steadfast' } });
  const token = (await a.api('/bootstrap')).data.steadfastWebhook.token;

  // tracking_update without a status: message saved, status unchanged
  let r = await sfHook(a, { notification_type: 'tracking_update', consignment_id: 5001, invoice: '820', tracking_message: 'Parcel received at Dhaka hub' }, { token });
  assert.equal(r.status, 200);
  await a.settle();
  let s = await a.db.getShipment(SHOP, '820');
  assert.equal(s.courier_message, 'Parcel received at Dhaka hub');
  assert.equal(s.pathao_status, 'in_review');
  assert.ok(a.logs.some((l) => /steadfast webhook: tracking_update cid=5001 .*order=#820/.test(l)), 'event logged');

  // status change found by invoice only
  r = await sfHook(a, { notification_type: 'delivery_status', invoice: '820', status: 'pending', tracking_message: 'Assigned to rider' }, { token });
  assert.equal(r.status, 200);
  await a.settle();
  s = await a.db.getShipment(SHOP, '820');
  assert.equal(s.pathao_status, 'pending');
  assert.equal(s.courier_message, 'Assigned to rider');
  const o = (await a.api('/orders?fresh=1')).data.orders.find((x) => x.id === '820');
  assert.equal(o.shipment.courierMessage, 'Assigned to rider');

  // unknown parcel: acknowledged and logged as not found
  r = await sfHook(a, { notification_type: 'delivery_status', consignment_id: 999, status: 'delivered' }, { token });
  assert.equal(r.status, 200);
  assert.ok(a.logs.some((l) => /cid=999 .*order=not found/.test(l)));
});

test('steadfast cancel_request: raised = message only, approved = cancelled; other events never set a fake status', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['830'] = gqlOrder(830);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['830'], courier: 'steadfast' } });
  const token = (await a.api('/bootstrap')).data.steadfastWebhook.token;

  await sfHook(a, { notification_type: 'cancel_request', consignment_id: 5001, status: 'pending' }, { token });
  await a.settle();
  let s = await a.db.getShipment(SHOP, '830');
  assert.equal(s.pathao_status, 'in_review', '"pending" of a cancel request is not a parcel status');
  assert.match(s.courier_message, /Cancellation requested/);

  await sfHook(a, { notification_type: 'pickup_request', consignment_id: 5001, status: 'approved' }, { token });
  await a.settle();
  assert.equal((await a.db.getShipment(SHOP, '830')).pathao_status, 'in_review');

  await sfHook(a, { notification_type: 'cancel_request', consignment_id: 5001, status: 'approved' }, { token });
  await a.settle();
  s = await a.db.getShipment(SHOP, '830');
  assert.equal(s.pathao_status, 'cancelled');
  assert.match(s.courier_message, /Cancellation approved/);
  const o = (await a.api('/orders?fresh=1')).data.orders.find((x) => x.id === '830');
  assert.equal(o.shipment.pathaoStatus, 'cancelled');
});

test('main Refresh asks couriers for active parcels only, and picks up a cancellation', async (t) => {
  const a = await steadfastShop(t);
  for (const id of [840, 841]) a.fake.state.orders[id] = gqlOrder(id);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['840', '841'], courier: 'steadfast' } });
  await a.db.finishShipment(SHOP, '841', { pathao_status: 'delivered' });
  a.fake.state.steadfastStatus['5001'] = 'cancelled';
  const before = a.fake.calls.filter((c) => c.url.includes('/status_by_cid/')).length;
  const r = await a.api('/orders/refresh-active', { method: 'POST' });
  assert.deepEqual(r.data, { checked: 1, changed: 1, failed: 0 });
  assert.equal(a.fake.calls.filter((c) => c.url.includes('/status_by_cid/')).length - before, 1, 'delivered parcel not checked');
  assert.equal((await a.db.getShipment(SHOP, '840')).pathao_status, 'cancelled');
});

test('parcel removed in Steadfast (unknown while in review) goes back to Not sent and can be sent again', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['850'] = gqlOrder(850);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['850'], courier: 'steadfast' } });
  let s = await a.db.getShipment(SHOP, '850');
  assert.ok(s.shopify_fulfillment_id, 'fulfilled when sent');
  a.fake.state.steadfastStatus['5001'] = 'unknown';
  const r = await a.api('/orders/refresh-active', { method: 'POST' });
  assert.equal(r.data.changed, 1);
  s = await a.db.getShipment(SHOP, '850');
  assert.equal(s.status, 'skipped');
  assert.match(s.error, /Removed in Steadfast/);
  assert.equal(s.consignment_id, null);
  assert.equal(s.counted, false, 'does not use up the monthly limit');
  assert.equal(s.shopify_fulfillment_id, null);
  assert.ok(a.fake.calls.some((c) => c.body && c.body.includes('fulfillmentCancel')), 'Shopify fulfillment undone');
  // can be sent again
  const again = await a.api('/orders/send', { method: 'POST', body: { ids: ['850'], courier: 'steadfast' } });
  assert.equal(again.data.results[0].ok, true, again.data.results[0].error);
  assert.equal((await a.db.getShipment(SHOP, '850')).consignment_id, '5002');
});

test('tracker checks every shop with parcels on the way', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['860'] = gqlOrder(860);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['860'], courier: 'steadfast' } });
  a.fake.state.steadfastStatus['5001'] = 'delivered';
  assert.deepEqual(await a.db.shopsWithActiveShipments(), [SHOP]);
  await a.tracker.pollAll();
  assert.equal((await a.db.getShipment(SHOP, '860')).pathao_status, 'delivered');
});

test('a parcel already saved as unknown is also treated as removed', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['870'] = gqlOrder(870);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['870'], courier: 'steadfast' } });
  await a.db.finishShipment(SHOP, '870', { pathao_status: 'unknown' });
  a.fake.state.steadfastStatus['5001'] = 'unknown';
  await a.tracker.pollAll();
  assert.equal((await a.db.getShipment(SHOP, '870')).status, 'skipped');
});

test('live updates: an open dashboard is told the moment a courier webhook changes an order', async (t) => {
  const { sessionToken } = require('./helpers');
  const a = await steadfastShop(t);
  a.fake.state.orders['880'] = gqlOrder(880);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['880'], courier: 'steadfast' } });
  const token = (await a.api('/bootstrap')).data.steadfastWebhook.token;

  const ctrl = new AbortController();
  const res = await fetch(`${a.base}/api/events`, { headers: { Authorization: `Bearer ${sessionToken()}` }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let text = '';
  const until = async (re) => { const end = Date.now() + 3000; while (!re.test(text) && Date.now() < end) { const { value } = await reader.read(); text += dec.decode(value || new Uint8Array(), { stream: true }); } return re.test(text); };
  assert.ok(await until(/: connected/), 'stream opened');
  await sfHook(a, { notification_type: 'delivery_status', consignment_id: 5001, status: 'delivered' }, { token });
  assert.ok(await until(/data: \{"type":"orders"/), 'event pushed');
  ctrl.abort();
  await a.settle();
  assert.equal(a.bus.count(SHOP), 0, 'listener removed when the dashboard closes');
});

test('steadfast webhook in the older format (no notification_type, bearer token only) still updates the order', async (t) => {
  const a = await steadfastShop(t);
  a.fake.state.orders['890'] = gqlOrder(890);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['890'], courier: 'steadfast' } });
  const token = (await a.api('/bootstrap')).data.steadfastWebhook.token;
  // Payload shape from Steadfast's own Laravel package example.
  const r = await sfHook(a, { consignment_id: 5001, invoice: '890', status: 'delivered', cod_amount: 990, updated_at: '2026-11-05 10:00:00' }, { token, bearerOnly: true });
  assert.equal(r.status, 200);
  await a.settle();
  assert.equal((await a.db.getShipment(SHOP, '890')).pathao_status, 'delivered');
});

test('steadfast delivery settings: optional fields are only sent when switched on', () => {
  const base = order({ fallbackPhones: ['01911222333'], items: [{ title: 'Panjabi', quantity: 2, grams: 0 }, { title: 'Cap', quantity: 1, grams: 0 }] });
  let p = buildSteadfastOrder(base, {}).payload;
  assert.equal(p.item_description, 'Panjabi x 2, Cap x 1', 'product list on by default (as before)');
  assert.equal('total_lot' in p, false);
  assert.equal('delivery_type' in p, false);
  assert.equal('alternative_phone' in p, false);
  p = buildSteadfastOrder(base, { sf_item_desc: false, sf_total_lot: true, sf_delivery_type: 1, sf_alt_phone: true }).payload;
  assert.equal('item_description' in p, false);
  assert.equal(p.total_lot, 3);
  assert.equal(p.delivery_type, 1);
  assert.equal(p.alternative_phone, '01911222333');
  // second phone equal to the main one is not sent
  assert.equal('alternative_phone' in buildSteadfastOrder(order({ fallbackPhones: ['+8801712345678'] }), { sf_alt_phone: true }).payload, false);
});

test('steadfast delivery settings are saved and used when sending', async (t) => {
  const a = await steadfastShop(t);
  const r = await a.api('/settings', { method: 'POST', body: { sf_delivery_type: 1, sf_total_lot: true, sf_item_desc: false } });
  assert.deepEqual([r.data.settings.steadfast.delivery_type, r.data.settings.steadfast.total_lot, r.data.settings.steadfast.item_desc], [1, true, false]);
  a.fake.state.orders['900'] = gqlOrder(900);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['900'], courier: 'steadfast' } });
  const sent = a.fake.state.steadfastOrders[0];
  assert.equal(sent.delivery_type, 1);
  assert.equal(sent.total_lot, 2);
  assert.equal('item_description' in sent, false);
});

test('tracker skips a courier that is not connected (no error spam)', async (t) => {
  const a = await steadfastShop(t);
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77 } });
  a.fake.state.orders['910'] = gqlOrder(910);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['910'], courier: 'pathao' } });
  await a.db.updateSettings(SHOP, { pathao_client_id: null }); // Pathao disconnected afterwards
  const r = await a.tracker.refreshActive(SHOP);
  assert.equal(r.failed, 0);
  assert.equal(a.logs.some((l) => /status check #910 failed/.test(l)), false);
});

test('webhook: a call with the wrong token is recorded and shown; changing the token clears it; only real calls make it Live', async (t) => {
  const a = await steadfastShop(t);
  assert.equal((await a.api('/settings', { method: 'POST', body: { steadfast_webhook_token: 'my-own-token-1234567890' } })).status, 200);
  let boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.steadfastWebhook.live, false);
  assert.equal(boot.steadfastWebhook.refusedAt, null);
  // Steadfast portal still has another token
  const bad = await sfHook(a, { notification_type: 'tracking_update', consignment_id: 1, tracking_message: 'x' }, { token: 'old-token-from-the-portal-xyz' });
  assert.equal(bad.status, 401);
  boot = (await a.api('/bootstrap')).data;
  assert.ok(boot.steadfastWebhook.refusedAt, 'refused call recorded');
  assert.equal(boot.steadfastWebhook.live, false);
  assert.ok(a.logs.some((l) => /steadfast webhook refused/.test(l)));
  // merchant pastes the portal's token here -> warning cleared; next real call -> Live
  await a.api('/settings', { method: 'POST', body: { steadfast_webhook_token: 'old-token-from-the-portal-xyz' } });
  assert.equal((await a.api('/bootstrap')).data.steadfastWebhook.refusedAt, null);
  const ok = await sfHook(a, { notification_type: 'tracking_update', consignment_id: 1, tracking_message: 'x' }, { token: 'old-token-from-the-portal-xyz' });
  assert.equal(ok.status, 200);
  assert.equal((await a.api('/bootstrap')).data.steadfastWebhook.live, true);
  assert.equal((await a.api('/settings', { method: 'POST', body: { steadfast_webhook_token: 'short' } })).status, 400);
  // the old self-test is gone
  assert.equal((await a.api('/webhooks/test', { method: 'POST', body: { courier: 'steadfast' } })).status, 404);
});

test('auto-send needs a connected default courier; otherwise the order says why', async (t) => {
  const a = await steadfastShop(t);
  // Pathao is not connected: it can't be default, and auto-send can't run on it
  assert.equal((await a.api('/settings', { method: 'POST', body: { auto_send: true } })).status, 400);
  assert.equal((await a.api('/settings', { method: 'POST', body: { default_courier: 'pathao' } })).status, 400);
  const r = await a.api('/settings', { method: 'POST', body: { default_courier: 'steadfast', auto_send: true, hold_risky: false } });
  assert.equal(r.status, 200, r.data.error);
  await new Promise((res) => setTimeout(res, 20));
  const payload = { id: 920, name: '#920', created_at: new Date(Date.now() + 1000).toISOString(), financial_status: 'pending', total_price: '500', total_outstanding: '500', tags: '',
    total_weight: 1500, shipping_address: { name: 'Mim', phone: '01812345678', address1: 'Road 2, Mirpur 10', city: 'Dhaka' }, line_items: [{ title: 'Shirt', quantity: 1, grams: 0 }] };
  await a.webhook('/webhooks/orders/create', payload, 'orders/create');
  await a.settle();
  assert.equal((await a.db.getShipment(SHOP, '920')).courier, 'steadfast', 'auto-sent with Steadfast');
  // an old bad state (default = Pathao, not connected, auto-send on) explains itself
  await a.db.updateSettings(SHOP, { default_courier: 'pathao' });
  await a.webhook('/webhooks/orders/create', { ...payload, id: 921, name: '#921' }, 'orders/create');
  await a.settle();
  assert.match((await a.db.getShipment(SHOP, '921')).error, /Pathao \(your default courier\) is not connected/);
});

test('Pathao weight uses Shopify product weights, or the order total weight', () => {
  const { buildPathaoOrder } = require('../src/pathao/mapper');
  const o = order({ items: [{ title: 'Shirt', quantity: 2, grams: 0 }], totalGrams: 1800 });
  assert.equal(buildPathaoOrder(o, { pathao_store_id: 1 }).payload.item_weight, 1.8);
  const o2 = order({ items: [{ title: 'Shirt', quantity: 2, grams: 700 }], totalGrams: 0 });
  assert.equal(buildPathaoOrder(o2, { pathao_store_id: 1 }).payload.item_weight, 1.4);
  assert.equal(buildPathaoOrder(order({ items: [{ title: 'x', quantity: 1, grams: 0 }] }), { pathao_store_id: 1, default_weight: 0.5 }).payload.item_weight, 0.5);
});

test('once a webhook is live, parcels are not polled (except Steadfast parcels still in review)', async (t) => {
  const a = await steadfastShop(t);
  for (const id of ['930', '931']) a.fake.state.orders[id] = gqlOrder(Number(id));
  await a.api('/orders/send', { method: 'POST', body: { ids: ['930', '931'], courier: 'steadfast' } });
  await a.db.finishShipment(SHOP, '931', { pathao_status: 'pending' }); // approved: only the webhook updates it now
  a.fake.state.steadfastStatus['5001'] = 'in_review'; // 930 still waiting for Steadfast's review
  a.fake.state.steadfastStatus['5002'] = 'pending';
  const calls = () => a.fake.calls.filter((c) => c.url.includes('/status_by_cid/')).map((c) => c.url.split('/').pop());
  // not live yet: both checked
  let before = calls().length;
  await a.tracker.refreshActive(SHOP);
  assert.equal(calls().length - before, 2);
  // Steadfast's own test arrives -> Live
  const token = (await a.api('/bootstrap')).data.steadfastWebhook.token;
  assert.equal((await sfHook(a, { notification_type: 'webhook_test' }, { token })).status, 200);
  assert.equal((await a.api('/bootstrap')).data.steadfastWebhook.live, true);
  before = calls().length;
  await a.tracker.refreshActive(SHOP);
  assert.deepEqual(calls().slice(before), ['5001'], 'only the in-review parcel is still checked (removal)');
});

test('saving a webhook marks it set up; Live still comes only from the courier', async (t) => {
  const a = await steadfastShop(t);
  let boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.steadfastWebhook.saved, false);
  await a.api('/settings', { method: 'POST', body: { steadfast_webhook_token: boot.steadfastWebhook.token } });
  await a.api('/settings', { method: 'POST', body: { webhook_secret: 'pathao-secret-123' } });
  boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.steadfastWebhook.saved, true);
  assert.equal(boot.pathaoWebhook.saved, true);
  assert.equal(boot.steadfastWebhook.live, false);
});
