// Server entry point (Railway or any always-on Node host).
const { load } = require('./config');
const { createApp } = require('./app');
const { makePool } = require('./pool');

async function main() {
  const config = load();
  const { app, db } = createApp({ config, pool: makePool(config.databaseUrl) });
  await db.migrate();
  app.listen(config.port, () => {
    console.log(`ShipBridge running on port ${config.port} (${config.appUrl})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
