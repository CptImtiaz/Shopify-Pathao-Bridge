const SHOP = process.env.SHOP || 'imtiaz-mmk7g8dm';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing CLIENT_ID or CLIENT_SECRET environment variables');
  process.exit(1);
}

let ACCESS_TOKEN = null;
let TOKEN_EXPIRES_AT = 0;

// Get OAuth Access Token
async function getAccessToken() {
  if (ACCESS_TOKEN && Date.now() < TOKEN_EXPIRES_AT - 60000) {
    return ACCESS_TOKEN;
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
    ACCESS_TOKEN = tokenData.access_token;
    TOKEN_EXPIRES_AT = Date.now() + (tokenData.expires_in * 1000);

    console.log('✅ Got access token\n');
    return ACCESS_TOKEN;
  } catch (error) {
    throw new Error(`Failed to get token: ${error.message}`);
  }
}

async function extractOrders() {
  try {
    // Get token first
    const token = await getAccessToken();

    const url = `https://${SHOP}.myshopify.com/admin/api/2026-07/orders.json?status=any&limit=5`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Error: ${response.status}`);
    }

    const data = await response.json();
    const orders = data.orders || [];

    console.log('\n📦 SHOPIFY ORDERS EXTRACTED\n');
    console.log('═══════════════════════════════════════════════════════════\n');

    orders.forEach((order, idx) => {
      const shipping = order.shipping_address || {};
      const items = order.line_items || [];

      console.log(`Order ${idx + 1}:`);
      console.log('─────────────────────────────────────────');
      console.log(`merchant_order_id: ${order.id}`);
      console.log(`recipient_name: ${shipping.name || 'N/A'}`);
      console.log(`recipient_phone: ${shipping.phone || 'N/A'}`);
      console.log(`recipient_address: ${shipping.address1 || ''} ${shipping.address2 || ''}`);
      console.log(`recipient_city: ${shipping.city || 'N/A'}`);
      console.log(`recipient_zone: ${shipping.province || 'N/A'}`);
      console.log(`recipient_area: ${shipping.country || 'N/A'}`);
      console.log(`delivery_type: ${order.fulfillment_status === 'fulfilled' ? 'Delivered' : 'Pending'}`);
      console.log(`amount_to_collect: ${order.total_price}`);

      console.log('\nItems:');
      items.forEach((item, itemIdx) => {
        console.log(`  ${itemIdx + 1}. ${item.title}`);
        console.log(`     item_type: ${item.product_type || item.title}`);
        console.log(`     item_quantity: ${item.quantity}`);
        console.log(`     item_weight: ${item.grams ? (item.grams / 1000).toFixed(2) : '0'} kg`);
        console.log(`     item_description: ${item.title}`);
        console.log(`     special_instruction: ${order.note || 'None'}`);
      });

      console.log(`\ncreated_at: ${order.created_at}`);
      console.log(`currency: ${order.currency}`);
      console.log('\n');
    });

    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`✅ Total Orders: ${orders.length}\n`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

extractOrders();
