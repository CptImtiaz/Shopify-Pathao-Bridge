const test = require('node:test');
const assert = require('node:assert');
const { assessOrder } = require('../src/fraud');
const { fromGraphql } = require('../src/pathao/mapper');
const { gqlOrder } = require('./helpers');

const order = (extra) => fromGraphql(gqlOrder(1, extra));
const sent = (status) => ({ status: 'sent', pathao_status: status });

test('new customer with a valid phone is low risk', () => {
  const r = assessOrder(order(), {});
  assert.equal(r.level, 'low');
  assert.equal(r.phone, '01712345678');
  assert.match(r.reasons.map((x) => x.text).join(' '), /New customer/);
});

test('returning customer with deliveries is safe', () => {
  const r = assessOrder(order(), { history: [sent('Delivered'), sent('Delivered')] });
  assert.equal(r.level, 'safe');
  assert.equal(r.history.successRate, 100);
});

test('one return is medium, repeated returns are high', () => {
  assert.equal(assessOrder(order(), { history: [sent('Delivered'), sent('Return')] }).level, 'medium');
  const r = assessOrder(order(), { history: [sent('Returned'), sent('Cancelled'), sent('Delivered')] });
  assert.equal(r.level, 'high');
  assert.equal(r.history.successRate, 33);
});

test('invalid phone, short address, duplicates and Shopify risk raise the level', () => {
  assert.equal(assessOrder(order({ shippingAddress: { ...gqlOrder(1).shippingAddress, phone: '12345' } })).level, 'high');
  assert.equal(assessOrder(order({ shippingAddress: { ...gqlOrder(1).shippingAddress, address1: 'X', address2: null, city: null } })).level, 'medium');
  assert.equal(assessOrder(order(), { duplicates: [{}] }).level, 'medium');
  assert.equal(assessOrder(order({ risk: { recommendation: 'CANCEL', assessments: [{ riskLevel: 'HIGH', facts: [{ description: 'Card declined 4 times', sentiment: 'NEGATIVE' }] }] } })).level, 'high');
  assert.equal(assessOrder(order({ risk: { recommendation: 'INVESTIGATE', assessments: [{ riskLevel: 'MEDIUM', facts: [] }] } })).level, 'medium');
  assert.equal(assessOrder(order({ risk: { recommendation: 'NONE', assessments: [{ riskLevel: 'PENDING', facts: [] }] } })).level, 'pending');
});

test('high COD is flagged without hiding worse problems', () => {
  const big = { totalPriceSet: { shopMoney: { amount: '15000', currencyCode: 'BDT' } }, totalOutstandingSet: { shopMoney: { amount: '15000' } } };
  const r = assessOrder(order(big), { history: [sent('Delivered')] });
  assert.equal(r.level, 'low');
  assert.match(r.reasons.map((x) => x.text).join(' '), /High cash-on-delivery/);
});

test('dashboard overview counts every shipment by delivery stage, COD and success rate', () => {
  const { summarise } = require('../src/stats');
  const now = new Date('2026-11-03T12:00:00');
  const at = (d) => new Date(`2026-11-0${d}T10:00:00`);
  const rows = [
    { status: 'sent', pathao_status: 'delivered', amount_to_collect: 1000, delivery_fee: 60, created_at: at(1) },
    { status: 'sent', pathao_status: 'partial-delivery', amount_to_collect: 500, delivery_fee: 60, created_at: at(2) },
    { status: 'sent', pathao_status: 'in-transit', amount_to_collect: 800, delivery_fee: 70, created_at: at(3) },
    { status: 'sent', pathao_status: 'assigned-for-delivery', amount_to_collect: 200, delivery_fee: 60, created_at: at(3) },
    { status: 'sent', pathao_status: 'picked', amount_to_collect: 300, delivery_fee: 60, created_at: at(3) },
    { status: 'sent', pathao_status: 'Pending', amount_to_collect: 100, delivery_fee: 60, created_at: at(3) },
    { status: 'sent', pathao_status: 'returned', amount_to_collect: 900, delivery_fee: 60, created_at: at(2) },
    { status: 'failed', pathao_status: null, amount_to_collect: null, delivery_fee: null, created_at: at(3) },
    { status: 'sent', pathao_status: 'delivered', amount_to_collect: 999, delivery_fee: 60, created_at: new Date('2026-10-20T10:00:00') },
  ];
  const m = summarise(rows, { range: 'month', now });
  assert.equal(m.sent, 7);
  assert.equal(m.delivered, 2);
  assert.equal(m.transit, 2);
  assert.equal(m.picked, 1);
  assert.equal(m.booked, 1);
  assert.equal(m.onTheWay, 4);
  assert.equal(m.returned, 1);
  assert.equal(m.notSent, 1);
  assert.equal(m.successRate, 67);
  assert.equal(m.codCollected, 1500);
  assert.equal(m.codOnTheWay, 1400);
  assert.equal(m.daily.length, 14);
  assert.equal(m.daily[13].booked, 4);
  assert.equal(summarise(rows, { range: 'all', now }).delivered, 3);
  assert.equal(summarise(rows, { range: 'today', now }).sent, 4);
});

test('stats: custom from/to range (to is exclusive) overrides the preset', () => {
  const { summarise } = require('../src/stats');
  const row = (day, status = 'sent', ps = 'Delivered') => ({ created_at: new Date(Date.UTC(2026, 10, day, 6)).toISOString(), status, pathao_status: ps, amount_to_collect: 100 });
  const rows = [row(1), row(2), row(3, 'sent', 'Pending'), row(5)];
  const m = summarise(rows, { range: 'month', from: new Date(Date.UTC(2026, 10, 2)), to: new Date(Date.UTC(2026, 10, 4)) });
  assert.equal(m.range, 'custom');
  assert.equal(m.sent, 2);
  assert.equal(m.delivered, 1);
  assert.equal(summarise(rows, { from: new Date(Date.UTC(2026, 10, 3)) }).sent, 2);
});
