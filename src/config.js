// Central configuration. Every value comes from environment variables so the
// same code runs locally, on Railway, or anywhere else.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function load() {
  const encryptionKey = required('ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }

  return {
    port: Number(process.env.PORT) || 3000,

    // Shopify app credentials (Partner Dashboard / Dev Dashboard -> your app -> Settings)
    shopifyApiKey: required('SHOPIFY_API_KEY'),
    shopifyApiSecret: required('SHOPIFY_API_SECRET'),
    shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2026-10',
    // Public HTTPS URL of this server, e.g. https://shipbridge.up.railway.app
    appUrl: required('APP_URL').replace(/\/$/, ''),
    // The app handle from your App Store listing URL (apps.shopify.com/<handle>)
    appHandle: process.env.SHOPIFY_APP_HANDLE || 'pathao-shipbridge',

    databaseUrl: required('DATABASE_URL'),
    encryptionKey,

    // Billing. Keep BILLING_TEST=true until the app is approved; test charges cost nothing.
    billingTest: bool('BILLING_TEST', true),

    pathaoProductionUrl: process.env.PATHAO_BASE_URL || 'https://api-hermes.pathao.com',
    pathaoSandboxUrl: process.env.PATHAO_SANDBOX_URL || 'https://courier-api-sandbox.pathao.com',
    // Value Pathao's merchant panel expects back when you register a webhook.
    pathaoIntegrationSecret: process.env.PATHAO_WEBHOOK_INTEGRATION_SECRET || 'f3992ecc-59da-4cbe-a049-a13da2018d51',
  };
}

module.exports = { load };
