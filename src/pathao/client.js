// Pathao Merchant API client, one per merchant (credentials live in that
// merchant's settings row, encrypted). Tokens are cached in the DB so they
// survive restarts and are shared across instances.

class PathaoError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function describePathaoError(status, data) {
  if (data && data.errors && typeof data.errors === 'object') {
    const parts = Object.entries(data.errors).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`);
    if (parts.length) return parts.join('; ');
  }
  return (data && (data.message || data.error)) || `Pathao HTTP ${status}`;
}

function makePathao({ config, db, cipher, fetchImpl = fetch }) {
  function baseUrl(settings) {
    return settings.pathao_env === 'sandbox' ? config.pathaoSandboxUrl : config.pathaoProductionUrl;
  }

  async function call(settings, path, { method = 'GET', body, token } = {}) {
    const res = await fetchImpl(`${baseUrl(settings)}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
    if (!res.ok) throw new PathaoError(describePathaoError(res.status, data), res.status, data);
    return data;
  }

  function hasCredentials(s) {
    return Boolean(s.pathao_client_id && s.pathao_client_secret_enc && s.pathao_username && s.pathao_password_enc);
  }

  async function issueToken(settings) {
    const base = {
      client_id: settings.pathao_client_id,
      client_secret: cipher.decrypt(settings.pathao_client_secret_enc),
    };
    let data;
    const refreshToken = cipher.decrypt(settings.pathao_refresh_enc);
    if (refreshToken) {
      try {
        data = await call(settings, '/aladdin/api/v1/issue-token', {
          method: 'POST', body: { ...base, grant_type: 'refresh_token', refresh_token: refreshToken },
        });
      } catch { data = null; }
    }
    if (!data) {
      data = await call(settings, '/aladdin/api/v1/issue-token', {
        method: 'POST',
        body: { ...base, grant_type: 'password', username: settings.pathao_username, password: cipher.decrypt(settings.pathao_password_enc) },
      });
    }
    if (!data.access_token) throw new PathaoError('Pathao did not return an access token', 502, data);
    await db.updateSettings(settings.shop, {
      pathao_token_enc: cipher.encrypt(data.access_token),
      pathao_token_expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000),
      pathao_refresh_enc: cipher.encrypt(data.refresh_token || null),
    });
    return data.access_token;
  }

  async function token(settings, { force = false } = {}) {
    if (!hasCredentials(settings)) throw new PathaoError('Pathao account is not connected yet. Add your Pathao API credentials in Settings.', 400);
    const fresh = settings.pathao_token_expires_at && new Date(settings.pathao_token_expires_at).getTime() - 300000 > Date.now();
    if (!force && fresh && settings.pathao_token_enc) return cipher.decrypt(settings.pathao_token_enc);
    return issueToken(settings);
  }

  // Authenticated call with one automatic retry on 401 (token revoked early).
  async function authed(settings, path, opts = {}) {
    try {
      return await call(settings, path, { ...opts, token: await token(settings) });
    } catch (e) {
      if (e.status !== 401) throw e;
      const fresh = await db.getSettings(settings.shop);
      return call(fresh, path, { ...opts, token: await token(fresh, { force: true }) });
    }
  }

  async function listStores(settings) {
    const data = await authed(settings, '/aladdin/api/v1/stores');
    const list = data.data?.data || data.data?.stores || data.data || [];
    return (Array.isArray(list) ? list : [])
      .map((s) => ({
        id: s.store_id ?? s.id, name: s.store_name ?? s.name, address: s.store_address ?? s.address, active: s.is_active !== 0,
      }))
      .filter((s) => Number.isInteger(Number(s.id)));
  }

  async function createOrder(settings, payload) {
    const data = await authed(settings, '/aladdin/api/v1/orders', { method: 'POST', body: payload });
    const d = data.data || {};
    return {
      consignmentId: d.consignment_id,
      status: d.order_status || 'Pending',
      deliveryFee: d.delivery_fee != null ? Number(d.delivery_fee) : null,
      raw: data,
    };
  }

  async function orderInfo(settings, consignmentId) {
    const data = await authed(settings, `/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`);
    return data.data || {};
  }

  return { hasCredentials, token, listStores, createOrder, orderInfo };
}

module.exports = { makePathao, PathaoError };
