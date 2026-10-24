import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { AuthService } from '../services/auth.service.js';
import { authenticate, verifyCsrf, SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { sendOtpEmail } from '../services/email.service.js';
import { pool } from '../db/index.js';
import { CryptoService } from '../services/crypto.service.js';
import { SessionService } from '../services/session.service.js';
import { AuditService } from '../services/audit.service.js';

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address format'),
  password: z.string().min(1, 'Password is required').max(256, 'Password is too long'),
});

// In-memory OTP store: email -> { otp, expires, name, isRegistration }
const otpStore = new Map<string, { otp: string; expires: number; name: string; isRegistration: boolean }>();

function generateOtp() {
  return String(Math.floor(100000 + crypto.randomInt(900000)));
}

function cookieOpts(expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: (process.env.COOKIE_SAME_SITE === 'none' ? 'none' : 'strict') as 'strict' | 'none',
    expires: expiresAt,
  };
}

export async function authRoutes(app: FastifyInstance) {

  // ── 1. Password Login ────────────────────────────────────────
  app.post('/api/auth/login', async (request, reply) => {
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Bad Request', message: parseResult.error.errors[0]?.message || 'Invalid input' });
    }
    const { email, password } = parseResult.data;
    try {
      const { user, sessionToken, csrfToken, expiresAt } = await AuthService.login(email, password, request.ip, request.headers['user-agent'] || null);
      reply.setCookie(SESSION_COOKIE_NAME, sessionToken, cookieOpts(expiresAt));
      return reply.status(200).send({ user, csrfToken });
    } catch (err: any) {
      const statusCode = err.statusCode || 401;
      return reply.status(statusCode).send({ error: statusCode === 423 ? 'Locked' : 'Unauthorized', message: err.message || 'Invalid email or password.' });
    }
  });

  // ── 2. Send OTP (Register or Login via Gmail OTP) ───────────
  app.post('/api/auth/send-otp', async (request, reply) => {
    const parsed = z.object({
      email: z.string().trim().email(),
      name: z.string().trim().min(2).max(120).optional().default(''),
      mode: z.enum(['register', 'login']).default('login'),
    }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: parsed.error.errors[0]?.message });

    const { email, name, mode } = parsed.data;
    const lowerEmail = email.toLowerCase();

    // For login mode: user must already exist
    if (mode === 'login') {
      const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 AND is_disabled = FALSE', [lowerEmail]);
      if (existing.rows.length === 0) {
        // Don't leak existence; just pretend we sent
        return reply.status(200).send({ message: 'If that email is registered, a code was sent.' });
      }
    }

    const otp = generateOtp();
    otpStore.set(lowerEmail, { otp, expires: Date.now() + 10 * 60 * 1000, name: name || '', isRegistration: mode === 'register' });

    try {
      await sendOtpEmail(lowerEmail, otp, name || '');
    } catch (e) {
      console.error('[OTP] Email send failed:', e);
    }

    return reply.status(200).send({ message: 'Verification code sent. Check your Gmail inbox.' });
  });

  // ── 3. Verify OTP → Create session ──────────────────────────
  app.post('/api/auth/verify-otp', async (request, reply) => {
    const parsed = z.object({
      email: z.string().trim().email(),
      otp: z.string().length(6),
      name: z.string().trim().min(2).max(120).optional().default(''),
    }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: 'Invalid input.' });

    const { email, otp, name } = parsed.data;
    const lowerEmail = email.toLowerCase();
    const entry = otpStore.get(lowerEmail);

    if (!entry || entry.otp !== otp || Date.now() > entry.expires) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired verification code.' });
    }
    otpStore.delete(lowerEmail);

    // Find or create user
    let userRow = await pool.query<{ id: string; organization_id: string; email: string; name: string; role: 'admin'|'owner'|'viewer'; is_disabled: boolean }>(
      'SELECT id, organization_id, email, name, role, is_disabled FROM users WHERE LOWER(email) = $1', [lowerEmail]
    );

    if (userRow.rows.length === 0) {
      // Auto-register as viewer under first org
      const org = await pool.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
      if (org.rows.length === 0) return reply.status(500).send({ error: 'ServerError', message: 'No organization found.' });
      const orgId = org.rows[0].id;
      const displayName = name || entry.name || lowerEmail.split('@')[0];
      const dummyHash = await CryptoService.hashPassword(CryptoService.generateRandomToken(32));
      await pool.query(
        `INSERT INTO users (organization_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, 'viewer')`,
        [orgId, lowerEmail, dummyHash, displayName]
      );
      userRow = await pool.query<{ id: string; organization_id: string; email: string; name: string; role: 'admin'|'owner'|'viewer'; is_disabled: boolean }>(
        'SELECT id, organization_id, email, name, role, is_disabled FROM users WHERE LOWER(email) = $1', [lowerEmail]
      );
    }

    const u = userRow.rows[0];
    if (u.is_disabled) return reply.status(401).send({ error: 'Unauthorized', message: 'Account is disabled.' });

    const { sessionToken, expiresAt } = await SessionService.createSession(u.id, request.ip, request.headers['user-agent'] || null);
    const csrfToken = CryptoService.generateCsrfToken(sessionToken);

    await AuditService.log({
      eventType: 'AUTH_LOGIN', action: 'OTP_LOGIN_SUCCESS', status: 'ALLOWED',
      actorId: u.id, actorEmail: u.email, organizationId: u.organization_id,
      reason: 'OTP email verification', ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
    });

    reply.setCookie(SESSION_COOKIE_NAME, sessionToken, cookieOpts(expiresAt));
    return reply.status(200).send({
      user: { id: u.id, email: u.email, name: u.name, role: u.role, organizationId: u.organization_id, isDisabled: u.is_disabled },
      csrfToken,
    });
  });

  // ── 4. Logout ────────────────────────────────────────────────
  app.post('/api/auth/logout', { preHandler: [authenticate, verifyCsrf] }, async (request, reply) => {
    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    if (sessionToken && request.user) {
      await AuthService.logout(sessionToken, request.user, request.ip, request.headers['user-agent'] || null);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
    return reply.status(200).send({ status: 'success', message: 'Logged out successfully.' });
  });

  // ── 5. Current user / CSRF refresh ──────────────────────────
  app.get('/api/auth/me', { preHandler: [authenticate] }, async (request) => {
    return { user: request.user, csrfToken: request.csrfToken };
  });
}
