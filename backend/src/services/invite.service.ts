import { pool } from '../db/index.js';
import { AuthorizationService, AuthorizationError } from './authorization.service.js';
import { CryptoService } from './crypto.service.js';
import { AuditService } from './audit.service.js';
import { UserContext } from '../types/auth.js';

export interface ShareInviteRecord {
  id: string;
  documentId: string;
  email: string;
  permission: 'read' | 'edit';
  createdBy: string;
  expiresAt: Date;
  revokedAt: Date | null;
  usedAt: Date | null;
  createdAt: Date;
}

export class InviteService {
  /**
   * Create a single-purpose, expiring, per-recipient external share invite.
   * Owner-only. Token is hashed in DB; raw token returned once for secure delivery.
   */
  static async createInvite(
    owner: UserContext,
    documentId: string,
    recipientEmail: string,
    permission: 'read' | 'edit',
    expiresInHours = 72,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{ invite: ShareInviteRecord; rawToken: string }> {
    await AuthorizationService.authorize(owner, documentId, 'manage_grants', {
      ipAddress,
      userAgent,
    });

    const normalizedEmail = recipientEmail.trim().toLowerCase();
    const rawToken = CryptoService.generateRandomToken(32);
    const tokenHash = CryptoService.sha256(rawToken);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const res = await pool.query<{
      id: string;
      document_id: string;
      email: string;
      permission: 'read' | 'edit';
      created_by: string;
      expires_at: Date;
      revoked_at: Date | null;
      used_at: Date | null;
      created_at: Date;
    }>(
      `INSERT INTO share_invites (document_id, email, token_hash, permission, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [documentId, normalizedEmail, tokenHash, permission, owner.id, expiresAt]
    );

    const row = res.rows[0];

    await AuditService.log({
      eventType: 'SHARE_LINK',
      action: 'SHARE_LINK_CREATED',
      status: 'ALLOWED',
      actorId: owner.id,
      actorEmail: owner.email,
      organizationId: owner.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: `Owner issued share invite to '${normalizedEmail}' with '${permission}' (expires in ${expiresInHours}h)`,
      ipAddress,
      userAgent,
      payload: {
        documentId,
        recipientEmail: normalizedEmail,
        permission,
        expiresAt,
      },
    });

    return {
      invite: {
        id: row.id,
        documentId: row.document_id,
        email: row.email,
        permission: row.permission,
        createdBy: row.created_by,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        usedAt: row.used_at,
        createdAt: row.created_at,
      },
      rawToken,
    };
  }

  /**
   * List all share invites for a document. (Owner-only).
   */
  static async listInvites(
    owner: UserContext,
    documentId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<ShareInviteRecord[]> {
    await AuthorizationService.authorize(owner, documentId, 'manage_grants', {
      ipAddress,
      userAgent,
    });

    const res = await pool.query<{
      id: string;
      document_id: string;
      email: string;
      permission: 'read' | 'edit';
      created_by: string;
      expires_at: Date;
      revoked_at: Date | null;
      used_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, document_id, email, permission, created_by, expires_at, revoked_at, used_at, created_at
       FROM share_invites
       WHERE document_id = $1
       ORDER BY created_at DESC;`,
      [documentId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      email: row.email,
      permission: row.permission,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      usedAt: row.used_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * Revoke an active share invite immediately.
   * Owner-only. Prevents redemption if link was sent.
   */
  static async revokeInvite(
    owner: UserContext,
    documentId: string,
    inviteId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    await AuthorizationService.authorize(owner, documentId, 'manage_grants', {
      ipAddress,
      userAgent,
    });

    const res = await pool.query<{ id: string; email: string }>(
      `UPDATE share_invites
       SET revoked_at = NOW()
       WHERE id = $1 AND document_id = $2 AND revoked_at IS NULL
       RETURNING id, email;`,
      [inviteId, documentId]
    );

    if (res.rows.length === 0) {
      throw new AuthorizationError('Resource not found or access denied.', 404);
    }

    await AuditService.log({
      eventType: 'SHARE_LINK',
      action: 'SHARE_LINK_REVOKED',
      status: 'ALLOWED',
      actorId: owner.id,
      actorEmail: owner.email,
      organizationId: owner.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: `Owner revoked share invite for '${res.rows[0].email}'`,
      ipAddress,
      userAgent,
      payload: { documentId, inviteId },
    });
  }

  /**
   * Accept/redeem a share invite.
   * Recipient-bound: must be authenticated and email must match invite email.
   * Converts invite into an active grant on the document.
   */
  static async acceptInvite(
    rawToken: string,
    acceptingUser: UserContext,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{ documentId: string; permission: string; message: string }> {
    const tokenHash = CryptoService.sha256(rawToken);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query<{
        id: string;
        document_id: string;
        email: string;
        permission: 'read' | 'edit';
        created_by: string;
        expires_at: Date;
        revoked_at: Date | null;
        used_at: Date | null;
        organization_id: string;
      }>(
        `SELECT
           i.id, i.document_id, i.email, i.permission, i.created_by,
           i.expires_at, i.revoked_at, i.used_at, d.organization_id
         FROM share_invites i
         JOIN documents d ON i.document_id = d.id
         WHERE i.token_hash = $1
         FOR UPDATE;`,
        [tokenHash]
      );

      // Token not found, revoked, expired, or already used
      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        await AuditService.log({
          eventType: 'SHARE_LINK',
          action: 'SHARE_LINK_USE_FAILED',
          status: 'DENIED',
          actorId: acceptingUser.id,
          actorEmail: acceptingUser.email,
          reason: 'Attempted redemption with non-existent or invalid token',
          ipAddress,
          userAgent,
        });
        throw new AuthorizationError('Resource not found or access denied.', 404);
      }

      const invite = res.rows[0];

      // Check revoked
      if (invite.revoked_at !== null) {
        await client.query('ROLLBACK');
        await AuditService.log({
          eventType: 'SHARE_LINK',
          action: 'SHARE_LINK_USE_FAILED',
          status: 'DENIED',
          actorId: acceptingUser.id,
          actorEmail: acceptingUser.email,
          targetId: invite.document_id,
          reason: 'Attempted redemption of revoked share invite',
          ipAddress,
          userAgent,
        });
        throw new AuthorizationError('Resource not found or access denied.', 404);
      }

      // Check already used
      if (invite.used_at !== null) {
        await client.query('ROLLBACK');
        throw new AuthorizationError('Resource not found or access denied.', 404);
      }

      // Check expired
      if (Date.now() > new Date(invite.expires_at).getTime()) {
        await client.query('ROLLBACK');
        await AuditService.log({
          eventType: 'SHARE_LINK',
          action: 'SHARE_LINK_USE_FAILED',
          status: 'DENIED',
          actorId: acceptingUser.id,
          actorEmail: acceptingUser.email,
          targetId: invite.document_id,
          reason: 'Attempted redemption of expired share invite',
          ipAddress,
          userAgent,
        });
        throw new AuthorizationError('Resource not found or access denied.', 404);
      }

      // Recipient email binding verification
      if (invite.email.toLowerCase() !== acceptingUser.email.toLowerCase()) {
        await client.query('ROLLBACK');
        await AuditService.log({
          eventType: 'SHARE_LINK',
          action: 'SHARE_LINK_USE_FAILED',
          status: 'DENIED',
          actorId: acceptingUser.id,
          actorEmail: acceptingUser.email,
          targetId: invite.document_id,
          reason: `Recipient email mismatch (invite: ${invite.email}, actor: ${acceptingUser.email})`,
          ipAddress,
          userAgent,
        });
        throw new AuthorizationError('Resource not found or access denied.', 404);
      }

      // A valid invite cannot bridge workspace boundaries, even if its recipient
      // happens to have the same email address in a different organization.
      if (invite.organization_id !== acceptingUser.organizationId) {
        await client.query('ROLLBACK');
        await AuditService.log({
          eventType: 'SHARE_LINK',
          action: 'SHARE_LINK_USE_FAILED',
          status: 'DENIED',
          actorId: acceptingUser.id,
          actorEmail: acceptingUser.email,
          targetId: invite.document_id,
          reason: 'Attempted redemption of a share invite from another workspace',
          ipAddress,
          userAgent,
        });
        throw new AuthorizationError('Resource not found or access denied.', 404);
      }

      // Convert invite into active document grant
      await client.query(
        `INSERT INTO document_grants (document_id, user_id, permission, granted_by, grant_version)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (document_id, user_id) DO UPDATE
           SET permission = EXCLUDED.permission,
               updated_at = NOW();`,
        [invite.document_id, acceptingUser.id, invite.permission, invite.created_by]
      );

      // Mark invite as used
      await client.query('UPDATE share_invites SET used_at = NOW() WHERE id = $1;', [invite.id]);
      await client.query('COMMIT');

      await AuditService.log({
        eventType: 'SHARE_LINK',
        action: 'SHARE_LINK_USED',
        status: 'ALLOWED',
        actorId: acceptingUser.id,
        actorEmail: acceptingUser.email,
        organizationId: invite.organization_id,
        targetType: 'DOCUMENT',
        targetId: invite.document_id,
        reason: `User successfully redeemed invite and was granted '${invite.permission}' access`,
        ipAddress,
        userAgent,
        payload: { documentId: invite.document_id, permission: invite.permission },
      });

      return {
        documentId: invite.document_id,
        permission: invite.permission,
        message: `Successfully accepted invite. You now have '${invite.permission}' access to the document.`,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
