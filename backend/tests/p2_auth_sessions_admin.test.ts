import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { setupTestDatabase } from './helpers/testDb.js';
import { buildApp } from '../src/app.js';
import { AuditService } from '../src/services/audit.service.js';
import { SESSION_COOKIE_NAME } from '../src/middleware/auth.js';
import { DatabasePool, setDatabasePool } from '../src/db/index.js';

describe('Phase 2: Auth, Sessions, Roles, & User Admin', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: DatabasePool;

  beforeAll(async () => {
    const res = await setupTestDatabase();
    pool = res.pool;
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await pool.end();
    setDatabasePool(null);
  });

  describe('1. Authentication & Session Issuance', () => {
    it('authenticates valid credentials and issues a secure httpOnly cookie and CSRF token', async () => {
      const response = await supertest(app.server)
        .post('/api/auth/login')
        .send({
          email: 'admin@acme.com',
          password: 'TrustVault2026!#',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe('admin@acme.com');
      expect(response.body.user.role).toBe('admin');
      expect(response.body).toHaveProperty('csrfToken');
      expect(typeof response.body.csrfToken).toBe('string');

      // Verify hardened cookie headers
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const sessionCookie = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Strict/i);

      // Verify that database does NOT store the raw session token, but stores its SHA-256 hash
      const rawToken = sessionCookie.split(';')[0].split('=')[1];
      const sessions = await pool.query('SELECT * FROM sessions WHERE user_id = $1;', [
        response.body.user.id,
      ]);
      expect(sessions.rows.length).toBeGreaterThan(0);
      // The raw token must NEVER equal the stored token hash
      expect(sessions.rows[0].session_token_hash).not.toEqual(rawToken);
    });

    it('returns generic error on non-existent email (timing defense invoked)', async () => {
      const response = await supertest(app.server)
        .post('/api/auth/login')
        .send({
          email: 'unknown_attacker@domain.com',
          password: 'SomeRandomPassword123!',
        });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'Invalid email or password.',
      });
    });

    it('enforces progressive account lockout after 5 consecutive failed password attempts', async () => {
      const targetEmail = 'owner@stark.com';

      // 4 consecutive bad attempts
      for (let i = 1; i <= 4; i++) {
        const res = await supertest(app.server)
          .post('/api/auth/login')
          .send({ email: targetEmail, password: 'WrongPasswordAttempt' });
        expect(res.status).toBe(401);
      }

      // 5th bad attempt -> locks account
      const fifthRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: targetEmail, password: 'WrongPasswordAttempt' });
      expect(fifthRes.status).toBe(401);

      // 6th attempt while locked -> returns 423 Locked
      const sixthRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: targetEmail, password: 'TrustVault2026!#' });

      expect(sixthRes.status).toBe(423);
      expect(sixthRes.body.message).toMatch(/Account is temporarily locked/);
    });
  });

  describe('2. Session Validation, CSRF Protection, & Logout', () => {
    let sessionCookie: string;
    let csrfToken: string;

    beforeAll(async () => {
      const loginRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'owner@acme.com', password: 'TrustVault2026!#' });

      sessionCookie = loginRes.headers['set-cookie'][0];
      csrfToken = loginRes.body.csrfToken;
    });

    it('rejects /api/auth/me without session cookie', async () => {
      const res = await supertest(app.server).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns actor identity on /api/auth/me with valid session cookie', async () => {
      const res = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', sessionCookie);

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('owner@acme.com');
      expect(res.body.user.role).toBe('owner');
      expect(res.body.csrfToken).toBe(csrfToken);
    });

    it('rejects state-changing logout when X-CSRF-Token header is missing', async () => {
      const res = await supertest(app.server)
        .post('/api/auth/logout')
        .set('Cookie', sessionCookie);

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Missing CSRF protection token/);
    });

    it('rejects state-changing logout when X-CSRF-Token is invalid', async () => {
      const res = await supertest(app.server)
        .post('/api/auth/logout')
        .set('Cookie', sessionCookie)
        .set('X-CSRF-Token', '0000000000000000000000000000000000000000000000000000000000000000');

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Invalid CSRF protection token/);
    });

    it('successfully logs out with valid CSRF token and terminates session', async () => {
      const res = await supertest(app.server)
        .post('/api/auth/logout')
        .set('Cookie', sessionCookie)
        .set('X-CSRF-Token', csrfToken);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // Subsequent request using old cookie MUST fail (immediate revocation)
      const afterRes = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', sessionCookie);

      expect(afterRes.status).toBe(401);
    });
  });

  describe('3. Role Boundaries & Admin User Management', () => {
    let adminCookie: string;
    let adminCsrf: string;
    let viewerCookie: string;

    beforeAll(async () => {
      // Login Acme Admin
      const adminLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'admin@acme.com', password: 'TrustVault2026!#' });
      adminCookie = adminLogin.headers['set-cookie'][0];
      adminCsrf = adminLogin.body.csrfToken;

      // Login Acme Viewer
      const viewerLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
      viewerCookie = viewerLogin.headers['set-cookie'][0];
    });

    it('forbids viewer from accessing admin user management', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/users')
        .set('Cookie', viewerCookie);

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/do not have sufficient privileges/);
    });

    it('allows admin to list users scoped strictly to their organization', async () => {
      const res = await supertest(app.server)
        .get('/api/admin/users')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThan(0);

      const emails = res.body.users.map((u: any) => u.email);
      expect(emails).toContain('admin@acme.com');
      expect(emails).toContain('owner@acme.com');
      expect(emails).toContain('viewer@acme.com');

      // Zero cross-tenant leakage: Stark Industries users MUST NOT appear
      expect(emails).not.toContain('admin@stark.com');
      expect(emails).not.toContain('owner@stark.com');
      expect(emails).not.toContain('viewer@stark.com');
    });

    it('allows admin to create a new user in their organization', async () => {
      const newEmail = 'contractor@acme.com';
      const res = await supertest(app.server)
        .post('/api/admin/users')
        .set('Cookie', adminCookie)
        .set('X-CSRF-Token', adminCsrf)
        .send({
          email: newEmail,
          name: 'Charlie Contractor',
          role: 'viewer',
          initialPassword: 'TempPassword2026!#',
        });

      expect(res.status).toBe(201);
      expect(res.body.email).toBe(newEmail);
      expect(res.body.role).toBe('viewer');

      // Test login with the newly created user
      const loginRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: newEmail, password: 'TempPassword2026!#' });

      expect(loginRes.status).toBe(200);
    });

    it('disables user and immediately terminates active sessions', async () => {
      // 1. Log in viewer
      const loginRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
      const activeViewerCookie = loginRes.headers['set-cookie'][0];
      const viewerId = loginRes.body.user.id;

      // Confirm session is valid
      const meBefore = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', activeViewerCookie);
      expect(meBefore.status).toBe(200);

      // 2. Admin disables viewer
      const disableRes = await supertest(app.server)
        .patch(`/api/admin/users/${viewerId}/status`)
        .set('Cookie', adminCookie)
        .set('X-CSRF-Token', adminCsrf)
        .send({ isDisabled: true });

      expect(disableRes.status).toBe(200);
      expect(disableRes.body.isDisabled).toBe(true);
      expect(disableRes.body.revokedSessionsCount).toBeGreaterThan(0);

      // 3. Confirm active session is immediately revoked on next request
      const meAfter = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', activeViewerCookie);
      expect(meAfter.status).toBe(401);

      // 4. Confirm new login is also rejected
      const loginAttempt = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
      expect(loginAttempt.status).toBe(401);

      // 5. Re-enable user
      await supertest(app.server)
        .patch(`/api/admin/users/${viewerId}/status`)
        .set('Cookie', adminCookie)
        .set('X-CSRF-Token', adminCsrf)
        .send({ isDisabled: false });
    });

    it('prevents administrator from disabling their own account', async () => {
      const meRes = await supertest(app.server)
        .get('/api/auth/me')
        .set('Cookie', adminCookie);
      const adminId = meRes.body.user.id;

      const selfDisableRes = await supertest(app.server)
        .patch(`/api/admin/users/${adminId}/status`)
        .set('Cookie', adminCookie)
        .set('X-CSRF-Token', adminCsrf)
        .send({ isDisabled: true });

      expect(selfDisableRes.status).toBe(400);
      expect(selfDisableRes.body.message).toMatch(/cannot disable their own account/);
    });

    it('admin cannot manipulate users belonging to another organization (cross-tenant 404)', async () => {
      // Fetch a Stark user ID
      const starkUser = await pool.query("SELECT id FROM users WHERE email = 'owner@stark.com';");
      const starkUserId = starkUser.rows[0].id;

      // Acme Admin attempts to force-logout Stark user
      const res = await supertest(app.server)
        .post(`/api/admin/users/${starkUserId}/force-logout`)
        .set('Cookie', adminCookie)
        .set('X-CSRF-Token', adminCsrf);

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Resource not found or access denied/);
    });

    it('admin unlocks locked user and resets failed login attempts', async () => {
      // Find the locked Stark user from earlier lockout test
      const lockedUser = await pool.query(
        "SELECT id, organization_id FROM users WHERE email = 'owner@stark.com';"
      );
      const lockedUserId = lockedUser.rows[0].id;

      // Log in Stark Admin to unlock their own user
      const starkAdminLogin = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'admin@stark.com', password: 'TrustVault2026!#' });

      const starkAdminCookie = starkAdminLogin.headers['set-cookie'][0];
      const starkAdminCsrf = starkAdminLogin.body.csrfToken;

      const unlockRes = await supertest(app.server)
        .post(`/api/admin/users/${lockedUserId}/unlock`)
        .set('Cookie', starkAdminCookie)
        .set('X-CSRF-Token', starkAdminCsrf);

      expect(unlockRes.status).toBe(200);

      // Confirm user can now log in successfully
      const loginRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'owner@stark.com', password: 'TrustVault2026!#' });

      expect(loginRes.status).toBe(200);
    });
  });

  describe('4. Tamper-Evident Audit Trail Integrity', () => {
    it('verifies the cryptographic hash chain is valid and unbroken after all operations', async () => {
      const integrity = await AuditService.verifyChainIntegrity();

      expect(integrity.isValid).toBe(true);
      expect(integrity.totalRecords).toBeGreaterThan(5);
      expect(integrity.brokenAtSequence).toBeUndefined();
    });
  });
});
