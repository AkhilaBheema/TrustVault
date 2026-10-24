import crypto from 'node:crypto';
import { loadEnvironment } from '../config/env.js';

loadEnvironment();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits

export interface EncryptedResult {
  encryptedPayload: Buffer;
  encryptedDek: string; // Base64 wrapped DEK + auth tag
  dekIv: string;        // Base64 DEK wrapping IV
  fileIv: string;       // Base64 file encryption IV
  fileAuthTag: string;  // Base64 file authentication tag
}

export class EncryptionService {
  /**
   * Retrieve and validate the 256-bit Master Key from environment.
   */
  private static getMasterKey(): Buffer {
    const rawKey = process.env.MASTER_KEY;
    if (!rawKey) {
      throw new Error('MASTER_KEY is required to encrypt or decrypt document data');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      throw new Error('MASTER_KEY must be exactly 64 hexadecimal characters');
    }

    const keyBuffer = Buffer.from(rawKey, 'hex');

    if (keyBuffer.length !== KEY_LENGTH) {
      throw new Error(`Invalid MASTER_KEY length: expected ${KEY_LENGTH} bytes, got ${keyBuffer.length}`);
    }

    return keyBuffer;
  }

  /**
   * Envelope Encryption:
   * 1. Generates a random 256-bit Data Encryption Key (DEK).
   * 2. Encrypts the plaintext payload using AES-256-GCM with the DEK.
   * 3. Wraps (encrypts) the DEK using AES-256-GCM with the MASTER_KEY.
   */
  static encrypt(plaintext: Buffer): EncryptedResult {
    const masterKey = this.getMasterKey();

    // 1. Generate per-file DEK
    const dek = crypto.randomBytes(KEY_LENGTH);

    // 2. Encrypt payload with DEK
    const fileIv = crypto.randomBytes(IV_LENGTH);
    const fileCipher = crypto.createCipheriv(ALGORITHM, dek, fileIv);
    const encryptedPayload = Buffer.concat([fileCipher.update(plaintext), fileCipher.final()]);
    const fileAuthTag = fileCipher.getAuthTag();

    // 3. Wrap DEK with Master Key
    const dekIv = crypto.randomBytes(IV_LENGTH);
    const dekCipher = crypto.createCipheriv(ALGORITHM, masterKey, dekIv);
    const wrappedDekCiphertext = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekAuthTag = dekCipher.getAuthTag();

    // Combine wrapped DEK and its auth tag: ciphertext:tag
    const combinedEncryptedDek = `${wrappedDekCiphertext.toString('base64')}:${dekAuthTag.toString('base64')}`;

    return {
      encryptedPayload,
      encryptedDek: combinedEncryptedDek,
      dekIv: dekIv.toString('base64'),
      fileIv: fileIv.toString('base64'),
      fileAuthTag: fileAuthTag.toString('base64'),
    };
  }

  /**
   * Envelope Decryption:
   * 1. Unwraps the DEK using the MASTER_KEY and validates DEK integrity.
   * 2. Decrypts the payload using the unwrapped DEK and validates file integrity.
   * Throws if any bit of the ciphertext or key was tampered with.
   */
  static decrypt(
    encryptedPayload: Buffer,
    encryptedDekStr: string,
    dekIvBase64: string,
    fileIvBase64: string,
    fileAuthTagBase64: string
  ): Buffer {
    const masterKey = this.getMasterKey();

    // 1. Parse wrapped DEK components
    const [wrappedDekB64, dekAuthTagB64] = encryptedDekStr.split(':');
    if (!wrappedDekB64 || !dekAuthTagB64) {
      throw new Error('Invalid wrapped DEK structure');
    }

    const wrappedDek = Buffer.from(wrappedDekB64, 'base64');
    const dekAuthTag = Buffer.from(dekAuthTagB64, 'base64');
    const dekIv = Buffer.from(dekIvBase64, 'base64');

    // 2. Unwrap DEK using Master Key
    const dekDecipher = crypto.createDecipheriv(ALGORITHM, masterKey, dekIv);
    dekDecipher.setAuthTag(dekAuthTag);
    const unwrappedDek = Buffer.concat([dekDecipher.update(wrappedDek), dekDecipher.final()]);

    // 3. Decrypt payload using unwrapped DEK
    const fileIv = Buffer.from(fileIvBase64, 'base64');
    const fileAuthTag = Buffer.from(fileAuthTagBase64, 'base64');

    const fileDecipher = crypto.createDecipheriv(ALGORITHM, unwrappedDek, fileIv);
    fileDecipher.setAuthTag(fileAuthTag);
    const decryptedPayload = Buffer.concat([fileDecipher.update(encryptedPayload), fileDecipher.final()]);

    return decryptedPayload;
  }
}
