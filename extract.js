const express = require('express');

const app = express();

app.use(express.json({ limit: '1mb' }));

// ============================================================
// CONFIGURATION
// ============================================================

const SHOP = process.env.SHOP || 'imtiaz-mmk7g8dm';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || '2026-07';

const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL ||
  'https://courier-api-sandbox.pathao.com';

const PATHAO_CLIENT_ID = process.env.PATHAO_CLIENT_ID;
const PATHAO_CLIENT_SECRET = process.env.PATHAO_CLIENT_SECRET;
const PATHAO_USERNAME = process.env.PATHAO_USERNAME;
const PATHAO_PASSWORD = process.env.PATHAO_PASSWORD;

const MERCHANT_STORE_ID =
  Number(process.env.MERCHANT_STORE_ID) || 1;

const PORT = process.env.PORT || 3000;

// ============================================================
// VALIDATE ENVIRONMENT
// ============================================================

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '❌ Missing CLIENT_ID or CLIENT_SECRET'
  );
  process.exit(1);
}

if (
  !PATHAO_CLIENT_ID ||
  !PATHAO_CLIENT_SECRET ||
  !PATHAO_USERNAME ||
  !PATHAO_PASSWORD
) {
  console.error(
    '❌ Missing Pathao credentials'
  );
  process.exit(1);
}

// ============================================================
// TOKEN CACHE
// ============================================================

let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;

let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;

// ============================================================
// SIMPLE IN-MEMORY PATHAO DUPLICATE PROTECTION
// ============================================================
//
// IMPORTANT:
// This is only protection while this Railway instance is running.
// For permanent production protection, use Shopify metafields/tags
// or another persistent database.
//
// ============================================================

const submittedOrders = new Map();

// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {

  // Reuse existing token if still valid
  if (
    SHOPIFY_TOKEN &&
    Date.now() < SHOPIFY_EXPIRES_AT - 60_000
  ) {
    return SHOPIFY_TOKEN;
  }

  console.log('🔐 Requesting Shopify access token...');

  const tokenUrl =
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const data = await response.json();

  if (!response.ok) {

    console.error(
      '❌ Shopify token response:',
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      `Shopify token error ${response.status}: ${
        data.error_description ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }

  if (!data.access_token) {
    throw new Error(
      'Shopify response did not contain access_token'
    );
  }

  SHOPIFY_TOKEN = data.access_token;

  // Shopify client-credential tokens are valid for 24 hours.
  SHOPIFY_EXPIRES_AT =
    Date.now() +
    ((data.expires_in || 86400) * 1000);

  console.log(
    '✅ Shopify access token obtained'
  );

  return SHOPIFY_TOKEN;
}

// ============================================================
// PATHAO ACCESS TOKEN
// ============================================================

async function getPathaoToken() {

  if (
    PATHAO_TOKEN &&
    Date.now() < PATHAO_EXPIRES_AT - 60_000
  ) {
    return PATHAO_TOKEN;
  }

  console.log('🔐 Requesting Pathao access token...');

  const tokenUrl =
    `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: PATHAO_CLIENT_ID,
      client_secret: PATHAO_CLIENT_SECRET,
      username: PATHAO_USERNAME,
      password: PATHAO_PASSWORD,
      grant_type: 'password'
    })
  });

  const data = await response.json();

  if (!response.ok) {

    console.error(
      '❌ Pathao token response:',
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      `Pathao token error ${response.status}: ${
        data.message ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }

  if (!data.access_token) {
    throw new Error(
      'Pathao response did not contain access_token'
    );
  }

  PATHAO_TOKEN = data.access_token;

  // Pathao token normally lasts around 1 hour.
  PATHAO_EXPIRES_AT =
    Date.now() +
    ((data.expires_in || 3600) * 1000);

  console.log(
    '✅ Pathao access token obtained'
  );

  return PATHAO_TOKEN;
}

// ============================================================
// SHOPIFY API REQUEST
// ============================================================

async function shopifyRequest(
  endpoint,
  options = {}
) {

  const token = await getShopifyToken();

  const url =
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;

  const response = await fetch(url, {
    method: options.method || 'GET',

    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },

    body: options.body
      ? JSON.stringify(options.body)
      : undefined
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {

    const error = new Error(
      `Shopify API ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

// ============================================================
// PATHAO API REQUEST
// ============================================================

async function pathaoRequest(
  endpoint,
  options = {}
) {

  const token = await getPathaoToken();

  const url =
    `${PATHAO_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    method: options.method || 'GET',

    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },

    body: options.body
      ? JSON.stringify(options.body)
      : undefined
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {

    const error = new Error(
      `Pathao API ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {

  res.json({
    success: true,
    status: 'ok',
    service: 'Shopify Pathao Bridge',
    shop: SHOP,
    shopify_api_version: SHOPIFY_API_VERSION,
    pathao_environment:
      PATHAO_BASE_URL.includes('sandbox')
        ? 'sandbox'
        : 'production'
  });
});


app.get('/health', (req, res) => {

  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// TEST SHOPIFY AUTHENTICATION
// ============================================================

app.get(
  '/api/test/shopify',
  async (req, res) => {

    try {

      const data = await shopifyRequest(
        'shop.json'
      );

      res.json({
        success: true,
        message: 'Shopify API connection working',
        shop: data.shop
      });

    } catch (error) {

      console.error(
        'Shopify test error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        service: 'shopify',
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// TEST PATHAO AUTHENTICATION
// ============================================================

app.get(
  '/api/test/pathao',
  async (req, res) => {

    try {

      await getPathaoToken();

      res.json({
        success: true,
        message: 'Pathao API authentication working',
        environment:
          PATHAO_BASE_URL.includes('sandbox')
            ? 'sandbox'
            : 'production'
      });

    } catch (error) {

      console.error(
        'Pathao test error:',
        error.message
      );

      res.status(error.status || 500).json({
        success: false,
        service: 'pathao',
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// GET SHOPIFY ORDERS
// ============================================================

app.get(
  '/api/shopify/orders',
  async (req, res) => {

    try {

      const limit = Math.min(
        Math.max(
          parseInt(req.query.limit, 10) || 10,
          1
        ),
        250
      );

      const status =
        req.query.status || 'any';

      const data = await shopifyRequest(
        `orders.json?status=${encodeURIComponent(
          status
        )}&limit=${limit}`
      );

      res.json({
        success: true,
        count: data.orders?.length || 0,
        orders: data.orders || []
      });

    } catch (error) {

      console.error(
        'Orders error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// GET SINGLE SHOPIFY ORDER
// ============================================================

app.get(
  '/api/shopify/orders/:id',
  async (req, res) => {

    try {

      const orderId =
        encodeURIComponent(req.params.id);

      const data = await shopifyRequest(
        `orders/${orderId}.json`
      );

      res.json({
        success: true,
        order: data.order || null
      });

    } catch (error) {

      console.error(
        'Single order error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// GET SHOPIFY PRODUCTS
// ============================================================

app.get(
  '/api/shopify/products',
  async (req, res) => {

    try {

      const limit = Math.min(
        Math.max(
          parseInt(req.query.limit, 10) || 10,
          1
        ),
        250
      );

      const data = await shopifyRequest(
        `products.json?limit=${limit}`
      );

      res.json({
        success: true,
        count: data.products?.length || 0,
        products: data.products || []
      });

    } catch (error) {

      console.error(
        'Products error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// GET SHOPIFY CUSTOMERS
// ============================================================

app.get(
  '/api/shopify/customers',
  async (req, res) => {

    try {

      const limit = Math.min(
        Math.max(
          parseInt(req.query.limit, 10) || 10,
          1
        ),
        250
      );

      const data = await shopifyRequest(
        `customers.json?limit=${limit}`
      );

      res.json({
        success: true,
        count: data.customers?.length || 0,
        customers: data.customers || []
      });

    } catch (error) {

      console.error(
        'Customers error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// CALCULATE ORDER WEIGHT
// ============================================================

function calculateOrderWeight(items) {

  let totalGrams = 0;

  for (const item of items) {

    const grams =
      Number(item.grams) || 0;

    const quantity =
      Number(item.quantity) || 0;

    totalGrams +=
      grams * quantity;
  }

  let weightKg =
    totalGrams / 1000;

  // Pathao minimum = 0.5 KG
  if (weightKg < 0.5) {
    weightKg = 0.5;
  }

  // Pathao maximum = 10 KG
  if (weightKg > 10) {
    weightKg = 10;
  }

  return Number(
    weightKg.toFixed(2)
  );
}

// ============================================================
// BUILD PATHAO ORDER
// ============================================================

function buildPathaoOrder(
  shopifyOrder
) {

  const shipping =
    shopifyOrder.shipping_address || {};

  const items =
    shopifyOrder.line_items || [];

  if (!shipping.name) {
    throw new Error(
      'Recipient name is missing'
    );
  }

  if (!shipping.phone) {
    throw new Error(
      `Recipient phone is missing for Shopify order ${shopifyOrder.id}`
    );
  }

  const addressParts = [
    shipping.address1,
    shipping.address2,
    shipping.city,
    shipping.province,
    shipping.zip,
    shipping.country
  ].filter(Boolean);

  const recipientAddress =
    addressParts.join(', ');

  if (
    recipientAddress.length < 10
  ) {
    throw new Error(
      `Recipient address is too short for Shopify order ${shopifyOrder.id}`
    );
  }

  if (
    recipientAddress.length > 220
  ) {
    throw new Error(
      `Recipient address is longer than Pathao's 220 character limit for Shopify order ${shopifyOrder.id}`
    );
  }

  // Total quantity across ALL products
  const totalQuantity =
    items.reduce(
      (total, item) =>
        total +
        (Number(item.quantity) || 0),
      0
    );

  // Description of all products
  const itemDescription =
    items
      .map(item => {
        const title =
          item.title || 'Product';

        const quantity =
          Number(item.quantity) || 1;

        return `${title} x ${quantity}`;
      })
      .join(', ');

  // Shopify total price
  const totalPrice =
    Number(
      parseFloat(
        shopifyOrder.total_price || 0
      ).toFixed(0)
    );

  const pathaoOrder = {

    store_id: MERCHANT_STORE_ID,

    merchant_order_id:
      String(shopifyOrder.id),

    recipient_name:
      shipping.name,

    recipient_phone:
      shipping.phone,

    recipient_address:
      recipientAddress,

    delivery_type: 48,

    item_type: 2,

    special_instruction:
      shopifyOrder.note || '',

    item_quantity:
      totalQuantity || 1,

    item_weight:
      calculateOrderWeight(items),

    item_description:
      itemDescription ||
      `Shopify Order ${shopifyOrder.name || shopifyOrder.id}`,

    amount_to_collect:
      totalPrice
  };

  // Only include secondary phone if it exists
  if (shipping.phone) {
    // Don't duplicate the same phone
  }

  return pathaoOrder;
}

// ============================================================
// CONVERT SHOPIFY ORDER TO PATHAO FORMAT
// ============================================================

app.get(
  '/api/shopify/order/:id/pathao',
  async (req, res) => {

    try {

      const orderId =
        encodeURIComponent(req.params.id);

      const data = await shopifyRequest(
        `orders/${orderId}.json`
      );

      if (!data.order) {

        return res.status(404).json({
          success: false,
          error: 'Shopify order not found'
        });
      }

      const pathaoOrder =
        buildPathaoOrder(data.order);

      res.json({
        success: true,
        shopify_order_id:
          data.order.id,
        pathao_order:
          pathaoOrder
      });

    } catch (error) {

      console.error(
        'Pathao conversion error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// CREATE PATHAO ORDER FROM SHOPIFY ORDER
// ============================================================

app.post(
  '/api/pathao/create/:shopifyOrderId',
  async (req, res) => {

    const shopifyOrderId =
      req.params.shopifyOrderId;

    try {

      // ------------------------------------------------------
      // Check duplicate
      // ------------------------------------------------------

      if (
        submittedOrders.has(
          String(shopifyOrderId)
        )
      ) {

        return res.status(409).json({
          success: false,
          error:
            'This Shopify order has already been submitted to Pathao during this server session.',
          previous_result:
            submittedOrders.get(
              String(shopifyOrderId)
            )
        });
      }

      // ------------------------------------------------------
      // Get Shopify order
      // ------------------------------------------------------

      const data =
        await shopifyRequest(
          `orders/${encodeURIComponent(
            shopifyOrderId
          )}.json`
        );

      const shopifyOrder =
        data.order;

      if (!shopifyOrder) {

        return res.status(404).json({
          success: false,
          error: 'Shopify order not found'
        });
      }

      // ------------------------------------------------------
      // Build Pathao payload
      // ------------------------------------------------------

      const pathaoOrder =
        buildPathaoOrder(
          shopifyOrder
        );

      console.log(
        '📦 Creating Pathao order:',
        JSON.stringify(
          pathaoOrder,
          null,
          2
        )
      );

      // ------------------------------------------------------
      // Send to Pathao
      // ------------------------------------------------------

      const result =
        await pathaoRequest(
          '/aladdin/api/v1/orders',
          {
            method: 'POST',
            body: pathaoOrder
          }
        );

      const pathaoResult = {
        success: true,

        shopify_order_id:
          shopifyOrder.id,

        shopify_order_name:
          shopifyOrder.name,

        pathao_response:
          result
      };

      // Remember this order during this server session
      submittedOrders.set(
        String(shopifyOrderId),
        pathaoResult
      );

      res.json(
        pathaoResult
      );

    } catch (error) {

      console.error(
        '❌ Pathao order creation error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,

        shopify_order_id:
          shopifyOrderId,

        error:
          error.message,

        details:
          error.data || null
      });
    }
  }
);

// ============================================================
// GET ALL SHOPIFY ORDERS AND PREVIEW PATHAO DATA
// ============================================================

app.get(
  '/api/sync/preview',
  async (req, res) => {

    try {

      const limit = Math.min(
        Math.max(
          parseInt(req.query.limit, 10) || 5,
          1
        ),
        50
      );

      const data =
        await shopifyRequest(
          `orders.json?status=any&limit=${limit}`
        );

      const orders =
        data.orders || [];

      const results = [];

      for (const order of orders) {

        try {

          const pathaoOrder =
            buildPathaoOrder(order);

          results.push({
            success: true,

            shopify_order_id:
              order.id,

            shopify_order_name:
              order.name,

            pathao_order:
              pathaoOrder
          });

        } catch (error) {

          results.push({
            success: false,

            shopify_order_id:
              order.id,

            shopify_order_name:
              order.name,

            error:
              error.message
          });
        }
      }

      res.json({
        success: true,
        count: results.length,
        results
      });

    } catch (error) {

      console.error(
        'Sync preview error:',
        error.data || error.message
      );

      res.status(error.status || 500).json({
        success: false,
        error: error.message,
        details: error.data || null
      });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (err, req, res, next) => {

    console.error(
      'Unhandled error:',
      err
    );

    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '============================================'
    );

    console.log(
      '🚀 SHOPIFY → PATHAO BRIDGE'
    );

    console.log(
      '============================================'
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🏪 Shopify: ${SHOP}.myshopify.com`
    );

    console.log(
      `📡 Shopify API: ${SHOPIFY_API_VERSION}`
    );

    console.log(
      `🚚 Pathao: ${
        PATHAO_BASE_URL.includes('sandbox')
          ? 'SANDBOX'
          : 'PRODUCTION'
      }`
    );

    console.log(
      `🏬 Pathao Store ID: ${MERCHANT_STORE_ID}`
    );

    console.log(
      '============================================'
    );
  }
);
