import { FastifyReply, FastifyRequest } from 'fastify';
import { SessionService } from '../services/session.service.js';
import { CryptoService } from '../services/crypto.service.js';
import { AuditService } from '../services/audit.service.js';
import { UserRole } from '../types/auth.js';

export const SESSION_COOKIE_NAME = 'trustvault_session';

/**
 * Authentication preHandler hook.
 * Extracts session from httpOnly cookie, validates against PostgreSQL, and decorates request.user.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const sessionToken = request.cookies[SESSION_COOKIE_NAME];

  if (!sessionToken) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required. Please log in.',
    });
  }

  const result = await SessionService.validateSession(sessionToken);

  if (!result) {
    // Clear invalid / expired cookie
    reply.clearCookie(SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.COOKIE_SAME_SITE === 'none' ? 'none' : 'strict',
    });

    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Session has expired or been revoked. Please log in again.',
    });
  }

  request.user = {
    ...result.user,
    sessionId: result.session.id,
  };

  request.csrfToken = CryptoService.generateCsrfToken(sessionToken);
}

/**
 * Role-guard preHandler factory.
 * Enforces role boundaries (e.g. only 'admin' or 'owner').
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required.',
      });
    }

    if (!allowedRoles.includes(request.user.role)) {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: 'INSUFFICIENT_ROLE',
        status: 'DENIED',
        actorId: request.user.id,
        actorEmail: request.user.email,
        organizationId: request.user.organizationId,
        reason: `Role '${request.user.role}' denied for endpoint requiring [${allowedRoles.join(', ')}]`,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have sufficient privileges to perform this action.',
      });
    }
  };
}

/**
 * CSRF verification preHandler hook for state-changing requests.
 * Compares X-CSRF-Token header against HMAC derived from session cookie.
 */
export async function verifyCsrf(request: FastifyRequest, reply: FastifyReply) {
  const method = request.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return;
  }

  const sessionToken = request.cookies[SESSION_COOKIE_NAME];
  if (!sessionToken) {
    // If there is no session token, let authentication handler deal with it
    return;
  }

  const providedCsrfToken = request.headers['x-csrf-token'];
  if (!providedCsrfToken || typeof providedCsrfToken !== 'string') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Missing CSRF protection token (X-CSRF-Token header required).',
    });
  }

  const isValid = CryptoService.verifyCsrfToken(sessionToken, providedCsrfToken);
  if (!isValid) {
    await AuditService.log({
      eventType: 'SECURITY_ALERT',
      action: 'CSRF_VALIDATION_FAILED',
      status: 'DENIED',
      actorId: request.user?.id || null,
      actorEmail: request.user?.email || null,
      reason: 'Provided X-CSRF-Token failed cryptographic verification against session',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Invalid CSRF protection token.',
    });
  }
}
