import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const databaseUrl = process.env.DATABASE_URL || 'postgresql://trustvault:trustvault_secret@localhost:5432/trustvault';

export async function runMigrations(customPool?: pg.Pool) {
  const pool = customPool || new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log('[MIGRATE] Connecting to PostgreSQL database...');

    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Read all migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    // 3. Get applied migrations
    const { rows: appliedRows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations'
    );
    const appliedSet = new Set(appliedRows.map((r) => r.name));

    // 4. Apply pending migrations sequentially in transactions
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[MIGRATE] [SKIP] ${file} (already executed)`);
        continue;
      }

      console.log(`[MIGRATE] [APPLYING] ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[MIGRATE] [SUCCESS] ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[MIGRATE] [FAILED] ${file}:`, err);
        throw err;
      }
    }

    console.log('[MIGRATE] All pending migrations executed successfully.');
  } finally {
    client.release();
    if (!customPool) {
      await pool.end();
    }
  }
}

// Direct invocation check
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations().catch((err) => {
    console.error('[MIGRATE] Migration process failed:', err);
    process.exit(1);
  });
}
