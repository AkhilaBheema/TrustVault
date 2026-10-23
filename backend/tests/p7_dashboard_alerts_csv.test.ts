/**
 * Phase 7 Tests: Admin Dashboard Alerts, Activity Timelines, CSV Export
 *
 * What we test:
 *  1. Dashboard is admin-only; owner/viewer get 403.
 *  2. Dashboard returns expected alert categories.
 *  3. Activity timeline per document is org-scoped (cross-tenant doc returns 404).
 *  4. Activity timeline per user is org-scoped (cross-tenant user returns 404).
 *  5. CSV export: Content-Type is text/csv; X-Content-Type-Options is nosniff.
 *  6. CSV-injection sanitization: cells starting with = are prefixed with '.
 *  7. CSV export is org-scoped (only admin's org events appear).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { setupTestDatabase } from './helpers/testDb.js';
import { buildApp } from '../src/app.js';
import { AuditService } from '../src/services/audit.service.js';
import { DatabasePool, setDatabasePool } from '../src/db/index.js';

describe('Phase 7: Admin Dashboard, Alerts, Activity Timelines, CSV Export', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: DatabasePool;

  let adminCookie: string;
  let ownerCookie: string;
  let viewerCookie: string;
  let starkAdminCookie: string;
  let acmeDocId: string;
  let acmeViewerUserId: string;
  let starkDocId: string;
  let starkViewerUserId: string;

  beforeAll(async () => {
    const res = await setupTestDatabase();
    pool = res.pool;
    app = buildApp();
    await app.ready();

    const al = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password: 'TrustVault2026!#' });
    adminCookie = al.headers['set-cookie'][0];

    const ol = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'owner@acme.com', password: 'TrustVault2026!#' });
    ownerCookie = ol.headers['set-cookie'][0];

    const vl = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
    viewerCookie = vl.headers['set-cookie'][0];
    acmeViewerUserId = vl.body.user.id;

    const sl = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'admin@stark.com', password: 'TrustVault2026!#' });
    starkAdminCookie = sl.headers['set-cookie'][0];

    // Get an Acme doc and a Stark doc for cross-tenant tests
    const acmeDocRes = await pool.query(
      "SELECT id FROM documents WHERE title = 'Acme Financial Strategy 2026.pdf';"
    );
    acmeDocId = acmeDocRes.rows[0].id;

    const starkDocRes = await pool.query(
      "SELECT id FROM documents WHERE title = 'Arc Reactor Schematics.pdf';"
    );
    starkDocId = starkDocRes.rows[0].id;

    const starkViewerRes = await pool.query(
      "SELECT id FROM users WHERE email = 'viewer@stark.com';"
    );
    starkViewerUserId = starkViewerRes.rows[0].id;

    // Inject a synthetic audit event with a CSV-injection payload to test sanitization
    await AuditService.log({
      eventType: 'TEST',
      action: 'CSV_INJECTION_TEST',
      status: 'INFO',
      actorEmail: '=DANGEROUS_FORMULA()',
      organizationId: al.body.user.organizationId,
      reason: '+inject',
    });
  });

  afterAll(async () => {
    await pool.end();
    setDatabasePool(null);
  });

  // ─── 1. Dashboard Access Control ─────────────────────────────────────────────

  describe('1. Dashboard access control', () => {
    it('admin can access the dashboard', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/dashboard')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.alerts).toBeDefined();
      expect(res.body.generatedAt).toBeDefined();
    });

    it('owner is forbidden from dashboard (403)', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/dashboard')
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(403);
    });

    it('viewer is forbidden from dashboard (403)', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/dashboard')
        .set('Cookie', viewerCookie);
      expect(res.status).toBe(403);
    });

    it('unauthenticated request is rejected (401)', async () => {
      const res = await supertest(app.server).get('/api/admin/dashboard');
      expect(res.status).toBe(401);
    });
  });

  // ─── 2. Dashboard Alert Categories ───────────────────────────────────────────

  describe('2. Dashboard alert structure', () => {
    it('returns all expected alert categories', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/dashboard')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const { alerts } = res.body;
      expect(alerts).toHaveProperty('bulkDownloads');
      expect(alerts).toHaveProperty('repeatedDenials');
      expect(alerts).toHaveProperty('offHoursAccess');
      expect(alerts).toHaveProperty('quickRevokes');
      expect(alerts).toHaveProperty('newIpLogins');
      expect(alerts).toHaveProperty('expiredTokenAttempts');

      // All alert arrays must be arrays
      for (const key of Object.keys(alerts)) {
        expect(Array.isArray(alerts[key])).toBe(true);
      }
    });
  });

  // ─── 3. Activity Timeline Per Document ───────────────────────────────────────

  describe('3. Activity timeline per document', () => {
    it('admin can view activity timeline for own-org document', async () => {
      const res = await supertest(app.server)
        .get(`/api/admin/activity/document/${acmeDocId}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.events).toBeInstanceOf(Array);
      expect(res.body.pagination).toBeDefined();
    });

    it('admin cannot view activity timeline for cross-tenant document (404)', async () => {
      // Stark admin tries to fetch Acme doc timeline
      const res = await supertest(app.server)
        .get(`/api/admin/activity/document/${acmeDocId}`)
        .set('Cookie', starkAdminCookie);

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Resource not found or access denied/);
    });

    it('owner cannot view activity timeline (403)', async () => {
      const res = await supertest(app.server)
        .get(`/api/admin/activity/document/${acmeDocId}`)
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(403);
    });
  });

  // ─── 4. Activity Timeline Per User ───────────────────────────────────────────

  describe('4. Activity timeline per user', () => {
    it('admin can view activity timeline for own-org user', async () => {
      const res = await supertest(app.server)
        .get(`/api/admin/activity/user/${acmeViewerUserId}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.events).toBeInstanceOf(Array);
    });

    it('Stark admin cannot view Acme user activity timeline (cross-tenant, 404)', async () => {
      const res = await supertest(app.server)
        .get(`/api/admin/activity/user/${acmeViewerUserId}`)
        .set('Cookie', starkAdminCookie);

      expect(res.status).toBe(404);
    });

    it('Acme admin cannot view Stark user activity timeline (cross-tenant, 404)', async () => {
      const res = await supertest(app.server)
        .get(`/api/admin/activity/user/${starkViewerUserId}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
    });
  });

  // ─── 5. CSV Export Headers ────────────────────────────────────────────────────

  describe('5. CSV export response headers', () => {
    it('CSV export returns correct Content-Type and security headers', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/export')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toMatch(/attachment.*\.csv/);
    });

    it('CSV export is forbidden for owner (403)', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/export')
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(403);
    });
  });

  // ─── 6. CSV Injection Sanitization ───────────────────────────────────────────

  describe('6. CSV injection sanitization', () => {
    it('cell values starting with = are prefixed with apostrophe in CSV output', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/export')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const csv = res.text;

      // The injected formula =DANGEROUS_FORMULA() must appear as '=DANGEROUS_FORMULA() in CSV
      // (not raw = which would be executed by spreadsheet software)
      // The CSV cell will be quoted: "'=DANGEROUS_FORMULA()"
      expect(csv).toContain("'=DANGEROUS_FORMULA()");
    });

    it('cell values starting with + are prefixed with apostrophe in CSV output', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/audit/export')
        .set('Cookie', adminCookie);

      const csv = res.text;
      // The '+inject' reason we inserted must appear as '''+inject' in the CSV
      expect(csv).toContain("'+inject");
    });
  });

  // ─── 7. CSV Export Org Isolation ─────────────────────────────────────────────

  describe('7. CSV export org isolation', () => {
    it('Stark admin CSV export does not contain Acme org events', async () => {
      // Get Acme org ID to check it doesn't appear in Stark export
      const acmeOrgRes = await pool.query(
        "SELECT id FROM organizations WHERE name = 'Acme Corp';"
      );
      const acmeOrgId = acmeOrgRes.rows[0]?.id;

      const res = await supertest(app.server)
        .get('/api/admin/audit/export')
        .set('Cookie', starkAdminCookie);

      expect(res.status).toBe(200);
      // Acme org IDs must not appear in Stark's exported CSV
      // (We check by looking for Acme-specific email patterns)
      expect(res.text).not.toContain('@acme.com');
    });
  });
});
