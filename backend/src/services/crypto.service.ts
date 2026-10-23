import crypto from 'node:crypto';
import * as argon2 from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
};

// Pre-computed dummy hash initialized on startup to mitigate timing-based user enumeration
let dummyHashPromise: Promise<string> | null = null;

async function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash('TrustVaultDummyPasswordTimingDefense#2026', ARGON2_OPTIONS);
  }
  return dummyHashPromise;
}

export class CryptoService {
  /**
   * Hash a plaintext password using Argon2id with high-work memory parameters.
   */
  static async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verify password against an Argon2id hash.
   */
  static async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Perform a dummy verification against a valid precomputed hash.
   * Ensures identical response timing when an email does not exist in the database.
   */
  static async dummyVerifyPassword(plain: string): Promise<boolean> {
    const dummy = await getDummyHash();
    try {
      await argon2.verify(dummy, plain);
    } catch {
      // Expected to fail
    }
    return false;
  }

  /**
   * Generate a cryptographically secure 256-bit opaque random token (hex string).
   */
  static generateRandomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Compute standard SHA-256 hash of a string or buffer (hex output).
   */
  static sha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Deterministically serialize JSON according to canonical key sorting (RFC 8785).
   * Parses JSON strings if needed to ensure identical serialization regardless of DB driver return format.
   */
  static canonicalJson(obj: unknown): string {
    if (obj === null || obj === undefined) {
      return '{}';
    }

    let parsed = obj;
    if (typeof obj === 'string') {
      try {
        parsed = JSON.parse(obj);
      } catch {
        return JSON.stringify(obj);
      }
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return JSON.stringify(parsed);
    }

    if (Array.isArray(parsed)) {
      return '[' + parsed.map((item) => this.canonicalJson(item)).join(',') + ']';
    }

    const keys = Object.keys(parsed as object).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ':' + this.canonicalJson((parsed as Record<string, unknown>)[k])
    );
    return '{' + pairs.join(',') + '}';
  }

  /**
   * Derive a CSRF token for a given session token using HMAC-SHA256.
   * Bound to the server session secret and the opaque session token.
   */
  static generateCsrfToken(sessionToken: string): string {
    const secret = process.env.SESSION_SECRET || 'fallback_trustvault_csrf_secret_32_bytes_min';
    return crypto.createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('hex');
  }

  /**
   * Constant-time verification of CSRF token.
   */
  static verifyCsrfToken(sessionToken: string, candidateToken: string): boolean {
    if (!sessionToken || !candidateToken) {
      return false;
    }
    const expected = this.generateCsrfToken(sessionToken);
    const expectedBuf = Buffer.from(expected, 'hex');
    const candidateBuf = Buffer.from(candidateToken, 'hex');

    if (expectedBuf.length !== candidateBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, candidateBuf);
  }
}
