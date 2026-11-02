const { Pool } = require('pg');
const { load } = require('./config');
const { createApp } = require('./app');

async function main() {
  const config = load();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: /sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  const { app, db } = createApp({ config, pool });
  await db.migrate();
  app.listen(config.port, () => {
    console.log(`ShipBridge running on port ${config.port} (${config.appUrl})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
