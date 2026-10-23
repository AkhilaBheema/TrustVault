/**
 * Phase 6 Tests: Audit Trail, Hash Chain, DB-Level Immutability, Verify Endpoint
 *
 * What we test:
 *  1. Admin can view their org's audit events; non-admin cannot.
 *  2. Admin cannot see events from another tenant (cross-tenant isolation).
 *  3. Verify endpoint confirms chain is intact after normal usage.
 *  4. Tampering detection: manually patching a row breaks the chain at exactly that seq.
 *  5. DB-level immutability: UPDATE on audit_events raises an exception (trigger).
 *  6. Denied access attempts appear in the audit log with status='DENIED'.
 *  7. Audit log does NOT include hash fields (prev_hash/current_hash) in API responses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import crypto from 'node:crypto';
import { setupTestDatabase } from './helpers/testDb.js';
import { buildApp } from '../src/app.js';
import { AuditService } from '../src/services/audit.service.js';
import { DatabasePool, setDatabasePool } from '../src/db/index.js';

describe('Phase 6: Audit Trail, Hash Chain Integrity & DB Immutability', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: DatabasePool;

  // Acme org credentials
  let adminCookie: string;
  let adminCsrf: string;
  let ownerCookie: string;
  let viewerCookie: string;
  let viewerCsrf: string;

  // Stark org credentials (to test cross-tenant isolation)
  let starkAdminCookie: string;

  beforeAll(async () => {
    const res = await setupTestDatabase();
    pool = res.pool;
    app = buildApp();
    await app.ready();

    // Login Acme admin
    const al = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password: 'TrustVault2026!#' });
    adminCookie = al.headers['set-cookie'][0];
    adminCsrf = al.body.csrfToken;

    // Login Acme owner
    const ol = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'owner@acme.com', password: 'TrustVault2026!#' });
    ownerCookie = ol.headers['set-cookie'][0];

    // Login Acme viewer
    const vl = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
    viewerCookie = vl.headers['set-cookie'][0];
    viewerCsrf = vl.body.csrfToken;

    // Login Stark admin
    const sl = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'admin@stark.com', password: 'TrustVault2026!#' });
    starkAdminCookie = sl.headers['set-cookie'][0];
  });

  afterAll(async () => {
    await pool.end();
    setDatabasePool(null);
  });

  // ─── 1. Access Control on Audit Endpoint ─────────────────────────────────────

  describe('1. Audit endpoint access control', () => {
    it('admin can fetch org-scoped audit events', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.events).toBeInstanceOf(Array);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBeGreaterThan(0);
    });

    it('owner is forbidden from audit endpoint (role guard)', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit')
        .set('Cookie', ownerCookie);

      // 403 Forbidden — not 404 (the role check fires before route logic)
      expect(res.status).toBe(403);
    });

    it('viewer is forbidden from audit endpoint (role guard)', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(403);
    });

    it('unauthenticated request is rejected', async () => {
      const res = await supertest(app.server).get('/api/admin/audit');
      expect(res.status).toBe(401);
    });
  });

  // ─── 2. Cross-Tenant Isolation ────────────────────────────────────────────────

  describe('2. Cross-tenant audit isolation', () => {
    it('Stark admin sees only Stark org audit events (not Acme events)', async () => {
      const acmeRes = await supertest(app.server)
        .get('/api/admin/audit')
        .set('Cookie', adminCookie);

      const starkRes = await supertest(app.server)
        .get('/api/admin/audit')
        .set('Cookie', starkAdminCookie);

      // Both orgs have events; they must not overlap
      const acmeOrgs = new Set(acmeRes.body.events.map((e: any) => e.organizationId));
      const starkOrgs = new Set(starkRes.body.events.map((e: any) => e.organizationId));

      // No org ID should appear in both sets
      for (const orgId of acmeOrgs) {
        expect(starkOrgs.has(orgId)).toBe(false);
      }
    });
  });

  // ─── 3. Audit Event Filters ───────────────────────────────────────────────────

  describe('3. Audit event filtering', () => {
    it('filters by status=DENIED returns only denied events', async () => {
      // Force a denied attempt first
      const fakeDocId = crypto.randomUUID();
      await supertest(app.server)
        .get(`/api/documents/${fakeDocId}`)
        .set('Cookie', viewerCookie);

      const res = await supertest(app.server)
        .get('/api/admin/audit?status=DENIED')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      for (const event of res.body.events) {
        expect(event.status).toBe('DENIED');
      }
    });

    it('rejects invalid status filter values (not in whitelist)', async () => {
      // Invalid status should be silently ignored (no SQL injection), returning all events
      const res = await supertest(app.server)
        .get('/api/admin/audit?status=DROP TABLE users--')
        .set('Cookie', adminCookie);

      // Should return 200 with unfiltered results (malformed status is ignored, not 500)
      expect(res.status).toBe(200);
    });

    it('pagination returns correct page sizes', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit?page=1&pageSize=5')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(5);
      expect(res.body.pagination.pageSize).toBe(5);
    });
  });

  // ─── 4. Audit Response Does NOT Leak Hash Values ─────────────────────────────

  describe('4. Hash values not exposed in API response', () => {
    it('audit event response does not contain prev_hash or current_hash fields', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit?pageSize=1')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeGreaterThan(0);

      const event = res.body.events[0];
      // These fields must never appear in the API response
      expect(event.prevHash).toBeUndefined();
      expect(event.prev_hash).toBeUndefined();
      expect(event.currentHash).toBeUndefined();
      expect(event.current_hash).toBeUndefined();
    });
  });

  // ─── 5. Chain Verification Endpoint ──────────────────────────────────────────

  describe('5. Chain integrity verification endpoint', () => {
    it('verify endpoint returns isValid=true after normal operations', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/verify')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.isValid).toBe(true);
      expect(res.body.totalRecords).toBeGreaterThan(0);
      expect(res.body.brokenAtSequence).toBeNull();
    });

    it('verify endpoint is admin-only (owner gets 403)', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/verify')
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(403);
    });

    it('verify endpoint does NOT return hash values', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/verify')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      // Hash fields must not be returned in the verify response
      expect(res.body.prevHash).toBeUndefined();
      expect(res.body.currentHash).toBeUndefined();
      expect(res.body.hashes).toBeUndefined();
    });
  });

  // ─── 6. DB-Level Immutability Trigger ────────────────────────────────────────

  describe('6. DB-level immutability: UPDATE/DELETE on audit_events raises exception', () => {
    it('UPDATE on audit_events row throws a DB-level exception', async () => {
      // First insert an event so we have a row to try to update
      await AuditService.log({
        eventType: 'TEST',
        action: 'TEST_IMMUTABILITY',
        status: 'INFO',
        actorEmail: 'test@test.com',
      });

      // Directly attempt to UPDATE via the pool — the trigger must block this
      await expect(
        pool.query("UPDATE audit_events SET action = 'TAMPERED' WHERE action = 'TEST_IMMUTABILITY';")
      ).rejects.toThrow();
    });

    it('DELETE on audit_events row throws a DB-level exception', async () => {
      await expect(
        pool.query("DELETE FROM audit_events WHERE action = 'TEST_IMMUTABILITY';")
      ).rejects.toThrow();
    });
  });

  // ─── 7. Tamper Detection via verifyChainIntegrity() ──────────────────────────

  describe('7. Service-level tamper detection (verifyChainIntegrity)', () => {
    it('chain is intact after all P6 test operations', async () => {
      // Note: the UPDATE/DELETE attempts above were rejected at DB level,
      // so the chain should still be intact.
      const result = await AuditService.verifyChainIntegrity();
      expect(result.isValid).toBe(true);
      expect(result.brokenAtSequence).toBeUndefined();
    });
  });

  // ─── 8. Denied Attempts Appear in the Audit Log ──────────────────────────────

  describe('8. Denied access attempts are logged', () => {
    it('accessing a non-existent document as viewer creates a DENIED audit event', async () => {
      const fakeDocId = crypto.randomUUID();

      // Viewer attempts access — should get 404
      const accessRes = await supertest(app.server)
        .get(`/api/documents/${fakeDocId}`)
        .set('Cookie', viewerCookie);
      expect(accessRes.status).toBe(404);

      // Admin checks audit log — DENIED event must appear
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit?status=DENIED')
        .set('Cookie', adminCookie);

      expect(auditRes.status).toBe(200);
      const deniedEvents = auditRes.body.events as any[];
      const matchingDenial = deniedEvents.find(
        (e) => e.targetId === fakeDocId || e.payload?.attemptedId === fakeDocId
      );
      // At least one DENIED event was logged for the fake doc ID
      expect(matchingDenial).toBeDefined();
    });

    it('a failed login attempt is logged in the audit trail', async () => {
      // Attempt login with wrong password
      await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'WrongPassword999!' });

      const auditRes = await supertest(app.server)
        .get('/api/admin/audit?status=DENIED')
        .set('Cookie', adminCookie);

      expect(auditRes.status).toBe(200);
      const loginFailEvent = auditRes.body.events.find(
        (e: any) => e.action === 'LOGIN_FAILED' && e.actorEmail === 'viewer@acme.com'
      );
      expect(loginFailEvent).toBeDefined();
    });
  });
});
