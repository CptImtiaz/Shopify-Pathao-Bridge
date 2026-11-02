// Vercel entry point. vercel.json sends every request here (except static
// files in /public). The Express app is built once per warm instance.

const { load } = require('../src/config');
const { createApp } = require('../src/app');
const { makePool } = require('../src/pool');

let defer = (p) => p;
try {
  // Keeps webhook processing alive after we reply 200 to Shopify.
  ({ waitUntil: defer } = require('@vercel/functions'));
} catch { /* not on Vercel */ }

function makeHandler(build) {
  let ready = null;
  return async function handler(req, res) {
    try {
      ready = ready || build();
      const app = await ready;
      return app(req, res);
    } catch (e) {
      ready = null; // retry setup on the next request
      console.error('Startup failed:', e);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`App is not configured yet: ${e.message}`);
    }
  };
}

async function buildFromEnv() {
  const config = load();
  const { app, db } = createApp({ config, pool: makePool(config.databaseUrl, 3), defer });
  await db.migrate(); // CREATE TABLE IF NOT EXISTS: safe to run on every cold start
  return app;
}

module.exports = makeHandler(buildFromEnv);
module.exports.makeHandler = makeHandler;
