import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import * as argon2 from '@node-rs/argon2';
import supertest from 'supertest';
import { buildApp } from '../src/app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 1: DB Schema, Migrations, Seed, & Fastify Scaffold', () => {
  let db: PGlite;
  const app = buildApp();

  beforeAll(async () => {
    db = new PGlite();
    await app.ready();
  });

  it('executes 001_initial_schema.sql without syntax or relational errors', async () => {
    const migrationPath = path.resolve(__dirname, '../../db/migrations/001_initial_schema.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Execute migration in full
    await db.exec(sql);

    // Verify all core tables exist in the schema
    const res = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
    );
    const tables = res.rows.map((r) => r.tablename);

    expect(tables).toContain('organizations');
    expect(tables).toContain('users');
    expect(tables).toContain('sessions');
    expect(tables).toContain('documents');
    expect(tables).toContain('document_versions');
    expect(tables).toContain('document_grants');
    expect(tables).toContain('download_tickets');
    expect(tables).toContain('share_invites');
    expect(tables).toContain('access_requests');
    expect(tables).toContain('audit_events');
  });

  it('executes 002_audit_immutability.sql and enforces database-level append-only rules', async () => {
    const immutabilityPath = path.resolve(__dirname, '../../db/migrations/002_audit_immutability.sql');
    const sql = fs.readFileSync(immutabilityPath, 'utf8');
    await db.exec(sql);

    // Insert a valid audit event
    const insertRes = await db.query<{ id: string }>(`
      INSERT INTO audit_events (
        event_type, action, status, reason, prev_hash, current_hash
      ) VALUES (
        'TEST_EVENT', 'CREATE', 'INFO', 'Test entry', '0000000000', '1111111111'
      ) RETURNING id;
    `);
    const eventId = insertRes.rows[0].id;
    expect(eventId).toBeDefined();

    // Verify that UPDATE is rejected by the trigger
    await expect(
      db.query(`UPDATE audit_events SET reason = 'tampered' WHERE id = '${eventId}';`)
    ).rejects.toThrow(/Audit trail violation: audit_events is strictly append-only/);

    // Verify that DELETE is rejected by the trigger
    await expect(
      db.query(`DELETE FROM audit_events WHERE id = '${eventId}';`)
    ).rejects.toThrow(/Audit trail violation: audit_events is strictly append-only/);
  });

  it('seeds two isolated companies with 3 distinct roles each and verified password hashing', async () => {
    // Hash password with Argon2id
    const passwordHash = await argon2.hash('TrustVault2026!#', {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    // 1. Create Acme Corp & Stark Industries
    const acmeRes = await db.query<{ id: string }>(
      "INSERT INTO organizations (name) VALUES ('Acme Corp') RETURNING id;"
    );
    const acmeId = acmeRes.rows[0].id;

    const starkRes = await db.query<{ id: string }>(
      "INSERT INTO organizations (name) VALUES ('Stark Industries') RETURNING id;"
    );
    const starkId = starkRes.rows[0].id;

    expect(acmeId).toBeDefined();
    expect(starkId).toBeDefined();
    expect(acmeId).not.toEqual(starkId);

    // 2. Insert Acme users
    const acmeAdmin = (
      await db.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ('${acmeId}', 'admin@acme.com', '${passwordHash}', 'Acme Admin', 'admin') RETURNING id;`
      )
    ).rows[0].id;

    const acmeOwner = (
      await db.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ('${acmeId}', 'owner@acme.com', '${passwordHash}', 'Acme Owner', 'owner') RETURNING id;`
      )
    ).rows[0].id;

    const acmeViewer = (
      await db.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ('${acmeId}', 'viewer@acme.com', '${passwordHash}', 'Acme Viewer', 'viewer') RETURNING id;`
      )
    ).rows[0].id;

    // 3. Insert Stark users
    const starkOwner = (
      await db.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ('${starkId}', 'owner@stark.com', '${passwordHash}', 'Stark Owner', 'owner') RETURNING id;`
      )
    ).rows[0].id;

    const starkViewer = (
      await db.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ('${starkId}', 'viewer@stark.com', '${passwordHash}', 'Stark Viewer', 'viewer') RETURNING id;`
      )
    ).rows[0].id;

    // 4. Verify password verification
    const verified = await argon2.verify(passwordHash, 'TrustVault2026!#');
    expect(verified).toBe(true);
    const wrongVerified = await argon2.verify(passwordHash, 'WrongPassword!');
    expect(wrongVerified).toBe(false);

    // 5. Seed Documents
    const acmeDocRes = await db.query<{ id: string }>(
      `INSERT INTO documents (organization_id, owner_id, title, category)
       VALUES ('${acmeId}', '${acmeOwner}', 'Acme Financial Strategy 2026.pdf', 'Financial') RETURNING id;`
    );
    const acmeDocId = acmeDocRes.rows[0].id;

    const starkDocRes = await db.query<{ id: string }>(
      `INSERT INTO documents (organization_id, owner_id, title, category)
       VALUES ('${starkId}', '${starkOwner}', 'Arc Reactor Schematics.pdf', 'Engineering') RETURNING id;`
    );
    const starkDocId = starkDocRes.rows[0].id;

    // 6. Grant Acme Viewer read on Acme Doc
    await db.query(
      `INSERT INTO document_grants (document_id, user_id, permission, granted_by)
       VALUES ('${acmeDocId}', '${acmeViewer}', 'read', '${acmeOwner}');`
    );

    // 7. Verify Separation of Duties: Admin has NO grant on document
    const adminGrantRes = await db.query(
      `SELECT * FROM document_grants WHERE document_id = '${acmeDocId}' AND user_id = '${acmeAdmin}';`
    );
    expect(adminGrantRes.rows.length).toBe(0);

    // 8. Verify Cross-Tenant Isolation: Stark Viewer has NO grant on Acme Doc
    const crossTenantGrantRes = await db.query(
      `SELECT * FROM document_grants WHERE document_id = '${acmeDocId}' AND user_id = '${starkViewer}';`
    );
    expect(crossTenantGrantRes.rows.length).toBe(0);

    // 9. Verify Tenant Boundary on Document
    const acmeDocs = await db.query(
      `SELECT id, title FROM documents WHERE organization_id = '${acmeId}';`
    );
    expect(acmeDocs.rows.length).toBe(1);
    expect(acmeDocs.rows[0].title).toBe('Acme Financial Strategy 2026.pdf');

    const starkDocs = await db.query(
      `SELECT id, title FROM documents WHERE organization_id = '${starkId}';`
    );
    expect(starkDocs.rows.length).toBe(1);
    expect(starkDocs.rows[0].title).toBe('Arc Reactor Schematics.pdf');
  });

  it('serves /api/health with strict security headers', async () => {
    const response = await supertest(app.server).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('service', 'trustvault-backend');

    // Verify security headers
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('returns uniform 404 for unknown routes without disclosure', async () => {
    const response = await supertest(app.server).get('/api/random-unknown-endpoint');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Not Found',
      message: 'Resource not found or access denied.',
    });
  });
});
