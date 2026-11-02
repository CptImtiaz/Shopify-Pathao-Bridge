const { Pool } = require('pg');

// Works with Railway Postgres, Neon, Supabase, etc. Neon/Supabase URLs
// contain sslmode=require, which turns SSL on.
function makePool(databaseUrl, max = 10) {
  return new Pool({
    connectionString: databaseUrl,
    ssl: /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    max,
  });
}

module.exports = { makePool };
