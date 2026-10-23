import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from './app.js';
import { pool, setDatabasePool, DatabasePool, DatabaseClient } from './db/index.js';
import { runSeed } from '../../db/seed.js';

dotenv.config();

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
  } catch {
    console.log('[DATABASE] External PostgreSQL not reachable. Booting embedded PostgreSQL (PGlite)...');
    const db = new PGlite();
    const pglitePool = createPGlitePool(db);
    setDatabasePool(pglitePool);

    // Apply migrations
    const migrationsDir = path.resolve(__dirname, '../../db/migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await db.exec(sql);
      }
    }

    // Seed default accounts and documents
    await runSeed(pglitePool);
    console.log('[DATABASE] Embedded database initialized & seeded successfully.');
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
