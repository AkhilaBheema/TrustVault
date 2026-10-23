/**
 * Mutation Testing Script for TrustVault
 * 
 * Verifies that bypassing document detail authorization causes the IDOR
 * test suite to fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const routesPath = path.resolve(__dirname, '../src/routes/document.routes.ts');

console.log('🔒 Starting TrustVault Authorization Mutation Checker...');

const originalCode = fs.readFileSync(routesPath, 'utf8');
const authorizationCall = /const auth = await AuthorizationService\.authorize\(user, id, 'read', \{\r?\n      ipAddress: request\.ip,\r?\n      userAgent: request\.headers\['user-agent'\] \|\| null,\r?\n    \}\);/g;
const authorizationMatches = [...originalCode.matchAll(authorizationCall)];

if (authorizationMatches.length !== 1) {
  throw new Error(`Expected one document detail authorization call; found ${authorizationMatches.length}.`);
}

const mutatedCode = originalCode.replace(
  authorizationCall,
  "const auth = { effectivePermission: 'owner' as const }; // mutation: bypass authorization"
);

let sourceMayBeMutated = false;
try {
  console.log('1. Verifying baseline test suite passes...');
  execSync('npm test -- tests/p10_matrix_idor_mutation.test.ts', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
  console.log('✅ Baseline test suite PASSED.\n');

  console.log('2. Injecting mutant: bypassing authorization check in document.routes.ts...');
  sourceMayBeMutated = true;
  fs.writeFileSync(routesPath, mutatedCode, 'utf8');
  if (fs.readFileSync(routesPath, 'utf8') !== mutatedCode) {
    throw new Error('Failed to install the authorization bypass mutant.');
  }

  console.log('3. Running test suite against mutant (expecting failure)...');
  let testFailed = false;
  try {
    execSync('npm test -- tests/p10_matrix_idor_mutation.test.ts', { stdio: 'pipe', cwd: path.resolve(__dirname, '..') });
  } catch (error) {
    testFailed = true;
  }

  if (testFailed) {
    console.log('✅ Mutant was KILLED! Test suite caught unauthorized access.');
  } else {
    throw new Error('Mutant survived; tests did not detect unauthorized access.');
  }
} finally {
  if (sourceMayBeMutated) {
    fs.writeFileSync(routesPath, originalCode, 'utf8');
    console.log('\n🔄 Restored original document.routes.ts.');
  }
}
