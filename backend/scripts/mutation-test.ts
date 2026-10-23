/**
 * Mutation Testing Script for TrustVault
 * 
 * Verifies that removing or bypassing `AuthorizationService.authorize` from
 * any protected route causes the test suite to fail.
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

// Target mutation: Replace AuthorizationService.authorize check with a bypass (granting 'owner' access)
const targetCall = 'await AuthorizationService.authorize(';
const mutantCall = 'await Promise.resolve({ allowed: true, document: { id: req.params.id, org_id: actor.org_id, is_deleted: false } as any }) && false && (';

if (!originalCode.includes(targetCall)) {
  console.error('❌ Could not locate target authorize() call in document.routes.ts');
  process.exit(1);
}

try {
  console.log('1. Verifying baseline test suite passes...');
  execSync('npm test -- tests/p10_matrix_idor_mutation.test.ts', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
  console.log('✅ Baseline test suite PASSED.\n');

  console.log('2. Injecting mutant: bypassing authorization check in document.routes.ts...');
  // Modify first occurrence of authorize check to bypass
  const mutatedCode = originalCode.replace(
    'const authResult = await AuthorizationService.authorize(actor, id, \'read\');',
    'const authResult = { allowed: true, document: { id, title: "Mutated Doc", org_id: actor.org_id } as any };'
  );

  fs.writeFileSync(routesPath, mutatedCode, 'utf8');

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
    console.error('❌ Mutant SURVIVED! Tests failed to detect missing authorize() check.');
    process.exit(1);
  }
} finally {
  // Always restore original file
  fs.writeFileSync(routesPath, originalCode, 'utf8');
  console.log('\n🔄 Restored original document.routes.ts.');
}
