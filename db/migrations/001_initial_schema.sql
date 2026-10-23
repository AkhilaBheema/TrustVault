-- TrustVault Schema Migration 001: Initial Schema
-- Enforces UUIDv4 identifiers, relational integrity, multi-tenancy, and security boundaries.

-- 1. Organizations (Multi-tenant company boundaries)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'owner', 'viewer')),
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    failed_login_attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique email index (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_org ON users (organization_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- 3. Sessions (Server-side opaque sessions in DB, token is hashed)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (session_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- 4. Documents (Tenant-scoped, owned, soft-deletable)
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'General',
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    purge_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_org ON documents (organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents (owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents (is_deleted);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents (category);

-- 5. Document Versions (AES-256-GCM metadata and random storage key)
CREATE TABLE IF NOT EXISTS document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    file_size BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    sha256_hash TEXT NOT NULL,
    encrypted_dek TEXT NOT NULL,
    dek_iv TEXT NOT NULL,
    file_iv TEXT NOT NULL,
    file_auth_tag TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_doc_version UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_doc_versions_doc_id ON document_versions (document_id);

-- 6. Document Grants (Per-user explicit access; default deny)
CREATE TABLE IF NOT EXISTS document_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
    granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expires_at TIMESTAMPTZ,
    grant_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_doc_grant_user UNIQUE (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_grants_doc_user ON document_grants (document_id, user_id);
CREATE INDEX IF NOT EXISTS idx_grants_user ON document_grants (user_id);
CREATE INDEX IF NOT EXISTS idx_grants_expires ON document_grants (expires_at);

-- 7. Download Tickets (Single-use, <=60s expiry, tied to grant-version)
CREATE TABLE IF NOT EXISTS download_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_hash TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    grant_version INT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_hash ON download_tickets (ticket_hash);
CREATE INDEX IF NOT EXISTS idx_tickets_expires ON download_tickets (expires_at);

-- 8. Share Invites (Expiring, revocable, per-recipient)
CREATE TABLE IF NOT EXISTS share_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    permission TEXT NOT NULL CHECK (permission IN ('read', 'edit')),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invites_hash ON share_invites (token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_doc ON share_invites (document_id);

-- 9. Access Requests (Neutral direct-link requests)
CREATE TABLE IF NOT EXISTS access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_permission TEXT NOT NULL DEFAULT 'read' CHECK (target_permission IN ('read', 'edit')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at TIMESTAMPTZ,
    reviewer_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_req_doc ON access_requests (document_id);
CREATE INDEX IF NOT EXISTS idx_access_req_requester ON access_requests (requester_id);

-- 10. Audit Events (Hash-chained, tamper-evident log)
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_number BIGSERIAL UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    target_type TEXT,
    target_id UUID,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ALLOWED', 'DENIED', 'ERROR', 'INFO')),
    reason TEXT,
    ip_address TEXT,
    user_agent TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    prev_hash TEXT NOT NULL,
    current_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_events (sequence_number);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_events (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target_time ON audit_events (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_events (status);
