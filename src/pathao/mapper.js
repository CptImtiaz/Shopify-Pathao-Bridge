// Converts a Shopify order into a Pathao Merchant API order payload.
// Ported from the original buildPathaoOrder()/normalizePhone(), and hardened
// against the problems merchants report with other Pathao integrations
// (doubled +880 prefixes, wrong COD amount after edits / partial payments,
// zero weight, too-short addresses).

// ---------- phone ----------

function normalizePhone(input) {
  if (!input) return { phone: '', valid: false };
  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Strip one or more leading 880 country codes ("+880 880 17..." happens).
  while (digits.startsWith('880') && digits.length > 11) digits = digits.slice(3);
  if (digits.length === 10 && digits.startsWith('1')) digits = '0' + digits;
  return { phone: digits, valid: /^01[3-9]\d{8}$/.test(digits) };
}

// ---------- weight ----------

const UNIT_TO_GRAMS = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };

function gramsFromMeasurement(weight) {
  if (!weight || weight.value == null) return 0;
  return Number(weight.value) * (UNIT_TO_GRAMS[weight.unit] || 1);
}

// ---------- normalisers: webhook (REST shape) and GraphQL shape ----------

function fromWebhook(o) {
  const ship = o.shipping_address || {};
  const bill = o.billing_address || {};
  return {
    id: String(o.id),
    name: o.name || `#${o.order_number || o.id}`,
    createdAt: o.created_at,
    cancelled: Boolean(o.cancelled_at),
    note: o.note || '',
    tags: String(o.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    paid: o.financial_status === 'paid',
    total: num(o.total_price),
    outstanding: o.total_outstanding != null ? num(o.total_outstanding) : null,
    shipping: {
      name: ship.name, phone: ship.phone, address1: ship.address1, address2: ship.address2,
      city: ship.city, province: ship.province, zip: ship.zip, country: ship.country,
    },
    fallbackName: bill.name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' '),
    fallbackPhones: [bill.phone, o.customer?.phone, o.phone],
    items: (o.line_items || []).map((li) => ({ title: li.title, quantity: Number(li.quantity) || 0, grams: Number(li.grams) || 0 })),
  };
}

function fromGraphql(o) {
  const ship = o.shippingAddress || {};
  return {
    id: String(o.legacyResourceId),
    name: o.name,
    createdAt: o.createdAt,
    cancelled: Boolean(o.cancelledAt),
    note: o.note || '',
    tags: o.tags || [],
    paid: o.displayFinancialStatus === 'PAID',
    total: num(o.totalPriceSet?.shopMoney?.amount),
    outstanding: o.totalOutstandingSet ? num(o.totalOutstandingSet.shopMoney.amount) : null,
    shipping: {
      name: ship.name, phone: ship.phone, address1: ship.address1, address2: ship.address2,
      city: ship.city, province: ship.province, zip: ship.zip, country: ship.country,
    },
    fallbackName: o.billingAddress?.name || [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' '),
    fallbackPhones: [o.billingAddress?.phone, o.customer?.phone, o.phone],
    risk: o.risk || null,
    items: (o.lineItems?.nodes || []).map((li) => ({
      title: li.title,
      image: li.image?.url || null,
      quantity: Number(li.quantity) || 0,
      grams: gramsFromMeasurement(li.variant?.inventoryItem?.measurement?.weight),
    })),
  };
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function clip(s, max) {
  s = String(s || '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------- build ----------

// Returns { payload, errors[] }. If errors is non-empty, don't send.
function buildPathaoOrder(order, settings) {
  const errors = [];
  const s = order.shipping;

  const name = clip(s.name || order.fallbackName || 'Customer', 100);

  const candidates = [s.phone, ...order.fallbackPhones].filter(Boolean);
  let phone = { phone: '', valid: false };
  for (const c of candidates) {
    phone = normalizePhone(c);
    if (phone.valid) break;
  }
  if (!phone.valid) {
    errors.push(candidates.length
      ? `Phone "${candidates[0]}" is not a valid Bangladesh mobile number (needs 01XXXXXXXXX)`
      : 'Order has no phone number');
  }

  const address = [s.address1, s.address2, s.city, s.province, s.zip].filter(Boolean).join(', ');
  if (address.length < 10) errors.push('Shipping address is missing or shorter than 10 characters');

  const quantity = order.items.reduce((t, i) => t + i.quantity, 0) || 1;
  const grams = order.items.reduce((t, i) => t + i.grams * i.quantity, 0);
  const fallbackKg = Math.max(Number(settings.default_weight) || 0.5, 0.5);
  const weight = grams > 0 ? Math.min(Math.max(grams / 1000, 0.5), 10) : fallbackKg;

  const description = order.items.map((i) => `${i.title || 'Product'} x ${i.quantity || 1}`).join(', ');

  // Cash to collect: what the customer still owes. Shopify's outstanding
  // amount already reflects edits, refunds and partial payments.
  let cod = order.outstanding != null ? order.outstanding : order.paid ? 0 : order.total;
  cod = Math.max(0, Math.round(cod));

  if (!settings.pathao_store_id) errors.push('No Pathao store selected in app settings');

  const payload = {
    store_id: Number(settings.pathao_store_id),
    merchant_order_id: order.name,
    recipient_name: name,
    recipient_phone: phone.phone,
    recipient_address: clip(address, 220),
    delivery_type: Number(settings.delivery_type) || 48,
    item_type: Number(settings.item_type) || 2,
    special_instruction: clip(order.note || settings.default_note || '', 255),
    item_quantity: quantity,
    item_weight: Number(weight.toFixed(2)),
    item_description: clip(description || `Shopify order ${order.name}`, 255),
    amount_to_collect: cod,
  };

  return { payload, errors };
}

// Decide whether an incoming order should be auto-sent.
function autoSendSkipReason(order, settings) {
  if (!settings.auto_send) return 'Auto-send is off';
  if (order.cancelled) return 'Order is cancelled';
  if (settings.auto_send_since && order.createdAt && new Date(order.createdAt) < new Date(settings.auto_send_since)) {
    return 'Order was created before auto-send was turned on';
  }
  const skipTag = (settings.skip_tag || '').trim().toLowerCase();
  if (skipTag && order.tags.some((t) => t.toLowerCase() === skipTag)) return `Order has the "${settings.skip_tag}" tag`;
  if (settings.only_cod) {
    const owed = order.outstanding != null ? order.outstanding : order.paid ? 0 : order.total;
    if (owed <= 0) return 'Order is prepaid and "COD orders only" is on';
  }
  return null;
}

module.exports = { normalizePhone, fromWebhook, fromGraphql, buildPathaoOrder, autoSendSkipReason };
