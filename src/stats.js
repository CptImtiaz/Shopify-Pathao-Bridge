// Delivery overview for the dashboard, computed from every shipment in the
// chosen period (not just the orders on screen).

const RANGES = ['today', '7d', 'month', 'all'];

function rangeStart(range, now = new Date()) {
  const d = new Date(now);
  if (range === 'today') { d.setHours(0, 0, 0, 0); return d; }
  if (range === '7d') { d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d; }
  if (range === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  return null;
}

// Pathao status text -> overview bucket.
function bucketOf(row) {
  if (row.status === 'failed' || row.status === 'skipped') return 'notSent';
  if (row.status !== 'sent') return 'processing';
  const s = String(row.pathao_status || '').toLowerCase();
  if (/partial/.test(s) || (/deliver/.test(s) && !/fail/.test(s) && !/assigned/.test(s))) return 'delivered';
  if (/return/.test(s)) return 'returned';
  if (/cancel/.test(s)) return 'cancelled';
  if (/fail/.test(s)) return 'failed';
  if (/assigned.?for.?delivery|out.?for|transit|hub|sorting|hold/.test(s)) return 'transit';
  if (/picked/.test(s) && !/pickup/.test(s)) return 'picked';
  return 'booked';
}

function dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }

// `from`/`to` (Dates, `to` exclusive) come from the dashboard's date picker and win over `range`.
function summarise(rows, { range = 'month', from = null, to = null, now = new Date() } = {}) {
  const start = from || (to ? null : rangeStart(range, now));
  const inRange = rows.filter((r) => {
    const t = new Date(r.created_at);
    return (!start || t >= start) && (!to || t < to);
  });
  const c = { booked: 0, picked: 0, transit: 0, delivered: 0, returned: 0, cancelled: 0, failed: 0, notSent: 0, processing: 0 };
  let codCollected = 0, codOnTheWay = 0, fees = 0, feeCount = 0;
  for (const r of inRange) {
    const b = bucketOf(r);
    c[b] += 1;
    const cod = Number(r.amount_to_collect) || 0;
    if (b === 'delivered') codCollected += cod;
    if (['booked', 'picked', 'transit'].includes(b)) codOnTheWay += cod;
    if (r.status === 'sent' && r.delivery_fee != null) { fees += Number(r.delivery_fee) || 0; feeCount += 1; }
  }
  const sent = c.booked + c.picked + c.transit + c.delivered + c.returned + c.cancelled + c.failed;
  const finished = c.delivered + c.returned + c.cancelled + c.failed;

  // Last 14 days of activity, always (independent of range).
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push({ date: dayKey(d), booked: 0, delivered: 0 }); }
  const byDay = new Map(days.map((d) => [d.date, d]));
  for (const r of rows) {
    if (r.status !== 'sent') continue;
    const d = byDay.get(dayKey(r.created_at));
    if (d) { d.booked += 1; if (bucketOf(r) === 'delivered') d.delivered += 1; }
  }

  return {
    range: from || to ? 'custom' : range,
    from: start ? start.toISOString() : null,
    to: to ? to.toISOString() : null,
    sent, ...c,
    onTheWay: c.booked + c.picked + c.transit,
    problems: c.returned + c.cancelled + c.failed,
    successRate: finished ? Math.round((c.delivered / finished) * 100) : null,
    codCollected: Math.round(codCollected), codOnTheWay: Math.round(codOnTheWay),
    fees: Math.round(fees), avgFee: feeCount ? Math.round(fees / feeCount) : null,
    daily: days,
  };
}

module.exports = { summarise, bucketOf, rangeStart, RANGES };
