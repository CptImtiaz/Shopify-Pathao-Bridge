// Fraud check for an order. Combines Shopify's own risk analysis with signals
// that matter for cash-on-delivery in Bangladesh: the customer's delivery
// history with this store, phone validity, duplicate orders and large COD.
//
// Levels, most to least severe: high > medium > low > safe. "pending" means
// Shopify is still analysing and nothing else is wrong.

const { normalizePhone } = require('./pathao/mapper');

const RANK = { safe: 0, low: 1, pending: 1, medium: 2, high: 3 };
const LEVELS = {
  high: { label: 'High risk', tone: 'red' },
  medium: { label: 'Medium risk', tone: 'yellow' },
  low: { label: 'Low risk', tone: 'blue' },
  pending: { label: 'Checking', tone: '' },
  safe: { label: 'Safe', tone: 'green' },
};
const HIGH_COD = 10000;

// Delivery outcome of one past shipment, from the courier status text.
function outcome(row) {
  if (row.status !== 'sent') return null;
  const s = String(row.pathao_status || '').toLowerCase();
  if (/return/.test(s)) return 'returned';
  if (/cancel/.test(s)) return 'cancelled';
  if (/deliver/.test(s) && !/fail/.test(s)) return 'delivered';
  return 'active';
}

// history: past shipments for this phone (excluding this order).
function summariseHistory(rows) {
  const h = { total: 0, delivered: 0, returned: 0, cancelled: 0, active: 0 };
  for (const r of rows) {
    const o = outcome(r);
    if (!o) continue;
    h.total += 1; h[o] += 1;
  }
  const finished = h.delivered + h.returned + h.cancelled;
  h.successRate = finished ? Math.round((h.delivered / finished) * 100) : null;
  return h;
}

/**
 * @param order  normalised order (mapper.fromGraphql) plus `risk` (Shopify OrderRiskSummary or null)
 * @param ctx    { history: shipment rows for the same phone, duplicates: other recent orders by the same phone }
 */
function assessOrder(order, ctx = {}) {
  const reasons = [];
  let level = 'safe';
  const bump = (lv, text, tone) => { reasons.push({ text, tone: tone || LEVELS[lv].tone, level: lv }); if (RANK[lv] > RANK[level]) level = lv; };

  // 1. Shopify's own analysis
  const risk = order.risk || null;
  let shopify = 'unavailable';
  if (risk) {
    const rec = String(risk.recommendation || '').toUpperCase();
    const assess = risk.assessments || [];
    const levels = assess.map((a) => String(a.riskLevel || '').toUpperCase());
    const facts = assess.flatMap((a) => (a.facts || []).filter((f) => f.sentiment === 'NEGATIVE').map((f) => f.description)).filter(Boolean);
    if (rec === 'CANCEL' || levels.includes('HIGH')) { shopify = 'high'; bump('high', `Shopify flags this order as high risk${facts[0] ? `: ${facts[0]}` : ''}`); }
    else if (rec === 'INVESTIGATE' || levels.includes('MEDIUM')) { shopify = 'medium'; bump('medium', `Shopify suggests checking this order${facts[0] ? `: ${facts[0]}` : ''}`); }
    else if (levels.length && levels.every((l) => l === 'PENDING')) { shopify = 'pending'; }
    else if (rec === 'ACCEPT' || levels.includes('LOW')) { shopify = 'low'; reasons.push({ text: 'Shopify found no fraud indicators', tone: 'green', level: 'safe' }); }
    else shopify = 'none';
  }

  // 2. Phone
  const candidates = [order.shipping?.phone, ...(order.fallbackPhones || [])].filter(Boolean);
  const phone = candidates.map(normalizePhone).find((p) => p.valid) || null;
  if (!candidates.length) bump('high', 'No phone number on the order');
  else if (!phone) bump('high', `Phone "${candidates[0]}" isn't a Bangladesh mobile number`);

  // 3. Address
  const s = order.shipping || {};
  const address = [s.address1, s.address2, s.city].filter(Boolean).join(', ');
  if (address.length < 10) bump('medium', 'Shipping address is missing or very short');

  // 4. Delivery history with this store
  const history = summariseHistory(ctx.history || []);
  const bad = history.returned + history.cancelled;
  if (bad >= 2 && (history.successRate == null || history.successRate < 50)) bump('high', `Customer returned or cancelled ${bad} of ${history.delivered + bad} past parcels`);
  else if (bad >= 1) bump('medium', `Customer returned or cancelled ${bad} past parcel${bad > 1 ? 's' : ''}`);
  else if (history.delivered >= 1) reasons.push({ text: `Returning customer: ${history.delivered} parcel${history.delivered > 1 ? 's' : ''} delivered`, tone: 'green', level: 'safe' });
  else if (phone) { reasons.push({ text: 'New customer: no delivery history with your store yet', tone: 'blue', level: 'low' }); if (RANK.low > RANK[level]) level = 'low'; }

  // 5. Duplicate orders from the same phone in the last 24 hours
  const dups = (ctx.duplicates || []).length;
  if (dups) bump('medium', `${dups} other order${dups > 1 ? 's' : ''} from the same phone in the last 24 hours`);

  // 6. Large cash on delivery
  const cod = order.outstanding != null ? order.outstanding : order.paid ? 0 : order.total;
  if (cod >= HIGH_COD) bump('low', `High cash-on-delivery amount (৳${Math.round(cod).toLocaleString('en-US')})`, 'yellow');

  if (shopify === 'pending' && RANK[level] <= RANK.low) level = 'pending';

  // Score 0–100 for the meter: higher is riskier.
  const score = { safe: 5, low: 30, pending: 20, medium: 60, high: 90 }[level];
  return { level, ...LEVELS[level], score, shopify, phone: phone ? phone.phone : null, history, reasons };
}

module.exports = { assessOrder, summariseHistory, LEVELS, HIGH_COD };
