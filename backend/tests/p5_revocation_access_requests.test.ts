import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import crypto from 'node:crypto';
import { setupTestDatabase } from './helpers/testDb.js';
import { buildApp } from '../src/app.js';
import { AuditService } from '../src/services/audit.service.js';
import { DatabasePool, setDatabasePool } from '../src/db/index.js';

describe('Phase 5: Immediate Revocation (Sessions, Tickets, Links) & Access Requests', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: DatabasePool;

  let acmeAdminCookie: string;
  let acmeAdminCsrf: string;
  let acmeOwnerCookie: string;
  let acmeOwnerCsrf: string;
  let acmeViewerCookie: string;
  let acmeViewerCsrf: string;

  let acmeStrategyDocId: string;
  let acmeSecretDocId: string;
  let viewerUserId: string;

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
    viewerUserId = viewerLogin.body.user.id;

    // 4. Fetch document IDs
    const strategyDoc = await pool.query(
      "SELECT id FROM documents WHERE title = 'Acme Financial Strategy 2026.pdf';"
    );
    acmeStrategyDocId = strategyDoc.rows[0].id;

    const secretDoc = await pool.query(
      "SELECT id FROM documents WHERE title = 'Acme Product Roadmap Secret.docx';"
    );
    acmeSecretDocId = secretDoc.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
    setDatabasePool(null);
  });

  describe('1. Immediate Revocation of In-Flight Download Tickets', () => {
    it('invalidates an in-flight ticket at stream time if the grant is revoked', async () => {
      // 1. Issue a valid download ticket to viewer
      const ticketRes = await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/download-ticket`)
        .set('Cookie', acmeViewerCookie)
        .set('X-CSRF-Token', acmeViewerCsrf);

      expect(ticketRes.status).toBe(200);
      const ticketToken = ticketRes.body.rawTicket;

      // 2. Owner revokes grant before ticket is redeemed
      const revokeRes = await supertest(app.server)
        .delete(`/api/documents/${acmeStrategyDocId}/grants/${viewerUserId}`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf);
      expect(revokeRes.status).toBe(200);

      // 3. Viewer attempts to redeem the in-flight ticket
      // Stream-time authorization MUST detect grant revocation and refuse the download!
      const redeemRes = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}/download?ticket=${ticketToken}`)
        .set('Cookie', acmeViewerCookie);

      expect(redeemRes.status).toBe(404);
      expect(redeemRes.body.message).toMatch(/Resource not found or access denied/);
    });

    it('invalidates an in-flight ticket if grant_version changed (grant updated)', async () => {
      // 1. Re-issue 'read' grant to viewer
      await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/grants`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({ userId: viewerUserId, permission: 'read' });

      // 2. Issue ticket (bound to grant_version: 1)
      const ticketRes = await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/download-ticket`)
        .set('Cookie', acmeViewerCookie)
        .set('X-CSRF-Token', acmeViewerCsrf);
      const ticketToken = ticketRes.body.rawTicket;

      // 3. Owner updates grant (elevates to 'edit'), incrementing grant_version to 2
      await supertest(app.server)
        .post(`/api/documents/${acmeStrategyDocId}/grants`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({ userId: viewerUserId, permission: 'edit' });

      // 4. Viewer tries to redeem old ticket bound to grant_version 1
      const redeemRes = await supertest(app.server)
        .get(`/api/documents/${acmeStrategyDocId}/download?ticket=${ticketToken}`)
        .set('Cookie', acmeViewerCookie);

      expect(redeemRes.status).toBe(404);
    });
  });

  describe('2. Immediate Revocation of Sessions', () => {
    it('immediately terminates all user sessions when Admin force-revokes sessions', async () => {
      // 1. Log in fresh viewer session
      const loginRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });

      const viewerActiveCookie = loginRes.headers['set-cookie'][0];

      // Confirm session works
      const meBefore = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', viewerActiveCookie);
      expect(meBefore.status).toBe(200);

      // 2. Admin force-revokes viewer's sessions
      const revokeRes = await supertest(app.server)
        .post(`/api/admin/users/${viewerUserId}/force-logout`)
        .set('Cookie', acmeAdminCookie)
        .set('X-CSRF-Token', acmeAdminCsrf);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revokedSessionsCount).toBeGreaterThan(0);

      // 3. Next request with that cookie MUST fail immediately
      const meAfter = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', viewerActiveCookie);

      expect(meAfter.status).toBe(401);
    });
  });

  describe('3. External Share Invites & Immediate Link Revocation', () => {
    let inviteToken: string;
    let inviteId: string;

    it('owner creates an external share invite for a verified email', async () => {
      const res = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/invites`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({
          recipientEmail: 'viewer@acme.com',
          permission: 'read',
          expiresInHours: 48,
        });

      expect(res.status).toBe(201);
      expect(res.body.rawToken).toBeDefined();
      expect(res.body.invite.email).toBe('viewer@acme.com');

      inviteToken = res.body.rawToken;
      inviteId = res.body.invite.id;
    });

    it('rejects invite redemption if recipient email does not match token binding', async () => {
      // Stark Owner attempts to redeem an invite issued to viewer@acme.com
      const starkLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'owner@stark.com', password: 'TrustVault2026!#' });

      const starkCookie = starkLogin.headers['set-cookie'][0];
      const starkCsrf = starkLogin.body.csrfToken;

      const res = await supertest(app.server)
        .post('/api/invites/accept')
        .set('Cookie', starkCookie)
        .set('X-CSRF-Token', starkCsrf)
        .send({ token: inviteToken });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Resource not found or access denied/);
    });

    it('owner immediately revokes share invite before redemption', async () => {
      const revokeRes = await supertest(app.server)
        .delete(`/api/documents/${acmeSecretDocId}/invites/${inviteId}`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf);

      expect(revokeRes.status).toBe(200);

      // Legitimate recipient now tries to redeem the revoked token -> fails immediately!
      // Re-login viewer to get fresh session
      const freshViewerLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });

      const viewerCookie = freshViewerLogin.headers['set-cookie'][0];
      const viewerCsrf = freshViewerLogin.body.csrfToken;

      const redeemRes = await supertest(app.server)
        .post('/api/invites/accept')
        .set('Cookie', viewerCookie)
        .set('X-CSRF-Token', viewerCsrf)
        .send({ token: inviteToken });

      expect(redeemRes.status).toBe(404);
    });

    it('redeems valid unrevoked invite and converts it into active document grant', async () => {
      // 1. Create fresh valid invite for viewer
      const createRes = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/invites`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({
          recipientEmail: 'viewer@acme.com',
          permission: 'edit',
          expiresInHours: 24,
        });

      const token = createRes.body.rawToken;

      // 2. Viewer logs in and redeems invite
      const viewerLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });

      const viewerCookie = viewerLogin.headers['set-cookie'][0];
      const viewerCsrf = viewerLogin.body.csrfToken;

      const acceptRes = await supertest(app.server)
        .post('/api/invites/accept')
        .set('Cookie', viewerCookie)
        .set('X-CSRF-Token', viewerCsrf)
        .send({ token });

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.permission).toBe('edit');

      // 3. Confirm Viewer now has edit access to secret roadmap
      const viewRes = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', viewerCookie);

      expect(viewRes.status).toBe(200);
      expect(viewRes.body.document.effectivePermission).toBe('edit');

      // 4. Reusing the token MUST fail
      const reuseRes = await supertest(app.server)
        .post('/api/invites/accept')
        .set('Cookie', viewerCookie)
        .set('X-CSRF-Token', viewerCsrf)
        .send({ token });

      expect(reuseRes.status).toBe(404);
    });
  });

  describe('4. Neutral Access Requests (Zero Existence Leaks) & Owner Review', () => {
    let freshViewerCookie: string;
    let freshViewerCsrf: string;

    beforeAll(async () => {
      const viewerLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });

      freshViewerCookie = viewerLogin.headers['set-cookie'][0];
      freshViewerCsrf = viewerLogin.body.csrfToken;
    });

    it('returns neutral confirmation for non-existent document ID (no existence leak)', async () => {
      const fakeDocId = crypto.randomUUID();

      const res = await supertest(app.server)
        .post(`/api/documents/${fakeDocId}/access-requests`)
        .set('Cookie', freshViewerCookie)
        .set('X-CSRF-Token', freshViewerCsrf)
        .send({ targetPermission: 'read' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe(
        'If this document exists, your access request has been forwarded to the owner.'
      );
    });

    it('returns identical neutral confirmation for cross-tenant document ID', async () => {
      // Stark doc ID requested by Acme viewer
      const starkDoc = await pool.query(
        "SELECT id FROM documents WHERE title = 'Arc Reactor Schematics.pdf';"
      );
      const starkDocId = starkDoc.rows[0].id;

      const res = await supertest(app.server)
        .post(`/api/documents/${starkDocId}/access-requests`)
        .set('Cookie', freshViewerCookie)
        .set('X-CSRF-Token', freshViewerCsrf)
        .send({ targetPermission: 'read' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe(
        'If this document exists, your access request has been forwarded to the owner.'
      );
    });

    it('submits legitimate access request and owner reviews with time-boxed approval', async () => {
      // 1. Remove any existing grant on secret roadmap
      await pool.query(
        'DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2;',
        [acmeSecretDocId, viewerUserId]
      );

      // 2. Viewer submits access request
      const reqRes = await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/access-requests`)
        .set('Cookie', freshViewerCookie)
        .set('X-CSRF-Token', freshViewerCsrf)
        .send({ targetPermission: 'read' });

      expect(reqRes.status).toBe(200);
      expect(reqRes.body.message).toBe(
        'If this document exists, your access request has been forwarded to the owner.'
      );

      // 3. Owner lists pending access requests
      const listRes = await supertest(app.server)
        .get('/api/access-requests')
        .set('Cookie', acmeOwnerCookie);

      expect(listRes.status).toBe(200);
      expect(listRes.body.requests.length).toBeGreaterThan(0);

      const pending = listRes.body.requests.find(
        (r: any) => r.documentId === acmeSecretDocId && r.requesterEmail === 'viewer@acme.com'
      );
      expect(pending).toBeDefined();
      const requestId = pending.id;

      // 4. Owner approves request with 7-day expiration
      const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const reviewRes = await supertest(app.server)
        .post(`/api/access-requests/${requestId}/review`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({
          decision: 'approve',
          permission: 'read',
          expiresAt: futureExpiry,
          reviewerNotes: 'Approved for Q4 audit review',
        });

      expect(reviewRes.status).toBe(200);
      expect(reviewRes.body.status).toBe('approved');

      // 5. Confirm Viewer now has immediate access
      const docView = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', freshViewerCookie);

      expect(docView.status).toBe(200);
      expect(docView.body.document.effectivePermission).toBe('read');
    });

    it('owner denies access request and viewer remains denied', async () => {
      // 1. Remove grant
      await pool.query(
        'DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2;',
        [acmeSecretDocId, viewerUserId]
      );

      // 2. Viewer submits new request
      await supertest(app.server)
        .post(`/api/documents/${acmeSecretDocId}/access-requests`)
        .set('Cookie', freshViewerCookie)
        .set('X-CSRF-Token', freshViewerCsrf)
        .send({ targetPermission: 'edit' });

      // 3. Owner lists and denies
      const listRes = await supertest(app.server)
        .get('/api/access-requests')
        .set('Cookie', acmeOwnerCookie);

      const pending = listRes.body.requests.find(
        (r: any) => r.documentId === acmeSecretDocId && r.status === 'pending'
      );
      expect(pending).toBeDefined();

      const denyRes = await supertest(app.server)
        .post(`/api/access-requests/${pending.id}/review`)
        .set('Cookie', acmeOwnerCookie)
        .set('X-CSRF-Token', acmeOwnerCsrf)
        .send({
          decision: 'deny',
          reviewerNotes: 'Denied: internal engineering only',
        });

      expect(denyRes.status).toBe(200);
      expect(denyRes.body.status).toBe('denied');

      // 4. Viewer remains denied
      const checkRes = await supertest(app.server)
        .get(`/api/documents/${acmeSecretDocId}`)
        .set('Cookie', freshViewerCookie);

      expect(checkRes.status).toBe(404);
    });
  });

  describe('5. Audit Trail Hash Chain Integrity', () => {
    it('verifies the hash chain is unbroken after all revocation, invite, and access request events', async () => {
      const integrity = await AuditService.verifyChainIntegrity();

      expect(integrity.isValid).toBe(true);
      expect(integrity.totalRecords).toBeGreaterThan(15);
      expect(integrity.brokenAtSequence).toBeUndefined();
    });
  });
});
