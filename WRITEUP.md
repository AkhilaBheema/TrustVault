# TrustVault Implementation Writeup (WRITEUP.md)

## 1. What Was Built (Complete & Verified)

### Core Architecture & Authorization
- **Single Chokepoint (`authorize`)**: Centralized in `backend/src/services/authorization.service.ts`. Evaluates ownership, explicit per-document grants (`read`/`edit`), time-based expiry at check time, soft-delete state, and tenant organization boundary.
- **Uniform 404 & Anti-Enumeration**: Denied requests and non-existent IDs return identical HTTP 404 responses (`Resource not found or access denied`) to prevent document existence discovery.
- **SQL-Scoped Queries**: All document list and search queries join against active grants directly in PostgreSQL (`backend/src/repositories/document.repository.ts`), ensuring zero metadata/count leaks.
- **Server-Side Session Management**: 256-bit secure random tokens stored hashed in DB with idle (30m) and absolute (12h) timeouts. Single-endpoint immediate revocation invalidates sessions instantly.

### Cryptography & Storage Security
- **AES-256-GCM Envelope Encryption**: Per-document DEK (Data Encryption Key) wrapped by a 256-bit Master Key from environment variables.
- **Zero Static File Serving**: Files stored with UUID filenames in private directory; never mapped to web server paths. Path traversal impossible by design.
- **Strict Upload Validation**: Validates file size (≤15MB), extension allowlist, and magic-byte sniffing (PDF, PNG, JPEG, DOCX, XLSX). Disallows executables, scripts, and archives.
- **Secure Downloads**: Single-use download tickets (≤60s lifespan) re-verified at stream time. Forced `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and strict CSP.

### Tamper-Evident Audit Trail
- **Cryptographic Hash Chain**: Every `audit_events` row stores the SHA-256 hash of `(prev_hash + timestamp + actor + action + target + outcome + metadata)`.
- **Database-Level Immutability**: PostgreSQL triggers prevent `UPDATE`, `DELETE`, or `TRUNCATE` operations on `audit_events`.
- **Chain Verification Endpoint**: `GET /api/admin/audit/verify` walks the entire chain in sequence and reports the exact broken record if altered.
- **CSV Injection Prevention**: Audit export sanitizes formula prefix characters (`=`, `+`, `-`, `@`, `\t`, `\r`) with single quotes.

### Role Separation & Features
- **Separation of Duties**: Admin can manage users and inspect audit logs, but cannot view document contents without an explicit grant from an Owner.
- **"Who can see this?" Panel**: Plain-language breakdown of all active grants, permissions, and expirations with a one-click "Revoke All" button.
- **Neutral Access Requests**: Unshared direct links display a neutral request form that reveals zero document metadata.
- **AI-Assisted Suggestions**: Suggests sharing candidates based on metadata using Claude API or a deterministic rule-based fallback. AI never writes to the DB; humans must review and confirm.
- **Admin "Needs Attention" Dashboard**: Flags anomalous activities (bulk downloads, repeated denials, off-hours access, rapid grant-revocation cycles).
- **Command Palette & UI Polish**: React 18 + Vite frontend with Tailwind, dark mode, keyboard navigation (Ctrl+K), upload progress indicators, and accessible controls.

---

## 2. What Was Intentionally Not Built (and Why)

1. **Folder Inheritance**: Intentionally omitted. Hierarchy-based permission inheritance introduces accidental over-sharing, subtle permission leakages, and complex cache invalidation bugs. Direct, per-document grants ensure unambiguous authorization.
2. **Long-Lived JWT Tokens**: Intentionally rejected. JWTs cannot be revoked immediately without stateful blacklists, undermining the zero-trust requirement of instantaneous revocation.
3. **Public / Anonymous Share Links**: Intentionally avoided. All external shares require invited email-bound accounts so every single view or download is attributable to a specific, auditable identity.
4. **Client-side PDF / Office In-Browser Rendering**: Intentionally avoided. In-browser rendering of complex PDF/DOCX engines carries significant XSS and memory corruption surface. Documents are previewed via text-only extract or downloaded as safe attachments.

---

## 3. Unfinished / Future Improvements

1. **Hardware Security Module (HSM / AWS KMS) Integration**: In current setup, the master encryption key is read from process environment variables. Production deployments should use KMS with automatic key rotation and envelope key wrapping.
2. **Real-time Webhook / WebSocket Audit Alerts**: Currently, the admin dashboard evaluates alerts on request. Push notifications via WebSockets would notify security teams in real-time.
3. **Dedicated Read-Only DB Replica**: Moving audit verification to a read-only replica would isolate heavy cryptographic chain verification queries from OLTP application traffic.
