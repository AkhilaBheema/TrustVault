import { pool } from '../db/index.js';
import { CryptoService } from './crypto.service.js';
import { SessionData, UserContext } from '../types/auth.js';

export const ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;          // 30 minutes
export const ACTIVITY_UPDATE_INTERVAL_MS = 60 * 1000;   // Throttle updates to once per 60s

export class SessionService {
  /**
   * Create a new server-side session.
   * Generates a 256-bit random opaque token, stores only its SHA-256 hash in DB,
   * and sets absolute timeout.
   */
  static async createSession(
    userId: string,
    ipAddress: string | null = null,
    userAgent: string | null = null
  ): Promise<{ sessionToken: string; sessionId: string; expiresAt: Date }> {
    const sessionToken = CryptoService.generateRandomToken(32);
    const sessionTokenHash = CryptoService.sha256(sessionToken);
    const expiresAt = new Date(Date.now() + ABSOLUTE_TIMEOUT_MS);

    const res = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, session_token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id;`,
      [userId, sessionTokenHash, ipAddress, userAgent, expiresAt]
    );

    return {
      sessionToken,
      sessionId: res.rows[0].id,
      expiresAt,
    };
  }

  /**
   * Validate session token from cookie, checking:
   * 1. Token existence in DB
   * 2. User active / not disabled
   * 3. Absolute timeout
   * 4. Idle timeout
   * Updates last_active_at if valid.
   */
  static async validateSession(
    rawToken: string
  ): Promise<{ session: SessionData; user: UserContext } | null> {
    if (!rawToken || typeof rawToken !== 'string') {
      return null;
    }

    const tokenHash = CryptoService.sha256(rawToken);

    const res = await pool.query<{
      session_id: string;
      user_id: string;
      session_token_hash: string;
      ip_address: string | null;
      user_agent: string | null;
      created_at: Date;
      last_active_at: Date;
      expires_at: Date;
      email: string;
      name: string;
      role: 'admin' | 'owner' | 'viewer';
      organization_id: string;
      is_disabled: boolean;
    }>(
      `SELECT
         s.id AS session_id,
         s.user_id,
         s.session_token_hash,
         s.ip_address,
         s.user_agent,
         s.created_at,
         s.last_active_at,
         s.expires_at,
         u.email,
         u.name,
         u.role,
         u.organization_id,
         u.is_disabled
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.session_token_hash = $1;`,
      [tokenHash]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    const now = Date.now();

    // 1. If user was disabled, immediately revoke session
    if (row.is_disabled) {
      await this.deleteSessionByHash(tokenHash);
      return null;
    }

    // 2. Absolute timeout check
    if (now > new Date(row.expires_at).getTime()) {
      await this.deleteSessionByHash(tokenHash);
      return null;
    }

    // 3. Idle timeout check
    const lastActive = new Date(row.last_active_at).getTime();
    if (now - lastActive > IDLE_TIMEOUT_MS) {
      await this.deleteSessionByHash(tokenHash);
      return null;
    }

    // 4. Throttle updates to last_active_at to reduce DB load
    if (now - lastActive > ACTIVITY_UPDATE_INTERVAL_MS) {
      await pool.query('UPDATE sessions SET last_active_at = NOW() WHERE id = $1;', [
        row.session_id,
      ]);
    }

    return {
      session: {
        id: row.session_id,
        userId: row.user_id,
        sessionTokenHash: row.session_token_hash,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        expiresAt: row.expires_at,
      },
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        organizationId: row.organization_id,
        isDisabled: row.is_disabled,
      },
    };
  }

  /**
   * Delete single session by raw token (e.g. on user logout).
   */
  static async deleteSession(rawToken: string): Promise<void> {
    const tokenHash = CryptoService.sha256(rawToken);
    await this.deleteSessionByHash(tokenHash);
  }

  private static async deleteSessionByHash(tokenHash: string): Promise<void> {
    await pool.query('DELETE FROM sessions WHERE session_token_hash = $1;', [tokenHash]);
  }

  /**
   * Force-revoke all sessions for a specific user ID (immediate effect).
   */
  static async revokeAllUserSessions(userId: string): Promise<number> {
    const res = await pool.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id;', [
      userId,
    ]);
    return res.rowCount ?? 0;
  }
}
