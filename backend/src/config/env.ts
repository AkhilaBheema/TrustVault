import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** Load backend configuration from the current project or repository root. */
export function loadEnvironment() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ];
  const envFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (envFile) dotenv.config({ path: envFile });
}

export function validateProductionEnvironment() {
  if (process.env.NODE_ENV === 'test') return;

  const required = ['DATABASE_URL', 'MASTER_KEY', 'SESSION_SECRET', 'CORS_ORIGIN'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(process.env.MASTER_KEY!)) {
    throw new Error('MASTER_KEY must be exactly 64 hexadecimal characters');
  }
  if (process.env.SESSION_SECRET!.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
}
