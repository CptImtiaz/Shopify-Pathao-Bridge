// Shopify authentication for an embedded app:
//  - verify App Bridge session tokens (JWT, HS256, signed with the app secret)
//  - exchange a session token for an EXPIRING offline access token (required
//    for public apps created after 1 April 2026)
//  - refresh that token in the background for webhook processing
//  - verify webhook HMACs

const crypto = require('crypto');
const { safeEqual } = require('../crypto');

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function isValidShop(shop) {
  return typeof shop === 'string' && SHOP_RE.test(shop);
}

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Returns the decoded payload, or throws.
function verifySessionToken(token, { apiKey, apiSecret, now = Date.now() }) {
  if (!token || typeof token !== 'string') throw new AuthError('Missing session token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed session token');
  const [h, p, sig] = parts;

  const header = JSON.parse(b64urlDecode(h).toString('utf8'));
  if (header.alg !== 'HS256') throw new AuthError('Unexpected token algorithm');

  const expected = crypto.createHmac('sha256', apiSecret).update(`${h}.${p}`).digest();
  const got = b64urlDecode(sig);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    throw new AuthError('Invalid session token signature');
  }

  const payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  const nowSec = Math.floor(now / 1000);
  const leeway = 10;
  if (typeof payload.exp !== 'number' || payload.exp + leeway < nowSec) throw new AuthError('Session token expired');
  if (typeof payload.nbf === 'number' && payload.nbf - leeway > nowSec) throw new AuthError('Session token not yet valid');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(apiKey)) throw new AuthError('Session token audience mismatch');

  const shop = String(payload.dest || '').replace(/^https:\/\//, '');
  if (!isValidShop(shop)) throw new AuthError('Session token has invalid shop');
  if (!String(payload.iss || '').startsWith(`https://${shop}`)) throw new AuthError('Session token issuer mismatch');

  return { ...payload, shop };
}

function verifyWebhookHmac(rawBody, hmacHeader, apiSecret) {
  if (!rawBody || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('base64');
  return safeEqual(digest, hmacHeader);
}

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function makeTokenManager({ config, db, cipher, fetchImpl = fetch }) {
  const refreshing = new Map(); // shop -> Promise, so parallel jobs share one refresh

  function toRecord(data) {
    const now = Date.now();
    return {
      accessTokenEnc: cipher.encrypt(data.access_token),
      accessExpiresAt: data.expires_in ? new Date(now + data.expires_in * 1000) : null,
      refreshTokenEnc: cipher.encrypt(data.refresh_token || null),
      refreshExpiresAt: data.refresh_token_expires_in ? new Date(now + data.refresh_token_expires_in * 1000) : null,
      scope: data.scope || null,
    };
  }

  async function postToken(shop, params) {
    const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.shopifyApiKey,
        client_secret: config.shopifyApiSecret,
        ...params,
      }).toString(),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok || !data.access_token) {
      const err = new AuthError(`Shopify token request failed (${res.status}): ${data.error_description || data.error || text.slice(0, 200)}`, res.status === 400 || res.status === 401 ? 401 : 502);
      err.data = data;
      throw err;
    }
    return data;
  }

  // Called from authenticated UI requests: we have a fresh session token.
  async function exchange(shop, sessionToken) {
    const data = await postToken(shop, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
    await db.saveShopTokens(shop, toRecord(data));
    return data.access_token;
  }

  async function refresh(shop, refreshToken) {
    const data = await postToken(shop, { grant_type: 'refresh_token', refresh_token: refreshToken });
    await db.saveShopTokens(shop, toRecord(data));
    return data.access_token;
  }

  function isFresh(date, marginMs) {
    return date && new Date(date).getTime() - marginMs > Date.now();
  }

  // Returns a valid Admin API token for the shop. If `sessionToken` is given
  // and nothing else works, falls back to token exchange.
  async function getAccessToken(shop, { sessionToken } = {}) {
    const row = await db.getShop(shop);
    if (row && row.access_token_enc && !row.uninstalled_at) {
      // Non-expiring tokens have no expiry; expiring ones get a 2-minute margin.
      if (!row.access_expires_at || isFresh(row.access_expires_at, 120000)) {
        return cipher.decrypt(row.access_token_enc);
      }
      if (row.refresh_token_enc && isFresh(row.refresh_expires_at, 60000)) {
        if (!refreshing.has(shop)) {
          const p = refresh(shop, cipher.decrypt(row.refresh_token_enc)).finally(() => refreshing.delete(shop));
          refreshing.set(shop, p);
        }
        try {
          return await refreshing.get(shop);
        } catch (e) {
          if (!sessionToken) throw e;
        }
      }
    }
    if (sessionToken) return exchange(shop, sessionToken);
    throw new AuthError(`No valid access token for ${shop}; merchant must open the app to re-authenticate`);
  }

  return { getAccessToken, exchange };
}

module.exports = { verifySessionToken, verifyWebhookHmac, makeTokenManager, isValidShop, AuthError };
