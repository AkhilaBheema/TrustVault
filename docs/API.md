# TrustVault API Reference

All requests must use `Content-Type: application/json` unless multipart. State-changing requests (`POST`, `PATCH`, `DELETE`) require `X-CSRF-Token` header. Auth uses `httpOnly` secure session cookie.

## Authentication & Users
- `POST /api/auth/login` - Public (rate-limited). Body: `{ email, password }`. Sets session cookie, returns user & CSRF token.
- `POST /api/auth/logout` - Authenticated. Revokes current session from DB immediately.
- `GET /api/auth/me` - Authenticated. Returns current user profile.
- `POST /api/admin/users` - Admin only. Body: `{ email, name, role, initialPassword }`. Creates user in caller's organization; passwords must be at least 12 characters.
- `PATCH /api/admin/users/:id/status` - Admin only. Body: `{ isDisabled }`.
- `POST /api/admin/users/:id/force-logout` - Admin only. Immediately deletes all active DB sessions for user.

## Documents & Grants (Authorization Chokepoint)
*All document access is evaluated via `AuthorizationService.authorize()`. Unshared or missing documents return identical 404 with uniform timing.*
- `GET /api/documents` - Owner/Viewer. Scoped in SQL to owned or granted documents. Supports query params: `search`, `category`, `page`.
- `POST /api/documents` - Owner only. Multipart: `file`, `title`, `category`. Validates size, extension, and magic bytes. Encrypts with AES-256-GCM.
- `GET /api/documents/:id` - Owner or Granted Viewer. Returns document metadata, version count, and active grant status.
- `POST /api/documents/:id/versions` - Owner or Editor. Multipart: `file`. Increments version, preserves old encrypted versions.
- `DELETE /api/documents/:id` - Owner only. Soft-deletes document (30-day restore window).
- `POST /api/documents/:id/restore` - Owner only. Restores soft-deleted document.
- `DELETE /api/documents/:id/purge` - Owner only. Hard deletes document records and physical ciphertext files.
- `POST /api/documents/:id/download-ticket` - Owner/Viewer with read. Generates single-use, 60s ticket bound to user, doc, version, and grant version.
- `GET /api/documents/stream/:rawTicket` - Public endpoint validating ticket at stream time. Re-authorizes grant before decrypting and streaming payload.
- `GET /api/documents/:id/preview` - Owner/Viewer with read. Returns safe text preview; strictly refuses executable/HTML/SVG.

## Permissions & Access Management
- `GET /api/documents/:id/grants` - Owner or Granted Viewer. Returns list of explicit grants ("Who can see this").
- `POST /api/documents/:id/grants` - Owner only. Body: `{ userId, permission: 'read'|'edit', expiresAt? }`.
- `DELETE /api/documents/:id/grants/:userId` - Owner only. Revokes grant immediately (takes effect on next request).
- `POST /api/documents/:id/grants/revoke-all` - Owner only. Immediate emergency revocation of all third-party grants.
- `POST /api/documents/:id/access-requests` - Authenticated Viewer without access. Neutral request submission (reveals zero doc metadata).
- `GET /api/access-requests` - Owner. Lists pending requests for documents owned by caller.
- `POST /api/access-requests/:id/review` - Owner. Body: `{ decision: 'approve'|'deny', permission?, expiresAt?, reviewerNotes? }`. Future-dated expiry is required when supplied.

## AI Suggestions & Audit
- `GET /api/documents/:id/suggestions` - Owner only. Returns AI or deterministic permission suggestions based on category and history. Does NOT grant permissions.
- `POST /api/documents/:id/suggestions/confirm` - Owner only. Body: `{ accepted: [{ userId, permission, expiresAt? }], rejectedUserIds: [] }`. Applies grants and logs human confirmation.
- `GET /api/admin/audit` - Admin only. Filterable, paginated audit records for caller's organization.
- `GET /api/admin/audit/verify` - Admin only. Walks SHA-256 tamper-evident hash chain and reports verification status or break index.
- `GET /api/admin/audit/export` - Admin only. Exports audit logs to CSV with sanitization against formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`).
- `GET /api/admin/dashboard` - Admin only. Summarizes alerts: bulk downloads, failed access, rapid revocations, off-hours access.
