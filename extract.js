const express = require('express');
const crypto = require('crypto');

const app = express();

const SHOP = process.env.SHOP || 'wellessia';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const PATHAO_BASE_URL = process.env.PATHAO_BASE_URL || 'https://api-hermes.pathao.com';
const PATHAO_CLIENT_ID = process.env.PATHAO_CLIENT_ID;
const PATHAO_CLIENT_SECRET = process.env.PATHAO_CLIENT_SECRET;
const PATHAO_USERNAME = process.env.PATHAO_USERNAME;
const PATHAO_PASSWORD = process.env.PATHAO_PASSWORD;
const MERCHANT_STORE_ID = Number(process.env.MERCHANT_STORE_ID) || 1;
const PORT = process.env.PORT || 3000;

if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing CLIENT_ID or CLIENT_SECRET');
if (!PATHAO_CLIENT_ID || !PATHAO_CLIENT_SECRET || !PATHAO_USERNAME || !PATHAO_PASSWORD) {
  throw new Error('Missing Pathao credentials');
}

const SERVER_STARTED_AT = new Date();
let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;
let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;
const submittedOrders = new Map();

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); }
}));

function verifyShopifyWebhook(req) {
  try {
    const received = req.get('X-Shopify-Hmac-Sha256');
    if (!received || !req.rawBody) return false;
    const generated = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('base64');
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(generated, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function getShopifyToken() {
  if (SHOPIFY_TOKEN && Date.now() < SHOPIFY_EXPIRES_AT - 60000) return SHOPIFY_TOKEN;

  const response = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    }).toString()
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Shopify token error ${response.status}: ${data.error_description || data.error || JSON.stringify(data)}`);
  }

  SHOPIFY_TOKEN = data.access_token;
  SHOPIFY_EXPIRES_AT = Date.now() + (data.expires_in || 86400) * 1000;
  return SHOPIFY_TOKEN;
}

async function getPathaoToken() {
  if (PATHAO_TOKEN && Date.now() < PATHAO_EXPIRES_AT - 60000) return PATHAO_TOKEN;

  const response = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: PATHAO_CLIENT_ID,
      client_secret: PATHAO_CLIENT_SECRET,
      username: PATHAO_USERNAME,
      password: PATHAO_PASSWORD,
      grant_type: 'password'
    })
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Pathao token error ${response.status}: ${data.message || data.error || JSON.stringify(data)}`);
  }

  PATHAO_TOKEN = data.access_token;
  PATHAO_EXPIRES_AT = Date.now() + (data.expires_in || 3600) * 1000;
  return PATHAO_TOKEN;
}

async function shopifyRequest(endpoint, options = {}) {
  const token = await getShopifyToken();
  const response = await fetch(`https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok) {
    const error = new Error(`Shopify API ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function shopifyGraphqlRequest(query, variables = {}) {
  const token = await getShopifyToken();
  const response = await fetch(`https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    const error = new Error(data.errors?.map(e => e.message).join('; ') || `Shopify GraphQL API ${response.status}`);
    error.status = response.status || 400;
    error.data = data;
    throw error;
  }
  return data.data;
}

async function pathaoRequest(endpoint, options = {}) {
  const token = await getPathaoToken();
  const response = await fetch(`${PATHAO_BASE_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok) {
    const error = new Error(`Pathao API ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function normalizePhone(phone) {
  if (!phone) return '';
  let value = String(phone).trim().replace(/[\s\-()]/g, '');
  if (value.startsWith('+880')) value = '0' + value.substring(4);
  else if (value.startsWith('880')) value = '0' + value.substring(3);
  return value;
}

function calculateOrderWeight(items = []) {
  const grams = items.reduce((sum, item) => sum + (Number(item.grams) || 0) * (Number(item.quantity) || 0), 0);
  return Number((grams / 1000).toFixed(2));
}

function buildPathaoOrder(order) {
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};
  const items = order.line_items || [];
  const recipientName = shipping.name || billing.name || order.customer?.first_name || 'Customer';
  const recipientPhone = normalizePhone(shipping.phone || billing.phone || order.customer?.phone || '');
  const recipientAddress = [shipping.address1, shipping.address2, shipping.city, shipping.province, shipping.zip, shipping.country]
    .filter(Boolean)
    .join(', ');
  const totalQuantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1;
  const itemDescription = items.map(item => `${item.title || 'Product'} x ${Number(item.quantity) || 1}`).join(', ');
  const totalPrice = Number(parseFloat(order.total_price || 0).toFixed(0));

  return {
    store_id: MERCHANT_STORE_ID,
    merchant_order_id: order.name,
    recipient_name: recipientName,
    recipient_phone: recipientPhone,
    recipient_address: recipientAddress,
    delivery_type: 48,
    item_type: 2,
    special_instruction: order.note || '',
    item_quantity: totalQuantity,
    item_weight: calculateOrderWeight(items),
    item_description: itemDescription || `Shopify Order ${order.name || order.id}`,
    amount_to_collect: totalPrice
  };
}

function extractPathaoConsignmentId(result) {
  return result?.data?.consignment_id || result?.consignment_id || result?.data?.consignmentId || result?.consignmentId || null;
}

async function getPathaoOrderInfo(consignmentId) {
  return pathaoRequest(`/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`);
}

function mapPathaoStatusToShopifyEvent(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!status) return null;
  if (status.includes('delivered') || status.includes('delivery completed')) return 'DELIVERED';
  if (status.includes('out for delivery') || status.includes('on the way to recipient') || status.includes('last mile')) return 'OUT_FOR_DELIVERY';
  if (status.includes('attempted') || status.includes('delivery attempt')) return 'ATTEMPTED_DELIVERY';
  if (status.includes('failed') || status.includes('cancelled') || status.includes('canceled') || status.includes('rejected')) return 'FAILURE';
  if (status.includes('delayed') || status.includes('hold')) return 'DELAYED';
  if (status.includes('picked up') || status.includes('pickup completed') || status.includes('collected')) return 'CARRIER_PICKED_UP';
  if (status.includes('transit') || status.includes('hub') || status.includes('sorting') || status.includes('processing') || status.includes('dispatch') || status.includes('shipment')) return 'IN_TRANSIT';
  return null;
}

async function getShopifyOrderFulfillmentInfo(orderId) {
  const query = `
    query GetOrderFulfillment($id: ID!) {
      order(id: $id) {
        id
        name
        fulfillments {
          id
          status
          displayStatus
          trackingInfo { company number url }
        }
        fulfillmentOrders(first: 20) {
          nodes { id status }
        }
      }
    }
  `;
  const data = await shopifyGraphqlRequest(query, { id: `gid://shopify/Order/${orderId}` });
  return data?.order || null;
}

async function updateShopifyFulfillmentTracking(fulfillmentId, consignmentId) {
  const mutation = `
    mutation UpdatePathaoTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!) {
      fulfillmentTrackingInfoUpdate(
        fulfillmentId: $fulfillmentId,
        trackingInfoInput: $trackingInfoInput,
        notifyCustomer: false
      ) {
        fulfillment { id status displayStatus trackingInfo { company number url } }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphqlRequest(mutation, {
    fulfillmentId,
    trackingInfoInput: { company: 'Pathao', number: String(consignmentId) }
  });
  const payload = data?.fulfillmentTrackingInfoUpdate;
  if (payload?.userErrors?.length) throw new Error(payload.userErrors.map(e => e.message).join('; '));
  return payload?.fulfillment || null;
}

async function createShopifyFulfillmentForPathao(orderId, consignmentId) {
  const order = await getShopifyOrderFulfillmentInfo(orderId);
  if (!order) throw new Error(`Shopify order ${orderId} not found`);

  const existing = (order.fulfillments || []).find(f =>
    (f.trackingInfo || []).some(t =>
      String(t.company || '').toLowerCase() === 'pathao' || String(t.number || '') === String(consignmentId)
    )
  );
  if (existing) return existing;

  const open = (order.fulfillmentOrders?.nodes || []).filter(x => x.status === 'OPEN' || x.status === 'IN_PROGRESS');
  if (!open.length) {
    const existingFulfillment = (order.fulfillments || [])[0];
    if (!existingFulfillment) throw new Error('No open Shopify fulfillment order is available.');
    await updateShopifyFulfillmentTracking(existingFulfillment.id, consignmentId);
    return existingFulfillment;
  }

  const mutation = `
    mutation CreatePathaoFulfillment($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status displayStatus trackingInfo { company number url } }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphqlRequest(mutation, {
    fulfillment: {
      lineItemsByFulfillmentOrder: open.map(x => ({ fulfillmentOrderId: x.id })),
      notifyCustomer: false,
      trackingInfo: { company: 'Pathao', number: String(consignmentId) }
    }
  });

  const payload = data?.fulfillmentCreate;
  if (payload?.userErrors?.length) throw new Error(payload.userErrors.map(e => e.message).join('; '));
  if (!payload?.fulfillment?.id) throw new Error('Shopify did not return a fulfillment ID.');
  return payload.fulfillment;
}

async function createShopifyFulfillmentEvent(fulfillmentId, status, message, happenedAt = null) {
  const mutation = `
    mutation CreatePathaoDeliveryEvent($fulfillmentEvent: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
        fulfillmentEvent { id status message happenedAt }
        userErrors { field message }
      }
    }
  `;

  const fulfillmentEvent = { fulfillmentId, status, message };
  if (happenedAt) fulfillmentEvent.happenedAt = happenedAt;

  const data = await shopifyGraphqlRequest(mutation, { fulfillmentEvent });
  const payload = data?.fulfillmentEventCreate;
  if (payload?.userErrors?.length) throw new Error(payload.userErrors.map(e => e.message).join('; '));
  return payload?.fulfillmentEvent || null;
}

async function syncPathaoStatusToShopify(orderId, explicitConsignmentId = null) {
  const order = await getShopifyOrderFulfillmentInfo(orderId);
  if (!order) throw new Error(`Shopify order ${orderId} not found`);

  let fulfillment = null;
  let consignmentId = explicitConsignmentId;

  for (const item of order.fulfillments || []) {
    const tracking = (item.trackingInfo || []).find(t => String(t.company || '').toLowerCase() === 'pathao');
    if (tracking) {
      fulfillment = item;
      consignmentId = consignmentId || tracking.number;
      break;
    }
  }

  if (!consignmentId) throw new Error('No Pathao consignment ID found on this Shopify order.');
  if (!fulfillment) fulfillment = await createShopifyFulfillmentForPathao(orderId, consignmentId);

  const pathaoResponse = await getPathaoOrderInfo(consignmentId);
  const info = pathaoResponse?.data || pathaoResponse;
  const pathaoStatus = info?.order_status_slug || info?.order_status || '';
  const shopifyStatus = mapPathaoStatusToShopifyEvent(pathaoStatus);

  if (!shopifyStatus) {
    return {
      success: true,
      updated: false,
      shopify_order_id: orderId,
      fulfillment_id: fulfillment.id,
      consignment_id: consignmentId,
      pathao_status: pathaoStatus,
      pathao_response: pathaoResponse
    };
  }

  let happenedAt = null;
  if (info?.updated_at) {
    const parsed = new Date(String(info.updated_at).replace(' ', 'T') + '+06:00');
    if (!isNaN(parsed.getTime())) happenedAt = parsed.toISOString();
  }

  const event = await createShopifyFulfillmentEvent(
    fulfillment.id,
    shopifyStatus,
    `Pathao: ${info?.order_status || pathaoStatus}`,
    happenedAt
  );

  return {
    success: true,
    updated: true,
    shopify_order_id: orderId,
    fulfillment_id: fulfillment.id,
    consignment_id: consignmentId,
    pathao_status: pathaoStatus,
    shopify_delivery_status: shopifyStatus,
    event
  };
}

async function sendShopifyOrderToPathao(order) {
  const result = await pathaoRequest('/aladdin/api/v1/orders', {
    method: 'POST',
    body: buildPathaoOrder(order)
  });

  const consignmentId = extractPathaoConsignmentId(result);
  let shopifyFulfillment = null;

  if (consignmentId) {
    try {
      shopifyFulfillment = await createShopifyFulfillmentForPathao(order.id, consignmentId);
    } catch (error) {
      console.error('Pathao created but Shopify fulfillment linking failed:', error.data || error.message);
    }
  }

  return {
    success: true,
    shopify_order_id: order.id,
    shopify_order_name: order.name,
    consignment_id: consignmentId,
    shopify_fulfillment: shopifyFulfillment,
    pathao_response: result
  };
}

app.get('/', (req, res) => res.json({
  success: true,
  service: 'Shopify Pathao Bridge',
  shop: SHOP,
  shopify_api_version: SHOPIFY_API_VERSION,
  pathao_environment: PATHAO_BASE_URL.includes('sandbox') ? 'sandbox' : 'production',
  server_started_at: SERVER_STARTED_AT.toISOString()
}));

app.get('/health', (req, res) => res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() }));

app.post('/webhooks/orders-create', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).json({ success: false, error: 'Invalid Shopify webhook signature' });

  const order = req.body;
  if (!order?.id) return res.status(400).json({ success: false, error: 'Invalid Shopify order webhook payload' });

  const orderId = String(order.id);
  const createdAt = new Date(order.created_at);
  if (!isNaN(createdAt.getTime()) && createdAt < SERVER_STARTED_AT) {
    return res.status(200).json({ success: true, skipped: true, reason: 'Order created before this server instance started' });
  }

  if (submittedOrders.has(orderId)) {
    return res.status(200).json({ success: true, duplicate: true, previous_result: submittedOrders.get(orderId) });
  }

  submittedOrders.set(orderId, { status: 'processing' });
  try {
    const result = await sendShopifyOrderToPathao(order);
    submittedOrders.set(orderId, result);
    return res.json(result);
  } catch (error) {
    submittedOrders.delete(orderId);
    return res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/test/shopify', async (req, res) => {
  try { res.json({ success: true, shop: (await shopifyRequest('shop.json')).shop }); }
  catch (error) { res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null }); }
});

app.get('/api/test/pathao', async (req, res) => {
  try { await getPathaoToken(); res.json({ success: true, message: 'Pathao API authentication working' }); }
  catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/shopify/orders', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 250);
    const status = req.query.status || 'any';
    const data = await shopifyRequest(`orders.json?status=${encodeURIComponent(status)}&limit=${limit}`);
    res.json({ success: true, count: data.orders?.length || 0, orders: data.orders || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/shopify/orders/:id', async (req, res) => {
  try {
    const data = await shopifyRequest(`orders/${encodeURIComponent(req.params.id)}.json`);
    res.json({ success: true, order: data.order || null });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/shopify/products', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 250);
    const data = await shopifyRequest(`products.json?limit=${limit}`);
    res.json({ success: true, count: data.products?.length || 0, products: data.products || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/shopify/customers', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 250);
    const data = await shopifyRequest(`customers.json?limit=${limit}`);
    res.json({ success: true, count: data.customers?.length || 0, customers: data.customers || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/shopify/order/:id/pathao', async (req, res) => {
  try {
    const data = await shopifyRequest(`orders/${encodeURIComponent(req.params.id)}.json`);
    if (!data.order) return res.status(404).json({ success: false, error: 'Shopify order not found' });
    res.json({ success: true, shopify_order_id: data.order.id, pathao_order: buildPathaoOrder(data.order) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.post('/api/pathao/create/:shopifyOrderId', async (req, res) => {
  const orderId = String(req.params.shopifyOrderId);
  if (submittedOrders.has(orderId)) {
    return res.status(409).json({ success: false, error: 'This Shopify order has already been submitted during this server session.', previous_result: submittedOrders.get(orderId) });
  }

  submittedOrders.set(orderId, { status: 'processing' });
  try {
    const data = await shopifyRequest(`orders/${encodeURIComponent(orderId)}.json`);
    if (!data.order) throw new Error('Shopify order not found');
    const result = await sendShopifyOrderToPathao(data.order);
    submittedOrders.set(orderId, result);
    res.json(result);
  } catch (error) {
    submittedOrders.delete(orderId);
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/pathao/order/:consignmentId/info', async (req, res) => {
  try {
    const result = await getPathaoOrderInfo(req.params.consignmentId);
    res.json({ success: true, consignment_id: req.params.consignmentId, pathao_response: result });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.post('/api/pathao/sync-status/:shopifyOrderId', async (req, res) => {
  try {
    const result = await syncPathaoStatusToShopify(
      req.params.shopifyOrderId,
      req.body?.consignment_id || req.query?.consignment_id || null
    );
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/sync/preview', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
    const data = await shopifyRequest(`orders.json?status=any&limit=${limit}`);
    const results = (data.orders || []).map(order => ({
      success: true,
      shopify_order_id: order.id,
      shopify_order_name: order.name,
      pathao_order: buildPathaoOrder(order)
    }));
    res.json({ success: true, count: results.length, results });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/api/debug/webhooks', async (req, res) => {
  try {
    const data = await shopifyRequest('webhooks.json');
    res.json({ success: true, count: data.webhooks?.length || 0, webhooks: data.webhooks || [] });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message, details: error.data || null });
  }
});

app.get('/webhooks/orders-create', (req, res) => res.json({
  success: true,
  message: 'Shopify orders/create webhook endpoint is active.',
  method: 'POST',
  topic: 'ORDERS_CREATE',
  endpoint: '/webhooks/orders-create',
  server_started_at: SERVER_STARTED_AT.toISOString()
}));

app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found', path: req.originalUrl }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Shopify → Pathao Bridge running on port ${PORT}`);
  console.log(`🏪 Shopify: ${SHOP}.myshopify.com`);
  console.log(`🚚 Pathao: ${PATHAO_BASE_URL.includes('sandbox') ? 'SANDBOX' : 'PRODUCTION'}`);
});
