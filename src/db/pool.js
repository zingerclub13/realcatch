const { Pool } = require('pg');
require('dotenv').config();

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('Unexpected PG pool error:', err.message);
  });
}

module.exports = {
  query: (text, params) => {
    if (!pool) throw new Error('DATABASE_URL not configured');
    return pool.query(text, params);
  },
  getClient: () => {
    if (!pool) throw new Error('DATABASE_URL not configured');
    return pool.connect();
  },
  pool,
};
