// Server entry point (Railway or any always-on Node host).
const { load } = require('./config');
const { createApp } = require('./app');
const { makePool } = require('./pool');

async function main() {
  const config = load();
  const { app, db, tracker } = createApp({ config, pool: makePool(config.databaseUrl) });
  await db.migrate();
  tracker.start(); // checks parcels still on the way every 3 minutes
  app.listen(config.port, () => {
    console.log(`ShipBridge running on port ${config.port} (${config.appUrl})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
