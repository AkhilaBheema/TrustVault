import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, verifyCsrf } from '../middleware/auth.js';
import { AuthorizationService } from '../services/authorization.service.js';
import { DocumentRepository } from '../repositories/document.repository.js';
import { DocumentService } from '../services/document.service.js';
import { UploadValidationService } from '../services/upload-validation.service.js';
import { TicketService } from '../services/ticket.service.js';
import { GrantService } from '../services/grant.service.js';
import { StorageService } from '../services/storage.service.js';
import { EncryptionService } from '../services/encryption.service.js';
import { AuditService } from '../services/audit.service.js';
import { pool } from '../db/index.js';

export async function documentRoutes(app: FastifyInstance) {
  // 1. List / Search accessible documents (Repository query scoped in SQL)
  app.get('/api/documents', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as Record<string, string | undefined>;

    const filters = {
      search: query.search,
      category: query.category,
      ownerId: query.ownerId,
      fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
      toDate: query.toDate ? new Date(query.toDate) : undefined,
      onlyDeleted: query.onlyDeleted === 'true',
    };

    const documents = await DocumentRepository.listAccessibleDocuments(user, filters);
    return reply.status(200).send({ documents });
  });

  // 2. Get single document metadata & version history (Enforces authorize('read'))
  app.get('/api/documents/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const auth = await AuthorizationService.authorize(user, id, 'read', {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    const docRes = await pool.query<{
      id: string;
      title: string;
      description: string;
      category: string;
      owner_id: string;
      is_deleted: boolean;
      created_at: Date;
      updated_at: Date;
      owner_name: string;
      owner_email: string;
    }>(
      `SELECT d.id, d.title, d.description, d.category, d.owner_id, d.is_deleted,
              d.created_at, d.updated_at, u.name AS owner_name, u.email AS owner_email
       FROM documents d
       JOIN users u ON d.owner_id = u.id
       WHERE d.id = $1;`,
      [id]
    );

    const versionsRes = await pool.query<{
      id: string;
      version_number: number;
      file_size: string;
      mime_type: string;
      original_filename: string;
      sha256_hash: string;
      created_at: Date;
    }>(
      `SELECT id, version_number, file_size, mime_type, original_filename, sha256_hash, created_at
       FROM document_versions
       WHERE document_id = $1
       ORDER BY version_number DESC;`,
      [id]
    );

    return reply.status(200).send({
      document: {
        id: docRes.rows[0].id,
        title: docRes.rows[0].title,
        description: docRes.rows[0].description,
        category: docRes.rows[0].category,
        ownerId: docRes.rows[0].owner_id,
        ownerName: docRes.rows[0].owner_name,
        ownerEmail: docRes.rows[0].owner_email,
        isDeleted: docRes.rows[0].is_deleted,
        createdAt: docRes.rows[0].created_at,
        updatedAt: docRes.rows[0].updated_at,
        effectivePermission: auth.effectivePermission,
      },
      versions: versionsRes.rows.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        fileSize: parseInt(v.file_size, 10),
        mimeType: v.mime_type,
        originalFilename: v.original_filename,
        sha256Hash: v.sha256_hash,
        createdAt: v.created_at,
      })),
    });
  });

  // 3. Upload new document with Version 1 (Owner-only)
  app.post(
    '/api/documents',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Multipart file upload is required (field name: "file")',
        });
      }

      const fileBuffer = await data.toBuffer();
      const rawTitle = (data.fields.title as any)?.value || data.filename;
      const rawDescription = (data.fields.description as any)?.value || '';
      const rawCategory = (data.fields.category as any)?.value || 'General';

      const metadataSchema = z.object({
        title: z.string().trim().min(1, 'Title is required').max(200),
        description: z.string().max(1000).default(''),
        category: z.string().trim().min(1).max(50).default('General'),
      });

      const parsedMeta = metadataSchema.safeParse({
        title: rawTitle,
        description: rawDescription,
        category: rawCategory,
      });

      if (!parsedMeta.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsedMeta.error.errors[0]?.message || 'Invalid metadata',
        });
      }

      const validatedFile = UploadValidationService.validate(data.filename, fileBuffer);

      const result = await DocumentService.createDocument(
        user,
        parsedMeta.data.title,
        parsedMeta.data.description,
        parsedMeta.data.category,
        validatedFile,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(201).send(result);
    }
  );

  // 4. Issue Download Ticket (Enforces authorize('download'))
  app.post(
    '/api/documents/:id/download-ticket',
    { preHandler: [authenticate, verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      // Authorize caller to download document
      const auth = await AuthorizationService.authorize(user, id, 'download', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      // Get latest version ID
      const verRes = await pool.query<{ id: string }>(
        'SELECT id FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1;',
        [id]
      );

      if (verRes.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Resource not found or access denied.',
        });
      }

      const ticketResult = await TicketService.issueTicket(
        user.id,
        id,
        verRes.rows[0].id,
        auth.grantVersion
      );

      return reply.status(200).send(ticketResult);
    }
  );

  // 5. Download Stream with Stream-Time Re-Authorization
  app.get('/api/documents/:id/download', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const query = request.query as { ticket?: string };

    if (!query.ticket) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Download ticket parameter is required (?ticket=...)',
      });
    }

    // 1. Consume ticket (must be single-use, <=60s, bound to user)
    const ticket = await TicketService.consumeTicket(query.ticket, user.id);
    if (!ticket || ticket.documentId !== id) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    // 2. RE-AUTHORIZE AT STREAM TIME!
    const auth = await AuthorizationService.authorize(user, id, 'download', {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    // 3. Verify grant version matches (prevents redemption if grant was revoked in the last 10s)
    if (auth.grantVersion !== ticket.grantVersion) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    // 4. Fetch encrypted version blob
    const verRes = await pool.query<{
      storage_path: string;
      original_filename: string;
      mime_type: string;
      encrypted_dek: string;
      dek_iv: string;
      file_iv: string;
      file_auth_tag: string;
    }>(
      `SELECT storage_path, original_filename, mime_type, encrypted_dek, dek_iv, file_iv, file_auth_tag
       FROM document_versions
       WHERE id = $1;`,
      [ticket.versionId]
    );

    if (verRes.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    const version = verRes.rows[0];
    const encryptedBytes = await StorageService.readEncryptedFile(version.storage_path);

    // 5. Decrypt plaintext
    const decryptedBytes = EncryptionService.decrypt(
      encryptedBytes,
      version.encrypted_dek,
      version.dek_iv,
      version.file_iv,
      version.file_auth_tag
    );

    await AuditService.log({
      eventType: 'DOCUMENT_LIFECYCLE',
      action: 'DOCUMENT_DOWNLOAD',
      status: 'ALLOWED',
      actorId: user.id,
      actorEmail: user.email,
      organizationId: user.organizationId,
      targetType: 'DOCUMENT',
      targetId: id,
      reason: `File downloaded via verified ticket (${version.original_filename})`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    // 6. Send with hardened security headers
    reply.header('Content-Type', version.mime_type);
    reply.header('Content-Disposition', `attachment; filename="${version.original_filename}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");

    return reply.send(decryptedBytes);
  });

  // 6. Sandboxed Safe Preview Endpoint (Enforces authorize('preview'))
  app.get('/api/documents/:id/preview', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    await AuthorizationService.authorize(user, id, 'preview', {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    // Fetch latest version
    const verRes = await pool.query<{
      storage_path: string;
      original_filename: string;
      mime_type: string;
      encrypted_dek: string;
      dek_iv: string;
      file_iv: string;
      file_auth_tag: string;
    }>(
      `SELECT storage_path, original_filename, mime_type, encrypted_dek, dek_iv, file_iv, file_auth_tag
       FROM document_versions
       WHERE document_id = $1
       ORDER BY version_number DESC
       LIMIT 1;`,
      [id]
    );

    if (verRes.rows.length === 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found or access denied.',
      });
    }

    const version = verRes.rows[0];

    // Safe preview MIME allowlist
    const SAFE_PREVIEW_MIMES = [
      'image/png',
      'image/jpeg',
      'text/plain',
      'text/csv',
      'application/pdf',
    ];

    if (!SAFE_PREVIEW_MIMES.includes(version.mime_type)) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Inline preview is not supported for this file type. Please use download.',
      });
    }

    const encryptedBytes = await StorageService.readEncryptedFile(version.storage_path);
    const decryptedBytes = EncryptionService.decrypt(
      encryptedBytes,
      version.encrypted_dek,
      version.dek_iv,
      version.file_iv,
      version.file_auth_tag
    );

    await AuditService.log({
      eventType: 'DOCUMENT_LIFECYCLE',
      action: 'DOCUMENT_PREVIEW',
      status: 'ALLOWED',
      actorId: user.id,
      actorEmail: user.email,
      organizationId: user.organizationId,
      targetType: 'DOCUMENT',
      targetId: id,
      reason: `File previewed (${version.original_filename})`,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || null,
    });

    reply.header('Content-Type', version.mime_type);
    reply.header('Content-Disposition', `inline; filename="${version.original_filename}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");

    return reply.send(decryptedBytes);
  });

  // 7. Upload new version (Enforces authorize('edit'))
  app.post(
    '/api/documents/:id/versions',
    { preHandler: [authenticate, verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      // Chokepoint check for edit permission
      await AuthorizationService.authorize(user, id, 'edit', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Multipart file upload is required (field name: "file")',
        });
      }

      const fileBuffer = await data.toBuffer();
      const validatedFile = UploadValidationService.validate(data.filename, fileBuffer);

      const version = await DocumentService.addVersion(
        user,
        id,
        validatedFile,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(201).send({ version });
    }
  );

  // 8. Soft-delete document (Enforces authorize('delete'))
  app.delete(
    '/api/documents/:id',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      await AuthorizationService.authorize(user, id, 'delete', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      await DocumentService.softDeleteDocument(
        user,
        id,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({
        message: 'Document soft-deleted successfully. It can be restored within 30 days.',
      });
    }
  );

  // 9. Restore soft-deleted document (Enforces authorize('restore'))
  app.post(
    '/api/documents/:id/restore',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      await AuthorizationService.authorize(user, id, 'restore', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      await DocumentService.restoreDocument(
        user,
        id,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({
        message: 'Document restored successfully.',
      });
    }
  );

  // 10. Permanently purge document (Enforces authorize('purge'))
  app.delete(
    '/api/documents/:id/purge',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      await AuthorizationService.authorize(user, id, 'purge', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      await DocumentService.purgeDocument(
        user,
        id,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({
        message: 'Document and all associated encrypted files permanently purged.',
      });
    }
  );

  // 11. "Who can see this?" panel: List grants on document
  app.get('/api/documents/:id/grants', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const result = await GrantService.listGrants(
      user,
      id,
      request.ip,
      request.headers['user-agent'] || null
    );

    return reply.status(200).send(result);
  });

  // 12. Issue or update grant (Owner-only)
  app.post(
    '/api/documents/:id/grants',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const grantSchema = z.object({
        userId: z.string().uuid(),
        permission: z.enum(['read', 'edit']),
        expiresAt: z.string().datetime().nullable().optional(),
      });

      const parsed = grantSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.errors[0]?.message || 'Invalid grant data',
        });
      }

      const grant = await GrantService.issueGrant(
        user,
        id,
        parsed.data.userId,
        parsed.data.permission,
        parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(201).send({ grant });
    }
  );

  // 13. Revoke single grant (Owner-only)
  app.delete(
    '/api/documents/:id/grants/:userId',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id, userId } = request.params as { id: string; userId: string };

      await GrantService.revokeGrant(
        user,
        id,
        userId,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({
        message: 'Access grant successfully revoked.',
      });
    }
  );

  // 14. Emergency "Revoke All" grants (Owner-only)
  app.post(
    '/api/documents/:id/grants/revoke-all',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const revokedCount = await GrantService.revokeAllGrants(
        user,
        id,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({
        message: `Emergency revoke all executed: ${revokedCount} grant(s) revoked.`,
        revokedCount,
      });
    }
  );
}
