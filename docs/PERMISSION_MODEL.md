# TrustVault Permission & Authorization Model

## 1. High-Level Architecture: Single Authorization Chokepoint

Every incoming HTTP request or internal job that attempts to read, preview, download, edit, delete, or inspect metadata of a document must pass through a single, non-bypassable chokepoint function:

```typescript
authorize(actor: UserContext, documentId: string, action: DocumentAction): Promise<AuthResult>
```

### Core Invariants:
1. **Default Deny**: If no explicit rule or grant allows the action, access is denied immediately.
2. **Uniform Error Surface (Zero Existence Leaks)**: If access is denied (whether because the user has no grant, the grant has expired, the tenant doesn't match, or the document genuinely does not exist), the API returns the **exact same response**:
   ```json
   {
     "error": "Not Found",
     "message": "Resource not found or access denied."
   }
   ```
   HTTP Status: `404 Not Found`.
   No differential timing, headers, or error messages are returned, rendering document enumeration and IDOR attacks completely ineffective.
3. **Stream-Time Authorization**:
   File bytes are never handed off to static file servers or long-lived public URLs. The server executes `authorize()` at the exact moment the stream is initiated.

---

## 2. Design Choices & Trade-offs (What Was Chosen vs. Rejected)

### 2.1 Server-Side Database Sessions vs. Stateless JWTs
* **Chosen**: Opaque, cryptographically random session tokens (256-bit entropy) stored in the database, delivered via `httpOnly`, `Secure`, `SameSite=Strict` cookies. Only the SHA-256 hash of the token is persisted in the database.
* **Rejected**: Stateless long-lived JWTs.
* **Reasoning**: A stateless JWT cannot be revoked immediately without introducing a secondary centralized revocation blacklist. If an employee is terminated or a credential is compromised, a stateless JWT remains valid until its signature expires. TrustVault requires that revoking a user or session terminates all access instantly on the next request.

### 2.2 Direct per-request Grant Lookup vs. Cached Grants
* **Chosen**: Evaluating the user's explicit grant in PostgreSQL on every request.
* **Rejected**: In-memory Redis caching or client-held permission tokens.
* **Cost of Immediate Revocation**:
  * Exactly **one indexed B-tree lookup** (`idx_grants_doc_user` on `document_id, user_id`).
  * In PostgreSQL, this lookup takes approximately **0.1 to 0.3 milliseconds**.
  * By paying this tiny query cost, we achieve **100% immediate revocation guarantee**: when an owner deletes a grant, all subsequent requests by that viewer are refused instantaneously without cache invalidation delays, race conditions, or distributed sync bugs.

### 2.3 Explicit Document Grants vs. Folder Hierarchy Inheritance
* **Chosen**: Direct per-document grants (`read` or `edit`).
* **Rejected**: Nested folder inheritance and group-cascading permissions.
* **Reasoning**: Studies across enterprise data breaches consistently demonstrate that nested folder inheritance is the primary cause of accidental data exposure. Users drop sensitive files into a subfolder without realizing an ancestor folder was shared with a wider audience. In TrustVault, every document's access list is self-contained and visible on the "Who can see this?" panel.

### 2.4 SQL Repository Scoping vs. Application-Level Filtering
* **Chosen**: Repository functions that embed the actor's grant check directly into the SQL `WHERE` clause.
* **Rejected**: Fetching documents from the database and filtering them in Node.js memory.
* **Reasoning**: Application-level filtering leaks document existence through paginated counts, search facets, total result headers, and response latency. SQL-level scoping guarantees that documents not reachable by the actor are invisible to the database execution plan itself.

---

## 3. The Lifecycle of an Access Request

```
1. Client Request
       │
       ▼
2. Authenticate Session (Lookup session_token_hash in DB)
       │ (Active & Not Expired)
       ▼
3. Call authorize(actor, documentId, action)
       │
       ├──► Check 1: Multi-tenant boundary match? (actor.orgId === doc.orgId)
       │       └── False -> DENY (404) + Log DENIED Audit
       │
       ├──► Check 2: Soft-deleted? (doc.is_deleted === true)
       │       └── True -> Only Owner can restore; all others DENY (404)
       │
       ├──► Check 3: Is Actor the Owner?
       │       └── True -> ALLOW (all actions)
       │
       ├──► Check 4: Action is Admin-restricted (e.g. view audit log, lock user)?
       │       └── If actor.role === 'admin' -> ALLOW metadata action
       │       └── If content action -> Proceed to Check 5 (Admin cannot view file content)
       │
       └──► Check 5: Explicit Grant in document_grants?
               ├── Found grant AND now() < expires_at AND action matches permission -> ALLOW
               └── Otherwise -> DENY (404) + Log DENIED Audit
```
