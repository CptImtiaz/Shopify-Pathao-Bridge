const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, sessionToken, gqlOrder, SHOP } = require('./helpers');

async function connected(t) {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  const s = await a.api('/settings', { method: 'POST', body: {
    pathao_client_id: 'cid', pathao_client_secret: 'csecret', pathao_username: 'me@shop.com', pathao_password: 'pw',
  } });
  assert.equal(s.status, 200);
  return a;
}

function restOrder(id, extra = {}) {
  return {
    id, name: `#${id}`, created_at: new Date(Date.now() + 1000).toISOString(), financial_status: 'pending',
    total_price: '990.00', total_outstanding: '990.00', note: '', tags: '',
    shipping_address: { name: 'Nasima', phone: '+8801912345678', address1: 'Road 7, Uttara Sector 4', city: 'Dhaka' },
    line_items: [{ title: 'Laddu', quantity: 1, grams: 500 }],
    ...extra,
  };
}

test('API rejects missing / forged / expired session tokens', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  assert.equal((await a.api('/bootstrap', { token: 'nope' })).status, 401);
  const forged = sessionToken().slice(0, -3) + 'abc';
  assert.equal((await a.api('/bootstrap', { token: forged })).status, 401);
  const expired = sessionToken(SHOP, { exp: Math.floor(Date.now() / 1000) - 120 });
  const r = await a.api('/bootstrap', { token: expired });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('x-shopify-retry-invalid-session-request'), '1');
});

test('first load exchanges for an expiring offline token and stores it encrypted', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const r = await a.api('/bootstrap');
  assert.equal(r.status, 200);
  assert.equal(r.data.plan, 'free');
  assert.equal(r.data.usage.limit, 50);
  assert.match(r.data.pathaoWebhook.url, /\/pathao\/webhook\/demo-store\.myshopify\.com$/);

  const exch = a.fake.calls.find((c) => c.url.endsWith('/admin/oauth/access_token'));
  const params = new URLSearchParams(exch.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(params.get('expiring'), '1');

  const row = await a.db.getShop(SHOP);
  assert.ok(row.access_token_enc.startsWith('v1:'));
  assert.ok(!row.access_token_enc.includes('shpat_'));
  assert.ok(row.refresh_token_enc);
});

test('expired offline token is refreshed with the refresh token (webhook path, no session)', async (t) => {
  const a = await connected(t);
  // Force the stored token to look expired.
  await a.db.pool.query(`UPDATE shops SET access_expires_at = NOW() - INTERVAL '1 minute'`);
  await a.db.updateSettings(SHOP, { auto_send: true, auto_send_since: new Date(Date.now() - 60000), pathao_store_id: 77, tag_orders: true });
  const status = await a.webhook('/webhooks/orders/create', restOrder(9001), 'orders/create');
  assert.equal(status, 200);
  await a.settle();
  const refresh = a.fake.calls.filter((c) => c.url.endsWith('/admin/oauth/access_token')).map((c) => new URLSearchParams(c.body).get('grant_type'));
  assert.ok(refresh.includes('refresh_token'), 'should refresh');
  const tagCall = a.fake.calls.find((c) => c.url.includes('graphql') && c.body.includes('tagsAdd'));
  assert.match(tagCall.headers['X-Shopify-Access-Token'], /shpat_refreshed/);
});

test('connect Pathao: credentials encrypted, test lists stores, secrets never returned', async (t) => {
  const a = await connected(t);
  const s = await a.db.getSettings(SHOP);
  assert.ok(s.pathao_password_enc.startsWith('v1:'));
  const test1 = await a.api('/pathao/test', { method: 'POST' });
  assert.equal(test1.data.ok, true);
  assert.equal(test1.data.stores[0].id, 77);
  const boot = await a.api('/bootstrap');
  const txt = JSON.stringify(boot.data);
  assert.ok(!txt.includes('csecret') && !txt.includes('"pw"'));
  assert.equal(boot.data.settings.connected, true);

  await a.api('/settings', { method: 'POST', body: { pathao_password: 'wrong' } });
  const bad = await a.api('/pathao/test', { method: 'POST' });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /Invalid credentials/);
});

test('auto-send cannot be enabled without a store', async (t) => {
  const a = await connected(t);
  const r = await a.api('/settings', { method: 'POST', body: { auto_send: true } });
  assert.equal(r.status, 400);
});

test('orders/create webhook: HMAC enforced, auto-send books once, duplicates ignored', async (t) => {
  const a = await connected(t);
  assert.equal(await a.webhook('/webhooks/orders/create', restOrder(1), 'orders/create').then(() => 200), 200);
  // bad HMAC
  const bad = await fetch(a.base + '/webhooks/orders/create', { method: 'POST', headers: { 'X-Shopify-Hmac-Sha256': 'x', 'X-Shopify-Shop-Domain': SHOP }, body: '{}' });
  assert.equal(bad.status, 401);

  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77, auto_send: true } });
  await new Promise((r) => setTimeout(r, 20));

  const order = restOrder(4242);
  // Shopify may deliver the same webhook twice, concurrently.
  await Promise.all([a.webhook('/webhooks/orders/create', order, 'orders/create'), a.webhook('/webhooks/orders/create', order, 'orders/create')]);
  await a.settle();
  await a.webhook('/webhooks/orders/create', order, 'orders/create');
  await a.settle();

  const creates = a.fake.calls.filter((c) => c.url.endsWith('/aladdin/api/v1/orders'));
  assert.equal(creates.length, 1, 'Pathao order created exactly once');
  const payload = JSON.parse(creates[0].body);
  assert.equal(payload.recipient_phone, '01912345678');
  assert.equal(payload.amount_to_collect, 990);
  assert.equal(payload.store_id, 77);
  const sh = await a.db.getShipment(SHOP, 4242);
  assert.equal(sh.status, 'sent');
  assert.match(sh.consignment_id, /^DL/);

  // Old order (created before auto-send) ignored entirely
  await a.webhook('/webhooks/orders/create', restOrder(4243, { created_at: '2020-01-01T00:00:00Z' }), 'orders/create');
  await a.settle();
  assert.equal(await a.db.getShipment(SHOP, 4243), null);
});

test('manual send from dashboard, failure then retry after merchant fixes the order', async (t) => {
  const a = await connected(t);
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
  a.fake.state.orders['700'] = gqlOrder(700, { shippingAddress: { ...gqlOrder(700).shippingAddress, phone: '12345' } });
  a.fake.state.orders['701'] = gqlOrder(701);

  const list = await a.api('/orders');
  assert.equal(list.data.orders.length, 2);
  assert.equal(list.data.orders.find((o) => o.id === '701').cod, 1250);

  let r = await a.api('/orders/send', { method: 'POST', body: { ids: ['700', '701'] } });
  const byId = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
  assert.equal(byId['701'].ok, true);
  assert.equal(byId['700'].ok, false);
  assert.match(byId['700'].error, /not a valid Bangladesh mobile/);

  // Weight from GraphQL measurement: 2 x 400g = 0.8kg
  const sent = JSON.parse(a.fake.calls.filter((c) => c.url.endsWith('/aladdin/api/v1/orders'))[0].body);
  assert.equal(sent.item_weight, 0.8);
  assert.equal(sent.recipient_phone, '01712345678');

  // Merchant fixes the phone in Shopify and retries
  a.fake.state.orders['700'] = gqlOrder(700);
  r = await a.api('/orders/send', { method: 'POST', body: { ids: ['700'] } });
  assert.equal(r.data.results[0].ok, true);

  // Re-sending an already-sent order is a no-op
  r = await a.api('/orders/send', { method: 'POST', body: { ids: ['701'] } });
  assert.equal(r.data.results[0].duplicate, true);
  assert.equal(a.fake.calls.filter((c) => c.url.endsWith('/aladdin/api/v1/orders')).length, 2);
});

test('Pathao validation errors are shown to the merchant', async (t) => {
  const a = await connected(t);
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
  a.fake.state.orders['800'] = gqlOrder(800);
  a.fake.state.pathaoFail = { recipient_address: ['The recipient address must be at least 10 characters.'] };
  const r = await a.api('/orders/send', { method: 'POST', body: { ids: ['800'] } });
  assert.match(r.data.results[0].error, /recipient_address: The recipient address/);
  assert.equal((await a.db.getShipment(SHOP, 800)).status, 'failed');
});

test('free plan limit blocks sends after 50, Pro is unlimited', async (t) => {
  const a = await connected(t);
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
  for (let i = 0; i < 50; i++) {
    await a.db.pool.query(`INSERT INTO shipments (shop, shopify_order_id, status, counted) VALUES ($1, $2, 'sent', TRUE)`, [SHOP, `x${i}`]);
  }
  a.fake.state.orders['900'] = gqlOrder(900);
  let r = await a.api('/orders/send', { method: 'POST', body: { ids: ['900'] } });
  assert.match(r.data.results[0].error, /Monthly limit reached/);

  a.fake.state.activeSubscriptions = [{ id: 'gid://shopify/AppSubscription/1', name: 'ShipBridge Pro', status: 'ACTIVE', test: true, trialDays: 7, currentPeriodEnd: null }];
  const boot = await a.api('/bootstrap');
  assert.equal(boot.data.plan, 'pro');
  r = await a.api('/orders/send', { method: 'POST', body: { ids: ['900'] } });
  assert.equal(r.data.results[0].ok, true);
});

test('billing: subscribe returns Shopify confirmation URL in test mode; cancel downgrades', async (t) => {
  const a = await connected(t);
  const r = await a.api('/billing/subscribe', { method: 'POST', body: { plan: 'pro' } });
  assert.equal(r.status, 200);
  assert.match(r.data.confirmationUrl, /^https:\/\/admin\.shopify\.com\//);
  const call = a.fake.calls.find((c) => c.body && c.body.includes('appSubscriptionCreate'));
  const vars = JSON.parse(call.body).variables;
  assert.equal(vars.test, true);
  assert.equal(vars.trialDays, 7);
  assert.equal(vars.lineItems[0].plan.appRecurringPricingDetails.price.amount, 9.99);
  assert.equal(vars.returnUrl, 'https://admin.shopify.com/store/demo-store/apps/pathao-shipbridge');

  a.fake.state.activeSubscriptions = [{ id: 'gid://shopify/AppSubscription/1', name: 'ShipBridge Pro', status: 'ACTIVE' }];
  await a.api('/bootstrap');
  const c = await a.api('/billing/cancel', { method: 'POST' });
  assert.equal(c.data.plan, 'free');
  assert.ok(a.fake.calls.some((x) => x.body && x.body.includes('appSubscriptionCancel')));
});

test('uninstall wipes tokens and Pathao secrets; shop/redact deletes everything; customers/redact removes orders', async (t) => {
  const a = await connected(t);
  await a.db.pool.query(`INSERT INTO shipments (shop, shopify_order_id, status) VALUES ($1, '55', 'sent'), ($1, '56', 'sent')`, [SHOP]);

  await a.webhook('/webhooks/compliance', { orders_to_redact: [55] }, 'customers/redact');
  await a.settle();
  assert.equal(await a.db.getShipment(SHOP, 55), null);
  assert.ok(await a.db.getShipment(SHOP, 56));

  assert.equal(await a.webhook('/webhooks/compliance', { customer: { id: 1 }, orders_requested: [56] }, 'customers/data_request'), 200);

  await a.webhook('/webhooks/app/uninstalled', { id: 1 }, 'app/uninstalled');
  await a.settle();
  const shop = await a.db.getShop(SHOP);
  assert.equal(shop.access_token_enc, null);
  assert.ok(shop.uninstalled_at);
  const s = await a.db.getSettings(SHOP);
  assert.equal(s.pathao_password_enc, null);
  assert.equal(s.auto_send, false);

  await a.webhook('/webhooks/compliance', { shop_domain: SHOP }, 'shop/redact');
  await a.settle();
  assert.equal(await a.db.getShop(SHOP), null);
  assert.equal(await a.db.getShipment(SHOP, 56), null);
});

test('Pathao status webhook: secret enforced, integration handshake, delivered tag', async (t) => {
  const a = await connected(t);
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
  a.fake.state.orders['300'] = gqlOrder(300);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['300'] } });
  const sh = await a.db.getShipment(SHOP, 300);
  const { secret, url } = (await a.api('/bootstrap')).data.pathaoWebhook;
  const path = new URL(url).pathname;

  const post = (body, sig) => fetch(a.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PATHAO-Signature': sig }, body: JSON.stringify(body) });

  assert.equal((await post({ event: 'order.delivered', consignment_id: sh.consignment_id }, 'wrong')).status, 401);
  const hs = await post({ event: 'webhook_integration' }, secret);
  assert.equal(hs.status, 202);
  assert.equal(hs.headers.get('x-pathao-merchant-webhook-integration-secret'), 'integration-uuid');

  assert.equal((await post({ event: 'order.delivered', consignment_id: sh.consignment_id }, secret)).status, 202);
  await a.settle();
  assert.equal((await a.db.getShipment(SHOP, 300)).pathao_status, 'delivered');
  assert.ok(a.fake.calls.some((c) => c.body && c.body.includes('pathao-delivered')));
});

test('embedded shell: CSP frame-ancestors, API key injected, bounce when opened outside admin', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  let res = await fetch(`${a.base}/?shop=${SHOP}&host=abc&embedded=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), `frame-ancestors https://${SHOP} https://admin.shopify.com;`);
  const html = await res.text();
  assert.match(html, /content="test_api_key"/);
  res = await fetch(`${a.base}/?shop=${SHOP}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://admin.shopify.com/store/demo-store/apps/pathao-shipbridge');
  assert.equal((await fetch(`${a.base}/privacy`)).status, 200);
});

test('Vercel handler: full app runs through makeHandler, webhook work finishes via defer, bad config reported', async (t) => {
  const http = require('http');
  const crypto = require('crypto');
  const { makeHandler } = require('../api/index');
  const { createApp } = require('../src/app');
  const { memPool, fakeFetch, gqlOrder, SECRET } = require('./helpers');

  const broken = makeHandler(async () => { throw new Error('Missing required environment variable: DATABASE_URL'); });
  const s1 = http.createServer(broken);
  await new Promise((r) => s1.listen(0, r));
  t.after(() => s1.close());
  const bad = await fetch(`http://127.0.0.1:${s1.address().port}/health`);
  assert.equal(bad.status, 500);
  assert.match(await bad.text(), /DATABASE_URL/);

  const fake = fakeFetch();
  const deferred = [];
  const config = {
    port: 0, shopifyApiKey: 'test_api_key', shopifyApiSecret: SECRET, shopifyApiVersion: '2026-10',
    appUrl: 'https://x.vercel.app', appHandle: 'h', databaseUrl: 'mem', encryptionKey: crypto.randomBytes(32).toString('hex'),
    billingTest: true, pathaoProductionUrl: 'https://api-hermes.pathao.com', pathaoSandboxUrl: 'https://s', pathaoIntegrationSecret: 'u',
  };
  let db;
  const handler = makeHandler(async () => {
    const built = createApp({ config, pool: memPool(), fetchImpl: fake.impl, log: { info() {}, warn() {}, error() {} }, defer: (p) => { deferred.push(p); return p; } });
    db = built.db;
    await db.migrate();
    return built.app;
  });
  const s2 = http.createServer(handler);
  await new Promise((r) => s2.listen(0, r));
  t.after(() => s2.close());
  const base = `http://127.0.0.1:${s2.address().port}`;
  const auth = { Authorization: `Bearer ${sessionToken()}`, 'Content-Type': 'application/json' };

  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: auth })).status, 200);
  await fetch(`${base}/api/settings`, { method: 'POST', headers: auth, body: JSON.stringify({ pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77, auto_send: true }) });
  await new Promise((r) => setTimeout(r, 20));

  const body = JSON.stringify({ id: 31, name: '#31', created_at: new Date(Date.now() + 1000).toISOString(), financial_status: 'pending', total_price: '500', total_outstanding: '500', tags: '',
    shipping_address: { name: 'A', phone: '01712345678', address1: 'House 1, Road 2, Banani', city: 'Dhaka' }, line_items: [{ title: 'x', quantity: 1, grams: 600 }] });
  const hmac = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
  const wr = await fetch(`${base}/webhooks/orders/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Shop-Domain': SHOP }, body });
  assert.equal(wr.status, 200);
  assert.ok(deferred.length >= 1, 'webhook work handed to waitUntil');
  await Promise.all(deferred);
  assert.equal((await db.getShipment(SHOP, 31)).status, 'sent');
});
