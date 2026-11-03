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
