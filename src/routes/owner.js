// App-owner admin page: /admin. Protected by HTTP Basic auth with ADMIN_PASSWORD
// (any username). Shows installed shops, plans and usage — no customer data.
// Disabled (404) when ADMIN_PASSWORD is not set.
const { redactPII } = require('../redact');

const crypto = require('crypto');
const express = require('express');
const { PLANS } = require('../plans');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function makeOwnerRouter({ config, db }) {
  const router = express.Router();

  // At most 5 password attempts per minute per IP address (wrong or right), then 429 for the rest of the minute.
  const LOGIN_PER_MIN = 5;
  const tries = new Map(); // ip -> { start, n }
  const clientIp = (req) => {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    return xff.length ? xff.at(-1) : req.socket.remoteAddress || 'unknown'; // last hop = what Railway's edge saw
  };

  router.use((req, res, next) => {
    if (!config.adminPassword) return res.status(404).send('Not found');
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    const pass = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : null;
    if (pass) {
      const now = Date.now(), ip = clientIp(req);
      let t = tries.get(ip);
      if (!t || now - t.start >= 60000) { t = { start: now, n: 0 }; tries.set(ip, t); }
      if (tries.size > 5000) for (const [k, v] of tries) if (now - v.start >= 60000) tries.delete(k);
      t.n += 1;
      if (t.n > LOGIN_PER_MIN) {
        res.set('Retry-After', String(Math.ceil((t.start + 60000 - now) / 1000)));
        return res.status(429).send('Too many attempts. Wait a minute and try again.');
      }
    }
    if (pass && safeEqual(pass, config.adminPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="AutoCourier BD owner", charset="UTF-8"');
    return res.status(401).send('Login required');
  });

  router.get('/', async (req, res, next) => {
    try {
      const [shops, failures, recent] = await Promise.all([db.ownerOverview(), db.recentFailures(25), db.recentShipments(40)]);
      const active = shops.filter((s) => !s.uninstalled_at);
      const paid = active.filter((s) => s.plan !== 'free');
      const mrr = paid.reduce((t, s) => t + ((PLANS[s.plan] && PLANS[s.plan].price) || 0), 0);
      const sent = active.reduce((t, s) => t + s.sent_month, 0);
      const tiles = [
        ['Active installs', active.length], ['Paying shops', paid.length], ['Est. monthly revenue', `$${mrr.toFixed(2)}`],
        ['Orders sent this month', sent], ['Uninstalled', shops.length - active.length],
      ];
      res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoCourier BD · Owner</title><style>
body{margin:0;background:#f4f5f7;font:14px/1.45 -apple-system,Segoe UI,Inter,Roboto,sans-serif;color:#15171a}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px}h1{margin:0 0 4px;font-size:22px}.meta{color:#6b7280;margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.tile,.card{background:#fff;border-radius:14px;box-shadow:0 0 0 1px #e6e7ea,0 1px 2px rgba(0,0,0,.04)}.tile{padding:14px 16px}.tile b{display:block;font-size:24px;margin-top:4px}
.tile span{color:#6b7280;font-size:12.5px}.card{overflow:auto;margin-bottom:20px}h2{font-size:15px;margin:0;padding:14px 16px;border-bottom:1px solid #eceef0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 16px;border-bottom:1px solid #f0f1f3;white-space:nowrap}th{font-size:12px;color:#6b7280;font-weight:600;background:#fafafb}
.b{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;background:#eceef0}.g{background:#d6f5e3;color:#0c5132}.r{background:#fde2e1;color:#8e0b21}.y{background:#fff1b8;color:#5c4b00}
td.err{white-space:normal;color:#8e0b21;max-width:520px}</style></head><body><div class="wrap">
<h1>AutoCourier BD owner dashboard</h1><p class="meta">Live from the app database · ${esc(new Date().toUTCString())}</p>
<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
<div class="card"><h2>Shops</h2><table><tr><th>Shop</th><th>Status</th><th>Plan</th><th>Pathao</th><th>Steadfast</th><th>Default</th><th>Auto-send</th><th>Sent this month</th><th>Failed (7 days)</th><th>Installed</th><th>Last activity</th><th>Granted scopes</th></tr>
${shops.map((s) => `<tr><td><a href="https://${esc(s.shop)}" target="_blank" rel="noopener">${esc(s.shop)}</a></td>
<td>${s.uninstalled_at ? `<span class="b r">Uninstalled ${esc(day(s.uninstalled_at))}</span>` : '<span class="b g">Active</span>'}</td>
<td><span class="b ${s.plan !== 'free' ? 'g' : ''}">${esc((PLANS[s.plan] && PLANS[s.plan].name) || s.plan)}</span></td>
<td>${s.pathao_connected ? `<span class="b g">Connected</span>${s.pathao_live ? ' <span class="b g">Live</span>' : ''}` : '<span class="b">Not set up</span>'}</td>
<td>${s.steadfast_connected ? `<span class="b g">Connected</span>${s.steadfast_live ? ' <span class="b g">Live</span>' : ''}` : '<span class="b">Not set up</span>'}</td>
<td>${esc(s.default_courier === 'steadfast' ? 'Steadfast' : 'Pathao')}</td>
<td>${s.auto_send ? 'On' : 'Off'}</td><td>${esc(s.sent_month)}</td><td>${s.failed_week ? `<span class="b r">${esc(s.failed_week)}</span>` : '0'}</td>
<td>${esc(day(s.installed_at))}</td><td>${esc(day(s.last_activity))}</td><td style="white-space:normal;max-width:320px;font-size:12px">${esc(s.scope)}</td></tr>`).join('') || '<tr><td colspan="12">No installs yet</td></tr>'}
</table></div>
<div class="card"><h2>Recent bookings</h2><table><tr><th>Updated</th><th>Shop</th><th>Order</th><th>Courier</th><th>Result</th><th>Courier status</th><th>Parcel</th><th>Error</th></tr>
${recent.map((r) => `<tr><td>${esc(new Date(r.updated_at).toISOString().slice(0, 16).replace('T', ' '))}</td><td>${esc(r.shop)}</td><td>${esc(r.order_name)}</td><td>${esc(r.courier || 'pathao')}</td>
<td><span class="b ${r.status === 'sent' ? 'g' : r.status === 'failed' ? 'r' : r.status === 'skipped' ? 'y' : ''}">${esc(r.status)}</span></td><td>${esc(r.pathao_status || '—')}</td><td>${esc(r.consignment_id || '—')}</td><td class="err">${esc(redactPII(r.error || ''))}</td></tr>`).join('') || '<tr><td colspan="8">None yet</td></tr>'}
</table></div>
<div class="card"><h2>Recent failed bookings</h2><table><tr><th>When</th><th>Shop</th><th>Order</th><th>Error</th></tr>
${failures.map((f) => `<tr><td>${esc(new Date(f.updated_at).toISOString().slice(0, 16).replace('T', ' '))}</td><td>${esc(f.shop)}</td><td>${esc(f.order_name)}</td><td class="err">${esc(redactPII(f.error || ''))}</td></tr>`).join('') || '<tr><td colspan="4">None</td></tr>'}
</table></div></div></body></html>`);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { makeOwnerRouter };
