// Server entry point (Railway or any always-on Node host).
const { load } = require('./config');
const { createApp } = require('./app');
const { makePool } = require('./pool');

async function main() {
  const config = load();
  if (!config.pathaoIntegrationSecret) {
    console.warn('Warning: PATHAO_WEBHOOK_INTEGRATION_SECRET is not set. Saving the webhook in the Pathao panel may fail until it is.');
  }
  if (!config.adminPassword) console.warn('Note: ADMIN_PASSWORD is not set, so the owner page /admin is switched off.');
  const pool = makePool(config.databaseUrl);
  const { app, db, tracker } = createApp({ config, pool });
  await db.migrate();
  const poller = tracker.start(); // checks parcels still on the way every minute
  const server = app.listen(config.port, () => {
    console.log(`AutoCourier BD running on port ${config.port} (${config.appUrl})`);
  });

  // Railway stops the old copy with SIGTERM on every deploy: finish open requests, then exit cleanly.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    clearInterval(poller);
    server.close(() => pool.end().finally(() => process.exit(0)));
    // Live-update streams never end on their own; don't wait for them.
    if (server.closeAllConnections) setTimeout(() => server.closeAllConnections(), 5000).unref();
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e) => {
  // Start-up failed (e.g. the database is unreachable): print why, without any secret in it.
  const { makeRedactor } = require('./redact');
  const env = process.env;
  const redact = makeRedactor([env.SHOPIFY_API_SECRET, env.ENCRYPTION_KEY, env.ADMIN_PASSWORD, env.DATABASE_URL, env.PATHAO_WEBHOOK_INTEGRATION_SECRET]);
  console.error(redact(e && (e.stack || e.message || e)));
  process.exit(1);
});
