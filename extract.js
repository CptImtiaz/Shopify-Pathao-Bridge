const express = require('express');
const crypto = require('crypto');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const SHOP =
  process.env.SHOP || 'imtiaz-mmk7g8dm';

const CLIENT_ID =
  process.env.CLIENT_ID;

const CLIENT_SECRET =
  process.env.CLIENT_SECRET;

const SHOPIFY_WEBHOOK_SECRET =
  process.env.SHOPIFY_WEBHOOK_SECRET ||
  CLIENT_SECRET;

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  '2026-07';


// ============================================================
// PATHAO CONFIGURATION
// ============================================================

const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL ||
  'https://api-hermes.pathao.com';

const PATHAO_CLIENT_ID =
  process.env.PATHAO_CLIENT_ID;

const PATHAO_CLIENT_SECRET =
  process.env.PATHAO_CLIENT_SECRET;

const PATHAO_USERNAME =
  process.env.PATHAO_USERNAME;

const PATHAO_PASSWORD =
  process.env.PATHAO_PASSWORD;


// IMPORTANT:
// Your existing Pathao merchant store ID
const MERCHANT_STORE_ID =
  Number(
    process.env.MERCHANT_STORE_ID
  ) || 136349;


const PORT =
  process.env.PORT || 3000;


// ============================================================
// ENVIRONMENT VALIDATION
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


if (!SHOPIFY_WEBHOOK_SECRET) {

  console.error(
    '❌ Missing SHOPIFY_WEBHOOK_SECRET'
  );

  process.exit(1);
}


// ============================================================
// TOKEN CACHE
// ============================================================

// Shopify
let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;


// Pathao
let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;


// Pathao refresh token
let PATHAO_REFRESH_TOKEN = null;


// ============================================================
// DUPLICATE PROTECTION
// ============================================================

const submittedOrders = new Map();


// ============================================================
// EXPRESS JSON BODY
// ============================================================

app.use(
  express.json({

    limit: '1mb',

    verify: (req, res, buf) => {

      req.rawBody =
        Buffer.from(buf);
    }

  })
);


// ============================================================
// SHOPIFY WEBHOOK HMAC VERIFICATION
// ============================================================

function verifyShopifyWebhook(req) {

  try {

    const hmacHeader =
      req.get(
        'X-Shopify-Hmac-Sha256'
      );


    if (!hmacHeader) {

      console.error(
        '❌ Missing X-Shopify-Hmac-Sha256 header'
      );

      return false;
    }


    if (!req.rawBody) {

      console.error(
        '❌ Raw webhook body is missing'
      );

      return false;
    }


    const generatedHash =
      crypto
        .createHmac(
          'sha256',
          SHOPIFY_WEBHOOK_SECRET
        )
        .update(req.rawBody)
        .digest('base64');


    const receivedBuffer =
      Buffer.from(
        hmacHeader,
        'utf8'
      );


    const generatedBuffer =
      Buffer.from(
        generatedHash,
        'utf8'
      );


    if (
      receivedBuffer.length !==
      generatedBuffer.length
    ) {

      return false;
    }


    return crypto.timingSafeEqual(
      receivedBuffer,
      generatedBuffer
    );

  } catch (error) {

    console.error(
      'Webhook HMAC verification error:',
      error.message
    );

    return false;
  }
}


// ============================================================
// SHOPIFY ACCESS TOKEN
// ============================================================

async function getShopifyToken() {

  // Use cached token
  if (
    SHOPIFY_TOKEN &&
    Date.now() <
      SHOPIFY_EXPIRES_AT - 60000
  ) {

    return SHOPIFY_TOKEN;
  }


  console.log(
    '🔐 Requesting Shopify access token...'
  );


  const tokenUrl =
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`;


  const body =
    new URLSearchParams({

      grant_type:
        'client_credentials',

      client_id:
        CLIENT_ID,

      client_secret:
        CLIENT_SECRET

    });


  const response =
    await fetch(
      tokenUrl,
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/x-www-form-urlencoded'

        },

        body:
          body.toString()

      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    console.error(
      '❌ Shopify token response:',
      JSON.stringify(
        data,
        null,
        2
      )
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


  SHOPIFY_TOKEN =
    data.access_token;


  SHOPIFY_EXPIRES_AT =
    Date.now() +
    (
      (data.expires_in || 86400) *
      1000
    );


  console.log(
    '✅ Shopify access token obtained'
  );


  return SHOPIFY_TOKEN;
}


// ============================================================
// PATHAO ISSUE TOKEN
// ============================================================

async function issuePathaoToken() {

  console.log(
    '🔐 Requesting Pathao access token...'
  );


  const tokenUrl =
    `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;


  const response =
    await fetch(
      tokenUrl,
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/json',

          'Accept':
            'application/json'

        },

        body:
          JSON.stringify({

            client_id:
              PATHAO_CLIENT_ID,

            client_secret:
              PATHAO_CLIENT_SECRET,

            grant_type:
              'password',

            username:
              PATHAO_USERNAME,

            password:
              PATHAO_PASSWORD

          })

      }
    );


  const text =
    await response.text();


  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };
  }


  if (!response.ok) {

    console.error(
      '❌ Pathao token response:',
      JSON.stringify(
        data,
        null,
        2
      )
    );


    const error =
      new Error(
        `Pathao token error ${response.status}`
      );


    error.status =
      response.status;

    error.data =
      data;


    throw error;
  }


  if (!data.access_token) {

    throw new Error(
      'Pathao response did not contain access_token'
    );
  }


  PATHAO_TOKEN =
    data.access_token;


  PATHAO_REFRESH_TOKEN =
    data.refresh_token ||
    null;


  // Pathao documentation says:
  // expires_in = 432000 seconds = 5 days
  const expiresIn =
    Number(
      data.expires_in
    ) || 432000;


  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      expiresIn *
      1000
    );


  console.log(
    '✅ Pathao access token obtained'
  );


  console.log(
    `⏱️ Pathao token expires in ${expiresIn} seconds`
  );


  return data;
}


// ============================================================
// PATHAO REFRESH TOKEN
// ============================================================

async function refreshPathaoToken() {

  if (!PATHAO_REFRESH_TOKEN) {

    console.log(
      '⚠️ No Pathao refresh token available'
    );

    return issuePathaoToken();
  }


  console.log(
    '🔄 Refreshing Pathao access token...'
  );


  const tokenUrl =
    `${PATHAO_BASE_URL}/aladdin/api/v1/issue-token`;


  const response =
    await fetch(
      tokenUrl,
      {

        method:
          'POST',

        headers: {

          'Content-Type':
            'application/json',

          'Accept':
            'application/json'

        },

        body:
          JSON.stringify({

            client_id:
              PATHAO_CLIENT_ID,

            client_secret:
              PATHAO_CLIENT_SECRET,

            grant_type:
              'refresh_token',

            refresh_token:
              PATHAO_REFRESH_TOKEN

          })

      }
    );


  const text =
    await response.text();


  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };
  }


  if (!response.ok) {

    console.error(
      '❌ Pathao refresh response:',
      JSON.stringify(
        data,
        null,
        2
      )
    );


    // If refresh fails,
    // issue a completely new token.
    console.log(
      '⚠️ Refresh failed. Requesting new Pathao token...'
    );


    return issuePathaoToken();
  }


  if (!data.access_token) {

    return issuePathaoToken();
  }


  PATHAO_TOKEN =
    data.access_token;


  PATHAO_REFRESH_TOKEN =
    data.refresh_token ||
    PATHAO_REFRESH_TOKEN;


  const expiresIn =
    Number(
      data.expires_in
    ) || 432000;


  PATHAO_EXPIRES_AT =
    Date.now() +
    (
      expiresIn *
      1000
    );


  console.log(
    '✅ Pathao token refreshed'
  );


  return data;
}


// ============================================================
// GET PATHAO ACCESS TOKEN
// ============================================================

async function getPathaoToken() {

  // Existing valid token
  if (
    PATHAO_TOKEN &&
    Date.now() <
      PATHAO_EXPIRES_AT - 60000
  ) {

    return PATHAO_TOKEN;
  }


  // Try refresh token first
  if (PATHAO_REFRESH_TOKEN) {

    try {

      const data =
        await refreshPathaoToken();

      return data.access_token;

    } catch (error) {

      console.error(
        '⚠️ Pathao refresh failed:',
        error.message
      );
    }
  }


  // Request new token
  const data =
    await issuePathaoToken();


  return data.access_token;
}


// ============================================================
// SHOPIFY API REQUEST
// ============================================================

async function shopifyRequest(
  endpoint,
  options = {}
) {

  const token =
    await getShopifyToken();


  const url =
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;


  const response =
    await fetch(
      url,
      {

        method:
          options.method || 'GET',

        headers: {

          'X-Shopify-Access-Token':
            token,

          'Content-Type':
            'application/json',

          'Accept':
            'application/json',

          ...(options.headers || {})

        },

        body:
          options.body
            ? JSON.stringify(
                options.body
              )
            : undefined

      }
    );


  const text =
    await response.text();


  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };
  }


  if (!response.ok) {

    const error =
      new Error(
        `Shopify API ${response.status}`
      );


    error.status =
      response.status;

    error.data =
      data;


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

  let token =
    await getPathaoToken();


  const url =
    `${PATHAO_BASE_URL}${endpoint}`;


  let response =
    await fetch(
      url,
      {

        method:
          options.method || 'GET',

        headers: {

          'Authorization':
            `Bearer ${token}`,

          'Content-Type':
            'application/json',

          'Accept':
            'application/json',

          ...(options.headers || {})

        },

        body:
          options.body
            ? JSON.stringify(
                options.body
              )
            : undefined

      }
    );


  // ----------------------------------------------------------
  // If token expired, refresh and retry ONCE
  // ----------------------------------------------------------

  if (
    response.status === 401
  ) {

    console.log(
      '⚠️ Pathao token expired. Getting new token...'
    );


    PATHAO_TOKEN =
      null;

    PATHAO_EXPIRES_AT =
      0;


    token =
      await getPathaoToken();


    response =
      await fetch(
        url,
        {

          method:
            options.method || 'GET',

          headers: {

            'Authorization':
              `Bearer ${token}`,

            'Content-Type':
              'application/json',

            'Accept':
              'application/json',

            ...(options.headers || {})

          },

          body:
            options.body
              ? JSON.stringify(
                  options.body
                )
              : undefined

        }
      );
  }


  const text =
    await response.text();


  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };
  }


  if (!response.ok) {

    const error =
      new Error(
        `Pathao API ${response.status}`
      );


    error.status =
      response.status;

    error.data =
      data;


    throw error;
  }


  return data;
}


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        'ok',

      service:
        'Shopify Pathao Bridge',

      shop:
        SHOP,

      shopify_api_version:
        SHOPIFY_API_VERSION,

      pathao_environment:
        PATHAO_BASE_URL.includes(
          'sandbox'
        )
          ? 'sandbox'
          : 'production',

      pathao_store_id:
        MERCHANT_STORE_ID,

      webhook:
        '/webhooks/orders-create'

    });
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        'healthy',

      timestamp:
        new Date().toISOString()

    });
  }
);


// ============================================================
// TEST PATHAO TOKEN
// ============================================================

app.get(
  '/api/test/pathao',
  async (req, res) => {

    try {

      const token =
        await getPathaoToken();


      res.json({

        success:
          true,

        message:
          'Pathao API authentication working',

        environment:
          PATHAO_BASE_URL.includes(
            'sandbox'
          )
            ? 'sandbox'
            : 'production',

        token_received:
          Boolean(token),

        store_id:
          MERCHANT_STORE_ID,

        token_expires_at:
          new Date(
            PATHAO_EXPIRES_AT
          ).toISOString()

      });

    } catch (error) {

      console.error(
        '❌ Pathao test error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        service:
          'pathao',

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// GET PATHAO STORES
// ============================================================

app.get(
  '/api/pathao/stores',
  async (req, res) => {

    try {

      const data =
        await pathaoRequest(
          '/aladdin/api/v1/stores'
        );


      res.json({

        success:
          true,

        configured_store_id:
          MERCHANT_STORE_ID,

        stores:
          data

      });

    } catch (error) {

      console.error(
        '❌ Pathao stores error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// SHOPIFY WEBHOOK
// ============================================================

app.post(
  '/webhooks/orders-create',
  async (req, res) => {

    console.log(
      '\n============================================'
    );

    console.log(
      '📩 SHOPIFY ORDERS/CREATE WEBHOOK RECEIVED'
    );

    console.log(
      '============================================'
    );


    // --------------------------------------------------------
    // Verify HMAC
    // --------------------------------------------------------

    if (
      !verifyShopifyWebhook(req)
    ) {

      console.error(
        '❌ Invalid Shopify webhook signature'
      );


      return res.status(401).json({

        success:
          false,

        error:
          'Invalid Shopify webhook signature'

      });
    }


    console.log(
      '✅ Shopify webhook signature verified'
    );


    // --------------------------------------------------------
    // Headers
    // --------------------------------------------------------

    const webhookId =
      req.get(
        'X-Shopify-Webhook-Id'
      );

    const topic =
      req.get(
        'X-Shopify-Topic'
      );

    const shopDomain =
      req.get(
        'X-Shopify-Shop-Domain'
      );


    console.log(
      'Webhook ID:',
      webhookId || 'N/A'
    );

    console.log(
      'Topic:',
      topic || 'N/A'
    );

    console.log(
      'Shop:',
      shopDomain || 'N/A'
    );


    // --------------------------------------------------------
    // Order
    // --------------------------------------------------------

    const shopifyOrder =
      req.body;


    if (
      !shopifyOrder ||
      !shopifyOrder.id
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          'Invalid Shopify order webhook payload'

      });
    }


    const shopifyOrderId =
      String(
        shopifyOrder.id
      );


    console.log(
      '🛒 Shopify Order ID:',
      shopifyOrderId
    );


    console.log(
      '🧾 Shopify Order:',
      shopifyOrder.name ||
      'N/A'
    );


    // --------------------------------------------------------
    // Duplicate protection
    // --------------------------------------------------------

    if (
      submittedOrders.has(
        shopifyOrderId
      )
    ) {

      console.log(
        '⚠️ Order already submitted to Pathao'
      );


      return res.status(200).json({

        success:
          true,

        duplicate:
          true,

        previous_result:
          submittedOrders.get(
            shopifyOrderId
          )

      });
    }


    // --------------------------------------------------------
    // Build Pathao order
    // --------------------------------------------------------

    const pathaoOrder =
      buildPathaoOrder(
        shopifyOrder
      );


    console.log(
      '\n📦 PATHAO ORDER PAYLOAD'
    );


    console.log(
      JSON.stringify(
        pathaoOrder,
        null,
        2
      )
    );


    // --------------------------------------------------------
    // Create Pathao order
    // --------------------------------------------------------

    try {

      console.log(
        '\n🚚 Sending order to Pathao...'
      );


      const result =
        await pathaoRequest(
          '/aladdin/api/v1/orders',
          {

            method:
              'POST',

            body:
              pathaoOrder

          }
        );


      const pathaoResult = {

        success:
          true,

        shopify_order_id:
          shopifyOrder.id,

        shopify_order_name:
          shopifyOrder.name,

        pathao_response:
          result

      };


      submittedOrders.set(
        shopifyOrderId,
        pathaoResult
      );


      console.log(
        '\n============================================'
      );

      console.log(
        '✅ SHOPIFY → PATHAO SUCCESS'
      );

      console.log(
        '============================================'
      );


      console.log(
        JSON.stringify(
          pathaoResult,
          null,
          2
        )
      );


      return res.status(200).json(
        pathaoResult
      );

    } catch (error) {

      console.error(
        '\n❌ PATHAO ORDER CREATION FAILED'
      );


      console.error(
        JSON.stringify(
          error.data ||
          error.message,
          null,
          2
        )
      );


      // IMPORTANT:
      // We do NOT normalize or modify
      // the phone number.
      //
      // We return Pathao's original
      // validation response.

      return res.status(
        error.status || 500
      ).json({

        success:
          false,

        shopify_order_id:
          shopifyOrderId,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// SHOPIFY TEST
// ============================================================

app.get(
  '/api/test/shopify',
  async (req, res) => {

    try {

      const data =
        await shopifyRequest(
          'shop.json'
        );


      res.json({

        success:
          true,

        message:
          'Shopify API connection working',

        shop:
          data.shop

      });

    } catch (error) {

      console.error(
        'Shopify test error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        service:
          'shopify',

        error:
          error.message,

        details:
          error.data ||
          null

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

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit,
              10
            ) || 10,
            1
          ),
          250
        );


      const status =
        req.query.status ||
        'any';


      const data =
        await shopifyRequest(
          `orders.json?status=${encodeURIComponent(
            status
          )}&limit=${limit}`
        );


      res.json({

        success:
          true,

        count:
          data.orders?.length ||
          0,

        orders:
          data.orders ||
          []

      });

    } catch (error) {

      console.error(
        'Orders error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

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
        encodeURIComponent(
          req.params.id
        );


      const data =
        await shopifyRequest(
          `orders/${orderId}.json`
        );


      res.json({

        success:
          true,

        order:
          data.order ||
          null

      });

    } catch (error) {

      console.error(
        'Single order error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

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

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit,
              10
            ) || 10,
            1
          ),
          250
        );


      const data =
        await shopifyRequest(
          `products.json?limit=${limit}`
        );


      res.json({

        success:
          true,

        count:
          data.products?.length ||
          0,

        products:
          data.products ||
          []

      });

    } catch (error) {

      console.error(
        'Products error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

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

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit,
              10
            ) || 10,
            1
          ),
          250
        );


      const data =
        await shopifyRequest(
          `customers.json?limit=${limit}`
        );


      res.json({

        success:
          true,

        count:
          data.customers?.length ||
          0,

        customers:
          data.customers ||
          []

      });

    } catch (error) {

      console.error(
        'Customers error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// CALCULATE ORDER WEIGHT
// ============================================================

function calculateOrderWeight(
  items
) {

  let totalGrams =
    0;


  for (
    const item of items
  ) {

    const grams =
      Number(
        item.grams
      ) || 0;


    const quantity =
      Number(
        item.quantity
      ) || 0;


    totalGrams +=
      grams *
      quantity;
  }


  let weightKg =
    totalGrams / 1000;


  // Pathao minimum
  if (
    weightKg < 0.5
  ) {

    weightKg =
      0.5;
  }


  // Pathao maximum
  if (
    weightKg > 10
  ) {

    weightKg =
      10;
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
    shopifyOrder.shipping_address ||
    {};


  const billing =
    shopifyOrder.billing_address ||
    {};


  const items =
    shopifyOrder.line_items ||
    [];


  // ----------------------------------------------------------
  // Recipient name
  // ----------------------------------------------------------

  const recipientName =
    shipping.name ||
    billing.name ||
    shopifyOrder.customer?.first_name ||
    'Customer';


  // ----------------------------------------------------------
  // Recipient phone
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // NO NORMALIZATION
  // NO REPLACEMENT
  // NO COUNTRY CODE CONVERSION
  // NO REMOVAL OF +
  //
  // The exact Shopify value is sent to Pathao.
  // ----------------------------------------------------------

  const recipientPhone =
    shipping.phone ||
    billing.phone ||
    shopifyOrder.customer?.phone ||
    '';


  // ----------------------------------------------------------
  // Recipient address
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // Total quantity
  // ----------------------------------------------------------

  const totalQuantity =
    items.reduce(
      (
        total,
        item
      ) => {

        return (
          total +
          (
            Number(
              item.quantity
            ) || 0
          )
        );

      },
      0
    );


  // ----------------------------------------------------------
  // Item description
  // ----------------------------------------------------------

  const itemDescription =
    items
      .map(
        item => {

          const title =
            item.title ||
            'Product';


          const quantity =
            Number(
              item.quantity
            ) || 1;


          return (
            `${title} x ${quantity}`
          );

        }
      )
      .join(', ');


  // ----------------------------------------------------------
  // Shopify total
  // ----------------------------------------------------------

  const totalPrice =
    Number(
      parseFloat(
        shopifyOrder.total_price ||
        0
      ).toFixed(0)
    );


  // ----------------------------------------------------------
  // Pathao order
  // ----------------------------------------------------------

  const pathaoOrder = {

    store_id:
      MERCHANT_STORE_ID,

    merchant_order_id:
      String(
        shopifyOrder.id
      ),

    recipient_name:
      recipientName,

    // EXACT SHOPIFY PHONE
    recipient_phone:
      recipientPhone,

    recipient_address:
      recipientAddress,

    delivery_type:
      48,

    item_type:
      2,

    special_instruction:
      shopifyOrder.note ||
      '',

    item_quantity:
      totalQuantity ||
      1,

    item_weight:
      calculateOrderWeight(
        items
      ),

    item_description:
      itemDescription ||
      `Shopify Order ${
        shopifyOrder.name ||
        shopifyOrder.id
      }`,

    amount_to_collect:
      totalPrice

  };


  return pathaoOrder;
}


// ============================================================
// PREVIEW SHOPIFY ORDER → PATHAO
// ============================================================

app.get(
  '/api/shopify/order/:id/pathao',
  async (req, res) => {

    try {

      const orderId =
        encodeURIComponent(
          req.params.id
        );


      const data =
        await shopifyRequest(
          `orders/${orderId}.json`
        );


      if (!data.order) {

        return res.status(404).json({

          success:
            false,

          error:
            'Shopify order not found'

        });
      }


      const pathaoOrder =
        buildPathaoOrder(
          data.order
        );


      res.json({

        success:
          true,

        shopify_order_id:
          data.order.id,

        pathao_order:
          pathaoOrder

      });

    } catch (error) {

      console.error(
        'Pathao conversion error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

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
      // Duplicate check
      // ------------------------------------------------------

      if (
        submittedOrders.has(
          String(
            shopifyOrderId
          )
        )
      ) {

        return res.status(409).json({

          success:
            false,

          error:
            'This Shopify order has already been submitted to Pathao during this server session.',

          previous_result:
            submittedOrders.get(
              String(
                shopifyOrderId
              )
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

          success:
            false,

          error:
            'Shopify order not found'

        });
      }


      // ------------------------------------------------------
      // Build Pathao order
      // ------------------------------------------------------

      const pathaoOrder =
        buildPathaoOrder(
          shopifyOrder
        );


      console.log(
        '\n📦 Creating Pathao order:'
      );


      console.log(
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

            method:
              'POST',

            body:
              pathaoOrder

          }
        );


      const pathaoResult = {

        success:
          true,

        shopify_order_id:
          shopifyOrder.id,

        shopify_order_name:
          shopifyOrder.name,

        pathao_response:
          result

      };


      submittedOrders.set(
        String(
          shopifyOrderId
        ),
        pathaoResult
      );


      res.json(
        pathaoResult
      );

    } catch (error) {

      console.error(
        '\n❌ Pathao order creation error:'
      );


      console.error(
        JSON.stringify(
          error.data ||
          error.message,
          null,
          2
        )
      );


      // Return Pathao's actual response
      res.status(
        error.status || 500
      ).json({

        success:
          false,

        shopify_order_id:
          shopifyOrderId,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// BULK PATHAO ORDERS
// ============================================================

app.post(
  '/api/pathao/bulk',
  async (req, res) => {

    try {

      if (
        !Array.isArray(
          req.body.orders
        )
      ) {

        return res.status(400).json({

          success:
            false,

          error:
            'orders must be an array'

        });
      }


      const orders =
        req.body.orders;


      const result =
        await pathaoRequest(
          '/aladdin/api/v1/orders/bulk',
          {

            method:
              'POST',

            body: {

              orders:
                orders

            }

          }
        );


      res.json({

        success:
          true,

        pathao_response:
          result

      });

    } catch (error) {

      console.error(
        '❌ Bulk Pathao error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// PATHAO ORDER INFO
// ============================================================

app.get(
  '/api/pathao/order/:consignmentId',
  async (req, res) => {

    try {

      const consignmentId =
        encodeURIComponent(
          req.params.consignmentId
        );


      const result =
        await pathaoRequest(
          `/aladdin/api/v1/orders/${consignmentId}/info`
        );


      res.json({

        success:
          true,

        pathao_response:
          result

      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// PATHAO CITIES
// ============================================================

app.get(
  '/api/pathao/cities',
  async (req, res) => {

    try {

      const result =
        await pathaoRequest(
          '/aladdin/api/v1/city-list'
        );


      res.json({

        success:
          true,

        pathao_response:
          result

      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// PATHAO ZONES
// ============================================================

app.get(
  '/api/pathao/cities/:cityId/zones',
  async (req, res) => {

    try {

      const cityId =
        encodeURIComponent(
          req.params.cityId
        );


      const result =
        await pathaoRequest(
          `/aladdin/api/v1/cities/${cityId}/zone-list`
        );


      res.json({

        success:
          true,

        pathao_response:
          result

      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// PATHAO AREAS
// ============================================================

app.get(
  '/api/pathao/zones/:zoneId/areas',
  async (req, res) => {

    try {

      const zoneId =
        encodeURIComponent(
          req.params.zoneId
        );


      const result =
        await pathaoRequest(
          `/aladdin/api/v1/zones/${zoneId}/area-list`
        );


      res.json({

        success:
          true,

        pathao_response:
          result

      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// PATHAO PRICE CALCULATION
// ============================================================

app.post(
  '/api/pathao/price',
  async (req, res) => {

    try {

      const result =
        await pathaoRequest(
          '/aladdin/api/v1/merchant/price-plan',
          {

            method:
              'POST',

            body:
              req.body

          }
        );


      res.json({

        success:
          true,

        pathao_response:
          result

      });

    } catch (error) {

      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// SYNC PREVIEW
// ============================================================

app.get(
  '/api/sync/preview',
  async (req, res) => {

    try {

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit,
              10
            ) || 5,
            1
          ),
          50
        );


      const data =
        await shopifyRequest(
          `orders.json?status=any&limit=${limit}`
        );


      const orders =
        data.orders ||
        [];


      const results =
        [];


      for (
        const order of orders
      ) {

        const pathaoOrder =
          buildPathaoOrder(
            order
          );


        results.push({

          success:
            true,

          shopify_order_id:
            order.id,

          shopify_order_name:
            order.name,

          pathao_order:
            pathaoOrder

        });
      }


      res.json({

        success:
          true,

        count:
          results.length,

        results

      });

    } catch (error) {

      console.error(
        'Sync preview error:',
        error.data ||
        error.message
      );


      res.status(
        error.status || 500
      ).json({

        success:
          false,

        error:
          error.message,

        details:
          error.data ||
          null

      });
    }
  }
);


// ============================================================
// WEBHOOK GET TEST
// ============================================================

app.get(
  '/webhooks/orders-create',
  (req, res) => {

    res.json({

      success:
        true,

      message:
        'Shopify orders/create webhook endpoint is active.',

      method:
        'POST',

      topic:
        'ORDERS_CREATE',

      endpoint:
        '/webhooks/orders-create',

      status:
        'waiting_for_shopify_webhook'

    });
  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({

      success:
        false,

      error:
        'Endpoint not found',

      path:
        req.originalUrl

    });
  }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      'Unhandled error:',
      err
    );


    res.status(500).json({

      success:
        false,

      error:
        'Internal server error'

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
        PATHAO_BASE_URL.includes(
          'sandbox'
        )
          ? 'SANDBOX'
          : 'PRODUCTION'
      }`
    );

    console.log(
      `🏬 Pathao Store ID: ${MERCHANT_STORE_ID}`
    );

    console.log(
      '🔔 Webhook: POST /webhooks/orders-create'
    );

    console.log(
      '============================================'
    );
  }
);
