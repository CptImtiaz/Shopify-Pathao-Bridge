// Steadfast Courier (Packzy) API client, one per merchant.
//
// Auth is two static headers (Api-Key + Secret-Key) on every call: no login and
// no token to refresh. Base URL: https://portal.packzy.com/api/v1
//
// Watch out (from Steadfast's guide):
// - 10 failed logins in 5 minutes locks the key out for 60 minutes, so never
//   retry a 401 in a loop.
// - Some endpoints report a failure inside a 200 response: always read `status`.
// - Duplicate invoices are refused, so a retry can never double-book.

const { normalizePhone } = require('../pathao/mapper');

class SteadfastError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function describeError(status, data) {
  const said = data && (data.message || data.error) ? ` (Steadfast said: "${String(data.message || data.error).slice(0, 160)}")` : '';
  if (status === 401) return `Steadfast rejected the API key or secret key${said}`;
  if (status === 403) return 'Steadfast account is inactive or needs its ownership (KYC) details resubmitted';
  if (status === 429) return 'Too many requests to Steadfast. Wait a few minutes and try again.';
  if (data && data.errors && typeof data.errors === 'object') {
    const parts = Object.entries(data.errors).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`);
    if (parts.length) return parts.join('; ');
  }
  return (data && (data.message || data.error)) || `Steadfast HTTP ${status}`;
}

function makeSteadfast({ config, cipher, db = null, fetchImpl = fetch }) {
  const base = () => (config.steadfastBaseUrl || 'https://portal.packzy.com/api/v1').replace(/\/$/, '');

  function hasCredentials(s) {
    return Boolean(s && s.steadfast_api_key && s.steadfast_secret_enc);
  }

  // `probe`: checking keys that aren't saved yet, so a 401 isn't recorded on the shop.
  async function call(settings, path, { method = 'GET', body, probe = false } = {}) {
    if (!hasCredentials(settings)) throw new SteadfastError('Steadfast is not connected yet. Add your API key and secret key under Couriers.', 400);
    // Keys were rejected before: don't keep failing (Steadfast locks the key out after 10 failures).
    if (!probe && settings.steadfast_auth_error) {
      throw new SteadfastError(`${settings.steadfast_auth_error}. Re-enter your keys under Couriers → Steadfast.`, 401);
    }
    const res = await fetchImpl(`${base()}${path}`, {
      method,
      headers: {
        'Api-Key': settings.steadfast_api_key,
        'Secret-Key': cipher.decrypt(settings.steadfast_secret_enc),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
    if (!res.ok) {
      const err = new SteadfastError(describeError(res.status, data), res.status, data);
      if (res.status === 401 && !probe && db && settings.shop) await db.updateSettings(settings.shop, { steadfast_auth_error: err.message }).catch(() => {});
      throw err;
    }
    // A 200 can still carry a failure in the body.
    if (data && data.status != null && Number(data.status) !== 200) {
      throw new SteadfastError(describeError(Number(data.status) || 400, data), Number(data.status) || 400, data);
    }
    return data;
  }

  // Checks the keys and returns the current balance (what Steadfast owes the merchant).
  async function balance(settings, { probe = false } = {}) {
    const d = await call(settings, '/get_balance', { probe });
    return { balance: d.current_balance != null ? Number(d.current_balance) : null };
  }

  async function createOrder(settings, payload) {
    const d = await call(settings, '/create_order', { method: 'POST', body: payload });
    const c = d.consignment || {};
    if (!c.consignment_id) throw new SteadfastError(d.message || 'Steadfast did not return a consignment id', 502, d);
    return {
      consignmentId: c.consignment_id,
      trackingCode: c.tracking_code || null,
      status: c.status || 'in_review',
      deliveryFee: c.delivery_charge != null ? Number(c.delivery_charge) : null,
      raw: d,
    };
  }

  async function statusByCid(settings, consignmentId) {
    const d = await call(settings, `/status_by_cid/${encodeURIComponent(consignmentId)}`);
    return { status: d.delivery_status || 'unknown' };
  }

  return { hasCredentials, balance, createOrder, statusByCid };
}

const clip = (s, max) => {
  s = String(s || '').trim();
  return s.length > max ? s.slice(0, max) : s;
};
// Steadfast replaces these with spaces anyway; do it ourselves so what we store matches.
const clean = (s) => String(s || '').replace(/[{};<>$]/g, ' ').replace(/\s+/g, ' ').trim();

// Invoice must be unique per Steadfast account. "#1001" -> "1001".
function invoiceFor(order) {
  const v = String(order.name || '').replace(/[^A-Za-z0-9_-]/g, '');
  return v || String(order.id);
}

// Returns { payload, errors[] }. If errors is non-empty, don't send.
function buildSteadfastOrder(order, settings = {}) {
  const errors = [];
  const s = order.shipping;
  const name = clip(clean(s.name || order.fallbackName || 'Customer'), 100);

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

  const address = clean([s.address1, s.address2, s.city, s.province, s.zip].filter(Boolean).join(', '));
  if (address.length < 10) errors.push('Shipping address is missing or shorter than 10 characters');

  let cod = order.outstanding != null ? order.outstanding : order.paid ? 0 : order.total;
  cod = Math.max(0, Math.round(cod));

  const items = order.items.map((i) => `${i.title || 'Product'} x ${i.quantity || 1}`).join(', ');
  const payload = {
    invoice: clip(invoiceFor(order), 100),
    recipient_name: name,
    recipient_phone: phone.phone,
    recipient_address: clip(address, 490),
    cod_amount: cod,
    note: clip(clean(order.note || settings.default_note || ''), 480),
    item_description: clip(clean(items || `Shopify order ${order.name}`), 480),
  };
  return { payload, errors };
}

// Public tracking page for a parcel.
function steadfastTrackingUrl(trackingCode) {
  return trackingCode ? `https://steadfast.com.bd/t/${encodeURIComponent(trackingCode)}` : 'https://steadfast.com.bd/';
}

module.exports = { makeSteadfast, buildSteadfastOrder, steadfastTrackingUrl, invoiceFor, SteadfastError };
