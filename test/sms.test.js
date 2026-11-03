const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, SHOP } = require('./helpers');
const { buildOrderSms, sourceAllowed, smsPhone, csmsIdFor, DEFAULT_TEMPLATE } = require('../src/sms/sms');

function order(id, extra = {}) {
  return {
    id, name: `#${id}`, created_at: new Date(Date.now() + 1000).toISOString(), source_name: 'web', currency: 'BDT',
    financial_status: 'pending', total_price: '990.00', total_outstanding: '990.00', tags: '',
    shipping_address: { name: 'Nasima', phone: '+880 1912-345678', address1: 'Road 7, Uttara Sector 4', city: 'Dhaka' },
    line_items: [{ title: 'Laddu', quantity: 2, grams: 500 }],
    ...extra,
  };
}

async function smsReady(t, source = 'web', extra = {}) {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  const r = await a.api('/settings', { method: 'POST', body: { sms_token: 'tok-123', sms_sid: 'WELLESSIA', sms_source: source, sms_enabled: true, ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 20));
  return a;
}

test('message template, phone format and csms_id', () => {
  const m = buildOrderSms(order(77), 'Hi {{name}}, order {{order_number}} ({{items}}) {{currency}} {{total}}');
  assert.equal(m.text, 'Hi Nasima, order #77 (Laddu x2) BDT 990.00');
  assert.equal(m.phone, '8801912345678');
  assert.equal(smsPhone('+880 880 1712345678'), '8801712345678');
  assert.equal(smsPhone('12345'), '');
  assert.match(buildOrderSms(order(1), null).text, /Nasima, আপনার অর্ডার #1 কনফার্ম/);
  assert.ok(DEFAULT_TEMPLATE.includes('{{order_number}}'));
  assert.ok(csmsIdFor('123456789012345678').length <= 20);
});

test('source filter: all / web only / manual only', () => {
  assert.equal(sourceAllowed('all', 'pos'), true);
  assert.equal(sourceAllowed('web', 'web'), true);
  assert.equal(sourceAllowed('web', 'shopify_draft_order'), false);
  assert.equal(sourceAllowed('manual', 'shopify_draft_order'), true);
  assert.equal(sourceAllowed('manual', 'web'), false);
});

test('web-only: online order gets one SMS (duplicates ignored), manual order does not', async (t) => {
  const a = await smsReady(t, 'web');
  const o = order(501);
  await Promise.all([a.webhook('/webhooks/orders/create', o, 'orders/create'), a.webhook('/webhooks/orders/create', o, 'orders/create')]);
  await a.settle();
  await a.webhook('/webhooks/orders/create', order(502, { source_name: 'shopify_draft_order' }), 'orders/create');
  await a.settle();
  assert.equal(a.fake.state.sms.length, 1);
  const sent = a.fake.state.sms[0];
  assert.equal(sent.api_token, 'tok-123');
  assert.equal(sent.sid, 'WELLESSIA');
  assert.equal(sent.sms[0].msisdn, '8801912345678');
  const rows = await a.db.smsForOrders(SHOP, ['501', '502']);
  assert.equal(rows.find((r) => r.shopify_order_id === '501').status, 'sent');
  assert.equal(rows.find((r) => r.shopify_order_id === '502').status, 'skipped');
});

test('manual-only and all modes', async (t) => {
  const a = await smsReady(t, 'manual');
  await a.webhook('/webhooks/orders/create', order(601), 'orders/create');
  await a.webhook('/webhooks/orders/create', order(602, { source_name: 'shopify_draft_order' }), 'orders/create');
  await a.settle();
  assert.deepEqual(a.fake.state.sms.map((s) => s.sms[0].csms_id.startsWith('602')), [true]);

  await a.api('/settings', { method: 'POST', body: { sms_source: 'all' } });
  await a.webhook('/webhooks/orders/create', order(603, { source_name: 'pos' }), 'orders/create');
  await a.settle();
  assert.equal(a.fake.state.sms.length, 2);
});

test('SMS off, old orders, bad phone, provider failure; Pathao still books when SMS fails', async (t) => {
  const a = await smsReady(t, 'all');
  await a.webhook('/webhooks/orders/create', order(701, { created_at: '2020-01-01T00:00:00Z' }), 'orders/create');
  await a.webhook('/webhooks/orders/create', order(702, { shipping_address: { name: 'X', phone: '123', address1: 'House 1, Road 2, Banani' } }), 'orders/create');
  await a.settle();
  assert.equal(a.fake.state.sms.length, 0);
  assert.match((await a.db.smsForOrders(SHOP, ['702']))[0].error, /not a valid Bangladesh mobile/);

  // Pathao connected + auto-send, SMS provider down
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77, auto_send: true } });
  await new Promise((r) => setTimeout(r, 20));
  a.fake.state.smsFail = 'Invalid SID';
  await a.webhook('/webhooks/orders/create', order(703), 'orders/create');
  await a.settle();
  assert.match((await a.db.smsForOrders(SHOP, ['703']))[0].error, /Invalid SID/);
  assert.equal((await a.db.getShipment(SHOP, 703)).status, 'sent', 'Pathao booking unaffected by SMS failure');

  await a.api('/settings', { method: 'POST', body: { sms_enabled: false } });
  a.fake.state.smsFail = null;
  const before = a.fake.state.sms.length;
  await a.webhook('/webhooks/orders/create', order(704), 'orders/create');
  await a.settle();
  assert.equal(a.fake.state.sms.length, before, 'no SMS when turned off');
});

test('settings: token encrypted and hidden, SMS needs token+SID, test SMS endpoint', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  assert.equal((await a.api('/settings', { method: 'POST', body: { sms_enabled: true } })).status, 400);
  await a.api('/settings', { method: 'POST', body: { sms_token: 'secret-token', sms_sid: 'SID1', sms_source: 'web' } });
  const s = await a.db.getSettings(SHOP);
  assert.ok(s.sms_token_enc.startsWith('v1:'));
  const boot = await a.api('/bootstrap');
  assert.ok(!JSON.stringify(boot.data).includes('secret-token'));
  assert.equal(boot.data.settings.sms.configured, true);
  assert.equal(boot.data.settings.sms.sources.length, 3);
  assert.equal((await a.api('/settings', { method: 'POST', body: { sms_source: 'nope' } })).status, 400);

  const bad = await a.api('/sms/test', { method: 'POST', body: { phone: '999' } });
  assert.equal(bad.status, 400);
  const ok = await a.api('/sms/test', { method: 'POST', body: { phone: '01712345678' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.to, '8801712345678');
});

test('orders list shows SMS status', async (t) => {
  const a = await smsReady(t, 'web');
  const { gqlOrder } = require('./helpers');
  await a.webhook('/webhooks/orders/create', order(801), 'orders/create');
  await a.settle();
  a.fake.state.orders['801'] = gqlOrder(801);
  const r = await a.api('/orders');
  assert.equal(r.data.orders[0].sms.status, 'sent');
});
