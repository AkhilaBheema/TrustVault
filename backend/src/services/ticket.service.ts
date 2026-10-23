import { pool } from '../db/index.js';
import { CryptoService } from './crypto.service.js';

export const TICKET_LIFETIME_SECONDS = 60;

export interface DownloadTicketData {
  id: string;
  userId: string;
  documentId: string;
  versionId: string;
  grantVersion: number;
  expiresAt: Date;
  usedAt: Date | null;
}

export class TicketService {
  /**
   * Issue a short-lived (<=60s), single-use download ticket.
   * Cryptographically bound to user, document, specific version, and grant version.
   */
  static async issueTicket(
    userId: string,
    documentId: string,
    versionId: string,
    grantVersion: number
  ): Promise<{ rawTicket: string; expiresInSeconds: number }> {
    const rawTicket = CryptoService.generateRandomToken(32);
    const ticketHash = CryptoService.sha256(rawTicket);
    const expiresAt = new Date(Date.now() + TICKET_LIFETIME_SECONDS * 1000);

    await pool.query(
      `INSERT INTO download_tickets (ticket_hash, user_id, document_id, version_id, grant_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [ticketHash, userId, documentId, versionId, grantVersion, expiresAt]
    );

    return {
      rawTicket,
      expiresInSeconds: TICKET_LIFETIME_SECONDS,
    };
  }

  /**
   * Consume and invalidate a download ticket atomically.
   * Verifies:
   * 1. Ticket hash matches
   * 2. Ticket has not already been used
   * 3. Ticket is within 60s expiration window
   * 4. Bound to caller user ID
   */
  static async consumeTicket(
    rawTicket: string,
    userId: string
  ): Promise<DownloadTicketData | null> {
    if (!rawTicket || typeof rawTicket !== 'string') {
      return null;
    }

    const ticketHash = CryptoService.sha256(rawTicket);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query<{
        id: string;
        user_id: string;
        document_id: string;
        version_id: string;
        grant_version: number;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `SELECT id, user_id, document_id, version_id, grant_version, expires_at, used_at
         FROM download_tickets
         WHERE ticket_hash = $1
         FOR UPDATE;`,
        [ticketHash]
      );

      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const ticket = res.rows[0];

      // 1. Check user binding
      if (ticket.user_id !== userId) {
        await client.query('ROLLBACK');
        return null;
      }

      // 2. Check already used (single-use invariant)
      if (ticket.used_at !== null) {
        await client.query('ROLLBACK');
        return null;
      }

      // 3. Check expiration (<= 60s invariant)
      if (Date.now() > new Date(ticket.expires_at).getTime()) {
        await client.query('ROLLBACK');
        return null;
      }

      // 4. Mark ticket as consumed
      await client.query('UPDATE download_tickets SET used_at = NOW() WHERE id = $1;', [ticket.id]);
      await client.query('COMMIT');

      return {
        id: ticket.id,
        userId: ticket.user_id,
        documentId: ticket.document_id,
        versionId: ticket.version_id,
        grantVersion: ticket.grant_version,
        expiresAt: ticket.expires_at,
        usedAt: new Date(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
