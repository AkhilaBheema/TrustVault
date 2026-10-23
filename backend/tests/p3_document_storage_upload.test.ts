import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import fs from 'node:fs';
import { setupTestDatabase } from './helpers/testDb.js';
import { buildApp } from '../src/app.js';
import { EncryptionService } from '../src/services/encryption.service.js';
import { StorageService } from '../src/services/storage.service.js';
import { UploadValidationService } from '../src/services/upload-validation.service.js';
import { AuditService } from '../src/services/audit.service.js';
import { DatabasePool, setDatabasePool } from '../src/db/index.js';

describe('Phase 3: Document Model, Encrypted Storage, & Upload Validation', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: DatabasePool;

  beforeAll(async () => {
    const res = await setupTestDatabase();
    pool = res.pool;
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await pool.end();
    setDatabasePool(null);
  });

  describe('1. Envelope Encryption & Bit-Flip Tamper Resistance', () => {
    it('encrypts plaintext at rest and decrypts accurately with wrapped DEK', () => {
      const plaintext = Buffer.from('Confidential financial roadmap Q4: Net revenue $45,000,000.');
      const encrypted = EncryptionService.encrypt(plaintext);

      // Ciphertext must NOT contain plaintext substrings
      expect(encrypted.encryptedPayload.includes(plaintext)).toBe(false);

      // Decrypt using wrapped DEK and master key
      const decrypted = EncryptionService.decrypt(
        encrypted.encryptedPayload,
        encrypted.encryptedDek,
        encrypted.dekIv,
        encrypted.fileIv,
        encrypted.fileAuthTag
      );

      expect(decrypted.toString('utf8')).toBe(plaintext.toString('utf8'));
    });

    it('rejects tampered ciphertext with GCM authentication tag error', () => {
      const plaintext = Buffer.from('Highly classified secret data.');
      const encrypted = EncryptionService.encrypt(plaintext);

      // Tamper with a single byte in ciphertext
      const tamperedCiphertext = Buffer.from(encrypted.encryptedPayload);
      tamperedCiphertext[0] ^= 0xff; // Flip bits

      expect(() => {
        EncryptionService.decrypt(
          tamperedCiphertext,
          encrypted.encryptedDek,
          encrypted.dekIv,
          encrypted.fileIv,
          encrypted.fileAuthTag
        );
      }).toThrow(/Unsupported state or unable to authenticate data/);
    });

    it('rejects tampered wrapped DEK with master key authentication tag error', () => {
      const plaintext = Buffer.from('Another secret message.');
      const encrypted = EncryptionService.encrypt(plaintext);

      // Tamper with wrapped DEK string
      const [wrappedDekB64, authTagB64] = encrypted.encryptedDek.split(':');
      const tamperedDekBytes = Buffer.from(wrappedDekB64, 'base64');
      tamperedDekBytes[0] ^= 0xaa;
      const tamperedDekStr = `${tamperedDekBytes.toString('base64')}:${authTagB64}`;

      expect(() => {
        EncryptionService.decrypt(
          encrypted.encryptedPayload,
          tamperedDekStr,
          encrypted.dekIv,
          encrypted.fileIv,
          encrypted.fileAuthTag
        );
      }).toThrow(/Unsupported state or unable to authenticate data/);
    });
  });

  describe('2. Upload Validation, Magic-Byte Sniffing, & Defense-in-Depth', () => {
    it('approves legitimate PDF, PNG, and text documents with matching magic bytes', () => {
      const pdfBuffer = Buffer.from('%PDF-1.7\nSample PDF stream');
      const validPdf = UploadValidationService.validate('report.pdf', pdfBuffer);
      expect(validPdf.detectedMimeType).toBe('application/pdf');

      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const validPng = UploadValidationService.validate('screenshot.png', pngBuffer);
      expect(validPng.detectedMimeType).toBe('image/png');

      const txtBuffer = Buffer.from('Plain ASCII text notes without control characters.');
      const validTxt = UploadValidationService.validate('notes.txt', txtBuffer);
      expect(validTxt.detectedMimeType).toBe('text/plain');
    });

    it('rejects spoofed MIME type: Windows executable disguised as a PDF', () => {
      // Starts with MZ (0x4D 0x5A)
      const fakePdf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      expect(() => {
        UploadValidationService.validate('malware.pdf', fakePdf);
      }).toThrow(/Windows PE executable detected via magic bytes/);
    });

    it('rejects spoofed MIME type: HTML markup disguised as an image', () => {
      const fakeJpg = Buffer.from('<html><script>alert(1)</script></html>');

      expect(() => {
        UploadValidationService.validate('avatar.jpg', fakeJpg);
      }).toThrow(/HTML\/SVG active web markup is prohibited/);
    });

    it('rejects SVG files containing active markup disguised as text', () => {
      const svgText = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert("XSS")</script></svg>');

      expect(() => {
        UploadValidationService.validate('vector.txt', svgText);
      }).toThrow(/HTML\/SVG active web markup is prohibited/);
    });

    it('rejects double-extension attacks (e.g. invoice.pdf.exe)', () => {
      const buffer = Buffer.from('%PDF-1.4\nFake content');

      expect(() => {
        UploadValidationService.validate('invoice.pdf.exe', buffer);
      }).toThrow(/Dangerous file extension segment detected: .exe/);
    });

    it('rejects generic ZIP archives to prevent decompression bombs', () => {
      // PK\x03\x04 without Office XML directories
      const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

      expect(() => {
        UploadValidationService.validate('archive.docx', zipBuffer);
      }).toThrow(/Generic ZIP archive or decompression bombs are prohibited/);
    });

    it('neutralizes path traversal in filenames without leaking path characters', () => {
      const traversalName = '../../../../../../etc/passwd.pdf';
      const clean = UploadValidationService.sanitizeFilename(traversalName);
      expect(clean).toBe('passwd.pdf');
      expect(clean.includes('/')).toBe(false);
      expect(clean.includes('\\')).toBe(false);
      expect(clean.includes('..')).toBe(false);
    });
  });

  describe('3. Storage Path Hardening', () => {
    it('guarantees on-disk filenames are pure UUIDs and rejects path traversal', () => {
      const storagePath = StorageService.generateStoragePath();
      expect(storagePath).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/i);

      // Verify that getDiskPath rejects any traversal injection
      expect(() => {
        StorageService.getDiskPath('../malicious.enc');
      }).toThrow(/Security violation: Invalid storage path format/);
    });
  });

  describe('4. Document Lifecycle API (Upload, Versions, Soft-Delete, Restore, Purge)', () => {
    let ownerCookie: string;
    let ownerCsrf: string;
    let viewerCookie: string;
    let viewerCsrf: string;
    let starkOwnerCookie: string;
    let starkOwnerCsrf: string;

    let createdDocId: string;
    let firstVersionStoragePath: string;

    beforeAll(async () => {
      // Login Acme Owner
      const ownerRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'owner@acme.com', password: 'TrustVault2026!#' });
      ownerCookie = ownerRes.headers['set-cookie'][0];
      ownerCsrf = ownerRes.body.csrfToken;

      // Login Acme Viewer
      const viewerRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'viewer@acme.com', password: 'TrustVault2026!#' });
      viewerCookie = viewerRes.headers['set-cookie'][0];
      viewerCsrf = viewerRes.body.csrfToken;

      // Login Stark Owner
      const starkRes = await supertest(app.server)
        .post('/api/auth/login')
        .send({ email: 'owner@stark.com', password: 'TrustVault2026!#' });
      starkOwnerCookie = starkRes.headers['set-cookie'][0];
      starkOwnerCsrf = starkRes.body.csrfToken;
    });

    it('forbids viewer from uploading a new document (Owner-only)', async () => {
      const pdfContent = Buffer.from('%PDF-1.4\nViewer test content');

      const res = await supertest(app.server)
        .post('/api/documents')
        .set('Cookie', viewerCookie)
        .set('X-CSRF-Token', viewerCsrf)
        .attach('file', pdfContent, 'test.pdf')
        .field('title', 'Unauthorized Document');

      expect(res.status).toBe(403);
    });

    it('allows owner to upload a new document with envelope encryption at rest', async () => {
      const pdfContent = Buffer.from('%PDF-1.4\nConfidential Q3 Strategic Acquisition Target');

      const res = await supertest(app.server)
        .post('/api/documents')
        .set('Cookie', ownerCookie)
        .set('X-CSRF-Token', ownerCsrf)
        .attach('file', pdfContent, 'acquisition_target.pdf')
        .field('title', 'Acquisition Target 2026')
        .field('category', 'M&A');

      expect(res.status).toBe(201);
      expect(res.body.document).toBeDefined();
      expect(res.body.document.title).toBe('Acquisition Target 2026');
      expect(res.body.version).toBeDefined();
      expect(res.body.version.versionNumber).toBe(1);

      createdDocId = res.body.document.id;
      firstVersionStoragePath = res.body.version.storagePath;

      // Verify encrypted file exists on disk
      const diskPath = StorageService.getDiskPath(firstVersionStoragePath);
      expect(fs.existsSync(diskPath)).toBe(true);

      // Verify file on disk is encrypted ciphertext (NOT plaintext)
      const onDiskBytes = fs.readFileSync(diskPath);
      expect(onDiskBytes.includes(pdfContent)).toBe(false);

      // Decrypt and confirm plaintext equivalence
      const verRecord = await pool.query(
        'SELECT encrypted_dek, dek_iv, file_iv, file_auth_tag FROM document_versions WHERE storage_path = $1;',
        [firstVersionStoragePath]
      );
      const row = verRecord.rows[0];
      const decrypted = EncryptionService.decrypt(
        onDiskBytes,
        row.encrypted_dek,
        row.dek_iv,
        row.file_iv,
        row.file_auth_tag
      );
      expect(decrypted.toString('utf8')).toBe(pdfContent.toString('utf8'));
    });

    it('allows adding a new version (Version 2) to the document', async () => {
      const v2Content = Buffer.from('%PDF-1.4\nConfidential Q3 Acquisition Target Version 2 Revised');

      const res = await supertest(app.server)
        .post(`/api/documents/${createdDocId}/versions`)
        .set('Cookie', ownerCookie)
        .set('X-CSRF-Token', ownerCsrf)
        .attach('file', v2Content, 'acquisition_target_v2.pdf');

      expect(res.status).toBe(201);
      expect(res.body.version.versionNumber).toBe(2);

      // Check database has 2 versions
      const vers = await pool.query(
        'SELECT version_number FROM document_versions WHERE document_id = $1 ORDER BY version_number ASC;',
        [createdDocId]
      );
      expect(vers.rows.length).toBe(2);
      expect(vers.rows[0].version_number).toBe(1);
      expect(vers.rows[1].version_number).toBe(2);
    });

    it('cross-tenant owner cannot add version to other tenant document (404)', async () => {
      const v3Content = Buffer.from('%PDF-1.4\nIntruder Content');

      const res = await supertest(app.server)
        .post(`/api/documents/${createdDocId}/versions`)
        .set('Cookie', starkOwnerCookie)
        .set('X-CSRF-Token', starkOwnerCsrf)
        .attach('file', v3Content, 'intruder.pdf');

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Resource not found or access denied/);
    });

    it('soft-deletes document with 30-day retention window', async () => {
      const res = await supertest(app.server)
        .delete(`/api/documents/${createdDocId}`)
        .set('Cookie', ownerCookie)
        .set('X-CSRF-Token', ownerCsrf);

      expect(res.status).toBe(200);

      // Check DB flags
      const doc = await pool.query('SELECT is_deleted, deleted_at, purge_at FROM documents WHERE id = $1;', [
        createdDocId,
      ]);
      expect(doc.rows[0].is_deleted).toBe(true);
      expect(doc.rows[0].deleted_at).toBeDefined();
      expect(doc.rows[0].purge_at).toBeDefined();
    });

    it('restores soft-deleted document', async () => {
      const res = await supertest(app.server)
        .post(`/api/documents/${createdDocId}/restore`)
        .set('Cookie', ownerCookie)
        .set('X-CSRF-Token', ownerCsrf);

      expect(res.status).toBe(200);

      const doc = await pool.query('SELECT is_deleted FROM documents WHERE id = $1;', [createdDocId]);
      expect(doc.rows[0].is_deleted).toBe(false);
    });

    it('permanently purges document and removes encrypted files from disk', async () => {
      // 1. Soft-delete first
      await supertest(app.server)
        .delete(`/api/documents/${createdDocId}`)
        .set('Cookie', ownerCookie)
        .set('X-CSRF-Token', ownerCsrf);

      // 2. Permanently purge
      const purgeRes = await supertest(app.server)
        .delete(`/api/documents/${createdDocId}/purge`)
        .set('Cookie', ownerCookie)
        .set('X-CSRF-Token', ownerCsrf);

      expect(purgeRes.status).toBe(200);

      // 3. Confirm database record is purged
      const docCheck = await pool.query('SELECT id FROM documents WHERE id = $1;', [createdDocId]);
      expect(docCheck.rows.length).toBe(0);

      // 4. Confirm physical file on disk was destroyed
      const diskPath = StorageService.getDiskPath(firstVersionStoragePath);
      expect(fs.existsSync(diskPath)).toBe(false);
    });
  });

  describe('5. Audit Trail Verification', () => {
    it('confirms the hash chain remains unbroken through all document operations', async () => {
      const integrity = await AuditService.verifyChainIntegrity();

      expect(integrity.isValid).toBe(true);
      expect(integrity.totalRecords).toBeGreaterThan(10);
      expect(integrity.brokenAtSequence).toBeUndefined();
    });
  });
});
