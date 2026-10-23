import { pool } from '../db/index.js';
import { CryptoService } from './crypto.service.js';

export interface AuditLogParams {
  eventType: string;
  action: string;
  status: 'ALLOWED' | 'DENIED' | 'ERROR' | 'INFO';
  actorId?: string | null;
  actorEmail?: string | null;
  organizationId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  payload?: Record<string, unknown>;
}

export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export class AuditService {
  /**
   * Deterministically compute the SHA-256 hash of an audit event.
   * Single source of truth for both log insertion and integrity verification.
   */
  static computeEventHash(
    prevHash: string,
    sequenceNumber: number,
    eventType: string,
    actorEmail: string | null,
    action: string,
    status: string,
    payload: unknown
  ): string {
    const canonicalPayload = CryptoService.canonicalJson(payload);
    const hashData = `${prevHash}|${sequenceNumber}|${eventType}|${actorEmail || 'NONE'}|${action}|${status}|${canonicalPayload}`;
    return CryptoService.sha256(hashData);
  }

  /**
   * Append an audit event to the tamper-evident hash chain.
   * Serialized with an advisory transaction lock to guarantee a single strictly linear chain.
   */
  static async log(params: AuditLogParams): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Advisory lock (key: 839201) to serialize audit hash chain writes
      await client.query('SELECT pg_advisory_xact_lock(839201);');

      // Fetch the last audit row to get prev_hash and sequence_number
      const lastRowRes = await client.query<{ sequence_number: string; current_hash: string }>(
        'SELECT sequence_number, current_hash FROM audit_events ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;'
      );

      let prevHash = GENESIS_PREV_HASH;
      let nextSeq = 1;

      if (lastRowRes.rows.length > 0) {
        prevHash = lastRowRes.rows[0].current_hash;
        nextSeq = parseInt(lastRowRes.rows[0].sequence_number, 10) + 1;
      }

      const safePayload = CryptoService.canonicalJson(params.payload || {});
      const currentHash = this.computeEventHash(
        prevHash,
        nextSeq,
        params.eventType,
        params.actorEmail || null,
        params.action,
        params.status,
        params.payload || {}
      );

      const insertRes = await client.query<{ id: string }>(
        `INSERT INTO audit_events (
           sequence_number, event_type, actor_id, actor_email, organization_id,
           target_type, target_id, action, status, reason, ip_address, user_agent,
           payload, prev_hash, current_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
         RETURNING id;`,
        [
          nextSeq,
          params.eventType,
          params.actorId || null,
          params.actorEmail || null,
          params.organizationId || null,
          params.targetType || null,
          params.targetId || null,
          params.action,
          params.status,
          params.reason || null,
          params.ipAddress || null,
          params.userAgent || null,
          safePayload,
          prevHash,
          currentHash,
        ]
      );

      await client.query('COMMIT');
      return insertRes.rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[AUDIT_ERROR] Failed to record audit log:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Verify the integrity of the audit hash chain from genesis to head.
   * Returns isValid: true, or reports the exact sequence number where the chain broke.
   */
  static async verifyChainIntegrity(): Promise<{
    isValid: boolean;
    totalRecords: number;
    brokenAtSequence?: number;
    errorReason?: string;
  }> {
    const res = await pool.query<{
      sequence_number: string;
      event_type: string;
      actor_email: string | null;
      action: string;
      status: string;
      payload: unknown;
      prev_hash: string;
      current_hash: string;
    }>('SELECT * FROM audit_events ORDER BY sequence_number ASC;');

    const rows = res.rows;
    if (rows.length === 0) {
      return { isValid: true, totalRecords: 0 };
    }

    let expectedPrevHash = GENESIS_PREV_HASH;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const seq = parseInt(row.sequence_number, 10);

      // Check prev_hash matches prior block's current_hash
      if (row.prev_hash !== expectedPrevHash) {
        return {
          isValid: false,
          totalRecords: rows.length,
          brokenAtSequence: seq,
          errorReason: `Broken link: row sequence ${seq} prev_hash (${row.prev_hash}) does not match expected (${expectedPrevHash})`,
        };
      }

      // Recompute expected current_hash using single source of truth
      const recomputedHash = this.computeEventHash(
        row.prev_hash,
        seq,
        row.event_type,
        row.actor_email,
        row.action,
        row.status,
        row.payload
      );

      if (recomputedHash !== row.current_hash) {
        return {
          isValid: false,
          totalRecords: rows.length,
          brokenAtSequence: seq,
          errorReason: `Tampered row: row sequence ${seq} current_hash does not match recomputed SHA-256`,
        };
      }

      expectedPrevHash = row.current_hash;
    }

    return { isValid: true, totalRecords: rows.length };
  }
}
