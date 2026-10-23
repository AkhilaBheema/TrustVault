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
