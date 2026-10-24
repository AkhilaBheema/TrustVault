import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../middleware/auth.js';
import { AuditService } from '../services/audit.service.js';
import { pool } from '../db/index.js';

/**
 * Audit admin routes — P6
 *
 * Security invariants:
 *  - Both endpoints require admin role (authenticated + role check).
 *  - SQL is scoped to the caller's organization_id — cross-tenant audit leaks impossible.
 *  - Hash fields (prev_hash, current_hash) are NEVER returned to the caller:
 *    knowing the latest hash would help an attacker craft a valid next row.
 *  - The verify endpoint only returns "valid / broken at seq N" — not the hashes.
 *  - All text fields are returned as-is; the React layer must escape them on render
 *    (do not inject into innerHTML without sanitization).
 */
export async function auditRoutes(app: FastifyInstance) {
  // 1. List audit events (admin-only, org-scoped, paginated)
  //    Supports filter params: status, eventType, actorId, targetId, fromDate, toDate
  app.get(
    '/api/admin/audit',
    { preHandler: [authenticate, requireRole('admin')] },
    async (request, reply) => {
      const admin = request.user!;
      const q = request.query as Record<string, string | undefined>;

      // --- Input validation & safe defaults ---
      const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize || '50', 10) || 50));
      const offset = (page - 1) * pageSize;

      // Whitelist allowed status values to prevent SQL injection via enum bypass
      const ALLOWED_STATUSES = new Set(['ALLOWED', 'DENIED', 'ERROR', 'INFO']);
      const statusFilter = q.status && ALLOWED_STATUSES.has(q.status) ? q.status : null;
      const ALLOWED_EVENT_TYPES = new Set([
        'ACCESS_DENIED', 'ACCESS_REQUEST', 'AI_SUGGESTION', 'AUTH_LOGIN', 'AUTH_LOGOUT',
        'DOCUMENT_LIFECYCLE', 'GRANT_LIFECYCLE', 'SECURITY_ALERT', 'SHARE_LINK', 'USER_ADMIN',
      ]);
      const eventTypeFilter = q.eventType && ALLOWED_EVENT_TYPES.has(q.eventType) ? q.eventType : null;

      // Only accept UUID-formatted actorId/targetId to prevent injection
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const actorIdFilter = q.actorId && UUID_RE.test(q.actorId) ? q.actorId : null;
      const targetIdFilter = q.targetId && UUID_RE.test(q.targetId) ? q.targetId : null;

      // Validate date strings — parseFloat handles "NaN" gracefully
      const fromDate = q.fromDate ? new Date(q.fromDate) : null;
      const toDate = q.toDate ? new Date(q.toDate) : null;
      const validFrom = fromDate && !isNaN(fromDate.getTime()) ? fromDate : null;
      const validTo = toDate && !isNaN(toDate.getTime()) ? toDate : null;

      // --- Parameterized SQL (all filters use $N placeholders) ---
      // Organization scope is always enforced at index position 1.
      const params: unknown[] = [admin.organizationId];
      let idx = 2; // next parameter index

      let conditions = 'WHERE ae.organization_id = $1';

      if (statusFilter) {
        conditions += ` AND ae.status = $${idx++}`;
        params.push(statusFilter);
      }
      if (eventTypeFilter) {
        conditions += ` AND ae.event_type = $${idx++}`;
        params.push(eventTypeFilter);
      }
      if (actorIdFilter) {
        conditions += ` AND ae.actor_id = $${idx++}`;
        params.push(actorIdFilter);
      }
      if (targetIdFilter) {
        conditions += ` AND ae.target_id = $${idx++}`;
        params.push(targetIdFilter);
      }
      if (validFrom) {
        conditions += ` AND ae.created_at >= $${idx++}`;
        params.push(validFrom);
      }
      if (validTo) {
        conditions += ` AND ae.created_at <= $${idx++}`;
        params.push(validTo);
      }

      // Count query (separate query to get total for pagination headers)
      const countRes = await pool.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM audit_events ae ${conditions};`,
        params
      );
      const total = parseInt(countRes.rows[0].total, 10);

      // Data query — NOTE: prev_hash and current_hash are intentionally excluded
      const dataParams = [...params, pageSize, offset];
      const dataRes = await pool.query<{
        id: string;
        sequence_number: string;
        event_type: string;
        actor_id: string | null;
        actor_email: string | null;
        organization_id: string | null;
        target_type: string | null;
        target_id: string | null;
        action: string;
        status: string;
        reason: string | null;
        ip_address: string | null;
        user_agent: string | null;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT
           ae.id, ae.sequence_number, ae.event_type,
           ae.actor_id, ae.actor_email, ae.organization_id,
           ae.target_type, ae.target_id,
           ae.action, ae.status, ae.reason,
           ae.ip_address, ae.user_agent, ae.payload, ae.created_at
         FROM audit_events ae
         ${conditions}
         ORDER BY ae.sequence_number DESC
         LIMIT $${idx++} OFFSET $${idx++};`,
        dataParams
      );

      return reply.status(200).send({
        events: dataRes.rows.map((row) => ({
          id: row.id,
          sequenceNumber: parseInt(row.sequence_number, 10),
          eventType: row.event_type,
          actorId: row.actor_id,
          // actor_email is returned — admins need to correlate events. Escape on display.
          actorEmail: row.actor_email,
          organizationId: row.organization_id,
          targetType: row.target_type,
          targetId: row.target_id,
          action: row.action,
          status: row.status,
          // reason field is escaped on the display layer, not here (escaping in API would break CSV export)
          reason: row.reason,
          ipAddress: row.ip_address,
          userAgent: row.user_agent,
          payload: row.payload,
          createdAt: row.created_at,
        })),
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      });
    }
  );

  // 2. Verify audit chain integrity (admin-only)
  //    Walks every row in sequence order, recomputes the SHA-256 hash chain,
  //    and reports the first break. Does NOT return hash values to the caller.
  app.get(
    '/api/admin/audit/verify',
    { preHandler: [authenticate, requireRole('admin')] },
    async (_request, reply) => {
      const result = await AuditService.verifyChainIntegrity();

      // Return chain health without exposing hash values
      return reply.status(200).send({
        isValid: result.isValid,
        totalRecords: result.totalRecords,
        // Only expose the sequence number of the first break, not any hash
        brokenAtSequence: result.brokenAtSequence ?? null,
        verifiedAt: new Date().toISOString(),
        message: result.isValid
          ? `Chain intact: all ${result.totalRecords} records verified.`
          : `Audit chain verification failed at sequence #${result.brokenAtSequence}.`,
      });
    }
  );
}
