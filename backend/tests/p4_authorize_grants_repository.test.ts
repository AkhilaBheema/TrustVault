import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import crypto from 'node:crypto';
import { setupTestDatabase } from './helpers/testDb.js';
import { buildApp } from '../src/app.js';
import { AuditService } from '../src/services/audit.service.js';
import { DatabasePool, setDatabasePool } from '../src/db/index.js';

describe('Phase 4: authorize() Chokepoint, Repository Scoping, & Grants', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: DatabasePool;

  let acmeAdminCookie: string;
  let acmeAdminCsrf: string;
  let acmeOwnerCookie: string;
  let acmeOwnerCsrf: string;
  let acmeViewerCookie: string;
  let acmeViewerCsrf: string;

  let starkViewerCookie: string;

  let acmeStrategyDocId: string;
  let acmeSecretDocId: string;
  let starkArcDocId: string;

  beforeAll(async () => {
    const res = await setupTestDatabase();
    pool = res.pool;
    app = buildApp();
    await app.ready();

    // 1. Log in Acme Admin
    const adminLogin = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password: 'TrustVault2026!#' });
    acmeAdminCookie = adminLogin.headers['set-cookie'][0];
    acmeAdminCsrf = adminLogin.body.csrfToken;

    // 2. Log in Acme Owner
    const ownerLogin = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'owner@acme.com', password: 'TrustVault2026!#' });
    acmeOwnerCookie = ownerLogin.headers['set-cookie'][0];
    acmeOwnerCsrf = ownerLogin.body.csrfToken;

    // 3. Log in Acme Viewer
    const viewerLogin = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
    acmeViewerCookie = viewerLogin.headers['set-cookie'][0];
    acmeViewerCsrf = viewerLogin.body.csrfToken;

    // 4. Log in Stark Viewer
    const starkViewerLogin = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'viewer@stark.com', password: 'TrustVault2026!#' });
    starkViewerCookie = starkViewerLogin.headers['set-cookie'][0];

    // 5. Fetch seed document IDs
    const strategyDoc = await pool.query(
      "SELECT id FROM documents WHERE title = 'Acme Financial Strategy 2026.pdf';"
    );
    acmeStrategyDocId = strategyDoc.rows[0].id;

    const secretDoc = await pool.query(
      "SELECT id FROM documents WHERE title = 'Acme Product Roadmap Secret.docx';"
    );
    acmeSecretDocId = secretDoc.rows[0].id;

    const starkDoc = await pool.query(
      "SELECT id FROM documents WHERE title = 'Arc Reactor Schematics.pdf';"
    );
    starkArcDocId = starkDoc.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
    setDatabasePool(null);
  });

  describe('1. Uniform 404 & Zero Existence Leaks (IDOR Mitigation)', () => {
    it('returns identical 404 status and body for inaccessible docs vs non-existent UUIDs', async () => {
      // Case A: Viewer attempts to read ungranted secret roadmap (exists in tenant, but no grant)
      const resDenied = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeViewerCookie);

      expect(resDenied.status).toBe(404);
      expect(resDenied.body).toEqual({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });

      // Case B: Viewer attempts to read a completely fake random UUID (does not exist)
      const fakeUuid = crypto.randomUUID();
      const resNonExistent = await supertest(app.server)
        .get(`/api/documents/${fakeUuid}`)
        .set('Cookie', acmeViewerCookie);

      expect(resNonExistent.status).toBe(404);
      expect(resNonExistent.body).toEqual({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });

      // Case C: Acme Viewer attempts to read a Stark Industries document (cross-tenant IDOR attack)
      const resCrossTenant = await supertest(app.server)
        .get(`/api/documents/${starkArcDocId}`)
        .set('Cookie', acmeViewerCookie);

      expect(resCrossTenant.status).toBe(404);
      expect(resCrossTenant.body).toEqual({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });

      // Case D: Malformed non-UUID identifier returns identical 404 without database syntax error leak
      const resMalformed = await supertest(app.server)
        .get('/api/documents/non-uuid-injection-attempt')
        .set('Cookie', acmeViewerCookie);

      expect(resMalformed.status).toBe(404);
      expect(resMalformed.body).toEqual({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    });

    it('records denied attempts with reason in tamper-evident audit log', async () => {
      const audits = await pool.query(
        "SELECT * FROM audit_events WHERE status = 'DENIED' AND action LIKE 'DENIED_%' ORDER BY created_at DESC LIMIT 1;"
      );
      expect(audits.rows.length).toBeGreaterThan(0);
      expect(audits.rows[0].status).toBe('DENIED');
      expect(audits.rows[0].reason).toBeDefined();
    });
  });

  describe('2. Separation of Duties: Admin Content Restrictions', () => {
    it('prohibits Admin from reading or downloading documents without an explicit grant', async () => {
      // Admin attempts to view secret roadmap metadata
      const viewRes = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeAdminCookie);

      expect(viewRes.status).toBe(404);

      // Admin attempts to issue a download ticket for secret roadmap
      const ticketRes = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/download-ticket`)
        .set('Cookie', acmeAdminCookie)
        .set('X-CSRF-Token', acmeAdminCsrf);

      expect(ticketRes.status).toBe(404);
    });

    it('prohibits Admin from issuing or managing document grants', async () => {
      // Only the Owner can manage grants
      const grantRes = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/grants`)
        .set('Cookie', acmeAdminCookie)
        .set('X-CSRF-Token', acmeAdminCsrf)
        .send({
          userId: crypto.randomUUID(),
          permission: 'read',
        });

      // Admin role fails requireRole('owner')
      expect(grantRes.status).toBe(403);
    });
  });

  describe('3. SQL Scoping in DocumentRepository (Zero Search/Count Leaks)', () => {
    it('viewer only sees documents with active unexpired grants', async () => {
      const res = await supertest(app.server)
        .get('/api/documents')
        .set('Cookie', acmeViewerCookie);

      expect(res.status).toBe(200);
      const docs = res.body.documents;

      const titles = docs.map((d: any) => d.title);
      // Viewer has grants on Strategy and Directory
      expect(titles).toContain('Acme Financial Strategy 2026.pdf');
      expect(titles).toContain('Acme Employee Directory.xlsx');

      // Ungranted secret roadmap MUST NOT be present
      expect(titles).not.toContain('Acme Product Roadmap Secret.docx');

      // Cross-tenant Stark docs MUST NOT be present
      expect(titles).not.toContain('Arc Reactor Schematics.pdf');
    });

    it('scopes keyword search in SQL so ungranted documents cannot be leaked by search or count', async () => {
      // Search for "Roadmap" (which matches the secret doc)
      const res = await supertest(app.server)
        .get('/api/documents?search=Roadmap')
        .set('Cookie', acmeViewerCookie);

      expect(res.status).toBe(200);
      // Must be empty for viewer!
      expect(res.body.documents.length).toBe(0);

      // Owner searching for "Roadmap" finds it
      const ownerRes = await supertest(app.server)
        .get('/api/documents?search=Roadmap')
        .set('Cookie', acmeOwnerCookie);

      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.documents.length).toBe(1);
      expect(ownerRes.body.documents[0].title).toBe('Acme Product Roadmap Secret.docx');
    });

    it('scopes category filtering strictly in SQL', async () => {
      const res = await supertest(app.server)
        .get('/api/documents?category=Financial')
        .set('Cookie', acmeViewerCookie);

      expect(res.status).toBe(200);
      expect(res.body.documents.length).toBe(1);
      expect(res.body.documents[0].title).toBe('Acme Financial Strategy 2026.pdf');
    });
  });

  describe('4. Download Tickets & Stream-Time Re-Authorization', () => {
    let ticketToken: string;

    it('issues single-use <=60s download ticket for authorized viewer', async () => {
      const res = await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/download-ticket`)
        .set('Cookie', acmeViewerCookie)
        .set('X-CSRF-Token', acmeViewerCsrf);

      expect(res.status).toBe(200);
      expect(res.body.rawTicket).toBeDefined();
      expect(res.body.expiresInSeconds).toBe(60);

      ticketToken = res.body.rawTicket;
    });

    it('streams decrypted bytes with attachment disposition and nosniff headers upon ticket redemption', async () => {
      const res = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}/download?ticket=${ticketToken}`)
        .set('Cookie', acmeViewerCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('rejects reused ticket (single-use invariant)', async () => {
      const res = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}/download?ticket=${ticketToken}`)
        .set('Cookie', acmeViewerCookie);

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Resource not found or access denied/);
    });

    it('rejects ticket redemption if caller user does not match ticket binding', async () => {
      // Issue ticket for Acme Owner
      const issueRes = await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/download-ticket`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf);

      const ownerTicket = issueRes.body.rawTicket;

      // Stark Viewer tries to redeem Acme Owner's ticket
      const hijackRes = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}/download?ticket=${ownerTicket}`)
        .set('Cookie', starkViewerCookie);

      expect(hijackRes.status).toBe(404);
    });
  });

  describe('5. Grants Lifecycle, Time-Boxed Expiry, & Immediate Revocation', () => {
    let viewerUserId: string;

    beforeAll(async () => {
      const viewerUser = await pool.query("SELECT id FROM users WHERE email = 'viewer@acme.com';");
      viewerUserId = viewerUser.rows[0].id;
    });

    it('owner inspects "Who can see this?" panel', async () => {
      const res = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}/grants`)
        .set('Cookie', acmeOwnerCookie);

      expect(res.status).toBe(200);
      expect(res.body.ownerInfo).toBeDefined();
      expect(res.body.ownerInfo.email).toBe('owner@acme.com');
      expect(res.body.grants.length).toBeGreaterThan(0);
      expect(res.body.grants[0].userEmail).toBe('viewer@acme.com');
      expect(res.body.grants[0].permission).toBe('read');
    });

    it('owner issues grant to viewer on previously ungranted secret roadmap', async () => {
      // Verify viewer CANNOT see it currently
      const beforeRes = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeViewerCookie);
      expect(beforeRes.status).toBe(404);

      // Owner issues 'read' grant
      const grantRes = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/grants`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({
          userId: viewerUserId,
          permission: 'read',
        });

      expect(grantRes.status).toBe(201);
      expect(grantRes.body.grant.permission).toBe('read');

      // Viewer CAN now see it!
      const afterRes = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeViewerCookie);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body.document.title).toBe('Acme Product Roadmap Secret.docx');
    });

    it('owner elevates grant to "edit" and increments grant_version', async () => {
      const elevateRes = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/grants`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({
          userId: viewerUserId,
          permission: 'edit',
        });

      expect(elevateRes.status).toBe(201);
      expect(elevateRes.body.grant.permission).toBe('edit');
      expect(elevateRes.body.grant.grantVersion).toBe(2);
    });

    it('automatically denies access when a grant reaches expiration timestamp', async () => {
      // Manually set grant expires_at to 1 second in the past
      await pool.query(
        "UPDATE document_grants SET expires_at = NOW() - INTERVAL '10 seconds' WHERE document_id = $1 AND user_id = $2;",
        [acmeSecretDocId, viewerUserId]
      );

      // Immediate check-time enforcement: Viewer is refused
      const res = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeViewerCookie);

      expect(res.status).toBe(404);
    });

    it('owner revokes grant immediately', async () => {
      // Reset grant to valid unexpired
      await pool.query(
        'UPDATE document_grants SET expires_at = NULL WHERE document_id = $1 AND user_id = $2;',
        [acmeSecretDocId, viewerUserId]
      );

      // Confirm valid
      const beforeRevoke = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeViewerCookie);
      expect(beforeRevoke.status).toBe(200);

      // Owner revokes grant
      const revokeRes = await supertest(app.server)
        .delete(`/api/documents/${acmeSecretDocId}/grants/${viewerUserId}`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf);

      expect(revokeRes.status).toBe(200);

      // Immediate next request: Viewer fails with 404
      const afterRevoke = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', acmeViewerCookie);
      expect(afterRevoke.status).toBe(404);
    });

    it('emergency "Revoke All" removes all grants in a single atomic transaction', async () => {
      const emergencyRes = await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/grants/revoke-all`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf);

      expect(emergencyRes.status).toBe(200);
      expect(emergencyRes.body.revokedCount).toBeGreaterThan(0);

      // Strategy doc now has 0 grants; Viewer fails
      const viewerRes = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}`)
        .set('Cookie', acmeViewerCookie);
      expect(viewerRes.status).toBe(404);
    });
  });

  describe('6. Cryptographic Audit Chain Verification', () => {
    it('proves the audit hash chain is unbroken after all authorization and grant events', async () => {
      const integrity = await AuditService.verifyChainIntegrity();

      expect(integrity.isValid).toBe(true);
      expect(integrity.totalRecords).toBeGreaterThan(15);
      expect(integrity.brokenAtSequence).toBeUndefined();
    });
  });
});
