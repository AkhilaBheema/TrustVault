import { pool } from '../db/index.js';
import { AuditService } from './audit.service.js';
import { UserContext } from '../types/auth.js';

export type DocumentAction =
  | 'read'
  | 'preview'
  | 'download'
  | 'edit'
  | 'manage_grants'
  | 'delete'
  | 'restore'
  | 'purge';

export interface AuthorizeResult {
  allowed: boolean;
  document: {
    id: string;
    organizationId: string;
    ownerId: string;
    title: string;
    category: string;
    isDeleted: boolean;
  };
  effectivePermission: 'owner' | 'edit' | 'read';
  grantVersion: number;
}

export class AuthorizationError extends Error {
  statusCode: number;
  constructor(message = 'Resource not found or access denied.', statusCode = 404) {
    super(message);
    this.name = 'AuthorizationError';
    this.statusCode = statusCode;
  }
}

// UUID validation regex (RFC 4122)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuthorizationService {
  /**
   * The ONE authorization chokepoint.
   * Every route touching documents, versions, previews, downloads, grants, or share links MUST call it.
   *
   * Invariants enforced:
   * 1. Default Deny.
   * 2. Zero Existence Leaks: Deny and unknown documents return identical 404 errors.
   * 3. Multi-Tenant Isolation: Cross-company access is strictly denied.
   * 4. Separation of Duties: Administrators CANNOT read/download document contents without an explicit grant.
   * 5. Grant Expiry Enforced at Check Time: Expired grants fail immediately.
   * 6. Every denied attempt is logged to the tamper-evident audit trail with actor, target, IP, and reason.
   */
  static async authorize(
    actor: UserContext,
    documentId: string,
    action: DocumentAction,
    context?: { ipAddress?: string | null; userAgent?: string | null }
  ): Promise<AuthorizeResult> {
    const ipAddress = context?.ipAddress || null;
    const userAgent = context?.userAgent || null;

    // 1. Guard against malformed UUIDs without leaking syntax errors
    if (!documentId || typeof documentId !== 'string' || !UUID_REGEX.test(documentId)) {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: null,
        reason: 'Malformed document identifier format',
        ipAddress,
        userAgent,
        payload: { attemptedId: documentId, action },
      });
      throw new AuthorizationError();
    }

    // 2. Fetch document record
    const docRes = await pool.query<{
      id: string;
      organization_id: string;
      owner_id: string;
      title: string;
      category: string;
      is_deleted: boolean;
      deleted_at: Date | null;
      purge_at: Date | null;
    }>('SELECT id, organization_id, owner_id, title, category, is_deleted, deleted_at, purge_at FROM documents WHERE id = $1;', [
      documentId,
    ]);

    // 3. Document does not exist OR belongs to another tenant (Tenant Isolation)
    if (docRes.rows.length === 0 || docRes.rows[0].organization_id !== actor.organizationId) {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason:
          docRes.rows.length === 0
            ? 'Document not found'
            : 'Cross-tenant boundary access violation',
        ipAddress,
        userAgent,
        payload: { action },
      });
      throw new AuthorizationError();
    }

    const doc = docRes.rows[0];

    // 4. Soft-deleted documents handling
    if (doc.is_deleted) {
      // Only the owner performing restore or purge can touch a soft-deleted document
      if ((action === 'restore' || action === 'purge') && doc.owner_id === actor.id) {
        return {
          allowed: true,
          document: {
            id: doc.id,
            organizationId: doc.organization_id,
            ownerId: doc.owner_id,
            title: doc.title,
            category: doc.category,
            isDeleted: doc.is_deleted,
          },
          effectivePermission: 'owner',
          grantVersion: 1,
        };
      }

      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: 'Attempted access on soft-deleted document',
        ipAddress,
        userAgent,
        payload: { action },
      });
      throw new AuthorizationError();
    }

    // 5. Document Owner has full privileges over non-deleted documents
    if (doc.owner_id === actor.id) {
      return {
        allowed: true,
        document: {
          id: doc.id,
          organizationId: doc.organization_id,
          ownerId: doc.owner_id,
          title: doc.title,
          category: doc.category,
          isDeleted: doc.is_deleted,
        },
        effectivePermission: 'owner',
        grantVersion: 1,
      };
    }

    // 6. Non-owners cannot delete, restore, purge, or manage grants
    if (action === 'delete' || action === 'restore' || action === 'purge' || action === 'manage_grants') {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `Actor is not document owner; action '${action}' denied`,
        ipAddress,
        userAgent,
        payload: { action, role: actor.role },
      });
      throw new AuthorizationError();
    }

    // 7. Check explicit grants in PostgreSQL (Separation of duties: Admins and Viewers MUST have an active grant)
    const grantRes = await pool.query<{
      id: string;
      permission: 'read' | 'edit';
      expires_at: Date | null;
      grant_version: number;
    }>(
      `SELECT id, permission, expires_at, grant_version
       FROM document_grants
       WHERE document_id = $1 AND user_id = $2;`,
      [documentId, actor.id]
    );

    // No grant exists for this actor
    if (grantRes.rows.length === 0) {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `No active grant for actor on document (Separation of Duties enforced for role: ${actor.role})`,
        ipAddress,
        userAgent,
        payload: { action, role: actor.role },
      });
      throw new AuthorizationError();
    }

    const grant = grantRes.rows[0];

    // 8. Automatic grant expiry enforcement at check time (not reliant on background cron)
    if (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= Date.now()) {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `Grant has expired (expired at: ${new Date(grant.expires_at).toISOString()})`,
        ipAddress,
        userAgent,
        payload: { action, expiresAt: grant.expires_at },
      });
      throw new AuthorizationError();
    }

    // 9. Permission level matching
    // 'edit' allows read, preview, download, and edit
    // 'read' allows read, preview, and download
    if (action === 'edit' && grant.permission !== 'edit') {
      await AuditService.log({
        eventType: 'ACCESS_DENIED',
        action: `DENIED_${action.toUpperCase()}`,
        status: 'DENIED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `Grant permission '${grant.permission}' insufficient for action '${action}'`,
        ipAddress,
        userAgent,
        payload: { action, grantPermission: grant.permission },
      });
      throw new AuthorizationError();
    }

    // Grant is valid and covers action!
    return {
      allowed: true,
      document: {
        id: doc.id,
        organizationId: doc.organization_id,
        ownerId: doc.owner_id,
        title: doc.title,
        category: doc.category,
        isDeleted: doc.is_deleted,
      },
      effectivePermission: grant.permission,
      grantVersion: grant.grant_version,
    };
  }
}
