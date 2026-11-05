const crypto = require('crypto');

// Postgres storage. One row per installed shop, one settings row per shop,
// and one shipment row per Shopify order (the unique key doubles as the
// duplicate-protection lock that used to live in memory).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shops (
    shop TEXT PRIMARY KEY,
    access_token_enc TEXT,
    access_expires_at TIMESTAMPTZ,
    refresh_token_enc TEXT,
    refresh_expires_at TIMESTAMPTZ,
    scope TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    subscription_id TEXT,
    installed_at TIMESTAMPTZ,
    uninstalled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    shop TEXT PRIMARY KEY,
    pathao_env TEXT NOT NULL DEFAULT 'production',
    pathao_client_id TEXT,
    pathao_client_secret_enc TEXT,
    pathao_username TEXT,
    pathao_password_enc TEXT,
    pathao_store_id INTEGER,
    pathao_token_enc TEXT,
    pathao_token_expires_at TIMESTAMPTZ,
    pathao_refresh_enc TEXT,
    auto_send BOOLEAN NOT NULL DEFAULT FALSE,
    auto_send_since TIMESTAMPTZ,
    delivery_type INTEGER NOT NULL DEFAULT 48,
    item_type INTEGER NOT NULL DEFAULT 2,
    default_weight NUMERIC NOT NULL DEFAULT 0.5,
    skip_tag TEXT NOT NULL DEFAULT 'no-pathao',
    only_cod BOOLEAN NOT NULL DEFAULT FALSE,
    tag_orders BOOLEAN NOT NULL DEFAULT TRUE,
    webhook_secret TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS shipments (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    shopify_order_id TEXT NOT NULL,
    order_name TEXT,
    status TEXT NOT NULL,
    consignment_id TEXT,
    pathao_status TEXT,
    delivery_fee NUMERIC,
    amount_to_collect NUMERIC,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    counted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop, shopify_order_id)
  )`,
  `CREATE INDEX IF NOT EXISTS shipments_shop_created ON shipments (shop, created_at)`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS pathao_store_name TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_token_enc TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_sid TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_source TEXT NOT NULL DEFAULT 'web'`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_template TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_since TIMESTAMPTZ`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_courier TEXT NOT NULL DEFAULT 'pathao'`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_note TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS courier TEXT NOT NULL DEFAULT 'pathao'`,
  `CREATE TABLE IF NOT EXISTS sms_log (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    shopify_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    claim_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop, shopify_order_id)
  )`,
  `CREATE INDEX IF NOT EXISTS shipments_consignment ON shipments (consignment_id)`,
  `ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS order_name TEXT`,
  `ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS pathao_webhook_at TIMESTAMPTZ`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sync_fulfillment BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS hold_risky BOOLEAN NOT NULL DEFAULT TRUE`,
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    email TEXT NOT NULL,
    topic TEXT NOT NULL,
    message TEXT NOT NULL,
    order_name TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS fulfill_when TEXT NOT NULL DEFAULT 'booked'`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_customer BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shopify_fulfillment_id TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shopify_event TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sync_error TEXT`,
  `CREATE INDEX IF NOT EXISTS shipments_shop_phone ON shipments (shop, phone)`,
  // Steadfast courier
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS steadfast_api_key TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS steadfast_secret_enc TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS steadfast_webhook_token TEXT`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS steadfast_webhook_at TIMESTAMPTZ`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_code TEXT`,
  // Set when Steadfast answers 401: stops further calls (10 failures = 60 min lockout).
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS steadfast_auth_error TEXT`,
  // Latest tracking text from the courier (e.g. Steadfast's tracking_message).
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS courier_message TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS courier_message_at TIMESTAMPTZ`,
  // Merchant's own note on an order (e.g. why it is on hold). Never sent to couriers.
  `CREATE TABLE IF NOT EXISTS order_notes (
    shop TEXT NOT NULL,
    shopify_order_id TEXT NOT NULL,
    note TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shop, shopify_order_id)
  )`,
];

function makeDb(pool) {
  const q = (text, params = []) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    pool,

    async migrate() {
      for (const stmt of SCHEMA) await q(stmt);
    },

    // ---------- shops ----------
    getShop: (shop) => one('SELECT * FROM shops WHERE shop = $1', [shop]),

    async saveShopTokens(shop, t) {
      await q(
        `INSERT INTO shops (shop, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at, scope, installed_at, uninstalled_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NULL)
         ON CONFLICT (shop) DO UPDATE SET
           access_token_enc = EXCLUDED.access_token_enc,
           access_expires_at = EXCLUDED.access_expires_at,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           scope = EXCLUDED.scope,
           installed_at = COALESCE(shops.installed_at, NOW()),
           uninstalled_at = NULL`,
        [shop, t.accessTokenEnc, t.accessExpiresAt, t.refreshTokenEnc, t.refreshExpiresAt, t.scope]
      );
    },

    async markUninstalled(shop) {
      await q(
        `UPDATE shops SET access_token_enc = NULL, refresh_token_enc = NULL, access_expires_at = NULL,
           refresh_expires_at = NULL, uninstalled_at = NOW(), installed_at = NULL, plan = 'free', subscription_id = NULL
         WHERE shop = $1`,
        [shop]
      );
      // Drop merchant's Pathao credentials immediately on uninstall.
      await q(
        `UPDATE settings SET pathao_client_secret_enc = NULL, pathao_password_enc = NULL,
           pathao_token_enc = NULL, pathao_refresh_enc = NULL, auto_send = FALSE,
           sms_token_enc = NULL, sms_enabled = FALSE WHERE shop = $1`,
        [shop]
      );
    },

    async setPlan(shop, plan, subscriptionId) {
      await q('UPDATE shops SET plan = $2, subscription_id = $3 WHERE shop = $1', [shop, plan, subscriptionId || null]);
    },

    async deleteShopData(shop) {
      await q('DELETE FROM support_tickets WHERE shop = $1', [shop]);
      await q('DELETE FROM sms_log WHERE shop = $1', [shop]);
      await q('DELETE FROM shipments WHERE shop = $1', [shop]);
      await q('DELETE FROM order_notes WHERE shop = $1', [shop]);
      await q('DELETE FROM settings WHERE shop = $1', [shop]);
      await q('DELETE FROM shops WHERE shop = $1', [shop]);
    },

    // ---------- settings ----------
    async getSettings(shop) {
      const row = await one('SELECT * FROM settings WHERE shop = $1', [shop]);
      if (row) return row;
      await q('INSERT INTO settings (shop) VALUES ($1) ON CONFLICT (shop) DO NOTHING', [shop]);
      return one('SELECT * FROM settings WHERE shop = $1', [shop]);
    },

    async updateSettings(shop, fields) {
      await this.getSettings(shop);
      const keys = Object.keys(fields);
      if (!keys.length) return this.getSettings(shop);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await q(`UPDATE settings SET ${sets}, updated_at = NOW() WHERE shop = $1`, [shop, ...keys.map((k) => fields[k])]);
      return this.getSettings(shop);
    },

    // ---------- shipments ----------
    // Atomically claim an order. Returns the row if we got the lock, or null
    // if the order is already sent / currently processing.
    // Each claim writes a random token; we only own the row if it comes back
    // with OUR token (robust even if a driver returns the conflicting row).
    async claimShipment(shop, orderId, orderName) {
      const token = crypto.randomUUID();
      const inserted = await one(
        `INSERT INTO shipments (shop, shopify_order_id, order_name, status, attempts, claim_token)
         VALUES ($1,$2,$3,'processing',1,$4)
         ON CONFLICT (shop, shopify_order_id) DO NOTHING
         RETURNING *`,
        [shop, String(orderId), orderName || null, token]
      );
      if (inserted && inserted.claim_token === token) return inserted;
      // Existing row: allow retry only if it previously failed / was skipped,
      // or got stuck in 'processing' (e.g. server crashed mid-request) for 10+ min.
      return one(
        `UPDATE shipments SET status = 'processing', attempts = attempts + 1, error = NULL, claim_token = $3, updated_at = NOW()
         WHERE shop = $1 AND shopify_order_id = $2
           AND (status IN ('failed','skipped')
                OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'))
         RETURNING *`,
        [shop, String(orderId), token]
      );
    },

    getShipment: (shop, orderId) =>
      one('SELECT * FROM shipments WHERE shop = $1 AND shopify_order_id = $2', [shop, String(orderId)]),

    async finishShipment(shop, orderId, fields) {
      const keys = Object.keys(fields);
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      return one(
        `UPDATE shipments SET ${sets}, updated_at = NOW() WHERE shop = $1 AND shopify_order_id = $2 RETURNING *`,
        [shop, String(orderId), ...keys.map((k) => fields[k])]
      );
    },

    async recordSkip(shop, orderId, orderName, reason) {
      await q(
        `INSERT INTO shipments (shop, shopify_order_id, order_name, status, error)
         VALUES ($1,$2,$3,'skipped',$4)
         ON CONFLICT (shop, shopify_order_id) DO NOTHING`,
        [shop, String(orderId), orderName || null, reason]
      );
    },

    listShipments: async (shop, limit = 50) =>
      (await q('SELECT * FROM shipments WHERE shop = $1 ORDER BY created_at DESC LIMIT $2', [shop, limit])).rows,

    async shipmentsForOrders(shop, orderIds) {
      if (!orderIds.length) return [];
      return (await q('SELECT * FROM shipments WHERE shop = $1 AND shopify_order_id = ANY($2)', [shop, orderIds.map(String)])).rows;
    },

    async createTicket(shop, t) {
      return one(`INSERT INTO support_tickets (shop, email, topic, message, order_name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [shop, t.email, t.topic, t.message, t.orderName || null]);
    },
    async listTickets(shop, limit = 20) {
      return (await q('SELECT id, topic, message, order_name, status, created_at FROM support_tickets WHERE shop = $1 ORDER BY created_at DESC LIMIT $2', [shop, limit])).rows;
    },
    async allTickets(limit = 50) {
      return (await q('SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT $1', [limit])).rows;
    },

    async pendingShopifySync(shop, limit = 25) {
      return (await q(
        `SELECT shopify_order_id FROM shipments WHERE shop = $1 AND status = 'sent' AND consignment_id IS NOT NULL
           AND shopify_fulfillment_id IS NULL AND sync_error LIKE '%permission%' ORDER BY updated_at DESC LIMIT $2`, [shop, limit]
      )).rows.map((r) => r.shopify_order_id);
    },

    async historyForPhones(shop, phones) {
      const list = [...new Set(phones.filter(Boolean))];
      if (!list.length) return [];
      return (await q('SELECT shopify_order_id, phone, status, pathao_status, created_at FROM shipments WHERE shop = $1 AND phone = ANY($2)', [shop, list])).rows;
    },

    // Owner overview: one row per installed shop, no customer data.
    async ownerOverview() {
      const [shops, agg] = await Promise.all([
        q(`SELECT s.shop, s.plan, s.scope, s.installed_at, s.uninstalled_at, st.pathao_client_id, st.pathao_env, st.auto_send
           FROM shops s LEFT JOIN settings st ON st.shop = s.shop`),
        q(`SELECT shop,
                  SUM(CASE WHEN counted = TRUE AND created_at >= date_trunc('month', NOW()) THEN 1 ELSE 0 END)::int AS sent_month,
                  SUM(CASE WHEN status = 'failed' AND updated_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS failed_week,
                  MAX(updated_at) AS last_activity
           FROM shipments GROUP BY shop`),
      ]);
      const byShop = new Map(agg.rows.map((r) => [r.shop, r]));
      return shops.rows.map((s) => {
        const a = byShop.get(s.shop) || {};
        return {
          shop: s.shop, plan: s.plan, scope: s.scope || '', installed_at: s.installed_at, uninstalled_at: s.uninstalled_at,
          pathao_connected: Boolean(s.pathao_client_id), pathao_env: s.pathao_env, auto_send: Boolean(s.auto_send),
          sent_month: Number(a.sent_month) || 0, failed_week: Number(a.failed_week) || 0, last_activity: a.last_activity || null,
        };
      }).sort((x, y) => (Boolean(x.uninstalled_at) - Boolean(y.uninstalled_at)) || (new Date(y.installed_at || 0) - new Date(x.installed_at || 0)));
    },

    async recentFailures(limit = 20) {
      return (await q(
        `SELECT shop, order_name, error, updated_at FROM shipments WHERE status = 'failed' ORDER BY updated_at DESC LIMIT $1`, [limit]
      )).rows;
    },

    async countSentThisMonth(shop) {
      const row = await one(
        `SELECT COUNT(*)::int AS n FROM shipments
         WHERE shop = $1 AND counted = TRUE AND created_at >= date_trunc('month', NOW())`,
        [shop]
      );
      return row ? Number(row.n) : 0;
    },

    // Steadfast invoice = order name without '#'; used when an event has no consignment id.
    findShipmentByInvoice: (shop, invoice) =>
      one(`SELECT * FROM shipments WHERE shop = $1 AND courier = 'steadfast' AND order_name IN ($2, $3) ORDER BY updated_at DESC LIMIT 1`,
        [shop, String(invoice), `#${String(invoice).replace(/^#/, '')}`]),
    findShipmentByConsignment: (shop, consignmentId) =>
      one('SELECT * FROM shipments WHERE shop = $1 AND consignment_id = $2', [shop, String(consignmentId)]),

    // ---------- sms log (one confirmation SMS per order) ----------
    async claimSms(shop, orderId, orderName) {
      const token = crypto.randomUUID();
      const row = await one(
        `INSERT INTO sms_log (shop, shopify_order_id, order_name, status, claim_token) VALUES ($1,$2,$4,'sending',$3)
         ON CONFLICT (shop, shopify_order_id) DO NOTHING RETURNING *`,
        [shop, String(orderId), token, orderName || null]
      );
      if (row && row.claim_token === token) return row;
      return one(
        `UPDATE sms_log SET status = 'sending', error = NULL, claim_token = $3, updated_at = NOW()
         WHERE shop = $1 AND shopify_order_id = $2 AND status = 'failed' RETURNING *`,
        [shop, String(orderId), token]
      );
    },
    async finishSms(shop, orderId, status, error, phone) {
      await q(`UPDATE sms_log SET status = $3, error = $4, phone = COALESCE($5, phone), updated_at = NOW() WHERE shop = $1 AND shopify_order_id = $2`,
        [shop, String(orderId), status, error || null, phone || null]);
    },
    async recordSmsSkip(shop, orderId, reason, orderName) {
      await q(`INSERT INTO sms_log (shop, shopify_order_id, order_name, status, error) VALUES ($1,$2,$4,'skipped',$3)
               ON CONFLICT (shop, shopify_order_id) DO NOTHING`, [shop, String(orderId), reason, orderName || null]);
    },
    listSms: async (shop, limit = 50) =>
      (await q('SELECT * FROM sms_log WHERE shop = $1 ORDER BY created_at DESC LIMIT $2', [shop, limit])).rows,
    async shipmentsForStats(shop, limit = 20000) {
      return (await q(`SELECT status, pathao_status, amount_to_collect, delivery_fee, created_at FROM shipments WHERE shop = $1 ORDER BY created_at DESC LIMIT $2`, [shop, limit])).rows;
    },

    async monthStats(shop) {
      const ship = (await q(
        `SELECT status, COUNT(*)::int AS n FROM shipments WHERE shop = $1 AND created_at >= date_trunc('month', NOW()) GROUP BY status`, [shop])).rows;
      const sms = (await q(
        `SELECT status, COUNT(*)::int AS n FROM sms_log WHERE shop = $1 AND created_at >= date_trunc('month', NOW()) GROUP BY status`, [shop])).rows;
      const pick = (rows, st) => Number((rows.find((r) => r.status === st) || {}).n || 0);
      return {
        shipped: pick(ship, 'sent'),
        shipFailed: pick(ship, 'failed') + pick(ship, 'skipped'),
        smsSent: pick(sms, 'sent'),
        smsFailed: pick(sms, 'failed'),
      };
    },
    async smsForOrders(shop, orderIds) {
      if (!orderIds.length) return [];
      return (await q('SELECT * FROM sms_log WHERE shop = $1 AND shopify_order_id = ANY($2)', [shop, orderIds.map(String)])).rows;
    },

    async redactOrders(shop, orderIds) {
      if (!orderIds.length) return;
      await q('DELETE FROM shipments WHERE shop = $1 AND shopify_order_id = ANY($2)', [shop, orderIds.map(String)]);
      await q('DELETE FROM sms_log WHERE shop = $1 AND shopify_order_id = ANY($2)', [shop, orderIds.map(String)]);
      await q('DELETE FROM order_notes WHERE shop = $1 AND shopify_order_id = ANY($2)', [shop, orderIds.map(String)]);
    },

    // ---------- order notes ----------
    async notesForOrders(shop, orderIds) {
      if (!orderIds.length) return [];
      return (await q('SELECT shopify_order_id, note, updated_at FROM order_notes WHERE shop = $1 AND shopify_order_id = ANY($2)', [shop, orderIds.map(String)])).rows;
    },
    async setNote(shop, orderId, note) {
      if (!note) {
        await q('DELETE FROM order_notes WHERE shop = $1 AND shopify_order_id = $2', [shop, String(orderId)]);
        return null;
      }
      return one(
        `INSERT INTO order_notes (shop, shopify_order_id, note) VALUES ($1, $2, $3)
         ON CONFLICT (shop, shopify_order_id) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW() RETURNING *`,
        [shop, String(orderId), note]
      );
    },
  };
}

module.exports = { makeDb, SCHEMA };
