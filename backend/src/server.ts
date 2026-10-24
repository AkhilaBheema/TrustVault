import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadEnvironment, validateProductionEnvironment } from './config/env.js';
import { buildApp } from './app.js';
import { pool, setDatabasePool, DatabasePool, DatabaseClient } from './db/index.js';
import { runSeed } from '../../db/seed.js';

loadEnvironment();
validateProductionEnvironment();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = parseInt(process.env.PORT || '4000', 10);
const host = process.env.HOST || '0.0.0.0';

function createPGlitePool(db: PGlite): DatabasePool {
  return {
    async query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, params?: unknown[]) {
      const res = await db.query<T>(text, (params || []) as any[]);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length,
        command: res.command,
        fields: (res.fields || []) as any,
        oid: 0,
      } as import('pg').QueryResult<T>;
    },
    async connect(): Promise<DatabaseClient> {
      return {
        async query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, params?: unknown[]) {
          const res = await db.query<T>(text, (params || []) as any[]);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
            command: res.command,
            fields: (res.fields || []) as any,
            oid: 0,
          } as import('pg').QueryResult<T>;
        },
        release() {},
      };
    },
    async end() {
      await db.close();
    },
  };
}

async function ensureDatabase() {
  try {
    // Attempt standard connection with 1s timeout
    const testPromise = pool.query('SELECT 1');
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), 1200)
    );
    await Promise.race([testPromise, timeoutPromise]);
    console.log('[DATABASE] Connected to external PostgreSQL database.');
    await runSeed(pool);
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Unable to connect to the configured PostgreSQL database', { cause: error });
    }
    const reason = error instanceof Error ? error.message : 'unknown connection error';
    console.warn(`[DATABASE] PostgreSQL unavailable at ${process.env.DATABASE_URL || 'the configured database'}: ${reason}`);
    console.warn('[DATABASE] Development fallback: booting embedded PostgreSQL (PGlite). Start PostgreSQL or Docker to use the configured database.');
    console.log('[DATABASE] Booting embedded PostgreSQL (PGlite)...');
    const db = new PGlite();
    const pglitePool = createPGlitePool(db);
    setDatabasePool(pglitePool);

    // Apply migrations
    const migrationsDir = [
      path.resolve(__dirname, '../../db/migrations'),
      path.resolve(__dirname, '../../../db/migrations'),
      path.resolve(__dirname, '../../../../db/migrations'),
      path.resolve(process.cwd(), 'db/migrations'),
    ].find((candidate) => fs.existsSync(candidate));
    if (!migrationsDir) {
      throw new Error('Could not locate the TrustVault db/migrations directory.');
    }
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await db.exec(sql);
    }

    // Provision the first configured administrator; never create sample content.
    await runSeed(pglitePool);
    console.log('[DATABASE] Embedded database initialized.');
  }
}

async function start() {
  try {
    await ensureDatabase();
    const app = buildApp({ enableLogging: false });
    await app.listen({ port, host });
    console.log(`[TRUSTVAULT] Backend listening on http://localhost:${port}`);
  } catch (err) {
    console.error('[TRUSTVAULT] Startup failed:', err);
    process.exit(1);
  }
}

start();
