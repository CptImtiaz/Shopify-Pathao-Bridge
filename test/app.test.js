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
  assert.match(byId['700'].error, /isn't a Bangladesh mobile number/);

  const sent = JSON.parse(a.fake.calls.filter((c) => c.url.endsWith('/aladdin/api/v1/orders'))[0].body);
  const q = a.fake.calls.find((c) => c.body && c.body.includes('OneOrder')).body;
  assert.ok(!/customer \{|variant|email/.test(q), 'order query asks only for permitted fields');
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
  // Plan is cached between page loads; returning from Shopify's approve page asks again.
  const boot = await a.api('/bootstrap?fresh=1');
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

  // customers/redact also removes rows found only by the customer's phone (fraud history).
  await a.db.pool.query(`INSERT INTO shipments (shop, shopify_order_id, status, phone) VALUES ($1, '57', 'sent', '01712345678')`, [SHOP]);
  await a.webhook('/webhooks/compliance', { customer: { id: 2, phone: '+8801712345678' }, orders_to_redact: [] }, 'customers/redact');
  await a.settle();
  assert.equal(await a.db.getShipment(SHOP, 57), null);
  assert.ok(await a.db.getShipment(SHOP, 56));

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
  assert.equal((await a.api('/bootstrap')).data.pathaoWebhook.live, false); // bad signature doesn't count
  const hs = await post({ event: 'webhook_integration' }, secret);
  assert.equal(hs.status, 202);
  assert.equal(hs.headers.get('x-pathao-merchant-webhook-integration-secret'), 'integration-uuid');

  assert.equal((await post({ event: 'order.delivered', consignment_id: sh.consignment_id }, secret)).status, 202);
  await a.settle();
  assert.equal((await a.db.getShipment(SHOP, 300)).pathao_status, 'delivered');
  const wh = (await a.api('/bootstrap')).data.pathaoWebhook;
  assert.equal(wh.live, true);
  assert.ok(wh.lastAt);
  assert.ok((await a.api('/orders')).data.orders.find((o) => o.id === '300').shipment.updatedAt);
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

test('settings rejects a non-numeric store id instead of crashing', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  const r = await a.api('/settings', { method: 'POST', body: { pathao_store_id: 'undefined' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /valid Pathao store/);
  assert.equal((await a.api('/settings', { method: 'POST', body: { pathao_store_id: '77' } })).data.settings.pathao_store_id, 77);
});

test('opening the app registers order/uninstall/billing webhooks once, and fixes stale ones', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  a.fake.state.webhooks.push({ id: 'gid://shopify/WebhookSubscription/old', topic: 'ORDERS_CREATE', uri: 'https://old.example.com/hook' });
  const r = await a.api('/bootstrap');
  assert.equal(r.data.webhooks.ok, true);
  const hooks = a.fake.state.webhooks.map((w) => `${w.topic} ${w.uri}`).sort();
  assert.deepEqual(hooks, [
    'APP_SUBSCRIPTIONS_UPDATE https://app.example.com/webhooks/app_subscriptions/update',
    'APP_UNINSTALLED https://app.example.com/webhooks/app/uninstalled',
    'ORDERS_CREATE https://app.example.com/webhooks/orders/create',
    'ORDERS_UPDATED https://app.example.com/webhooks/orders/updated',
  ]);
  const before = a.fake.calls.filter((c) => c.body && c.body.includes('webhookSubscriptionCreate')).length;
  await a.api('/bootstrap');
  assert.equal(a.fake.calls.filter((c) => c.body && c.body.includes('webhookSubscriptionCreate')).length, before, 'no duplicates on reopen');
});

test('courier registry, monthly stats, SMS history and page routes', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  let boot = (await a.api('/bootstrap')).data;
  const keys = boot.couriers.map((c) => c.key);
  assert.ok(keys.includes('pathao') && keys.includes('steadfast'));
  assert.equal(boot.couriers.find((c) => c.key === 'pathao').status, 'not_connected');
  assert.equal(boot.couriers.find((c) => c.key === 'steadfast').status, 'not_connected');
  assert.equal(boot.couriers.find((c) => c.key === 'redx').status, 'coming_soon');
  assert.equal(boot.couriers.find((c) => c.key === 'pathao').isDefault, true);
  assert.equal((await a.api('/settings', { method: 'POST', body: { default_courier: 'steadfast' } })).status, 400);

  const r = await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77, pathao_store_name: 'Main', sms_token: 't', sms_sid: 'S', sms_enabled: true, sms_source: 'all' } });
  assert.equal(r.data.couriers.find((c) => c.key === 'pathao').status, 'connected');
  await new Promise((res) => setTimeout(res, 20));
  await a.webhook('/webhooks/orders/create', { id: 41, name: '#41', created_at: new Date(Date.now() + 1000).toISOString(), source_name: 'web', currency: 'BDT', total_price: '100', tags: '',
    shipping_address: { name: 'A', phone: '01712345678', address1: 'House 1, Road 2, Banani' }, line_items: [] }, 'orders/create');
  await a.settle();
  boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.stats.smsSent, 1);
  const log = (await a.api('/sms/log')).data.items;
  assert.equal(log[0].orderName, '#41');
  assert.equal(log[0].phone, '88017••••5678', 'phone masked in history');

  for (const p of ['/couriers', '/sms', '/plans']) {
    const res = await fetch(`${a.base}${p}?shop=${SHOP}&host=x&embedded=1`);
    assert.equal(res.status, 200, p);
    assert.match(await res.text(), /id="sms-tab"/);
  }
});

test('SMS coming soon: cannot be enabled and never sends; webhook secret + default note + courier assignment', async (t) => {
  const a = await startApp({ smsFeature: false });
  t.after(() => a.close());
  let boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.settings.sms.available, false);
  await a.api('/settings', { method: 'POST', body: { sms_token: 't', sms_sid: 'S' } });
  const r = await a.api('/settings', { method: 'POST', body: { sms_enabled: true } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /coming soon/);
  // Even if enabled in the DB, the webhook does not send SMS while the feature is off.
  await a.db.updateSettings(SHOP, { sms_enabled: true, sms_since: new Date(Date.now() - 60000) });
  await a.webhook('/webhooks/orders/create', { id: 61, name: '#61', created_at: new Date().toISOString(), source_name: 'web', total_price: '1', tags: '',
    shipping_address: { name: 'A', phone: '01712345678', address1: 'House 1, Road 2, Banani' }, line_items: [] }, 'orders/create');
  await a.settle();
  assert.equal(a.fake.state.sms.length, 0);

  // merchant-chosen webhook secret
  assert.equal((await a.api('/settings', { method: 'POST', body: { webhook_secret: 'short' } })).status, 400);
  await a.api('/settings', { method: 'POST', body: { webhook_secret: 'my-pathao-secret-123' } });
  boot = (await a.api('/bootstrap')).data;
  assert.equal(boot.pathaoWebhook.secret, 'my-pathao-secret-123');

  // default note used when the order has none; courier assignment validated
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77, default_note: 'Handle with care' } });
  a.fake.state.orders['62'] = gqlOrder(62, { note: '' });
  assert.equal((await a.api('/orders/send', { method: 'POST', body: { ids: ['62'], courier: 'redx' } })).status, 400);
  const ok = await a.api('/orders/send', { method: 'POST', body: { ids: ['62'], courier: 'pathao' } });
  assert.equal(ok.data.results[0].ok, true);
  const sent = JSON.parse(a.fake.calls.filter((c) => c.url.endsWith('/aladdin/api/v1/orders')).pop().body);
  assert.equal(sent.special_instruction, 'Handle with care');
  const list = (await a.api('/orders')).data.orders;
  assert.equal(list[0].shipment.courier, 'pathao');
  assert.ok('fulfillment' in list[0] && 'items' in list[0]);
});

test('orders include product images and a fraud check using delivery history', async () => {
  const t = await startApp();
  try {
    await t.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u@x.com', pathao_password: 'p' } });
    await t.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
    t.fake.state.orders['501'] = gqlOrder(501, { lineItems: { nodes: [{ title: 'Laddu box', quantity: 2, image: { url: 'https://cdn.shopify.com/laddu.jpg' } }] } });
    t.fake.state.orders['502'] = gqlOrder(502);
    assert.equal((await t.api('/orders/send', { method: 'POST', body: { ids: ['501'] } })).data.results[0].ok, true);
    await t.db.finishShipment(SHOP, '501', { pathao_status: 'Return' });
    const { data } = await t.api('/orders');
    const o501 = data.orders.find((o) => o.id === '501');
    const o502 = data.orders.find((o) => o.id === '502');
    assert.equal(o501.products[0].image, 'https://cdn.shopify.com/laddu.jpg');
    assert.equal(o502.fraud.history.returned, 1);
    assert.equal(o502.fraud.level, 'medium'); // same phone: one past return + a same-day duplicate
    assert.ok(o502.fraud.reasons.length >= 2);
  } finally { t.close(); }
});

test('owner admin page needs ADMIN_PASSWORD and shows shops without customer data', async () => {
  const off = await startApp();
  try { assert.equal((await fetch(off.base + '/admin')).status, 404); } finally { off.close(); }
  const t = await startApp({ adminPassword: 'owner-pass-123' });
  try {
    await t.api('/bootstrap');
    assert.equal((await fetch(t.base + '/admin')).status, 401);
    const bad = await fetch(t.base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') } });
    assert.equal(bad.status, 401);
    const ok = await fetch(t.base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from('me:owner-pass-123').toString('base64') } });
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /demo-store\.myshopify\.com/);
    assert.match(html, /Active installs/);
    assert.doesNotMatch(html, /Rahim/);
  } finally { t.close(); }
});

test('speed: gzip responses, versioned assets cached for a year', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const html = await (await fetch(`${a.base}/?embedded=1&host=x`, { headers: { 'Accept-Encoding': 'gzip' } })).text();
  const js = html.match(/\/assets\/app\.js\?v=[0-9a-f]{10}/);
  const css = html.match(/\/assets\/app\.css\?v=[0-9a-f]{10}/);
  assert.ok(js && css, 'app.js and app.css carry a content hash');
  const r = await fetch(`${a.base}${js[0]}`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /max-age=31536000/);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
});

test('speed: order list is cached briefly, refreshed by Refresh and by new-order webhooks', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const listCalls = () => a.fake.calls.filter((c) => c.body && String(c.body).includes('RecentOrders')).length;
  a.fake.state.orders[501] = gqlOrder(501);
  assert.equal((await a.api('/orders')).data.orders.length, 1);
  const n = listCalls();
  await a.api('/orders');
  assert.equal(listCalls(), n, 'second load served from cache');
  await a.api('/orders?fresh=1');
  assert.equal(listCalls(), n + 1, 'Refresh button skips the cache');
  a.fake.state.orders[502] = gqlOrder(502);
  await a.webhook('/webhooks/orders/create', restOrder(502), 'orders/create');
  await a.settle();
  assert.equal((await a.api('/orders')).data.orders.length, 2, 'new order shows right away');
});

test('merchant notes are saved per order and never block sending', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  await a.api('/bootstrap');
  await a.api('/settings', { method: 'POST', body: { pathao_client_id: 'c', pathao_client_secret: 's', pathao_username: 'u', pathao_password: 'p', pathao_store_id: 77 } });
  a.fake.state.orders['950'] = gqlOrder(950);
  let r = await a.api('/orders/950/note', { method: 'POST', body: { note: '  Call after Friday ' } });
  assert.equal(r.data.note, 'Call after Friday');
  let o = (await a.api('/orders?fresh=1')).data.orders.find((x) => x.id === '950');
  assert.equal(o.note, 'Call after Friday');
  assert.equal((await a.api('/orders/950/note', { method: 'POST', body: { note: 'x'.repeat(501) } })).status, 400);
  assert.equal((await a.api('/orders/d950/note', { method: 'POST', body: { note: 'x' } })).status, 400);
  r = await a.api('/orders/950/note', { method: 'POST', body: { note: '' } });
  assert.equal(r.data.note, null);
  o = (await a.api('/orders?fresh=1')).data.orders.find((x) => x.id === '950');
  assert.equal(o.note, null);
  r = await a.api('/orders/send', { method: 'POST', body: { ids: ['950'], courier: 'pathao' } });
  assert.equal(r.data.results[0].ok, true, r.data.results[0].error);
});

test('courier logos: page carries a logo fingerprint, so versioned logos are cached for a year', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const html = await (await fetch(`${a.base}/?embedded=1&host=x`)).text();
  assert.match(html, /<meta name="logo-version" content="[0-9a-f]{10}"/);
  for (const f of ['steadfast-mark.png', 'pathao-mark.png']) {
    const r = await fetch(`${a.base}/assets/couriers/${f}?v=x`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('cache-control'), /immutable/, f);
  }
});

test('Pathao order.paid / order.updated never overwrite the delivery status', async (t) => {
  const a = await connected(t);
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
  a.fake.state.orders['310'] = gqlOrder(310);
  await a.api('/orders/send', { method: 'POST', body: { ids: ['310'] } });
  const sh = await a.db.getShipment(SHOP, 310);
  const { secret, url } = (await a.api('/bootstrap')).data.pathaoWebhook;
  const post = (body) => fetch(a.base + new URL(url).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PATHAO-Signature': secret }, body: JSON.stringify(body) });
  assert.equal((await post({ event: 'order.delivered', consignment_id: sh.consignment_id })).status, 202);
  await a.settle();
  assert.equal((await post({ event: 'order.paid', consignment_id: sh.consignment_id })).status, 202);
  assert.equal((await post({ event: 'order.updated', consignment_id: sh.consignment_id })).status, 202);
  await a.settle();
  const after = await a.db.getShipment(SHOP, 310);
  assert.equal(after.pathao_status, 'delivered');
  assert.equal(after.courier_message, 'Cash paid out by Pathao');
});

test('courier webhooks for stores that never installed the app are refused without creating data', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const ghost = 'not-installed.myshopify.com';
  const r1 = await fetch(`${a.base}/pathao/webhook/${ghost}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PATHAO-Signature': 'x' }, body: '{}' });
  const r2 = await fetch(`${a.base}/steadfast/webhook/${ghost}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: '{}' });
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
  assert.equal(await a.db.getShop(ghost), null);
  const { rows } = await a.db.pool.query('SELECT COUNT(*)::int AS n FROM settings WHERE shop = $1', [ghost]).catch(() => ({ rows: [{ n: 0 }] }));
  assert.equal(rows[0].n, 0);
});

test('every outbound call carries a timeout signal', async (t) => {
  const a = await connected(t);
  const calls = a.fake.calls.filter((c) => /myshopify\.com|pathao|packzy/.test(c.url));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal));
});

test('order list: page info, older pages and store-wide search go to Shopify', async (t) => {
  const a = await connected(t);
  a.fake.state.orders['320'] = gqlOrder(320);
  const first = await a.api('/orders');
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.data.pageInfo).sort(), ['endCursor', 'hasNextPage']);
  await a.api('/orders?after=abc123');
  await a.api('/orders/search', { method: 'POST', body: { q: 'Rahim' } });
  assert.equal((await a.api('/orders/search', { method: 'POST', body: { q: ' ' } })).status, 400);
  const bodies = a.fake.calls.filter((c) => c.url.includes('/graphql.json') && c.body && c.body.includes('RecentOrders')).map((c) => JSON.parse(c.body).variables);
  assert.ok(bodies.some((v) => v.after === 'abc123'));
  assert.ok(bodies.some((v) => v.query === 'Rahim'));
});

test('Pathao timeout: order is "Not confirmed" and needs the merchant\'s OK before sending again', async (t) => {
  const a = await connected(t);
  await a.api('/settings', { method: 'POST', body: { pathao_store_id: 77 } });
  a.fake.state.orders['330'] = gqlOrder(330);
  a.fake.state.pathaoTimeout = true;
  let r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['330'] } })).data.results[0];
  assert.equal(r.ok, false);
  assert.match(r.error, /^Not confirmed: Pathao did not answer in time/);
  a.fake.state.pathaoTimeout = false;
  const booked = () => a.fake.calls.filter((c) => c.url.endsWith('/aladdin/api/v1/orders')).length;
  const before = booked();
  r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['330'] } })).data.results[0];
  assert.equal(r.needsConfirm, true);
  assert.equal(booked(), before); // nothing sent without the OK
  r = (await a.api('/orders/send', { method: 'POST', body: { ids: ['330'], confirm: true } })).data.results[0];
  assert.equal(r.ok, true);
  assert.equal(booked(), before + 1);
});

test('Pathao status spellings are stored in one form and pickup-cancelled counts as finished', () => {
  const { pathaoSlug, DONE } = require('../src/tracking');
  assert.equal(pathaoSlug('Pickup_Cancelled'), 'pickup-cancelled');
  assert.equal(pathaoSlug('order.In Transit'), 'in-transit');
  assert.ok(DONE.test('pickup-cancelled'));
  assert.ok(DONE.test('partial-delivery'));
  assert.ok(!DONE.test('in-transit'));
});

test('privacy policy: no blanks, names Steadfast, shows the support contact', async (t) => {
  const { startApp } = require('./helpers');
  const a = await startApp();
  t.after(() => a.close());
  const html = await (await fetch(`${a.base}/privacy`)).text();
  assert.doesNotMatch(html, /\[(DATE|YOUR COMPANY NAME|SUPPORT EMAIL)\]|\{\{CONTACT\}\}/);
  assert.match(html, /Steadfast/);
  assert.match(html, /AutoCourier BD/);
  assert.match(html, /Questions or data requests: \S/);
});

test('per-store rate limit answers 429 with a friendly message', async (t) => {
  const { startApp } = require('./helpers');
  const a = await startApp({ apiRatePerMinute: 3 });
  t.after(() => a.close());
  for (let i = 0; i < 3; i++) assert.notEqual((await a.api('/bootstrap')).status, 429);
  const r = await a.api('/bootstrap');
  assert.equal(r.status, 429);
  assert.match(r.data.error, /Too many requests/);
});

test('versioned courier logos are cached for a year; unversioned ones are re-checked', async (t) => {
  const { startApp } = require('./helpers');
  const a = await startApp();
  t.after(() => a.close());
  const v = await fetch(`${a.base}/assets/couriers/pathao-mark.png?v=abc123`);
  assert.match(v.headers.get('cache-control'), /max-age=31536000, immutable/);
  const plain = await fetch(`${a.base}/assets/couriers/pathao-mark.png`);
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
});

test('merchant can delete stored customer data (needs DELETE); settings stay', async (t) => {
  const a = await connected(t);
  await a.db.pool.query(`INSERT INTO shipments (shop, shopify_order_id, status, phone) VALUES ($1, '70', 'sent', '01712345678')`, [SHOP]);
  await a.db.setNote(SHOP, '70', 'call before 5pm');
  assert.equal((await a.api('/data/delete', { method: 'POST', body: {} })).status, 400);
  const r = await a.api('/data/delete', { method: 'POST', body: { confirm: 'DELETE' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.removed, 2);
  assert.equal(await a.db.getShipment(SHOP, 70), null);
  assert.ok((await a.db.getSettings(SHOP)).pathao_client_id);
});

test('self-hosted font: served from the app and cached; no Google Fonts in the page', async (t) => {
  const a = await connected(t);
  const f = await fetch(a.base + '/assets/fonts/inter-latin-400.woff2');
  assert.equal(f.status, 200);
  assert.match(f.headers.get('cache-control'), /immutable/);
  const html = await (await fetch(a.base + '/app?shop=' + SHOP)).text();
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
});

test('bad JSON body: 400 and the body is not written to the log', async (t) => {
  const a = await connected(t);
  const res = await fetch(a.base + '/webhooks/steadfast/' + SHOP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"phone":"01712345678",' });
  assert.ok(res.status >= 400 && res.status < 500);
  assert.ok(a.logs.every((l) => !String(l).includes('01712345678')), a.logs.join('\n'));
});
