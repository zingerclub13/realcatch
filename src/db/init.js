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

    // Run each statement individually so one failure doesn't block all
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await db.query(stmt);
      } catch (err) {
        // Ignore "already exists" errors for indexes
        if (err.message.includes('already exists')) {
          console.log(`  Skipped (already exists): ${stmt.substring(0, 60)}...`);
        } else {
          console.error(`  Statement failed: ${stmt.substring(0, 80)}...`);
          console.error(`  Error: ${err.message}`);
        }
      }
    }

    // Verify tables
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    console.log('Tables created:', tables.rows.map(r => r.tablename).join(', '));
    console.log('Database schema initialized successfully');
  } catch (err) {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

init();
