import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const STORAGE_DIR = process.env.STORAGE_DIR || path.resolve(process.cwd(), 'uploads');

export class StorageService {
  private static ensureStorageDir(): void {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Generate an unguessable storage filename using UUIDv4.
   * Path traversal is impossible by construction because filenames are randomly generated.
   */
  static generateStoragePath(): string {
    return `${crypto.randomUUID()}.enc`;
  }

  /**
   * Resolve an on-disk absolute path strictly constrained within STORAGE_DIR.
   */
  static getDiskPath(storagePath: string): string {
    this.ensureStorageDir();
    // Validate storagePath is strictly a clean basename
    const baseName = path.basename(storagePath);
    if (baseName !== storagePath || storagePath.includes('..') || storagePath.includes('/') || storagePath.includes('\\')) {
      throw new Error('Security violation: Invalid storage path format');
    }
    return path.join(STORAGE_DIR, baseName);
  }

  /**
   * Save an encrypted buffer to private storage.
   */
  static async writeEncryptedFile(storagePath: string, encryptedBuffer: Buffer): Promise<void> {
    const diskPath = this.getDiskPath(storagePath);
    await fs.promises.writeFile(diskPath, encryptedBuffer, { mode: 0o600 });
  }

  /**
   * Read an encrypted buffer from private storage.
   */
  static async readEncryptedFile(storagePath: string): Promise<Buffer> {
    const diskPath = this.getDiskPath(storagePath);
    if (!fs.existsSync(diskPath)) {
      throw new Error('Encrypted file blob not found on disk');
    }
    return fs.promises.readFile(diskPath);
  }

  /**
   * Permanently delete an encrypted blob from disk.
   */
  static async deleteEncryptedFile(storagePath: string): Promise<void> {
    const diskPath = this.getDiskPath(storagePath);
    if (fs.existsSync(diskPath)) {
      await fs.promises.unlink(diskPath);
    }
  }
}
