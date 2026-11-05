const test = require('node:test');
const assert = require('node:assert');
const { makeRedactor, redactingLog } = require('../src/redact');

test('redact: own secrets by value, credential shapes by pattern', () => {
  const r = makeRedactor(['super-secret-value', '0123456789abcdef'.repeat(4)]);
  assert.equal(r('key super-secret-value here'), 'key [redacted] here');
  assert.equal(r('connect postgres://admin:pw123@db.internal:5432/app failed'), 'connect postgres://[redacted]@db.internal:5432/app failed');
  assert.equal(r('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [redacted]');
  assert.equal(r('{"access_token":"xyz12345","x":1}'), '{"access_token":"[redacted]","x":1}');
  assert.equal(r('got shpat_abc123DEF'), 'got [redacted]');
  assert.equal(r('Phone "555" isn\'t a Bangladesh mobile number'), 'Phone "555" isn\'t a Bangladesh mobile number');
});

test('redacting logger blanks secrets in every argument', () => {
  const lines = [];
  const log = redactingLog({ info: (...m) => lines.push(m.join(' ')), warn: () => {}, error: () => {} }, makeRedactor(['hunter2-secret']));
  log.info('password is', 'hunter2-secret');
  assert.equal(lines[0], 'password is [redacted]');
});
