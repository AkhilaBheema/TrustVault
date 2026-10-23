import pg from 'pg';
import { loadEnvironment } from '../config/env.js';

loadEnvironment();

const databaseUrl =
  process.env.DATABASE_URL || 'postgresql://trustvault:trustvault_secret@localhost:5432/trustvault';

export interface DatabaseClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>>;
  release(): void;
}

export interface DatabasePool {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>>;
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
}

let activePool: DatabasePool | null = null;

function createStandardPool(): DatabasePool {
  const pgPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pgPool.on('error', (err) => {
    console.error('[DATABASE] Unexpected client error on idle pool connection:', err);
  });

  return pgPool;
}

export function setDatabasePool(customPool: DatabasePool | null) {
  activePool = customPool;
}

export const pool: DatabasePool = {
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> {
    if (!activePool) {
      activePool = createStandardPool();
    }
    return activePool.query<T>(text, params);
  },

  async connect(): Promise<DatabaseClient> {
    if (!activePool) {
      activePool = createStandardPool();
    }
    return activePool.connect();
  },

  async end(): Promise<void> {
    if (activePool) {
      await activePool.end();
      activePool = null;
    }
  },
};

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
