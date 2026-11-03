// Order-confirmation SMS via SSL Wireless SMS Plus (Dynamic SMS API).
// Ported from Shopify-ISMS-Bridge and made per-merchant.

const { normalizePhone } = require('../pathao/mapper');

const DEFAULT_TEMPLATE = '{{name}}, আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে,ধন্যবাদ!';
const SSL_API_URL = 'https://smsplus.sslwireless.com/api/v3/send-sms/dynamic';

// Which orders get an SMS. Shopify's source_name: "web" = online store,
// "shopify_draft_order" = created manually in the admin (draft order).
const SOURCES = {
  all: { label: 'All orders', match: () => true },
  web: { label: 'Online store orders only', match: (s) => s === 'web' },
  manual: { label: 'Manual orders only', match: (s) => s === 'shopify_draft_order' },
};

function sourceAllowed(mode, sourceName) {
  const rule = SOURCES[mode] || SOURCES.web;
  return rule.match(String(sourceName || '').trim().toLowerCase());
}

// Bangladesh mobile → 8801XXXXXXXXX, or '' if invalid.
function smsPhone(raw) {
  const p = normalizePhone(raw);
  return p.valid ? `88${p.phone}` : '';
}

function fill(template, values) {
  return Object.entries(values).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(String(v ?? '')), template);
}

// Build the SMS from a Shopify orders/create webhook payload (REST shape).
function buildOrderSms(order, template) {
  const ship = order.shipping_address || {};
  const bill = order.billing_address || {};
  const candidates = [ship.phone, bill.phone, order.customer?.phone, order.phone].filter(Boolean);
  let phone = '';
  for (const c of candidates) { phone = smsPhone(c); if (phone) break; }
  const name = ship.name || bill.name || order.customer?.first_name || 'Customer';
  const items = (order.line_items || []).map((i) => `${i.title || i.name || 'Product'} x${Number(i.quantity) || 1}`).join(', ');
  const text = fill(template || DEFAULT_TEMPLATE, {
    name,
    order_number: order.name || order.order_number || order.id,
    items,
    total: order.total_price || '0.00',
    currency: order.currency || '',
  });
  return { phone, text, rawPhone: candidates[0] || '' };
}

function makeSmsClient({ fetchImpl = fetch, apiUrl = SSL_API_URL } = {}) {
  async function send({ token, sid }, phone, text, csmsId) {
    const res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ api_token: token, sid, sms: [{ msisdn: phone, text, csms_id: csmsId }] }),
    });
    let data;
    try { data = await res.json(); } catch { throw new Error(`SSL Wireless returned an invalid response (HTTP ${res.status})`); }
    if (!res.ok || data.status !== 'SUCCESS') {
      const detail = data.smsinfo?.[0]?.status_message || data.error_message || data.message || data.status || res.status;
      const err = new Error(`SSL Wireless rejected the SMS: ${detail}`);
      err.data = data;
      throw err;
    }
    return data;
  }
  return { send };
}

// csms_id must be unique per SMS and at most 20 characters.
function csmsIdFor(orderId) {
  return `${String(orderId).slice(-12)}${Date.now().toString(36)}`.slice(0, 20);
}

module.exports = { DEFAULT_TEMPLATE, SOURCES, sourceAllowed, smsPhone, buildOrderSms, makeSmsClient, csmsIdFor, SSL_API_URL };
