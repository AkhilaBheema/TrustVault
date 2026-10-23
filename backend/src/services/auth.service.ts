import { pool } from '../db/index.js';
import { CryptoService } from './crypto.service.js';
import { SessionService } from './session.service.js';
import { AuditService } from './audit.service.js';
import { UserContext, UserRole } from '../types/auth.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export class AuthenticationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = 'AuthenticationError';
    this.statusCode = statusCode;
  }
}

export class AuthService {
  /**
   * Authenticate a user with email and password.
   * Defends against:
   * 1. Timing attacks via constant-time dummy Argon2 verification when email is unknown
   * 2. Brute-force attacks via progressive account lockout (5 attempts -> 15 min lock)
   * 3. Information disclosure via identical generic error messages
   */
  static async login(
    emailPlain: string,
    passwordPlain: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{
    user: UserContext;
    sessionToken: string;
    csrfToken: string;
    expiresAt: Date;
  }> {
    const normalizedEmail = emailPlain.trim().toLowerCase();

    // 1. Fetch user by lowercase email
    const res = await pool.query<{
      id: string;
      organization_id: string;
      email: string;
      password_hash: string;
      name: string;
      role: UserRole;
      is_disabled: boolean;
      failed_login_attempts: number;
      locked_until: Date | null;
    }>('SELECT * FROM users WHERE LOWER(email) = $1;', [normalizedEmail]);

    // 2. Email not found: execute dummy Argon2 verify for timing equivalence
    if (res.rows.length === 0) {
      await CryptoService.dummyVerifyPassword(passwordPlain);
      await AuditService.log({
        eventType: 'AUTH_LOGIN',
        action: 'LOGIN_FAILED',
        status: 'DENIED',
        actorEmail: normalizedEmail,
        reason: 'Invalid credentials (non-existent identity)',
        ipAddress,
        userAgent,
      });
      throw new AuthenticationError('Invalid email or password.');
    }

    const userRow = res.rows[0];

    // 3. Check account disabled
    if (userRow.is_disabled) {
      await CryptoService.dummyVerifyPassword(passwordPlain);
      await AuditService.log({
        eventType: 'AUTH_LOGIN',
        action: 'LOGIN_FAILED',
        status: 'DENIED',
        actorId: userRow.id,
        actorEmail: userRow.email,
        organizationId: userRow.organization_id,
        reason: 'Account is disabled by administrator',
        ipAddress,
        userAgent,
      });
      throw new AuthenticationError('Invalid email or password.');
    }

    // 4. Check account lockout
    const now = Date.now();
    if (userRow.locked_until && new Date(userRow.locked_until).getTime() > now) {
      await AuditService.log({
        eventType: 'AUTH_LOGIN',
        action: 'LOGIN_FAILED',
        status: 'DENIED',
        actorId: userRow.id,
        actorEmail: userRow.email,
        organizationId: userRow.organization_id,
        reason: 'Account is temporarily locked due to repeated failed attempts',
        ipAddress,
        userAgent,
      });
      throw new AuthenticationError(
        'Account is temporarily locked due to excessive failed attempts. Please try again later or contact an administrator.',
        423 // Locked
      );
    }

    // 5. Verify password hash
    const isValidPassword = await CryptoService.verifyPassword(
      userRow.password_hash,
      passwordPlain
    );

    if (!isValidPassword) {
      const nextFailed = userRow.failed_login_attempts + 1;
      let newLockedUntil: Date | null = null;

      if (nextFailed >= MAX_FAILED_ATTEMPTS) {
        newLockedUntil = new Date(now + LOCKOUT_DURATION_MS);
      }

      await pool.query(
        `UPDATE users
         SET failed_login_attempts = $1,
             locked_until = $2,
             updated_at = NOW()
         WHERE id = $3;`,
        [nextFailed, newLockedUntil, userRow.id]
      );

      await AuditService.log({
        eventType: nextFailed >= MAX_FAILED_ATTEMPTS ? 'AUTH_LOCKED' : 'AUTH_LOGIN',
        action: nextFailed >= MAX_FAILED_ATTEMPTS ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
        status: 'DENIED',
        actorId: userRow.id,
        actorEmail: userRow.email,
        organizationId: userRow.organization_id,
        reason:
          nextFailed >= MAX_FAILED_ATTEMPTS
            ? `Account locked after ${nextFailed} consecutive failed attempts`
            : `Invalid password (attempt ${nextFailed}/${MAX_FAILED_ATTEMPTS})`,
        ipAddress,
        userAgent,
      });

      throw new AuthenticationError('Invalid email or password.');
    }

    // 6. Reset failed attempts & unlock
    if (userRow.failed_login_attempts > 0 || userRow.locked_until !== null) {
      await pool.query(
        `UPDATE users
         SET failed_login_attempts = 0,
             locked_until = NULL,
             updated_at = NOW()
         WHERE id = $1;`,
        [userRow.id]
      );
    }

    // 7. Create server-side session
    const { sessionToken, expiresAt } = await SessionService.createSession(
      userRow.id,
      ipAddress,
      userAgent
    );

    const csrfToken = CryptoService.generateCsrfToken(sessionToken);

    await AuditService.log({
      eventType: 'AUTH_LOGIN',
      action: 'LOGIN_SUCCESS',
      status: 'ALLOWED',
      actorId: userRow.id,
      actorEmail: userRow.email,
      organizationId: userRow.organization_id,
      reason: 'Successful password authentication and session creation',
      ipAddress,
      userAgent,
    });

    const userContext: UserContext = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      role: userRow.role,
      organizationId: userRow.organization_id,
      isDisabled: userRow.is_disabled,
    };

    return {
      user: userContext,
      sessionToken,
      csrfToken,
      expiresAt,
    };
  }

  /**
   * Log out a user, destroying the server session row.
   */
  static async logout(
    rawSessionToken: string,
    user: UserContext,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await SessionService.deleteSession(rawSessionToken);

    await AuditService.log({
      eventType: 'AUTH_LOGOUT',
      action: 'LOGOUT_SUCCESS',
      status: 'ALLOWED',
      actorId: user.id,
      actorEmail: user.email,
      organizationId: user.organizationId,
      reason: 'User explicitly terminated session',
      ipAddress,
      userAgent,
    });
  }
}
