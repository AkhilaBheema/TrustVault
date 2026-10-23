import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { CryptoService } from '../backend/src/services/crypto.service.js';
import type { DatabasePool } from '../backend/src/db/index.js';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://trustvault:trustvault_secret@localhost:5432/trustvault';

export interface InitialAdminSeedOptions {
  /** Require provisioning details for an explicit `npm run db:seed` invocation. */
  requireInitialAdmin?: boolean;
}

/**
 * Provision the first workspace administrator only when the database is empty.
 * This deliberately creates no sample users, documents, grants, or audit activity.
 */
export async function runSeed(
  customPool?: DatabasePool,
  options: InitialAdminSeedOptions = {}
): Promise<boolean> {
  const db: DatabasePool = customPool || new pg.Pool({ connectionString: databaseUrl });
  const ownsPool = !customPool;

  try {
    const existingUsers = await db.query('SELECT id FROM users LIMIT 1;');
    if (existingUsers.rows.length > 0) {
      console.log('[SEED] Database already has users; no changes made.');
      return false;
    }

    const organizationName = process.env.ORGANIZATION_NAME?.trim() || 'Workspace';
    const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || '';
    const name = process.env.INITIAL_ADMIN_NAME?.trim() || '';
    const password = process.env.INITIAL_ADMIN_PASSWORD || '';
    const missing = [
      !email && 'INITIAL_ADMIN_EMAIL',
      !name && 'INITIAL_ADMIN_NAME',
      !password && 'INITIAL_ADMIN_PASSWORD',
    ].filter(Boolean);

    if (missing.length) {
      const message = `Set ${missing.join(', ')} to provision the first administrator.`;
      if (options.requireInitialAdmin) throw new Error(message);
      console.warn(`[SEED] ${message} No account was created.`);
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('INITIAL_ADMIN_EMAIL must be a valid email address.');
    }
    if (name.length < 2 || name.length > 120) {
      throw new Error('INITIAL_ADMIN_NAME must contain between 2 and 120 characters.');
    }
    if (password.length < 12) {
      throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 12 characters.');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Serialize simultaneous first-start attempts, then recheck inside the lock.
      await client.query('SELECT pg_advisory_xact_lock(839202);');
      const recheck = await client.query('SELECT id FROM users LIMIT 1;');
      if (recheck.rows.length > 0) {
        await client.query('COMMIT');
        console.log('[SEED] Another process provisioned the workspace; no changes made.');
        return false;
      }

      const organization = await client.query<{ id: string }>(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id;',
        [organizationName]
      );
      const passwordHash = await CryptoService.hashPassword(password);
      await client.query(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'admin');`,
        [organization.rows[0].id, email, passwordHash, name]
      );
      await client.query('COMMIT');
      console.log(`[SEED] Initial administrator ${email} provisioned for ${organizationName}.`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    if (ownsPool) await db.end();
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  runSeed(undefined, { requireInitialAdmin: true }).catch((error) => {
    console.error('[SEED] Could not provision the initial administrator:', error);
    process.exitCode = 1;
  });
}
