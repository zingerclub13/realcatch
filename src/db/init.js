const fs = require('fs');
const path = require('path');
const db = require('./pool');

async function init() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    // Drop legacy boilerplate tables that don't belong to RealCatch
    await db.query(`
      DROP TABLE IF EXISTS bids CASCADE;
      DROP TABLE IF EXISTS auctions CASCADE;
      DROP TABLE IF EXISTS knex_migrations CASCADE;
      DROP TABLE IF EXISTS knex_migrations_lock CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    console.log('Cleaned up legacy tables');

    await db.query(sql);
    console.log('Database schema initialized successfully');
  } catch (err) {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

init();
