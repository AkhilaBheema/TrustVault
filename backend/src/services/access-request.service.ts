import { pool } from '../db/index.js';
import { AuditService } from './audit.service.js';
import { UserContext } from '../types/auth.js';

export interface AccessRequestItem {
  id: string;
  documentId: string;
  documentTitle: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  targetPermission: 'read' | 'edit';
  status: 'pending' | 'approved' | 'denied';
  createdAt: Date;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AccessRequestService {
  /**
   * Submit an access request for a document.
   *
   * Security Invariant: Neutral response contract.
   * If document does not exist or belongs to another company, returns identical success message
   * so attackers cannot probe or enumerate document existence via access requests.
   */
  static async submitRequest(
    requester: UserContext,
    documentId: string,
    targetPermission: 'read' | 'edit' = 'read',
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{ message: string }> {
    const neutralResponse = {
      message: 'If this document exists, your access request has been forwarded to the owner.',
    };

    // 1. Guard against malformed UUIDs without throwing internal errors
    if (!documentId || !UUID_REGEX.test(documentId)) {
      return neutralResponse;
    }

    // 2. Fetch document matching tenant boundary
    const docRes = await pool.query<{ id: string; owner_id: string; title: string; is_deleted: boolean }>(
      'SELECT id, owner_id, title, is_deleted FROM documents WHERE id = $1 AND organization_id = $2;',
      [documentId, requester.organizationId]
    );

    // If document doesn't exist, is cross-tenant, or is soft-deleted: return neutral response
    if (docRes.rows.length === 0 || docRes.rows[0].is_deleted) {
      return neutralResponse;
    }

    const doc = docRes.rows[0];

    // If requester is already owner, nothing to request
    if (doc.owner_id === requester.id) {
      return { message: 'You are the owner of this document.' };
    }

    // 3. Upsert pending access request
    const existingReq = await pool.query<{ id: string }>(
      "SELECT id FROM access_requests WHERE document_id = $1 AND requester_id = $2 AND status = 'pending';",
      [documentId, requester.id]
    );

    if (existingReq.rows.length === 0) {
      await pool.query(
        `INSERT INTO access_requests (document_id, requester_id, target_permission, status)
         VALUES ($1, $2, $3, 'pending');`,
        [documentId, requester.id, targetPermission]
      );
    }

    await AuditService.log({
      eventType: 'ACCESS_REQUEST',
      action: 'ACCESS_REQUEST_SUBMITTED',
      status: 'INFO',
      actorId: requester.id,
      actorEmail: requester.email,
      organizationId: requester.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: `User submitted neutral access request for document '${doc.title}' with permission '${targetPermission}'`,
      ipAddress,
      userAgent,
      payload: { documentId, targetPermission },
    });

    return neutralResponse;
  }

  /**
   * List pending access requests for all documents owned by the caller. (Owner-only).
   */
  static async listPendingRequestsForOwner(owner: UserContext): Promise<AccessRequestItem[]> {
    const res = await pool.query<{
      id: string;
      document_id: string;
      document_title: string;
      requester_id: string;
      requester_name: string;
      requester_email: string;
      target_permission: 'read' | 'edit';
      status: 'pending' | 'approved' | 'denied';
      created_at: Date;
    }>(
      `SELECT
         r.id,
         r.document_id,
         d.title AS document_title,
         r.requester_id,
         u.name AS requester_name,
         u.email AS requester_email,
         r.target_permission,
         r.status,
         r.created_at
       FROM access_requests r
       JOIN documents d ON r.document_id = d.id
       JOIN users u ON r.requester_id = u.id
       WHERE d.owner_id = $1 AND d.organization_id = $2 AND r.status = 'pending'
       ORDER BY r.created_at DESC;`,
      [owner.id, owner.organizationId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      requesterId: row.requester_id,
      requesterName: row.requester_name,
      requesterEmail: row.requester_email,
      targetPermission: row.target_permission,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /**
   * Owner reviews (approves or denies) an access request.
   * Approval issues a grant in document_grants with chosen expiry.
   */
  static async reviewRequest(
    owner: UserContext,
    requestId: string,
    decision: 'approve' | 'deny',
    permission: 'read' | 'edit',
    expiresAt: Date | null,
    reviewerNotes: string | null,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{ status: 'approved' | 'denied'; message: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query<{
        id: string;
        document_id: string;
        requester_id: string;
        requester_email: string;
        document_title: string;
        status: string;
      }>(
        `SELECT
           r.id, r.document_id, r.requester_id, u.email AS requester_email,
           d.title AS document_title, r.status
         FROM access_requests r
         JOIN documents d ON r.document_id = d.id
         JOIN users u ON r.requester_id = u.id
         WHERE r.id = $1 AND d.owner_id = $2 AND d.organization_id = $3
         FOR UPDATE;`,
        [requestId, owner.id, owner.organizationId]
      );

      if (res.rows.length === 0 || res.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        throw new Error('Resource not found or access denied.');
      }

      const req = res.rows[0];

      if (decision === 'approve') {
        // Issue or update explicit document grant
        await client.query(
          `INSERT INTO document_grants (document_id, user_id, permission, granted_by, expires_at, grant_version)
           VALUES ($1, $2, $3, $4, $5, 1)
           ON CONFLICT (document_id, user_id) DO UPDATE
             SET permission = EXCLUDED.permission,
                 expires_at = EXCLUDED.expires_at,
                 grant_version = document_grants.grant_version + 1,
                 updated_at = NOW();`,
          [req.document_id, req.requester_id, permission, owner.id, expiresAt]
        );

        // Update request record
        await client.query(
          `UPDATE access_requests
           SET status = 'approved',
               reviewed_by = $1,
               reviewed_at = NOW(),
               reviewer_notes = $2
           WHERE id = $3;`,
          [owner.id, reviewerNotes, requestId]
        );

        await AuditService.log({
          eventType: 'ACCESS_REQUEST',
          action: 'ACCESS_REQUEST_APPROVED',
          status: 'ALLOWED',
          actorId: owner.id,
          actorEmail: owner.email,
          organizationId: owner.organizationId,
          targetType: 'DOCUMENT',
          targetId: req.document_id,
          reason: `Owner approved access request for '${req.requester_email}' with '${permission}' (expires: ${
            expiresAt ? expiresAt.toISOString() : 'never'
          })`,
          ipAddress,
          userAgent,
          payload: {
            requestId,
            requesterId: req.requester_id,
            permission,
            expiresAt,
            notes: reviewerNotes,
          },
        });

        await client.query('COMMIT');
        return {
          status: 'approved',
          message: `Access request approved. '${permission}' grant issued to ${req.requester_email}.`,
        };
      } else {
        // Decision: Deny
        await client.query(
          `UPDATE access_requests
           SET status = 'denied',
               reviewed_by = $1,
               reviewed_at = NOW(),
               reviewer_notes = $2
           WHERE id = $3;`,
          [owner.id, reviewerNotes, requestId]
        );

        await AuditService.log({
          eventType: 'ACCESS_REQUEST',
          action: 'ACCESS_REQUEST_DENIED',
          status: 'ALLOWED',
          actorId: owner.id,
          actorEmail: owner.email,
          organizationId: owner.organizationId,
          targetType: 'DOCUMENT',
          targetId: req.document_id,
          reason: `Owner denied access request for '${req.requester_email}'`,
          ipAddress,
          userAgent,
          payload: { requestId, requesterId: req.requester_id, notes: reviewerNotes },
        });

        await client.query('COMMIT');
        return {
          status: 'denied',
          message: `Access request denied.`,
        };
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
