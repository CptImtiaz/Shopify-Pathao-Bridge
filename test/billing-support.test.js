const test = require('node:test');
const assert = require('node:assert');
const { startApp, SHOP } = require('./helpers');

function restOrder(id, extra = {}) {
  return {
    id, name: `#${id}`, created_at: new Date(Date.now() + 1000).toISOString(), financial_status: 'pending',
    total_price: '990.00', total_outstanding: '990.00', note: '', tags: '',
    shipping_address: { name: 'Nasima', phone: '+8801912345678', address1: 'Road 7, Uttara Sector 4', city: 'Dhaka' },
    line_items: [{ title: 'Laddu', quantity: 1, grams: 500 }],
    ...extra,
  };
}

test('billing page data: plans, usage, history; yearly subscriptions use the yearly price', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  a.fake.state.allSubscriptions = [{ id: 'gid://shopify/AppSubscription/9', name: 'ShipBridge Pro (yearly)', status: 'CANCELLED', createdAt: '2026-09-01T00:00:00Z', currentPeriodEnd: null, trialDays: 7, test: true,
    lineItems: [{ plan: { pricingDetails: { __typename: 'AppRecurringPricing', interval: 'ANNUAL', price: { amount: '99.9', currencyCode: 'USD' } } } }] }];
  const b = (await a.api('/billing')).data;
  assert.equal(b.plan, 'free');
  assert.deepEqual(b.plans.map((p) => p.key), ['free', 'starter', 'pro']);
  assert.equal(b.usage.limit, 50);
  assert.equal(b.history[0].interval, 'yearly');
  assert.equal(b.history[0].price, 99.9);
  assert.match(b.shopifyBillingUrl, /admin\.shopify\.com\/store\/demo-store\/settings\/billing/);

  await a.api('/billing/subscribe', { method: 'POST', body: { plan: 'starter', interval: 'yearly' } });
  const sub = a.fake.state.lastSubscription;
  assert.equal(sub.name, 'AutoCourier BD Starter (yearly)');
  assert.equal(sub.lineItems[0].plan.appRecurringPricingDetails.interval, 'ANNUAL');
  assert.equal(sub.lineItems[0].plan.appRecurringPricingDetails.price.amount, 49.9);

  a.fake.state.activeSubscriptions = [{ id: 'gid://shopify/AppSubscription/10', name: 'ShipBridge Starter (yearly)', status: 'ACTIVE', test: true, trialDays: 7, currentPeriodEnd: '2027-11-03T00:00:00Z' }];
  const b2 = (await a.api('/billing')).data;
  assert.equal(b2.plan, 'starter');
  assert.equal(b2.interval, 'yearly');
  assert.equal(b2.usage.limit, 300);
});

test('support: the app collects no emails or messages; owner page shows no customer phones', async (t) => {
  const a = await startApp({ adminPassword: 'pw-123456' });
  t.after(() => a.close());
  assert.equal((await a.api('/support', { method: 'POST', body: { email: 'me@shop.com', message: 'Order #1001 shows returned' } })).status, 404);
  const s = await a.api('/support');
  assert.equal(s.status, 200);
  assert.equal(s.data.tickets, undefined);
  assert.ok('contact' in s.data);
  await a.api('/bootstrap');
  await a.db.pool.query(`INSERT INTO shipments (shop, shopify_order_id, order_name, status, error) VALUES ('test-shop.myshopify.com', '9', '#9', 'failed', 'Phone "01712345678" is not valid')`);
  const html = await (await fetch(a.base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from('x:pw-123456').toString('base64') } })).text();
  assert.doesNotMatch(html, /01712345678/);
  assert.match(html, /REDACTED/);
});

test('hold high-risk orders: a customer with repeated returns is held, not auto-sent', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77 } });
  await a.db.updateSettings(SHOP, { auto_send: true, auto_send_since: new Date(Date.now() - 60000) });
  // two past returns from the same phone
  for (const id of ['801', '802']) {
    await a.db.claimShipment(SHOP, id, `#${id}`);
    await a.db.finishShipment(SHOP, id, { status: 'sent', consignment_id: `C${id}`, pathao_status: 'returned', phone: '01912345678' });
  }
  await a.webhook('/webhooks/orders/create', restOrder(803), 'orders/create');
  await a.settle();
  const s = await a.db.getShipment(SHOP, 803);
  assert.equal(s.status, 'skipped');
  assert.match(s.error, /^Held for review/);

  await a.api('/settings', { method: 'POST', body: { hold_risky: false } });
  assert.equal((await a.api('/bootstrap')).data.settings.hold_risky, false);
});
