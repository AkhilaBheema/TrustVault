import { pool } from '../db/index.js';
import { UserContext } from '../types/auth.js';

export interface DocumentListItem {
  id: string;
  title: string;
  description: string;
  category: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  effectivePermission: 'owner' | 'edit' | 'read';
  grantExpiresAt: Date | null;
  latestVersionNumber: number;
  fileSize: number;
  mimeType: string;
  originalFilename: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentQueryFilters {
  search?: string;
  category?: string;
  ownerId?: string;
  fromDate?: Date;
  toDate?: Date;
  onlyDeleted?: boolean;
}

export class DocumentRepository {
  /**
   * List and search documents strictly scoped in SQL to what the actor is authorized to see.
   *
   * Security Invariants:
   * 1. Multi-tenant filtering (d.organization_id = $orgId).
   * 2. Accessible filtering embedded in SQL (d.owner_id = $userId OR active grant exists).
   * 3. Prevents enumeration, counts, facets, or snippets from leaking inaccessible documents.
   */
  static async listAccessibleDocuments(
    actor: UserContext,
    filters: DocumentQueryFilters = {}
  ): Promise<DocumentListItem[]> {
    const params: unknown[] = [actor.id, actor.organizationId];
    let queryIndex = 3;

    // Base query joining active grants and latest version metadata
    let sql = `
      SELECT
        d.id,
        d.title,
        d.description,
        d.category,
        d.owner_id,
        d.created_at,
        d.updated_at,
        u.name AS owner_name,
        u.email AS owner_email,
        CASE
          WHEN d.owner_id = $1 THEN 'owner'
          ELSE g.permission
        END AS effective_permission,
        g.expires_at AS grant_expires_at,
        COALESCE(v.version_number, 1) AS version_number,
        COALESCE(v.file_size, 0) AS file_size,
        COALESCE(v.mime_type, 'application/octet-stream') AS mime_type,
        COALESCE(v.original_filename, d.title) AS original_filename
      FROM documents d
      JOIN users u ON d.owner_id = u.id
      LEFT JOIN document_grants g ON d.id = g.document_id
        AND g.user_id = $1
        AND (g.expires_at IS NULL OR g.expires_at > NOW())
      LEFT JOIN LATERAL (
        SELECT version_number, file_size, mime_type, original_filename
        FROM document_versions
        WHERE document_id = d.id
        ORDER BY version_number DESC
        LIMIT 1
      ) v ON true
      WHERE d.organization_id = $2
    `;

    // 1. Accessibility filter: Actor must be the owner OR possess an active unexpired grant
    sql += ` AND (d.owner_id = $1 OR g.id IS NOT NULL)`;

    // 2. Soft-delete filter
    if (filters.onlyDeleted) {
      // Only owners can view their soft-deleted documents
      sql += ` AND d.is_deleted = TRUE AND d.owner_id = $1`;
    } else {
      sql += ` AND d.is_deleted = FALSE`;
    }

    // 3. Search text (Title or description)
    if (filters.search && filters.search.trim()) {
      sql += ` AND (d.title ILIKE $${queryIndex} OR d.description ILIKE $${queryIndex})`;
      params.push(`%${filters.search.trim()}%`);
      queryIndex++;
    }

    // 4. Category filter
    if (filters.category && filters.category.trim()) {
      sql += ` AND d.category = $${queryIndex}`;
      params.push(filters.category.trim());
      queryIndex++;
    }

    // 5. Owner filter
    if (filters.ownerId && filters.ownerId.trim()) {
      sql += ` AND d.owner_id = $${queryIndex}`;
      params.push(filters.ownerId.trim());
      queryIndex++;
    }

    // 6. Date Range filters
    if (filters.fromDate) {
      sql += ` AND d.created_at >= $${queryIndex}`;
      params.push(filters.fromDate);
      queryIndex++;
    }
    if (filters.toDate) {
      sql += ` AND d.created_at <= $${queryIndex}`;
      params.push(filters.toDate);
      queryIndex++;
    }

    sql += ` ORDER BY d.updated_at DESC;`;

    const res = await pool.query<{
      id: string;
      title: string;
      description: string;
      category: string;
      owner_id: string;
      owner_name: string;
      owner_email: string;
      effective_permission: 'owner' | 'edit' | 'read';
      grant_expires_at: Date | null;
      version_number: number;
      file_size: string;
      mime_type: string;
      original_filename: string;
      created_at: Date;
      updated_at: Date;
    }>(sql, params);

    return res.rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      effectivePermission: row.effective_permission,
      grantExpiresAt: row.grant_expires_at,
      latestVersionNumber: row.version_number,
      fileSize: parseInt(row.file_size, 10),
      mimeType: row.mime_type,
      originalFilename: row.original_filename,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
