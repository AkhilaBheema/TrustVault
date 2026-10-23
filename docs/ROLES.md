# TrustVault Role-Based Access Control & Separation of Duties

TrustVault enforces a strict, zero-trust security model founded on the principle of **least privilege** and **separation of duties**. There is no "super-user" who implicitly bypasses access control checks.

---

## 1. Role Definitions

### 1.1 Admin
* **Purpose**: System administration, user lifecycle management, session control, and audit compliance.
* **Capabilities**:
  * Create users and disable, enable, or unlock accounts within their organization.
  * Terminate active sessions (force-logout) for compromised or departed accounts.
  * Review user status and session counts, security alerts, and each user's recorded activity.
  * Filter and export the organization-scoped tamper-evident audit log, including access-request events, and verify its hash chain.
* **Security Restriction (Separation of Duties)**:
  * **An Administrator CANNOT automatically view, download, preview, or edit document contents.**
  * *Justification*: In enterprise and security-critical settings, IT administrators manage infrastructure, accounts, and compliance. Conflating system administration with document content access violates confidentiality and creates a massive insider-threat vector. If an admin requires access to a sensitive document (e.g., quarterly financials or legal IP), they must be explicitly granted access by the document's owner like any other actor, and that grant is permanently recorded in the immutable audit trail.

### 1.2 Owner
* **Purpose**: Full lifecycle ownership of their uploaded documents.
* **Capabilities**:
  * Upload new documents and upload subsequent versions.
  * Issue `read` and `edit` grants to users in the organization, set optional expirations, and revoke individual or all grants.
  * Create recipient-bound invitation links with an expiry and revoke them before they are used. The recipient must have a workspace account and sign in with the invited email.
  * Review and approve or deny incoming document access requests.
  * Review pending requests and past decisions, choose the granted permission and expiry, and attach a note to the requester.
  * Inspect document grants, revoke all grants during an incident, and confirm or reject permission suggestions.
* **Security Boundary**:
  * Owners have zero privilege over documents owned by other users, unless explicitly granted.

### 1.3 Viewer
* **Purpose**: Target consumer or collaborator on specific granted documents.
* **Capabilities**:
  * Read, download, or edit documents according to an explicit, active `document_grants` entry.
  * Request read or edit access using a document UUID or link, or request edit access from a document they can read.
  * Search and filter a private request history with owner notes, decision dates, and the current grant state. Open a document directly when its grant is active.
* **Security Boundary**:
* Search results, list endpoints, and autocomplete omit documents without an active grant. Request history contains only requests submitted by the signed-in user.

### 1.4 Admin access-request oversight
* Administrators can filter their organization-scoped audit log to access-request events without receiving document-content access or owner review controls.

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
  * Document operations return a generic `404 Not Found`; access-request submission returns the same neutral response for missing and cross-tenant documents.
