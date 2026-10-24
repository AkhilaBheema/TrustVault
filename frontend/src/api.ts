/**
 * TrustVault Frontend — API Client
 * All requests go through this module; credentials: 'include' ensures
 * the httpOnly session cookie is sent on every request.
 * CSRF token is read from sessionStorage and sent as X-CSRF-Token header
 * on all state-changing requests (POST, PUT, PATCH, DELETE).
 */

export const API_BASE_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

function getCsrfToken(): string | null {
  return sessionStorage.getItem('csrf_token');
}

export function saveCsrfToken(token: string) {
  sessionStorage.setItem('csrf_token', token);
}

export function clearCsrfToken() {
  sessionStorage.removeItem('csrf_token');
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isMultipart = false
): Promise<T> {
  const headers: Record<string, string> = {};

  if (!isMultipart && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const csrfToken = getCsrfToken();
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: isMultipart
      ? (body as FormData)
      : body !== undefined
      ? JSON.stringify(body)
      : undefined,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ message: 'Unknown error' }));
    throw new ApiError(res.status, errorBody.message || 'Request failed', errorBody);
  }

  // Handle empty responses (204 etc.)
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Auth ───────────────────────────────────────────────────────
export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ user: User; csrfToken: string }>('POST', '/auth/login', { email, password }),
    sendOtp: (email: string, name?: string, mode: 'register' | 'login' = 'login') =>
      request<{ message: string }>('POST', '/auth/send-otp', { email, name, mode }),
    verifyOtp: (email: string, otp: string, name?: string, role?: 'owner' | 'viewer') =>
      request<{ user: User; csrfToken: string }>('POST', '/auth/verify-otp', { email, otp, name, role }),
    logout: () => request<void>('POST', '/auth/logout'),
    me: () => request<{ user: User; csrfToken: string }>('GET', '/auth/me'),
  },

  // ── Documents ───────────────────────────────────────────────
  documents: {
    list: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ documents: Document[] }>('GET', `/documents${qs}`);
    },
    catalog: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ documents: CatalogDocument[] }>('GET', `/documents/catalog${qs}`);
    },
    get: (id: string) => request<{ document: Document; versions: DocumentVersion[] }>('GET', `/documents/${id}`),
    upload: (formData: FormData) => request<Document>('POST', '/documents', formData, true),
    addVersion: (id: string, formData: FormData) =>
      request<{ version: DocumentVersion }>('POST', `/documents/${id}/versions`, formData, true),
    delete: (id: string) => request<{ message: string }>('DELETE', `/documents/${id}`),
    restore: (id: string) => request<{ message: string }>('POST', `/documents/${id}/restore`),
    purge: (id: string) => request<{ message: string }>('DELETE', `/documents/${id}/purge`),
  },

  // ── Download tickets ─────────────────────────────────────────
  tickets: {
    issue: (docId: string) =>
      request<{ rawTicket: string; expiresAt: string }>('POST', `/documents/${docId}/download-ticket`),
    download: async (docId: string, rawTicket: string) => {
      const res = await fetch(
        `${API_BASE_URL}/documents/${encodeURIComponent(docId)}/download?ticket=${encodeURIComponent(rawTicket)}`,
        { credentials: 'include', referrerPolicy: 'no-referrer' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string } | null;
        throw new ApiError(res.status, body?.message || 'Download failed');
      }
      return {
        blob: await res.blob(),
        filename: res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'document',
      };
    },
  },

  // ── Grants ───────────────────────────────────────────────────
  grants: {
    list: (docId: string) => request<{ grants: Grant[]; ownerId: string; ownerEmail: string }>('GET', `/documents/${docId}/grants`),
    issue: (docId: string, userId: string, permission: 'read' | 'edit', expiresAt?: string | null) =>
      request<{ grant: Grant }>('POST', `/documents/${docId}/grants`, { userId, permission, expiresAt }),
    revoke: (docId: string, userId: string) => request<{ message: string }>('DELETE', `/documents/${docId}/grants/${userId}`),
    revokeAll: (docId: string) => request<{ revokedCount: number }>('POST', `/documents/${docId}/grants/revoke-all`),
  },

  // ── Access requests ──────────────────────────────────────────
  accessRequests: {
    submit: (docId: string, targetPermission: 'read' | 'edit' = 'read') =>
      request<{ message: string }>('POST', `/documents/${encodeURIComponent(docId)}/access-requests`, { targetPermission }),
    listPending: () => request<{ requests: AccessRequest[] }>('GET', '/access-requests'),
    listOwned: () => request<{ requests: AccessRequest[] }>('GET', '/access-requests?status=all'),
    listMine: () => request<{ requests: AccessRequest[] }>('GET', '/access-requests/mine'),
    review: (
      requestId: string,
      decision: 'approve' | 'deny',
      permission: 'read' | 'edit' = 'read',
      expiresAt: string | null = null,
      reviewerNotes: string | null = null
    ) => request<{ status: 'approved' | 'denied'; message: string }>(
      'POST', `/access-requests/${requestId}/review`, { decision, permission, expiresAt, reviewerNotes }
    ),
  },

  // ── External share invitations ─────────────────────────────
  invites: {
    create: (docId: string, recipientEmail: string, permission: 'read' | 'edit', expiresInHours = 72) =>
      request<{ invite: ShareInvite; rawToken: string }>('POST', `/documents/${docId}/invites`, { recipientEmail, permission, expiresInHours }),
    list: (docId: string) => request<{ invites: ShareInvite[] }>('GET', `/documents/${docId}/invites`),
    revoke: (docId: string, inviteId: string) =>
      request<{ message: string }>('DELETE', `/documents/${docId}/invites/${inviteId}`),
    accept: (token: string) => request<{ message: string }>('POST', '/invites/accept', { token }),
  },

  // ── Admin ────────────────────────────────────────────────────
  admin: {
    listUsers: () => request<{ users: AdminUser[] }>('GET', '/admin/users'),
    createUser: (data: { email: string; name: string; role: string; initialPassword: string }) =>
      request<AdminUser>('POST', '/admin/users', data),
    updateStatus: (userId: string, isDisabled: boolean) =>
      request<{ id: string; isDisabled: boolean }>('PATCH', `/admin/users/${userId}/status`, { isDisabled }),
    forceLogout: (userId: string) => request<{ revokedSessionsCount: number }>('POST', `/admin/users/${userId}/force-logout`),
    unlock: (userId: string) => request<{ id: string }>('POST', `/admin/users/${userId}/unlock`),
    audit: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ events: AuditEvent[]; pagination: Pagination }>('GET', `/admin/audit${qs}`);
    },
    verifyChain: () => request<{ isValid: boolean; totalRecords: number; brokenAtSequence: number | null; message: string }>('GET', '/admin/audit/verify'),
    exportCsv: async (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      const res = await fetch(`${API_BASE_URL}/admin/audit/export${qs}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) throw new ApiError(res.status, 'Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trustvault-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    dashboard: () => request<{ alerts: DashboardAlerts; generatedAt: string }>('GET', '/admin/dashboard'),
    activityDocument: (docId: string, params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ events: AuditEvent[]; pagination: Pagination }>('GET', `/admin/activity/document/${docId}${qs}`);
    },
    activityUser: (userId: string, params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ events: UserActivityEvent[]; pagination: Pagination }>('GET', `/admin/activity/user/${userId}${qs}`);
    },
  },

  // ── AI Suggestions ───────────────────────────────────────────
  suggestions: {
    generate: (docId: string) =>
      request<{ suggestions: Suggestion[]; provider: string; note: string }>('POST', `/documents/${docId}/suggestions`),
    confirm: (docId: string, data: {
      userId: string;
      suggestedPermission: 'read' | 'edit';
      confirmedPermission: 'read' | 'edit';
      decision: 'accepted' | 'rejected' | 'modified';
      expiresAt?: string | null;
      aiRationale?: string;
    }) => request<{ decision: string; grant?: Grant }>('POST', `/documents/${docId}/suggestions/confirm`, data),
  },
};

// ── Types ─────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'owner' | 'viewer';
  organizationId: string;
}

export interface AdminUser extends User {
  isDisabled: boolean;
  failedLoginAttempts: number;
  lockedUntil?: string | null;
  activeSessionsCount: number;
  createdAt: string;
}

export interface Document {
  id: string;
  title: string;
  description: string;
  category: string;
  ownerId: string;
  ownerName?: string;
  ownerEmail?: string;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  effectivePermission?: 'owner' | 'read' | 'edit';
}

/** Lightweight catalog entry — no content, no version details. */
export interface CatalogDocument {
  id: string;
  title: string;
  description: string;
  category: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  myPermission: 'owner' | 'read' | 'edit' | null;
  hasAccess: boolean;
  createdAt: string;
}

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  fileSize: number;
  mimeType: string;
  originalFilename: string;
  sha256Hash: string;
  createdAt: string;
}

export interface Grant {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  permission: 'read' | 'edit';
  expiresAt?: string | null;
  createdAt: string;
  grantVersion: number;
}

export interface AccessRequest {
  id: string;
  documentId: string;
  documentTitle: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  targetPermission: 'read' | 'edit';
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  documentOwnerName?: string;
  documentOwnerEmail?: string;
  reviewedAt?: string | null;
  reviewerName?: string | null;
  reviewerNotes?: string | null;
  currentAccessStatus?: 'active' | 'expired' | 'none' | 'unavailable';
  currentGrantPermission?: 'read' | 'edit' | null;
  currentGrantExpiresAt?: string | null;
  documentDeleted?: boolean;
}

export interface ShareInvite {
  id: string;
  documentId: string;
  email: string;
  permission: 'read' | 'edit';
  expiresAt: string;
  revokedAt: string | null;
  usedAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  sequenceNumber: number;
  eventType: string;
  actorEmail?: string;
  actorId?: string;
  action: string;
  status: 'ALLOWED' | 'DENIED' | 'ERROR' | 'INFO';
  targetType?: string;
  targetId?: string;
  reason?: string;
  ipAddress?: string;
  createdAt: string;
}

export interface UserActivityEvent {
  id: string;
  sequence_number: number | string;
  event_type: string;
  target_type?: string | null;
  target_id?: string | null;
  action: string;
  status: string;
  reason?: string | null;
  ip_address?: string | null;
  created_at: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DashboardAlerts {
  bulkDownloads: AlertItem[];
  repeatedDenials: AlertItem[];
  offHoursAccess: AlertItem[];
  quickRevokes: AlertItem[];
  newIpLogins: AlertItem[];
  expiredTokenAttempts: AlertItem[];
}

export interface AlertItem {
  actorEmail?: string;
  actorId?: string;
  label: string;
  latestAt?: string;
  ipAddress?: string;
  documentId?: string;
}

export interface Suggestion {
  userId: string;
  email: string;
  name: string;
  suggestedPermission: 'read' | 'edit';
  rationale: string;
}
