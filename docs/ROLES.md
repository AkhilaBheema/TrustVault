# TrustVault Role-Based Access Control & Separation of Duties

TrustVault enforces a strict, zero-trust security model founded on the principle of **least privilege** and **separation of duties**. There is no "super-user" who implicitly bypasses access control checks.

---

## 1. Role Definitions

### 1.1 Admin
* **Purpose**: System administration, user lifecycle management, session control, and audit compliance.
* **Capabilities**:
  * Create, update, disable, and unlock users within their organization.
  * Terminate active sessions (force-logout) for compromised or departed accounts.
  * View system-wide metadata: user rosters, permission lists, access request statuses, and alert dashboards.
  * Inspect tamper-evident audit logs and execute the cryptographic hash-chain verification endpoint.
* **Security Restriction (Separation of Duties)**:
  * **An Administrator CANNOT automatically view, download, preview, or edit document contents.**
  * *Justification*: In enterprise and security-critical settings, IT administrators manage infrastructure, accounts, and compliance. Conflating system administration with document content access violates confidentiality and creates a massive insider-threat vector. If an admin requires access to a sensitive document (e.g., quarterly financials or legal IP), they must be explicitly granted access by the document's owner like any other actor, and that grant is permanently recorded in the immutable audit trail.

### 1.2 Owner
* **Purpose**: Full lifecycle ownership of their uploaded documents.
* **Capabilities**:
  * Upload new documents and upload subsequent versions.
  * Organize document metadata (title, description, category).
  * Issue, modify, and revoke per-document grants (`read`, `edit`) to other users in the organization.
  * Issue time-boxed grants with automatic millisecond-level expiration.
  * Issue external sharing invites with bounded expirations and email binding.
  * Soft-delete documents (retaining 30-day recovery) and perform permanent owner-only purge.
  * Approve or deny access requests submitted by users who attempt direct links.
  * View the "Who can see this?" real-time panel and trigger emergency "Revoke all" actions.
* **Security Boundary**:
  * Owners have zero privilege over documents owned by other users, unless explicitly granted.

### 1.3 Viewer
* **Purpose**: Target consumer or collaborator on specific granted documents.
* **Capabilities**:
  * Read or edit documents where an explicit, active `document_grants` entry exists for their user ID.
  * Request access when navigating to an ungranted document direct link (neutral UI without leaking title or metadata).
* **Security Boundary**:
  * Viewers have zero document listing visibility: search results, list endpoints, and autocomplete omit any document where the viewer does not possess an active grant.

---

## 2. Per-Document Permission Levels

| Permission | Can View / Preview | Can Download Stream | Can Upload New Version | Can Grant / Revoke | Can Delete / Purge |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Owner** | Yes | Yes | Yes | Yes | Yes |
| **Edit** | Yes | Yes | Yes | No | No |
| **Read** | Yes | Yes | No | No | No |
| **Admin** | *Only if granted* | *Only if granted* | *Only if granted* | No | No |

### Grant Constraints & Rules:
1. **Edit implies Read**: Any actor with `edit` permission is implicitly permitted to `read` and download the file.
2. **Edit cannot change permissions or delete**: Only the document `owner` can add/modify grants, approve access requests, or delete/restore the document.
3. **Optional Expiration**: Grants may specify an `expires_at` timestamp. Expired grants fail immediately at authorization evaluation time without relying on asynchronous background cleanup jobs.
4. **No Folder Inheritance**:
   * *Security Justification*: Hierarchical folder inheritance is the #1 cause of accidental over-sharing in cloud storage (e.g., placing a file in a sub-folder unaware that a parent folder has broad permissions). TrustVault intentionally rejects folder inheritance. Every document grant is explicit, granular, and visible directly on the document's access list.

---

## 3. Multi-Tenant Isolation (Company Boundaries)

* All users, documents, and audit logs are partitioned by `organization_id`.
* Cross-tenant access is structurally impossible:
  * Users in Company A cannot see, grant, or request access to documents in Company B.
  * Queries filter on `organization_id` at the database index level.
  * Any cross-tenant attempt returns a generic `404 Not Found` and logs a high-severity `DENIED` audit event.
