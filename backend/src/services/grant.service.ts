import { pool } from '../db/index.js';
import { AuthorizationService } from './authorization.service.js';
import { AuditService } from './audit.service.js';
import { UserContext } from '../types/auth.js';

export interface GrantRecord {
  id: string;
  documentId: string;
  userId: string;
  userName: string;
  userEmail: string;
  permission: 'read' | 'edit';
  expiresAt: Date | null;
  grantVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export class GrantService {
  /**
   * List all explicit grants for a document (Who can see this?).
   * Only accessible if actor has access to the document.
   */
  static async listGrants(
    actor: UserContext,
    documentId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{ grants: GrantRecord[]; ownerInfo: { id: string; name: string; email: string } }> {
    const auth = await AuthorizationService.authorize(actor, documentId, 'read', {
      ipAddress,
      userAgent,
    });

    // Fetch owner information
    const ownerRes = await pool.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE id = $1;',
      [auth.document.ownerId]
    );

    const grantsRes = await pool.query<{
      id: string;
      document_id: string;
      user_id: string;
      name: string;
      email: string;
      permission: 'read' | 'edit';
      expires_at: Date | null;
      grant_version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT
         g.id,
         g.document_id,
         g.user_id,
         u.name,
         u.email,
         g.permission,
         g.expires_at,
         g.grant_version,
         g.created_at,
         g.updated_at
       FROM document_grants g
       JOIN users u ON g.user_id = u.id
       WHERE g.document_id = $1
       ORDER BY g.created_at ASC;`,
      [documentId]
    );

    return {
      ownerInfo: ownerRes.rows[0],
      grants: grantsRes.rows.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        userId: row.user_id,
        userName: row.name,
        userEmail: row.email,
        permission: row.permission,
        expiresAt: row.expires_at,
        grantVersion: row.grant_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  /**
   * Issue or modify a per-document grant.
   * Owner-only. Target user must reside in the same company.
   * Increments grant_version to immediately invalidate stale download tickets.
   */
  static async issueGrant(
    actor: UserContext,
    documentId: string,
    targetUserId: string,
    permission: 'read' | 'edit',
    expiresAt: Date | null,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<GrantRecord> {
    await AuthorizationService.authorize(actor, documentId, 'manage_grants', {
      ipAddress,
      userAgent,
    });

    // Verify target user belongs to the same organization
    const targetRes = await pool.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE id = $1 AND organization_id = $2;',
      [targetUserId, actor.organizationId]
    );

    if (targetRes.rows.length === 0) {
      throw new Error('Resource not found or access denied.');
    }

    const targetUser = targetRes.rows[0];

    const res = await pool.query<{
      id: string;
      document_id: string;
      user_id: string;
      permission: 'read' | 'edit';
      expires_at: Date | null;
      grant_version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO document_grants (document_id, user_id, permission, granted_by, expires_at, grant_version)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (document_id, user_id) DO UPDATE
         SET permission = EXCLUDED.permission,
             expires_at = EXCLUDED.expires_at,
             grant_version = document_grants.grant_version + 1,
             updated_at = NOW()
       RETURNING *;`,
      [documentId, targetUserId, permission, actor.id, expiresAt]
    );

    const grantRow = res.rows[0];

    await AuditService.log({
      eventType: 'GRANT_LIFECYCLE',
      action: 'GRANT_ISSUED',
      status: 'ALLOWED',
      actorId: actor.id,
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      targetType: 'USER',
      targetId: targetUserId,
      reason: `Owner granted '${permission}' on document to '${targetUser.email}' (expires: ${
        expiresAt ? expiresAt.toISOString() : 'never'
      })`,
      ipAddress,
      userAgent,
      payload: {
        documentId,
        targetEmail: targetUser.email,
        permission,
        expiresAt,
        grantVersion: grantRow.grant_version,
      },
    });

    return {
      id: grantRow.id,
      documentId: grantRow.document_id,
      userId: grantRow.user_id,
      userName: targetUser.name,
      userEmail: targetUser.email,
      permission: grantRow.permission,
      expiresAt: grantRow.expires_at,
      grantVersion: grantRow.grant_version,
      createdAt: grantRow.created_at,
      updatedAt: grantRow.updated_at,
    };
  }

  /**
   * Revoke a specific user's grant immediately.
   * Owner-only. Next request by that user will fail instantly.
   */
  static async revokeGrant(
    actor: UserContext,
    documentId: string,
    targetUserId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await AuthorizationService.authorize(actor, documentId, 'manage_grants', {
      ipAddress,
      userAgent,
    });

    const res = await pool.query<{ id: string }>(
      'DELETE FROM document_grants WHERE document_id = $1 AND user_id = $2 RETURNING id;',
      [documentId, targetUserId]
    );

    if (res.rows.length === 0) {
      throw new Error('Resource not found or access denied.');
    }

    await AuditService.log({
      eventType: 'GRANT_LIFECYCLE',
      action: 'GRANT_REVOKED',
      status: 'ALLOWED',
      actorId: actor.id,
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      targetType: 'USER',
      targetId: targetUserId,
      reason: `Owner revoked access grant for user on document`,
      ipAddress,
      userAgent,
      payload: { documentId, targetUserId },
    });
  }

  /**
   * One-click "Revoke All" emergency action: removes all active grants on a document.
   */
  static async revokeAllGrants(
    actor: UserContext,
    documentId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<number> {
    await AuthorizationService.authorize(actor, documentId, 'manage_grants', {
      ipAddress,
      userAgent,
    });

    const res = await pool.query(
      'DELETE FROM document_grants WHERE document_id = $1 RETURNING id;',
      [documentId]
    );

    const revokedCount = res.rowCount ?? 0;

    await AuditService.log({
      eventType: 'GRANT_LIFECYCLE',
      action: 'ALL_GRANTS_REVOKED',
      status: 'ALLOWED',
      actorId: actor.id,
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: `Emergency 'Revoke All' triggered by owner (${revokedCount} grants purged)`,
      ipAddress,
      userAgent,
      payload: { documentId, revokedCount },
    });

    return revokedCount;
  }
}
