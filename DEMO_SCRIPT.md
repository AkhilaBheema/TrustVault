# TrustVault 5-Minute Live Demo Script (DEMO_SCRIPT.md)

This script walks an interviewer through the core zero-trust principles and authorization guarantees of TrustVault in under 5 minutes.

---

### Step 1: Separation of Duties & Admin Zero-Knowledge (0:00 - 1:00)
1. **Login as Admin** (`admin@acme.com` / `TrustVault2026!#`).
2. Navigate to **Audit Logs** and **Users**: show that admin can manage users, view system alerts, and verify audit integrity.
3. Attempt to view or download `Acme Financial Strategy 2026.pdf`.
4. **Key Talking Point**: Admin is greeted with a 404 / access denied. Separation of duties is strictly enforced: an admin has administrative authority, not intrinsic content access.
5. Log out.

---

### Step 2: Owner Upload, Encryption, and Scoped Sharing (1:00 - 2:00)
1. **Login as Owner** (`owner@acme.com` / `TrustVault2026!#`).
2. Drag and drop a document (e.g. `Strategy.pdf`) to upload:
   - Point out magic-byte verification in action.
   - Mention AES-256-GCM envelope encryption with per-file DEK.
3. Open the document detail page:
   - Point out the **"Who can see this?"** panel: *"Only you (owner) can see this. Admins have no access."*
4. Click **"Get Suggestions"**: show AI/rule-based sharing suggestions based on category. Note that checkboxes remain unselected until human confirmation.
5. Grant `viewer@acme.com` **Read** permission with a 1-hour expiry.
6. Log out.

---

### Step 3: Viewer Access & Direct Stream Authorization (2:00 - 3:00)
1. **Login as Viewer** (`viewer@acme.com` / `TrustVault2026!#`).
2. Show the document list: the viewer sees *only* documents explicitly granted to them.
3. Open the shared document and click **Download**:
   - Explain the two-phase download flow: generates a single-use 60s ticket, re-authorizes at actual stream time before decrypting bytes.
4. Try to access an unshared document ID directly via URL:
   - Observe the neutral 404 response with zero existence leak or metadata disclosure.
5. Log out.

---

### Step 4: Instant Revocation & Zero Clock-Skew (3:00 - 4:00)
1. **Login as Owner** (`owner@acme.com`).
2. Navigate to the document and click **"Revoke"** next to `viewer@acme.com` (or "Revoke All").
3. Log out and switch back to **Viewer** (`viewer@acme.com`).
4. Refresh the page: the document immediately vanishes from the list.
5. Attempt direct GET or ticket redemption: immediately returns 404.
6. **Key Talking Point**: No JWT expiration lag or polling interval. Authorization runs on every request; row deletion in Postgres is instantaneous.

---

### Step 5: Tamper-Evident Audit Verification & Export (4:00 - 5:00)
1. **Login as Admin** (`admin@acme.com`).
2. Navigate to **Audit Logs**:
   - Point out the logged grant creation, viewer download, denied attempt, and grant revocation.
3. Click **"Verify Chain Integrity"**:
   - Shows the green verification banner: SHA-256 hash chain intact across all sequential events.
4. Click **"Export CSV"**:
   - Open CSV and highlight that dangerous formula characters (`=`, `+`, `@`) are prepended with single quotes `'` to prevent CSV formula injection.
5. Show **Admin Alerts**:
   - Demonstrates detection of anomalous behavior (e.g. rapid grant/revoke cycles, repeated failed attempts).
