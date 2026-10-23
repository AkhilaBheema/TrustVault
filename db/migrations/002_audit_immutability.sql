-- TrustVault Schema Migration 002: Audit Immutability Trigger
-- Prevents UPDATE, DELETE, or TRUNCATE on audit_events at the database engine level.

CREATE OR REPLACE FUNCTION prevent_audit_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit trail violation: audit_events is strictly append-only. UPDATE, DELETE, and TRUNCATE are prohibited.';
END;
$$ LANGUAGE plpgsql;

-- Trigger to forbid UPDATE and DELETE on rows
DROP TRIGGER IF EXISTS trg_audit_events_immutable ON audit_events;
CREATE TRIGGER trg_audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_tampering();

-- Trigger to forbid TRUNCATE on the entire table
DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
CREATE TRIGGER trg_audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
EXECUTE FUNCTION prevent_audit_tampering();
