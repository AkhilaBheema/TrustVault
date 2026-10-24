import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { authenticate, requireRole, verifyCsrf } from '../middleware/auth.js';
import { CryptoService } from '../services/crypto.service.js';
import { SessionService } from '../services/session.service.js';
import { AuditService } from '../services/audit.service.js';

const createUserSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  name: z.string().trim().min(2, 'Name must be at least 2 characters'),
  role: z.enum(['admin', 'owner', 'viewer']),
  initialPassword: z.string().min(12, 'Password must be at least 12 characters'),
});

const updateUserStatusSchema = z.object({
  isDisabled: z.boolean(),
});

export async function adminRoutes(app: FastifyInstance) {
  // Pre-handler hook bundle for all admin endpoints:
  // 1. Must be authenticated
  // 2. Must possess 'admin' role
  // 3. Must pass CSRF check on mutating requests
  const adminGuards = [authenticate, requireRole('admin'), verifyCsrf];

  // 1. List Users in Admin's Organization
  app.get('/api/admin/users', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const admin = request.user!;

    // SQL scoped strictly to caller's organization to prevent cross-tenant discovery
    const res = await pool.query<{
      id: string;
      email: string;
      name: string;
      role: string;
      is_disabled: boolean;
      failed_login_attempts: number;
      locked_until: Date | null;
      created_at: Date;
      updated_at: Date;
      active_sessions_count: string;
    }>(
      `SELECT
         u.id,
         u.email,
         u.name,
         u.role,
         u.is_disabled,
         u.failed_login_attempts,
         u.locked_until,
         u.created_at,
         u.updated_at,
         COUNT(s.id)::int AS active_sessions_count
       FROM users u
       LEFT JOIN sessions s ON u.id = s.user_id AND s.expires_at > NOW()
       WHERE u.organization_id = $1
       GROUP BY u.id
       ORDER BY u.created_at ASC;`,
      [admin.organizationId]
    );

    return reply.status(200).send({
      users: res.rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        isDisabled: row.is_disabled,
        failedLoginAttempts: row.failed_login_attempts,
        lockedUntil: row.locked_until,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        activeSessionsCount: parseInt(row.active_sessions_count, 10),
      })),
    });
  });

  // 2. Create User within Admin's Organization
  app.post('/api/admin/users', { preHandler: adminGuards }, async (request, reply) => {
    const admin = request.user!;

    const parseResult = createUserSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: parseResult.error.errors[0]?.message || 'Invalid user data',
      });
    }

    const { email, name, role, initialPassword } = parseResult.data;
    const normalizedEmail = email.toLowerCase();

    // Check email uniqueness
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1;', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'A user with this email address already exists.',
      });
    }

    const passwordHash = await CryptoService.hashPassword(initialPassword);

    const insertRes = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at;`,
      [admin.organizationId, normalizedEmail, passwordHash, name, role]
    );

    const newUser = insertRes.rows[0];

    await AuditService.log({
      eventType: 'USER_ADMIN',
      action: 'USER_CREATED',
      status: 'ALLOWED',
      actorId: admin.id,
      actorEmail: admin.email,
      organizationId: admin.organizationId,
      targetType: 'USER',
      targetId: newUser.id,
      reason: `Admin created user '${normalizedEmail}' with role '${role}'`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
      payload: { email: normalizedEmail, role, name },
    });

    return reply.status(201).send({
      id: newUser.id,
      email: normalizedEmail,
      name,
      role,
      organizationId: admin.organizationId,
      isDisabled: false,
      createdAt: newUser.created_at,
    });
  });

  // 3. Disable / Enable User (Admin cannot disable self)
  app.patch('/api/admin/users/:id/status', { preHandler: adminGuards }, async (request, reply) => {
    const admin = request.user!;
    const { id: targetUserId } = request.params as { id: string };

    const parseResult = updateUserStatusSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: parseResult.error.errors[0]?.message || 'Invalid status parameter',
      });
    }

    const { isDisabled } = parseResult.data;

    // Self-disablement prevention
    if (admin.id === targetUserId && isDisabled) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Administrators cannot disable their own account.',
      });
    }

    // Tenant-isolated update
    const res = await pool.query<{ id: string; email: string }>(
      `UPDATE users
       SET is_disabled = $1,
           updated_at = NOW()
       WHERE id = $2 AND organization_id = $3
       RETURNING id, email;`,
      [isDisabled, targetUserId, admin.organizationId]
    );

    if (res.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    const targetUser = res.rows[0];

    // If disabled, immediately purge all active sessions
    let revokedSessionsCount = 0;
    if (isDisabled) {
      revokedSessionsCount = await SessionService.revokeAllUserSessions(targetUserId);
    }

    await AuditService.log({
      eventType: 'USER_ADMIN',
      action: isDisabled ? 'USER_DISABLED' : 'USER_ENABLED',
      status: 'ALLOWED',
      actorId: admin.id,
      actorEmail: admin.email,
      organizationId: admin.organizationId,
      targetType: 'USER',
      targetId: targetUserId,
      reason: isDisabled
        ? `User disabled by admin; ${revokedSessionsCount} active sessions terminated`
        : 'User re-enabled by admin',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
      payload: { isDisabled, revokedSessionsCount },
    });

    return reply.status(200).send({
      id: targetUser.id,
      email: targetUser.email,
      isDisabled,
      revokedSessionsCount,
      message: isDisabled
        ? 'User has been disabled and all active sessions were immediately revoked.'
        : 'User has been enabled.',
    });
  });

  // 4. Force Revoke All Sessions for User
  app.post('/api/admin/users/:id/force-logout', { preHandler: adminGuards }, async (request, reply) => {
    const admin = request.user!;
    const { id: targetUserId } = request.params as { id: string };

    // Verify user belongs to same tenant
    const targetCheck = await pool.query('SELECT id, email FROM users WHERE id = $1 AND organization_id = $2;', [
      targetUserId,
      admin.organizationId,
    ]);

    if (targetCheck.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    const count = await SessionService.revokeAllUserSessions(targetUserId);

    await AuditService.log({
      eventType: 'USER_ADMIN',
      action: 'SESSIONS_FORCE_REVOKED',
      status: 'ALLOWED',
      actorId: admin.id,
      actorEmail: admin.email,
      organizationId: admin.organizationId,
      targetType: 'USER',
      targetId: targetUserId,
      reason: `Admin force-revoked all ${count} active sessions for user`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
      payload: { revokedSessionsCount: count },
    });

    return reply.status(200).send({
      id: targetUserId,
      revokedSessionsCount: count,
      message: `Successfully revoked ${count} active session(s).`,
    });
  });

  // 5. Unlock Locked User Account
  app.post('/api/admin/users/:id/unlock', { preHandler: adminGuards }, async (request, reply) => {
    const admin = request.user!;
    const { id: targetUserId } = request.params as { id: string };

    const res = await pool.query<{ id: string; email: string }>(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING id, email;`,
      [targetUserId, admin.organizationId]
    );

    if (res.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    await AuditService.log({
      eventType: 'USER_ADMIN',
      action: 'USER_UNLOCKED',
      status: 'ALLOWED',
      actorId: admin.id,
      actorEmail: admin.email,
      organizationId: admin.organizationId,
      targetType: 'USER',
      targetId: targetUserId,
      reason: 'Admin cleared login failure lockout for user',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    return reply.status(200).send({
      id: targetUserId,
      message: 'User account has been successfully unlocked and failed login counter reset.',
    });
  });
}
