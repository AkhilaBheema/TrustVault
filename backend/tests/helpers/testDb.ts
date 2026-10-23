import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseClient, DatabasePool, setDatabasePool } from '../../src/db/index.js';
import { runSeed } from '../../../db/seed.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createPGlitePool(db: PGlite): DatabasePool {
  return {
    async query(text: string, params?: unknown[]) {
      const res = await db.query(text, (params || []) as any[]);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length,
        command: res.command,
        fields: (res.fields || []) as any,
        oid: 0,
      };
    },
    async connect(): Promise<DatabaseClient> {
      return {
        async query(text: string, params?: unknown[]) {
          const res = await db.query(text, (params || []) as any[]);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
            command: res.command,
            fields: (res.fields || []) as any,
            oid: 0,
          };
        },
        release() {},
      };
    },
    async end() {
      await db.close();
    },
  };
}

export async function setupTestDatabase(): Promise<{ db: PGlite; pool: DatabasePool }> {
  const db = new PGlite();
  const poolAdapter = createPGlitePool(db);

  // 1. Run migrations
  const migrationsDir = path.resolve(__dirname, '../../../db/migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
  }

  // 2. Set as active pool
  setDatabasePool(poolAdapter);

  // 3. Seed data
  await runSeed(poolAdapter as any);

  return { db, pool: poolAdapter };
}
