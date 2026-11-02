const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, fromWebhook, buildPathaoOrder, autoSendSkipReason } = require('../src/pathao/mapper');

test('normalizePhone handles the formats merchants complain about', () => {
  const cases = {
    '+8801741563884': '01741563884',
    '8801741563884': '01741563884',
    '01741563884': '01741563884',
    '+880 880 1832840889': '01832840889', // doubled country code
    '+880 01720128835': '01720128835', // country code + leading 0
    '00880 1712-345678': '01712345678',
    '1712345678': '01712345678',
    '(017) 1234 5678': '01712345678',
  };
  for (const [input, expected] of Object.entries(cases)) {
    const r = normalizePhone(input);
    assert.equal(r.phone, expected, input);
    assert.equal(r.valid, true, input);
  }
  assert.equal(normalizePhone('+60 12-345 6789').valid, false);
  assert.equal(normalizePhone('').valid, false);
});

const settings = { pathao_store_id: 77, delivery_type: 48, item_type: 2, default_weight: 0.5 };

function webhookOrder(extra = {}) {
  return {
    id: 5001, name: '#1001', created_at: '2026-11-02T05:00:00Z', financial_status: 'pending',
    total_price: '1500.00', total_outstanding: '1500.00', note: 'Leave at gate', tags: '',
    shipping_address: { name: 'Karim', phone: '+880 880 1712345678', address1: 'Flat 3B, 22 Gulshan Ave', city: 'Dhaka', zip: '1212', country: 'Bangladesh' },
    line_items: [{ title: 'Lai chee kang', quantity: 3, grams: 300 }],
    ...extra,
  };
}

test('buildPathaoOrder maps a COD order', () => {
  const { payload, errors } = buildPathaoOrder(fromWebhook(webhookOrder()), settings);
  assert.deepEqual(errors, []);
  assert.equal(payload.store_id, 77);
  assert.equal(payload.merchant_order_id, '#1001');
  assert.equal(payload.recipient_phone, '01712345678');
  assert.equal(payload.amount_to_collect, 1500);
  assert.equal(payload.item_quantity, 3);
  assert.equal(payload.item_weight, 0.9);
  assert.equal(payload.item_description, 'Lai chee kang x 3');
});

test('COD uses outstanding balance (partial payment / edits)', () => {
  const { payload } = buildPathaoOrder(fromWebhook(webhookOrder({ financial_status: 'partially_paid', total_outstanding: '500.40' })), settings);
  assert.equal(payload.amount_to_collect, 500);
  const paid = buildPathaoOrder(fromWebhook(webhookOrder({ financial_status: 'paid', total_outstanding: '0.00' })), settings);
  assert.equal(paid.payload.amount_to_collect, 0);
  const noOutstanding = buildPathaoOrder(fromWebhook(webhookOrder({ financial_status: 'paid', total_outstanding: undefined })), settings);
  assert.equal(noOutstanding.payload.amount_to_collect, 0);
});

test('weight falls back to default and is clamped to Pathao limits', () => {
  const zero = buildPathaoOrder(fromWebhook(webhookOrder({ line_items: [{ title: 'x', quantity: 1, grams: 0 }] })), { ...settings, default_weight: 1.5 });
  assert.equal(zero.payload.item_weight, 1.5);
  const light = buildPathaoOrder(fromWebhook(webhookOrder({ line_items: [{ title: 'x', quantity: 1, grams: 50 }] })), settings);
  assert.equal(light.payload.item_weight, 0.5);
  const heavy = buildPathaoOrder(fromWebhook(webhookOrder({ line_items: [{ title: 'x', quantity: 4, grams: 5000 }] })), settings);
  assert.equal(heavy.payload.item_weight, 10);
});

test('validation errors stop bad orders before they reach Pathao', () => {
  const r = buildPathaoOrder(fromWebhook(webhookOrder({ shipping_address: { name: 'A', phone: '123', address1: 'Dhaka' } })), { ...settings, pathao_store_id: null });
  assert.equal(r.errors.length, 3);
});

test('falls back to billing/customer phone if shipping phone is invalid', () => {
  const r = buildPathaoOrder(fromWebhook(webhookOrder({
    shipping_address: { name: 'Karim', phone: null, address1: 'Flat 3B, 22 Gulshan Ave', city: 'Dhaka' },
    billing_address: { phone: '01812345678' },
  })), settings);
  assert.equal(r.payload.recipient_phone, '01812345678');
  assert.deepEqual(r.errors, []);
});

test('autoSendSkipReason rules', () => {
  const o = fromWebhook(webhookOrder());
  assert.equal(autoSendSkipReason(o, { auto_send: false }), 'Auto-send is off');
  assert.equal(autoSendSkipReason(o, { auto_send: true, auto_send_since: '2026-11-03T00:00:00Z' }), 'Order was created before auto-send was turned on');
  assert.equal(autoSendSkipReason(o, { auto_send: true, auto_send_since: '2026-11-01T00:00:00Z' }), null);
  assert.match(autoSendSkipReason(fromWebhook(webhookOrder({ tags: 'vip, No-Pathao' })), { auto_send: true, skip_tag: 'no-pathao' }), /tag/);
  assert.match(autoSendSkipReason(fromWebhook(webhookOrder({ financial_status: 'paid', total_outstanding: '0' })), { auto_send: true, only_cod: true }), /prepaid/);
});
