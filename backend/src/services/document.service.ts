import { pool } from '../db/index.js';
import { StorageService } from './storage.service.js';
import { EncryptionService } from './encryption.service.js';
import { CryptoService } from './crypto.service.js';
import { AuditService } from './audit.service.js';
import { ValidatedFile } from './upload-validation.service.js';
import { UserContext } from '../types/auth.js';

export interface DocumentRecord {
  id: string;
  organizationId: string;
  ownerId: string;
  title: string;
  description: string;
  category: string;
  isDeleted: boolean;
  deletedAt: Date | null;
  purgeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VersionRecord {
  id: string;
  documentId: string;
  versionNumber: number;
  storagePath: string;
  fileSize: number;
  mimeType: string;
  originalFilename: string;
  sha256Hash: string;
  createdAt: Date;
  createdBy: string;
}

export class DocumentService {
  /**
   * Upload and create a brand-new document with Version 1.
   * Encrypts file payload using per-file DEK wrapped by master key.
   */
  static async createDocument(
    actor: UserContext,
    title: string,
    description: string,
    category: string,
    file: ValidatedFile,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<{ document: DocumentRecord; version: VersionRecord }> {
    const sha256Hash = CryptoService.sha256(file.buffer);

    // 1. Envelope Encryption
    const encrypted = EncryptionService.encrypt(file.buffer);

    // 2. Write to disk using random UUIDv4 storage path
    const storagePath = StorageService.generateStoragePath();
    await StorageService.writeEncryptedFile(storagePath, encrypted.encryptedPayload);

    // 3. Persist in database transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const docRes = await client.query<{
        id: string;
        organization_id: string;
        owner_id: string;
        title: string;
        description: string;
        category: string;
        is_deleted: boolean;
        deleted_at: Date | null;
        purge_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO documents (organization_id, owner_id, title, description, category)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [actor.organizationId, actor.id, title, description || '', category || 'General']
      );

      const docRow = docRes.rows[0];

      const versionRes = await client.query<{
        id: string;
        document_id: string;
        version_number: number;
        storage_path: string;
        file_size: string;
        mime_type: string;
        original_filename: string;
        sha256_hash: string;
        created_at: Date;
        created_by: string;
      }>(
        `INSERT INTO document_versions (
           document_id, version_number, storage_path, file_size, mime_type,
           original_filename, sha256_hash, encrypted_dek, dek_iv, file_iv,
           file_auth_tag, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *;`,
        [
          docRow.id,
          1,
          storagePath,
          file.sizeBytes,
          file.detectedMimeType,
          file.sanitizedFilename,
          sha256Hash,
          encrypted.encryptedDek,
          encrypted.dekIv,
          encrypted.fileIv,
          encrypted.fileAuthTag,
          actor.id,
        ]
      );

      await client.query('COMMIT');

      const verRow = versionRes.rows[0];

      await AuditService.log({
        eventType: 'DOCUMENT_LIFECYCLE',
        action: 'DOCUMENT_UPLOAD',
        status: 'ALLOWED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: docRow.id,
        reason: `Initial document upload '${title}' (${file.sanitizedFilename}, version 1)`,
        ipAddress,
        userAgent,
        payload: {
          title,
          category,
          originalFilename: file.sanitizedFilename,
          fileSize: file.sizeBytes,
          sha256Hash,
        },
      });

      return {
        document: {
          id: docRow.id,
          organizationId: docRow.organization_id,
          ownerId: docRow.owner_id,
          title: docRow.title,
          description: docRow.description,
          category: docRow.category,
          isDeleted: docRow.is_deleted,
          deletedAt: docRow.deleted_at,
          purgeAt: docRow.purge_at,
          createdAt: docRow.created_at,
          updatedAt: docRow.updated_at,
        },
        version: {
          id: verRow.id,
          documentId: verRow.document_id,
          versionNumber: verRow.version_number,
          storagePath: verRow.storage_path,
          fileSize: parseInt(verRow.file_size, 10),
          mimeType: verRow.mime_type,
          originalFilename: verRow.original_filename,
          sha256Hash: verRow.sha256_hash,
          createdAt: verRow.created_at,
          createdBy: verRow.created_by,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      // Cleanup disk blob if DB insert fails
      await StorageService.deleteEncryptedFile(storagePath);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Upload a subsequent version to an existing document.
   */
  static async addVersion(
    actor: UserContext,
    documentId: string,
    file: ValidatedFile,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<VersionRecord> {
    const sha256Hash = CryptoService.sha256(file.buffer);
    const encrypted = EncryptionService.encrypt(file.buffer);
    const storagePath = StorageService.generateStoragePath();
    await StorageService.writeEncryptedFile(storagePath, encrypted.encryptedPayload);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check document existence & tenant match
      const docCheck = await client.query<{ id: string; owner_id: string; is_deleted: boolean }>(
        'SELECT id, owner_id, is_deleted FROM documents WHERE id = $1 AND organization_id = $2 FOR UPDATE;',
        [documentId, actor.organizationId]
      );

      if (docCheck.rows.length === 0 || docCheck.rows[0].is_deleted) {
        throw new Error('Resource not found or access denied.');
      }

      // Determine next version number
      const maxVerRes = await client.query<{ max_ver: number }>(
        'SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM document_versions WHERE document_id = $1;',
        [documentId]
      );
      const nextVerNumber = maxVerRes.rows[0].max_ver + 1;

      const versionRes = await client.query<{
        id: string;
        document_id: string;
        version_number: number;
        storage_path: string;
        file_size: string;
        mime_type: string;
        original_filename: string;
        sha256_hash: string;
        created_at: Date;
        created_by: string;
      }>(
        `INSERT INTO document_versions (
           document_id, version_number, storage_path, file_size, mime_type,
           original_filename, sha256_hash, encrypted_dek, dek_iv, file_iv,
           file_auth_tag, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *;`,
        [
          documentId,
          nextVerNumber,
          storagePath,
          file.sizeBytes,
          file.detectedMimeType,
          file.sanitizedFilename,
          sha256Hash,
          encrypted.encryptedDek,
          encrypted.dekIv,
          encrypted.fileIv,
          encrypted.fileAuthTag,
          actor.id,
        ]
      );

      await client.query('UPDATE documents SET updated_at = NOW() WHERE id = $1;', [documentId]);
      await client.query('COMMIT');

      const verRow = versionRes.rows[0];

      await AuditService.log({
        eventType: 'DOCUMENT_LIFECYCLE',
        action: 'NEW_VERSION_UPLOADED',
        status: 'ALLOWED',
        actorId: actor.id,
        actorEmail: actor.email,
        organizationId: actor.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `New document version ${nextVerNumber} uploaded (${file.sanitizedFilename})`,
        ipAddress,
        userAgent,
        payload: {
          versionNumber: nextVerNumber,
          originalFilename: file.sanitizedFilename,
          fileSize: file.sizeBytes,
          sha256Hash,
        },
      });

      return {
        id: verRow.id,
        documentId: verRow.document_id,
        versionNumber: verRow.version_number,
        storagePath: verRow.storage_path,
        fileSize: parseInt(verRow.file_size, 10),
        mimeType: verRow.mime_type,
        originalFilename: verRow.original_filename,
        sha256Hash: verRow.sha256_hash,
        createdAt: verRow.created_at,
        createdBy: verRow.created_by,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      await StorageService.deleteEncryptedFile(storagePath);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Soft-delete a document with 30-day restore retention window.
   */
  static async softDeleteDocument(
    actor: UserContext,
    documentId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    const res = await pool.query<{ id: string }>(
      `UPDATE documents
       SET is_deleted = TRUE,
           deleted_at = NOW(),
           purge_at = NOW() + INTERVAL '30 days',
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND owner_id = $3 AND is_deleted = FALSE
       RETURNING id;`,
      [documentId, actor.organizationId, actor.id]
    );

    if (res.rows.length === 0) {
      throw new Error('Resource not found or access denied.');
    }

    await AuditService.log({
      eventType: 'DOCUMENT_LIFECYCLE',
      action: 'DOCUMENT_SOFT_DELETED',
      status: 'ALLOWED',
      actorId: actor.id,
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: 'Owner initiated soft-deletion (30-day recovery active)',
      ipAddress,
      userAgent,
    });
  }

  /**
   * Restore a soft-deleted document within its recovery window.
   */
  static async restoreDocument(
    actor: UserContext,
    documentId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    const res = await pool.query<{ id: string }>(
      `UPDATE documents
       SET is_deleted = FALSE,
           deleted_at = NULL,
           purge_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND owner_id = $3 AND is_deleted = TRUE
       RETURNING id;`,
      [documentId, actor.organizationId, actor.id]
    );

    if (res.rows.length === 0) {
      throw new Error('Resource not found or access denied.');
    }

    await AuditService.log({
      eventType: 'DOCUMENT_LIFECYCLE',
      action: 'DOCUMENT_RESTORED',
      status: 'ALLOWED',
      actorId: actor.id,
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: 'Owner restored soft-deleted document',
      ipAddress,
      userAgent,
    });
  }

  /**
   * Permanently purge document and remove all encrypted blobs from disk (Owner-only).
   */
  static async purgeDocument(
    actor: UserContext,
    documentId: string,
    ipAddress: string | null,
    userAgent: string | null
  ): Promise<void> {
    // 1. Fetch storage paths for all versions
    const verRes = await pool.query<{ storage_path: string }>(
      `SELECT v.storage_path
       FROM document_versions v
       JOIN documents d ON v.document_id = d.id
       WHERE d.id = $1 AND d.organization_id = $2 AND d.owner_id = $3;`,
      [documentId, actor.organizationId, actor.id]
    );

    if (verRes.rows.length === 0) {
      throw new Error('Resource not found or access denied.');
    }

    // 2. Delete database row (cascades to versions, grants, etc.)
    await pool.query('DELETE FROM documents WHERE id = $1;', [documentId]);

    // 3. Delete all physical encrypted files from disk
    for (const row of verRes.rows) {
      await StorageService.deleteEncryptedFile(row.storage_path);
    }

    await AuditService.log({
      eventType: 'DOCUMENT_LIFECYCLE',
      action: 'DOCUMENT_PERMANENTLY_PURGED',
      status: 'ALLOWED',
      actorId: actor.id,
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      reason: `Owner permanently purged document and destroyed ${verRes.rows.length} encrypted blobs on disk`,
      ipAddress,
      userAgent,
    });
  }
}
