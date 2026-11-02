// AES-256-GCM encryption for secrets at rest (Shopify tokens, Pathao credentials).
// Shopify's App Store review expects access tokens to be encrypted at rest.

const crypto = require('crypto');

function makeCipher(hexKey) {
  const key = Buffer.from(hexKey, 'hex');

  function encrypt(plain) {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  function decrypt(payload) {
    if (!payload) return null;
    const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
    if (version !== 'v1') throw new Error('Unknown ciphertext version');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { makeCipher, safeEqual };
