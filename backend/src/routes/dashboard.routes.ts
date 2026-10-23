import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../middleware/auth.js';
import { pool } from '../db/index.js';

/**
 * Admin dashboard, activity timeline, and CSV export routes — P7
 *
 * Security invariants:
 *  - All endpoints: admin-only + org-scoped (organization_id = $1 always first param).
 *  - CSV export: every field value is sanitized to prevent CSV injection
 *    (values starting with =, +, -, @, TAB, CR are prefixed with a single quote).
 *  - Activity timelines: org-scope enforced before fetching user/doc details.
 *  - Alert thresholds are configurable via constants (no hard-coded magic numbers in SQL).
 *  - Pagination on all list endpoints: max 200 rows per page.
 */

// Alert thresholds (adjust these to tune sensitivity)
const ALERTS = {
  BULK_DOWNLOAD_THRESHOLD: 10,       // downloads by one user in the last hour
  REPEATED_DENIAL_THRESHOLD: 5,      // denied attempts by one user in last 30 minutes
  OFF_HOURS_START: 0,                // midnight UTC
  OFF_HOURS_END: 6,                  // 6am UTC
  QUICK_REVOKE_MINUTES: 5,           // grant created then revoked within this many minutes
  NEW_IP_LOOKBACK_DAYS: 30,          // compare login IP against last N days
};

export async function dashboardRoutes(app: FastifyInstance) {

  // 1. "Needs Attention" Alert Dashboard
  //    Computes several risk signals using aggregate SQL queries,
  //    all scoped to the admin's organization.
  app.get(
    '/api/admin/dashboard',
    { preHandler: [authenticate, requireRole('admin')] },
    async (request, reply) => {
      const admin = request.user!;
      const orgId = admin.organizationId;

      // --- Alert 1: Bulk downloads by a single user in last 1 hour ---
      const bulkDownloads = await pool.query<{
        actor_email: string;
        actor_id: string;
        download_count: string;
        latest_at: Date;
      }>(
        `SELECT actor_email, actor_id, COUNT(*) AS download_count, MAX(created_at) AS latest_at
         FROM audit_events
         WHERE organization_id = $1
           AND action = 'DOCUMENT_DOWNLOAD'
           AND status = 'ALLOWED'
           AND created_at >= NOW() - INTERVAL '1 hour'
         GROUP BY actor_email, actor_id
         HAVING COUNT(*) >= $2
         ORDER BY download_count DESC;`,
        [orgId, ALERTS.BULK_DOWNLOAD_THRESHOLD]
      );

      // --- Alert 2: Repeated denied attempts by a single user in last 30 minutes ---
      const repeatedDenials = await pool.query<{
        actor_email: string;
        actor_id: string;
        denial_count: string;
        latest_at: Date;
      }>(
        `SELECT actor_email, actor_id, COUNT(*) AS denial_count, MAX(created_at) AS latest_at
         FROM audit_events
         WHERE organization_id = $1
           AND status = 'DENIED'
           AND created_at >= NOW() - INTERVAL '30 minutes'
           AND actor_id IS NOT NULL
         GROUP BY actor_email, actor_id
         HAVING COUNT(*) >= $2
         ORDER BY denial_count DESC;`,
        [orgId, ALERTS.REPEATED_DENIAL_THRESHOLD]
      );

      // --- Alert 3: Access events outside normal hours (midnight–6am UTC) ---
      const offHoursAccess = await pool.query<{
        actor_email: string;
        actor_id: string;
        event_count: string;
        hour_of_day: string;
        latest_at: Date;
      }>(
        `SELECT actor_email, actor_id,
                COUNT(*) AS event_count,
                EXTRACT(HOUR FROM created_at)::int AS hour_of_day,
                MAX(created_at) AS latest_at
         FROM audit_events
         WHERE organization_id = $1
           AND status = 'ALLOWED'
           AND created_at >= NOW() - INTERVAL '24 hours'
           AND EXTRACT(HOUR FROM created_at) BETWEEN $2 AND $3
           AND actor_id IS NOT NULL
         GROUP BY actor_email, actor_id, hour_of_day
         ORDER BY event_count DESC
         LIMIT 20;`,
        [orgId, ALERTS.OFF_HOURS_START, ALERTS.OFF_HOURS_END]
      );

      // --- Alert 4: Grants created then revoked within QUICK_REVOKE_MINUTES (suspicious pattern) ---
      const quickRevokes = await pool.query<{
        target_id: string;
        grant_created_at: Date;
        revoke_created_at: Date;
        actor_email: string;
        minutes_elapsed: string;
      }>(
        `SELECT
           g.target_id,
           g.created_at AS grant_created_at,
           r.created_at AS revoke_created_at,
           g.actor_email,
           EXTRACT(EPOCH FROM (r.created_at - g.created_at)) / 60 AS minutes_elapsed
         FROM audit_events g
         JOIN audit_events r
           ON g.target_id = r.target_id
          AND g.organization_id = r.organization_id
         WHERE g.organization_id = $1
           AND g.action IN ('GRANT_ISSUED', 'GRANT_UPDATED')
           AND r.action = 'GRANT_REVOKED'
           AND r.created_at > g.created_at
           AND EXTRACT(EPOCH FROM (r.created_at - g.created_at)) / 60 <= $2
           AND g.created_at >= NOW() - INTERVAL '24 hours'
         ORDER BY g.created_at DESC
         LIMIT 20;`,
        [orgId, ALERTS.QUICK_REVOKE_MINUTES]
      );

      // --- Alert 5: Logins from previously unseen IP addresses (last 30 days baseline) ---
      // Strategy: find successful logins whose IP has not appeared in any
      // prior successful login event for that actor in the last 30 days.
      const newIpLogins = await pool.query<{
        actor_email: string;
        actor_id: string;
        ip_address: string;
        first_seen_at: Date;
      }>(
        `SELECT DISTINCT ON (actor_id, ip_address)
           actor_email, actor_id, ip_address, created_at AS first_seen_at
         FROM audit_events
         WHERE organization_id = $1
           AND action = 'LOGIN_SUCCESS'
           AND status = 'ALLOWED'
           AND ip_address IS NOT NULL
           AND created_at >= NOW() - INTERVAL '24 hours'
           AND (actor_id, ip_address) NOT IN (
             SELECT actor_id, ip_address
             FROM audit_events
             WHERE organization_id = $1
               AND action = 'LOGIN_SUCCESS'
               AND status = 'ALLOWED'
               AND created_at < NOW() - INTERVAL '1 hour'
               AND created_at >= NOW() - INTERVAL '30 days'
               AND actor_id IS NOT NULL
               AND ip_address IS NOT NULL
           )
         ORDER BY actor_id, ip_address, first_seen_at DESC
         LIMIT 20;`,
        [orgId]
      );

      // --- Alert 6: Expired-but-used token attempts ---
      const expiredTokenAttempts = await pool.query<{
        actor_email: string;
        actor_id: string;
        attempt_count: string;
        latest_at: Date;
      }>(
        `SELECT actor_email, actor_id, COUNT(*) AS attempt_count, MAX(created_at) AS latest_at
         FROM audit_events
         WHERE organization_id = $1
           AND status = 'DENIED'
           AND reason ILIKE '%expired%'
           AND created_at >= NOW() - INTERVAL '24 hours'
           AND actor_id IS NOT NULL
         GROUP BY actor_email, actor_id
         ORDER BY attempt_count DESC
         LIMIT 20;`,
        [orgId]
      );

      return reply.status(200).send({
        generatedAt: new Date().toISOString(),
        alerts: {
          bulkDownloads: bulkDownloads.rows.map((r) => ({
            actorEmail: r.actor_email,
            actorId: r.actor_id,
            downloadCount: parseInt(r.download_count, 10),
            latestAt: r.latest_at,
            threshold: ALERTS.BULK_DOWNLOAD_THRESHOLD,
            label: `Bulk download: ${r.download_count} downloads in last hour`,
          })),
          repeatedDenials: repeatedDenials.rows.map((r) => ({
            actorEmail: r.actor_email,
            actorId: r.actor_id,
            denialCount: parseInt(r.denial_count, 10),
            latestAt: r.latest_at,
            label: `Repeated access denials: ${r.denial_count} in last 30 minutes`,
          })),
          offHoursAccess: offHoursAccess.rows.map((r) => ({
            actorEmail: r.actor_email,
            actorId: r.actor_id,
            eventCount: parseInt(r.event_count, 10),
            hourOfDay: parseInt(r.hour_of_day, 10),
            latestAt: r.latest_at,
            label: `Off-hours access at ${r.hour_of_day}:00 UTC`,
          })),
          quickRevokes: quickRevokes.rows.map((r) => ({
            documentId: r.target_id,
            actorEmail: r.actor_email,
            grantCreatedAt: r.grant_created_at,
            revokedAt: r.revoke_created_at,
            minutesElapsed: parseFloat(r.minutes_elapsed).toFixed(1),
            label: `Grant created and revoked within ${r.minutes_elapsed} minutes`,
          })),
          newIpLogins: newIpLogins.rows.map((r) => ({
            actorEmail: r.actor_email,
            actorId: r.actor_id,
            ipAddress: r.ip_address,
            firstSeenAt: r.first_seen_at,
            label: `Login from new IP: ${r.ip_address}`,
          })),
          expiredTokenAttempts: expiredTokenAttempts.rows.map((r) => ({
            actorEmail: r.actor_email,
            actorId: r.actor_id,
            attemptCount: parseInt(r.attempt_count, 10),
            latestAt: r.latest_at,
            label: `${r.attempt_count} expired token usage attempt(s)`,
          })),
        },
      });
    }
  );

  // 2. Activity Timeline: per Document
  app.get(
    '/api/admin/activity/document/:docId',
    { preHandler: [authenticate, requireRole('admin')] },
    async (request, reply) => {
      const admin = request.user!;
      const { docId } = request.params as { docId: string };
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize || '50', 10) || 50));
      const offset = (page - 1) * pageSize;

      // Org-scope: verify document belongs to admin's org before returning events
      const docCheck = await pool.query<{ id: string }>(
        'SELECT id FROM documents WHERE id = $1 AND organization_id = $2;',
        [docId, admin.organizationId]
      );

      if (docCheck.rows.length === 0) {
        // Same 404 body as everywhere else — no existence leak
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found or access denied.',
        });
      }

      const res = await pool.query<{
        id: string;
        sequence_number: string;
        event_type: string;
        actor_email: string | null;
        action: string;
        status: string;
        reason: string | null;
        ip_address: string | null;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT id, sequence_number, event_type, actor_email, action,
                status, reason, ip_address, payload, created_at
         FROM audit_events
         WHERE organization_id = $1
           AND target_id = $2
         ORDER BY sequence_number DESC
         LIMIT $3 OFFSET $4;`,
        [admin.organizationId, docId, pageSize, offset]
      );

      const countRes = await pool.query<{ total: string }>(
        'SELECT COUNT(*) AS total FROM audit_events WHERE organization_id = $1 AND target_id = $2;',
        [admin.organizationId, docId]
      );

      return reply.status(200).send({
        events: res.rows,
        pagination: {
          page, pageSize,
          total: parseInt(countRes.rows[0].total, 10),
          totalPages: Math.ceil(parseInt(countRes.rows[0].total, 10) / pageSize),
        },
      });
    }
  );

  // 3. Activity Timeline: per User
  app.get(
    '/api/admin/activity/user/:userId',
    { preHandler: [authenticate, requireRole('admin')] },
    async (request, reply) => {
      const admin = request.user!;
      const { userId } = request.params as { userId: string };
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize || '50', 10) || 50));
      const offset = (page - 1) * pageSize;

      // Org-scope: verify user belongs to admin's org
      const userCheck = await pool.query<{ id: string }>(
        'SELECT id FROM users WHERE id = $1 AND organization_id = $2;',
        [userId, admin.organizationId]
      );

      if (userCheck.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found or access denied.',
        });
      }

      const res = await pool.query<{
        id: string;
        sequence_number: string;
        event_type: string;
        target_type: string | null;
        target_id: string | null;
        action: string;
        status: string;
        reason: string | null;
        ip_address: string | null;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT id, sequence_number, event_type, target_type, target_id,
                action, status, reason, ip_address, payload, created_at
         FROM audit_events
         WHERE organization_id = $1
           AND actor_id = $2
         ORDER BY sequence_number DESC
         LIMIT $3 OFFSET $4;`,
        [admin.organizationId, userId, pageSize, offset]
      );

      const countRes = await pool.query<{ total: string }>(
        'SELECT COUNT(*) AS total FROM audit_events WHERE organization_id = $1 AND actor_id = $2;',
        [admin.organizationId, userId]
      );

      return reply.status(200).send({
        events: res.rows,
        pagination: {
          page, pageSize,
          total: parseInt(countRes.rows[0].total, 10),
          totalPages: Math.ceil(parseInt(countRes.rows[0].total, 10) / pageSize),
        },
      });
    }
  );

  // 4. CSV Export of Audit Events (CSV-injection-safe)
  //    Supports the same query filters as /api/admin/audit.
  //    SECURITY: Every cell value is sanitized with csvSanitize() before writing.
  app.get(
    '/api/admin/audit/export',
    { preHandler: [authenticate, requireRole('admin')] },
    async (request, reply) => {
      const admin = request.user!;
      const q = request.query as Record<string, string | undefined>;

      const ALLOWED_STATUSES = new Set(['ALLOWED', 'DENIED', 'ERROR', 'INFO']);
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      const statusFilter = q.status && ALLOWED_STATUSES.has(q.status) ? q.status : null;
      const actorIdFilter = q.actorId && UUID_RE.test(q.actorId) ? q.actorId : null;
      const targetIdFilter = q.targetId && UUID_RE.test(q.targetId) ? q.targetId : null;
      const fromDate = q.fromDate ? new Date(q.fromDate) : null;
      const toDate = q.toDate ? new Date(q.toDate) : null;
      const validFrom = fromDate && !isNaN(fromDate.getTime()) ? fromDate : null;
      const validTo = toDate && !isNaN(toDate.getTime()) ? toDate : null;

      const params: unknown[] = [admin.organizationId];
      let idx = 2;
      let conditions = 'WHERE organization_id = $1';

      if (statusFilter) { conditions += ` AND status = $${idx++}`; params.push(statusFilter); }
      if (actorIdFilter) { conditions += ` AND actor_id = $${idx++}`; params.push(actorIdFilter); }
      if (targetIdFilter) { conditions += ` AND target_id = $${idx++}`; params.push(targetIdFilter); }
      if (validFrom) { conditions += ` AND created_at >= $${idx++}`; params.push(validFrom); }
      if (validTo) { conditions += ` AND created_at <= $${idx++}`; params.push(validTo); }

      // Cap export at 10,000 rows — large enough for auditors, bounded for performance
      const res = await pool.query<{
        sequence_number: string;
        created_at: Date;
        event_type: string;
        actor_email: string | null;
        action: string;
        status: string;
        target_type: string | null;
        target_id: string | null;
        reason: string | null;
        ip_address: string | null;
        user_agent: string | null;
      }>(
        `SELECT sequence_number, created_at, event_type, actor_email, action,
                status, target_type, target_id, reason, ip_address, user_agent
         FROM audit_events
         ${conditions}
         ORDER BY sequence_number ASC
         LIMIT 10000;`,
        params
      );

      // CSV-injection prevention:
      // Prefix cells starting with =, +, -, @, TAB (0x09), CR (0x0D) with a single apostrophe.
      // This is the OWASP-recommended mitigation.
      function csvSanitize(value: unknown): string {
        const str = value === null || value === undefined ? '' : String(value);
        // Also strip newlines to prevent row injection
        const clean = str.replace(/\r?\n|\r/g, ' ');
        if (/^[=+\-@\t\r]/.test(clean)) {
          return `'${clean}`;
        }
        return clean;
      }

      function csvRow(cells: unknown[]): string {
        return cells.map((c) => `"${csvSanitize(c).replace(/"/g, '""')}"`).join(',');
      }

      const headers = [
        'Sequence', 'Timestamp', 'EventType', 'ActorEmail', 'Action',
        'Status', 'TargetType', 'TargetId', 'Reason', 'IpAddress', 'UserAgent',
      ];

      const rows = [
        csvRow(headers),
        ...res.rows.map((r) =>
          csvRow([
            r.sequence_number,
            r.created_at.toISOString(),
            r.event_type,
            r.actor_email,
            r.action,
            r.status,
            r.target_type,
            r.target_id,
            r.reason,
            r.ip_address,
            r.user_agent,
          ])
        ),
      ];

      const csv = rows.join('\r\n');

      // Filename: trustvault-audit-YYYY-MM-DD.csv
      const dateStr = new Date().toISOString().slice(0, 10);

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="trustvault-audit-${dateStr}.csv"`);
      // Prevent browser from sniffing CSV as HTML
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");

      return reply.send(csv);
    }
  );
}
