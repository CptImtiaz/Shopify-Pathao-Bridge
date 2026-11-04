const crypto = require('crypto');
const { newDb } = require('pg-mem');
const { createApp } = require('../src/app');

const SECRET = 'test_secret';
const KEY = 'test_api_key';
const SHOP = 'demo-store.myshopify.com';

function memPool() {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'date_trunc', args: ['text', 'timestamptz'], returns: 'timestamptz',
    implementation: (unit, d) => new Date(d.getFullYear(), d.getMonth(), 1),
  });
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sessionToken(shop = SHOP, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({
    iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: KEY, sub: '1',
    exp: now + 60, nbf: now - 5, iat: now - 5, jti: crypto.randomUUID(), ...overrides,
  }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

function webhookHeaders(body, topic, shop = SHOP) {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SECRET).update(body).digest('base64'),
    'X-Shopify-Topic': topic,
    'X-Shopify-Shop-Domain': shop,
  };
}

// Fake Shopify + Pathao. Records every call.
function fakeFetch() {
  const calls = [];
  const state = {
    tokenCounter: 0,
    tokenExpiresIn: 3600,
    pathaoFail: null,
    orders: {},
    activeSubscriptions: [],
    nextConsignment: 1000,
    webhooks: [],
    sms: [],
    smsFail: null,
    fo: {}, // orderId -> [{ id, status, fulfillmentHolds, fulfillments }]
    fulfillments: [], events: [], trackingUpdates: [], released: [], fulfillDenied: false,
    steadfastOrders: [], nextSteadfast: 5000, steadfastStatus: {}, steadfastFail: null,
    drafts: {}, draftsDenied: false, nextOrderFromDraft: 7000, paymentPendingRemoved: false,
  };

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function impl(url, init = {}) {
    url = String(url);
    const body = init.body;
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers || {} });

    if (url.endsWith('/admin/oauth/access_token')) {
      const params = new URLSearchParams(body);
      state.tokenCounter += 1;
      return json(200, {
        access_token: `shpat_${params.get('grant_type').includes('refresh') ? 'refreshed' : 'exchanged'}_${state.tokenCounter}`,
        expires_in: state.tokenExpiresIn,
        refresh_token: `shprt_${state.tokenCounter}`,
        refresh_token_expires_in: 7776000,
        scope: 'read_orders,write_orders',
      });
    }

    if (url.includes('/graphql.json')) {
      const { query, variables } = JSON.parse(body);
      if (query.includes('currentAppInstallation')) {
        return json(200, { data: { currentAppInstallation: { activeSubscriptions: state.activeSubscriptions, allSubscriptions: { nodes: state.allSubscriptions || [] } } } });
      }
      // ---- draft orders ----
      if (query.includes('draftOrder') && state.draftsDenied) return json(200, { errors: [{ message: 'Access denied for draftOrders field. Required access: `read_draft_orders` access scope.', extensions: { code: 'ACCESS_DENIED' } }] });
      if (query.includes('draftOrders(')) return json(200, { data: { draftOrders: { nodes: Object.values(state.drafts).filter((d) => d.status === 'OPEN') } } });
      if (query.includes('draftOrderComplete(')) {
        if (state.paymentPendingRemoved && query.includes('paymentPending')) return json(200, { errors: [{ message: "Field 'draftOrderComplete' doesn't accept argument 'paymentPending'" }] });
        const id = variables.id.split('/').pop();
        const d = state.drafts[id];
        d.status = 'COMPLETED';
        state.nextOrderFromDraft += 1;
        const oid = state.nextOrderFromDraft;
        // Worst case: Shopify marks the new order as paid.
        state.orders[oid] = gqlOrder(oid, { name: `#${oid}`, sourceName: 'shopify_draft_order', displayFinancialStatus: 'PAID', totalOutstandingSet: { shopMoney: { amount: '0.00' } } });
        return json(200, { data: { draftOrderComplete: { draftOrder: { status: 'COMPLETED', order: { legacyResourceId: String(oid), name: `#${oid}` } }, userErrors: [] } } });
      }
      if (query.includes('draftOrder(')) {
        const id = variables.id.split('/').pop();
        return json(200, { data: { draftOrder: state.drafts[id] || null } });
      }
      if (query.includes('RecentOrders')) return json(200, { data: { orders: { nodes: Object.values(state.orders) } } });
      if (query.includes('OneOrder')) {
        const id = variables.id.split('/').pop();
        return json(200, { data: { order: state.orders[id] || null } });
      }
      if (query.includes('webhookSubscriptions(')) return json(200, { data: { webhookSubscriptions: { nodes: state.webhooks } } });
      if (query.includes('webhookSubscriptionDelete')) { state.webhooks = state.webhooks.filter((w) => w.id !== variables.id); return json(200, { data: { webhookSubscriptionDelete: { userErrors: [] } } }); }
      if (query.includes('webhookSubscriptionCreate')) {
        const w = { id: `gid://shopify/WebhookSubscription/${state.webhooks.length + 1}`, topic: variables.topic, uri: variables.sub.uri };
        state.webhooks.push(w);
        return json(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: w.id }, userErrors: [] } } });
      }
      if (query.includes('query FO(')) {
        if (state.fulfillDenied) return json(200, { errors: [{ message: 'Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders`', extensions: { code: 'ACCESS_DENIED' } }] });
        const id = variables.id.split('/').pop();
        if (!state.orders[id]) return json(200, { data: { order: null } });
        state.fo[id] = state.fo[id] || [{ id: `gid://shopify/FulfillmentOrder/${id}1`, status: 'OPEN', fulfillmentHolds: [], fulfillments: { nodes: [] } }];
        return json(200, { data: { order: { id: variables.id, name: `#${id}`, fulfillmentOrders: { nodes: state.fo[id] } } } });
      }
      if (query.includes('fulfillmentOrderReleaseHold')) {
        state.released.push(variables.id);
        const fo = Object.values(state.fo).flat().find((f) => f.id === variables.id);
        fo.status = 'OPEN'; fo.fulfillmentHolds = [];
        return json(200, { data: { fulfillmentOrderReleaseHold: { fulfillmentOrder: fo, userErrors: [] } } });
      }
      if (query.includes('fulfillmentCreate(')) {
        const f = { id: `gid://shopify/Fulfillment/${state.fulfillments.length + 1}`, input: variables.f };
        state.fulfillments.push(f);
        for (const l of variables.f.lineItemsByFulfillmentOrder) { const fo = Object.values(state.fo).flat().find((x) => x.id === l.fulfillmentOrderId); fo.status = 'CLOSED'; fo.fulfillments.nodes.push({ id: f.id, status: 'SUCCESS' }); }
        return json(200, { data: { fulfillmentCreate: { fulfillment: { id: f.id, status: 'SUCCESS' }, userErrors: [] } } });
      }
      if (query.includes('fulfillmentTrackingInfoUpdate')) { state.trackingUpdates.push(variables); return json(200, { data: { fulfillmentTrackingInfoUpdate: { fulfillment: { id: variables.id }, userErrors: [] } } }); }
      if (query.includes('fulfillmentEventCreate')) { state.events.push(variables.e); return json(200, { data: { fulfillmentEventCreate: { fulfillmentEvent: { id: 'e', status: variables.e.status }, userErrors: [] } } }); }
      if (query.includes('tagsAdd')) return json(200, { data: { tagsAdd: { userErrors: [] } } });
      if (query.includes('metafieldsSet')) return json(200, { data: { metafieldsSet: { userErrors: [] } } });
      if (query.includes('appSubscriptionCreate')) {
        state.lastSubscription = variables;
        return json(200, { data: { appSubscriptionCreate: { confirmationUrl: 'https://admin.shopify.com/charges/confirm/1', appSubscription: { id: 'gid://shopify/AppSubscription/1' }, userErrors: [] } } });
      }
      if (query.includes('appSubscriptionCancel')) return json(200, { data: { appSubscriptionCancel: { userErrors: [] } } });
      return json(200, { errors: [{ message: 'unhandled query in fake' }] });
    }

    if (url.includes('sslwireless.com')) {
      const b = JSON.parse(body);
      state.sms.push(b);
      if (state.smsFail) return json(200, { status: 'FAILED', status_code: 4001, error_message: state.smsFail });
      return json(200, { status: 'SUCCESS', status_code: 200, smsinfo: [{ sms_status: 'SUCCESS', status_message: 'Success', msisdn: b.sms[0].msisdn, csms_id: b.sms[0].csms_id }] });
    }
    if (url.includes('/aladdin/api/v1/issue-token')) {
      const b = JSON.parse(body);
      if (b.password === 'wrong') return json(401, { message: 'Invalid credentials' });
      return json(200, { token_type: 'Bearer', expires_in: 432000, access_token: 'pathao_tok', refresh_token: 'pathao_ref' });
    }
    if (url.includes('/aladdin/api/v1/stores')) {
      return json(200, { data: { data: [{ store_id: 77, store_name: 'Dhaka Warehouse', store_address: 'Mirpur', is_active: 1 }] } });
    }
    if (url.endsWith('/aladdin/api/v1/orders')) {
      if (state.pathaoFail) return json(422, { message: 'Validation failed', errors: state.pathaoFail });
      const b = JSON.parse(body);
      state.nextConsignment += 1;
      return json(200, { message: 'Order Created', data: { consignment_id: `DL${state.nextConsignment}`, merchant_order_id: b.merchant_order_id, order_status: 'Pending', delivery_fee: 60 } });
    }
    // ---- Steadfast (Packzy) ----
    if (url.startsWith('https://portal.packzy.com/api/v1/')) {
      const h = init.headers || {};
      if (h['Api-Key'] !== 'sf_key' || h['Secret-Key'] !== 'sf_secret') return json(401, { message: 'Unauthenticated.' });
      const path = url.slice('https://portal.packzy.com/api/v1'.length);
      if (path === '/get_balance') return json(200, { status: 200, current_balance: 1520.5 });
      if (path === '/create_order') {
        const b = JSON.parse(body);
        state.steadfastOrders.push(b);
        if (state.steadfastFail) return json(422, { status: 422, errors: state.steadfastFail });
        state.nextSteadfast += 1;
        return json(200, { status: 200, message: 'Consignment has been created successfully.', consignment: {
          consignment_id: state.nextSteadfast, invoice: b.invoice, tracking_code: `SF${state.nextSteadfast}`, cod_amount: b.cod_amount, status: 'in_review' } });
      }
      const m = path.match(/^\/status_by_cid\/(\d+)$/);
      if (m) return json(200, { status: 200, delivery_status: state.steadfastStatus[m[1]] || 'pending' });
    }
    return json(404, { message: `fake: no route for ${url}` });
  }

  return { impl, calls, state };
}

function gqlOrder(id, extra = {}) {
  return {
    id: `gid://shopify/Order/${id}`, legacyResourceId: String(id), name: `#${id}`,
    createdAt: new Date().toISOString(), note: 'Call before delivery', tags: [], phone: null, email: null,
    displayFinancialStatus: 'PENDING', cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: '1250.00', currencyCode: 'BDT' } },
    totalOutstandingSet: { shopMoney: { amount: '1250.00' } },
    shippingAddress: { name: 'Rahim Uddin', phone: '+880 1712-345678', address1: 'House 12, Road 5', address2: 'Dhanmondi', city: 'Dhaka', province: null, zip: '1209', country: 'Bangladesh' },
    billingAddress: null, customer: { firstName: 'Rahim', lastName: 'Uddin', phone: null },
    lineItems: { nodes: [{ title: 'Laddu box', quantity: 2, variant: { inventoryItem: { measurement: { weight: { value: 400, unit: 'GRAMS' } } } } }] },
    ...extra,
  };
}

async function startApp({ smsFeature = true, adminPassword = '' } = {}) {
  const fake = fakeFetch();
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (...m) => logs.push(m.join(' ')) };
  const config = {
    port: 0, shopifyApiKey: KEY, shopifyApiSecret: SECRET, shopifyApiVersion: '2026-10',
    appUrl: 'https://app.example.com', appHandle: 'pathao-shipbridge', databaseUrl: 'mem',
    encryptionKey: crypto.randomBytes(32).toString('hex'), billingTest: true,
    pathaoProductionUrl: 'https://api-hermes.pathao.com', pathaoSandboxUrl: 'https://courier-api-sandbox.pathao.com',
    pathaoIntegrationSecret: 'integration-uuid',
    steadfastBaseUrl: 'https://portal.packzy.com/api/v1',
    smsFeature, adminPassword,
  };
  const { app, db } = createApp({ config, pool: memPool(), fetchImpl: fake.impl, log });
  await db.migrate();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (path, { method = 'GET', body, token = sessionToken() } = {}) => {
    const res = await fetch(base + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };

  const webhook = async (path, payload, topic, shop) => {
    const body = JSON.stringify(payload);
    const res = await fetch(base + path, { method: 'POST', headers: webhookHeaders(body, topic, shop), body });
    return res.status;
  };

  const settle = () => new Promise((r) => setTimeout(r, 150));

  return { base, api, webhook, settle, fake, db, logs, close: () => server.close() };
}

function gqlDraft(id, extra = {}) {
  return {
    id: `gid://shopify/DraftOrder/${id}`, legacyResourceId: String(id), name: `#D${id}`, createdAt: new Date().toISOString(),
    note2: '', tags: [], phone: null, status: 'OPEN',
    totalPriceSet: { shopMoney: { amount: '693.45', currencyCode: 'BDT' } },
    shippingAddress: { name: 'Karine Ruby', phone: '01712345678', address1: 'House 9, Road 3, Gulshan 1', city: 'Dhaka' },
    billingAddress: null,
    lineItems: { nodes: [{ title: 'Snowboard', quantity: 1, image: null }] },
    ...extra,
  };
}

module.exports = { gqlDraft, startApp, sessionToken, gqlOrder, memPool, fakeFetch, SHOP, SECRET };
