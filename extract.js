const SHOP = process.env.SHOP || 'imtiaz-mmk7g8dm';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const PATHAO_BASE_URL = process.env.PATHAO_BASE_URL || 'https://courier-api-sandbox.pathao.com';
const PATHAO_CLIENT_ID = process.env.PATHAO_CLIENT_ID;
const PATHAO_CLIENT_SECRET = process.env.PATHAO_CLIENT_SECRET;
const PATHAO_USERNAME = process.env.PATHAO_USERNAME;
const PATHAO_PASSWORD = process.env.PATHAO_PASSWORD;
const MERCHANT_STORE_ID = process.env.MERCHANT_STORE_ID || 1;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing Shopify CLIENT_ID or CLIENT_SECRET');
  process.exit(1);
}

if (!PATHAO_CLIENT_ID || !PATHAO_CLIENT_SECRET || !PATHAO_USERNAME || !PATHAO_PASSWORD) {
  console.error('❌ Missing Pathao credentials');
  process.exit(1);
}

let SHOPIFY_TOKEN = null;
let SHOPIFY_EXPIRES_AT = 0;
let PATHAO_TOKEN = null;
let PATHAO_EXPIRES_AT = 0;

// Get Shopify OAuth Access Token
async function getShopifyToken() {
  if (SHOPIFY_TOKEN && Date.now() < SHOPIFY_EXPIRES_AT - 60000) {
    return SHOPIFY_TOKEN;
  }

  try {
    const tokenUrl = `https://${SHOP}.myshopify.com/admin/oauth/access_token`;
    
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'read_orders,read_customers,read_products',
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token Error: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    SHOPIFY_TOKEN = tokenData.access_token;
    SHOPIFY_EXPIRES_AT = Date.now() + (tokenData.expires_in * 1000);

    return SHOPIFY_TOKEN;
  } catch (error) {
    throw new Error(`Failed to get Shopify token: ${error.message}`);
  }
}

// Get Pathao Access Token
async function getPathaoToken() {
  if (PATHAO_TOKEN && Date.now() < PATHAO_EXPIRES_AT - 60000) {
    return PATHAO_TOKEN;
  }

  try {
    const tokenUrl = `${PATHAO_BASE_URL}/auth/login`;
    
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: PATHAO_CLIENT_ID,
        client_secret: PATHAO_CLIENT_SECRET,
        username: PATHAO_USERNAME,
        password: PATHAO_PASSWORD,
        grant_type: 'password',
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Pathao Token Error: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    PATHAO_TOKEN = tokenData.access_token;
    PATHAO_EXPIRES_AT = Date.now() + (3600 * 1000); // 1 hour

    return PATHAO_TOKEN;
  } catch (error) {
    throw new Error(`Failed to get Pathao token: ${error.message}`);
  }
}

// Create order in Pathao
async function createPathaoOrder(shopifyOrder) {
  try {
    const token = await getPathaoToken();
    const shipping = shopifyOrder.shipping_address || {};
    const items = shopifyOrder.line_items || [];
    const firstItem = items[0] || {};

    const pathaoOrder = {
      store_id: MERCHANT_STORE_ID,
      merchant_order_id: shopifyOrder.id.toString(),
      recipient_name: shipping.name || 'Customer',
      recipient_phone: shipping.phone || '01700000000',
      recipient_address: `${shipping.address1 || ''} ${shipping.address2 || ''}`.trim(),
      recipient_city: shipping.city || 'Dhaka',
      delivery_type: 48, // Standard delivery
      item_type: 2, // General item
      special_instruction: shopifyOrder.note || '',
      item_quantity: firstItem.quantity || 1,
      item_weight: firstItem.grams ? (firstItem.grams / 1000).toFixed(2) : '0.5',
      item_description: firstItem.title || shopifyOrder.id,
      amount_to_collect: parseFloat(shopifyOrder.total_price) || 0,
    };

    const response = await fetch(`${PATHAO_BASE_URL}/aladdin/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(pathaoOrder),
    });

    const result = await response.json();
    
    if (!response.ok) {
      return {
        success: false,
        order_id: shopifyOrder.id,
        error: result.message || `Error: ${response.status}`,
      };
    }

    return {
      success: true,
      order_id: shopifyOrder.id,
      pathao_id: result.data?.id,
      tracking_number: result.data?.tracking_number,
      status: result.data?.status,
    };
  } catch (error) {
    return {
      success: false,
      order_id: shopifyOrder.id,
      error: error.message,
    };
  }
}

async function extractAndSubmitOrders() {
  try {
    // Get Shopify orders
    const shopifyToken = await getShopifyToken();
    const url = `https://${SHOP}.myshopify.com/admin/api/2026-07/orders.json?status=any&limit=5`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify Error: ${response.status}`);
    }

    const data = await response.json();
    const orders = data.orders || [];

    // Submit each order to Pathao
    const results = [];
    for (const order of orders) {
      const result = await createPathaoOrder(order);
      results.push(result);
    }

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    console.log(`Shopify Orders: ${orders.length}`);
    console.log(`Pathao Created: ${successful}`);
    console.log(`Pathao Failed: ${failed}`);
    console.log(JSON.stringify(results, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
  }
}

extractAndSubmitOrders();
