import crypto from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import * as argon2 from '@node-rs/argon2';
import { EncryptionService } from '../backend/src/services/encryption.service.js';
import { StorageService } from '../backend/src/services/storage.service.js';
import type { DatabasePool } from '../backend/src/db/index.js';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://trustvault:trustvault_secret@localhost:5432/trustvault';

export const SEED_PASSWORD_PLAIN = 'TrustVault2026!#';

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export async function runSeed(customPool?: DatabasePool) {
  const pool: DatabasePool = customPool || new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log('[SEED] Beginning database seed transaction...');
    await client.query('BEGIN');

    // 1. Hash default password with Argon2id
    console.log('[SEED] Computing Argon2id password hash with high-memory parameters...');
    const passwordHash = await argon2.hash(SEED_PASSWORD_PLAIN, {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    // 2. Create Organizations (Tenant isolation)
    console.log('[SEED] Inserting organizations...');
    const acmeRes = await client.query(
      `INSERT INTO organizations (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id;`,
      ['Acme Corp']
    );
    let acmeId = acmeRes.rows[0]?.id;
    if (!acmeId) {
      const existing = await client.query('SELECT id FROM organizations WHERE name = $1', ['Acme Corp']);
      acmeId = existing.rows[0].id;
    }

    const starkRes = await client.query(
      `INSERT INTO organizations (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id;`,
      ['Stark Industries']
    );
    let starkId = starkRes.rows[0]?.id;
    if (!starkId) {
      const existing = await client.query('SELECT id FROM organizations WHERE name = $1', ['Stark Industries']);
      starkId = existing.rows[0].id;
    }

    // 3. Helper to insert users
    const upsertUser = async (orgId: string, email: string, name: string, role: 'admin' | 'owner' | 'viewer') => {
      const res = await client.query(
        `INSERT INTO users (organization_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (LOWER(email)) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               name = EXCLUDED.name,
               role = EXCLUDED.role,
               organization_id = EXCLUDED.organization_id
         RETURNING id;`,
        [orgId, email.toLowerCase(), passwordHash, name, role]
      );
      return res.rows[0].id as string;
    };

    console.log('[SEED] Inserting Acme Corp users (Admin, Owner, Viewer)...');
    const acmeAdmin = await upsertUser(acmeId, 'admin@acme.com', 'Alice Vance (Admin)', 'admin');
    const acmeOwner = await upsertUser(acmeId, 'owner@acme.com', 'Oscar Wright (Owner)', 'owner');
    const acmeViewer = await upsertUser(acmeId, 'viewer@acme.com', 'Victor Reed (Viewer)', 'viewer');

    console.log('[SEED] Inserting Stark Industries users (Admin, Owner, Viewer)...');
    const starkAdmin = await upsertUser(starkId, 'admin@stark.com', 'Tony Stark (Admin)', 'admin');
    const starkOwner = await upsertUser(starkId, 'owner@stark.com', 'Pepper Potts (Owner)', 'owner');
    const starkViewer = await upsertUser(starkId, 'viewer@stark.com', 'Peter Parker (Viewer)', 'viewer');

    // 4. Helper to insert mock document and version
    const insertDocWithVersion = async (
      orgId: string,
      ownerId: string,
      title: string,
      description: string,
      category: string,
      filename: string,
      mimeType: string,
      fileSize: number
    ) => {
        void fileSize;
      // Check if document exists
      const existingDoc = await client.query(
        'SELECT id FROM documents WHERE organization_id = $1 AND title = $2',
        [orgId, title]
      );
      if (existingDoc.rows.length > 0) {
        return existingDoc.rows[0].id as string;
      }

      const docRes = await client.query(
        `INSERT INTO documents (organization_id, owner_id, title, description, category)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id;`,
        [orgId, ownerId, title, description, category]
      );
      const docId = docRes.rows[0].id as string;

      // Generate real file payload and perform AES-256-GCM envelope encryption
      const mockPayload = Buffer.from(`%PDF-1.4\n[TrustVault Seed Document]\nTitle: ${title}\nConfidential Organization Payload.`);
      const encrypted = EncryptionService.encrypt(mockPayload);
      const storagePath = StorageService.generateStoragePath();
      await StorageService.writeEncryptedFile(storagePath, encrypted.encryptedPayload);
      const sha256Hash = crypto.createHash('sha256').update(mockPayload).digest('hex');

      await client.query(
        `INSERT INTO document_versions (
           document_id, version_number, storage_path, file_size, mime_type,
           original_filename, sha256_hash, encrypted_dek, dek_iv, file_iv, file_auth_tag, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [
          docId,
          1,
          storagePath,
          mockPayload.length,
          mimeType,
          filename,
          sha256Hash,
          encrypted.encryptedDek,
          encrypted.dekIv,
          encrypted.fileIv,
          encrypted.fileAuthTag,
          ownerId,
        ]
      );

      return docId;
    };

    console.log('[SEED] Inserting sample documents for Acme Corp...');
    const acmeDoc1 = await insertDocWithVersion(
      acmeId,
      acmeOwner,
      'Acme Financial Strategy 2026.pdf',
      'Confidential Q1-Q4 operational budget and projections',
      'Financial',
      'Acme Financial Strategy 2026.pdf',
      'application/pdf',
      1024 * 350
    );

    const acmeDoc2 = await insertDocWithVersion(
      acmeId,
      acmeOwner,
      'Acme Product Roadmap Secret.docx',
      'Proprietary breakthrough hardware specifications',
      'Engineering',
      'Acme Product Roadmap Secret.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      1024 * 120
    );

    const acmeDoc3 = await insertDocWithVersion(
      acmeId,
      acmeOwner,
      'Acme Employee Directory.xlsx',
      'Internal directory with phone numbers and departments',
      'HR',
      'Acme Employee Directory.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      1024 * 45
    );

    const acmeDoc4 = await insertDocWithVersion(
      acmeId,
      acmeOwner,
      'Northstar Board Brief.pdf',
      'A concise board packet with quarterly priorities, runway, and decisions for review.',
      'Finance',
      'Northstar Board Brief.pdf',
      'application/pdf',
      1024 * 640
    );

    const acmeDoc5 = await insertDocWithVersion(
      acmeId,
      acmeOwner,
      'Vendor Assurance Packet.docx',
      'Security controls, data handling terms, and renewal notes for the Atlas vendor review.',
      'Legal',
      'Vendor Assurance Packet.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      1024 * 185
    );

    const acmeDoc6 = await insertDocWithVersion(
      acmeId,
      acmeOwner,
      'Q4 Hiring Plan.xlsx',
      'Team-level hiring targets and approved headcount for the fourth quarter.',
      'People',
      'Q4 Hiring Plan.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      1024 * 72
    );

    console.log('[SEED] Inserting sample documents for Stark Industries...');
    const starkDoc1 = await insertDocWithVersion(
      starkId,
      starkOwner,
      'Arc Reactor Schematics.pdf',
      'Clean energy clean power generator blueprints',
      'Engineering',
      'Arc Reactor Schematics.pdf',
      'application/pdf',
      1024 * 850
    );

    const starkDoc2 = await insertDocWithVersion(
      starkId,
      starkOwner,
      'Defense Contract Budget.xlsx',
      'Strictly classified departmental budget allocation',
      'Financial',
      'Defense Contract Budget.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      1024 * 210
    );

    const starkDoc3 = await insertDocWithVersion(
      starkId,
      starkOwner,
      'Facility Access Review.csv',
      'A demo access review for laboratory and secure-site permissions.',
      'Operations',
      'Facility Access Review.csv',
      'text/csv',
      1024 * 28
    );

    // 5. Explicit Document Grants
    console.log('[SEED] Setting up explicit grants...');
    // Acme Doc 1: Victor Reed has 'read'
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, permission, granted_by)
       VALUES ($1, $2, 'read', $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET permission = 'read';`,
      [acmeDoc1, acmeViewer, acmeOwner]
    );

    // Acme Doc 2: NO GRANTS (strictly private to owner Oscar Wright. Admin Alice Vance CANNOT read it!)
    // Acme Doc 3: Victor Reed has 'edit'
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, permission, granted_by)
       VALUES ($1, $2, 'edit', $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET permission = 'edit';`,
      [acmeDoc3, acmeViewer, acmeOwner]
    );

    // A time-boxed read grant gives the viewer a useful third document to preview.
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, permission, granted_by, expires_at)
       VALUES ($1, $2, 'read', $3, NOW() + INTERVAL '30 days')
       ON CONFLICT (document_id, user_id) DO UPDATE
         SET permission = 'read', expires_at = NOW() + INTERVAL '30 days';`,
      [acmeDoc4, acmeViewer, acmeOwner]
    );

    // Stark Doc 1: Peter Parker has 'read'
    await client.query(
      `INSERT INTO document_grants (document_id, user_id, permission, granted_by)
       VALUES ($1, $2, 'read', $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET permission = 'read';`,
      [starkDoc1, starkViewer, starkOwner]
    );
    // Stark Doc 2: NO GRANTS (strictly private to Pepper Potts)

    // Leave one realistic request pending so an owner can preview the review flow.
    const pendingRoadmapRequest = await client.query(
      `SELECT id FROM access_requests
       WHERE document_id = $1 AND requester_id = $2 AND status = 'pending'
       LIMIT 1;`,
      [acmeDoc2, acmeViewer]
    );
    if (pendingRoadmapRequest.rows.length === 0) {
      await client.query(
        `INSERT INTO access_requests (document_id, requester_id, target_permission)
         VALUES ($1, $2, 'read');`,
        [acmeDoc2, acmeViewer]
      );
    }

    // 6. Seed Genesis Audit Log Record
    console.log('[SEED] Initializing tamper-evident audit log genesis block...');
    const existingAudit = await client.query('SELECT id FROM audit_events LIMIT 1;');
    if (existingAudit.rows.length === 0) {
      const prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
      const eventType = 'SYSTEM_GENESIS';
      const action = 'DATABASE_INITIALIZED';
      const status = 'INFO';
      const reason = 'TrustVault database seeded with multi-tenant accounts';
      const payloadObj = { seed: true, version: '1.0.0' };
      const canonicalPayload = JSON.stringify(payloadObj); // keys already in sorted order {"seed":true,"version":"1.0.0"}

      const currentHash = crypto
        .createHash('sha256')
        .update(`${prevHash}|1|${eventType}|SYSTEM|${action}|${status}|${canonicalPayload}`)
        .digest('hex');

      await client.query(
        `INSERT INTO audit_events (
           sequence_number, event_type, actor_email, action, status, reason, payload, prev_hash, current_hash
         ) VALUES (1, $1, 'SYSTEM', $2, $3, $4, $5::jsonb, $6, $7);`,
        [eventType, action, status, reason, canonicalPayload, prevHash, currentHash]
      );
    }

    // Seed a few clearly marked events for the admin audit screen. They follow
    // the same SHA-256 chain as live activity and are inserted only once.
    const existingDemoEvents = await client.query(
      `SELECT id FROM audit_events WHERE payload->>'demoSeed' = 'true' LIMIT 1;`
    );
    if (existingDemoEvents.rows.length === 0) {
      const lastAudit = await client.query(
        `SELECT sequence_number, current_hash
         FROM audit_events ORDER BY sequence_number DESC LIMIT 1;`
      );
      let sequenceNumber = lastAudit.rows.length ? Number(lastAudit.rows[0].sequence_number) + 1 : 1;
      let previousHash = lastAudit.rows[0]?.current_hash || '0'.repeat(64);
      const demoEvents = [
        {
          actorId: acmeViewer, actorEmail: 'viewer@acme.com', organizationId: acmeId,
          eventType: 'DOCUMENT_ACCESS', targetId: acmeDoc1, action: 'DOCUMENT_VIEW', status: 'ALLOWED',
          reason: 'Demo preview: viewer opened a document with an active read grant.',
          payload: { demoSeed: true, documentTitle: 'Acme Financial Strategy 2026.pdf', permission: 'read' },
        },
        {
          actorId: acmeViewer, actorEmail: 'viewer@acme.com', organizationId: acmeId,
          eventType: 'DOCUMENT_ACCESS', targetId: acmeDoc2, action: 'DOCUMENT_VIEW', status: 'DENIED',
          reason: 'Demo preview: no active grant exists for this document.',
          payload: { demoSeed: true, documentTitle: 'Acme Product Roadmap Secret.docx', permission: 'read' },
        },
        {
          actorId: acmeOwner, actorEmail: 'owner@acme.com', organizationId: acmeId,
          eventType: 'GRANT_ISSUED', targetId: acmeDoc4, action: 'GRANT_ISSUED', status: 'INFO',
          reason: 'Demo preview: a time-boxed read grant was issued.',
          payload: { demoSeed: true, documentTitle: 'Northstar Board Brief.pdf', permission: 'read' },
        },
        {
          actorId: acmeViewer, actorEmail: 'viewer@acme.com', organizationId: acmeId,
          eventType: 'ACCESS_REQUEST', targetId: acmeDoc2, action: 'ACCESS_REQUEST_SUBMITTED', status: 'INFO',
          reason: 'Demo preview: viewer requested read access; owner review is pending.',
          payload: { demoSeed: true, documentTitle: 'Acme Product Roadmap Secret.docx', permission: 'read' },
        },
      ];

      for (const event of demoEvents) {
        const canonicalPayload = canonicalJson(event.payload);
        const currentHash = crypto.createHash('sha256')
          .update(`${previousHash}|${sequenceNumber}|${event.eventType}|${event.actorEmail}|${event.action}|${event.status}|${canonicalPayload}`)
          .digest('hex');
        await client.query(
          `INSERT INTO audit_events (
             sequence_number, event_type, actor_id, actor_email, organization_id,
             target_type, target_id, action, status, reason, payload, prev_hash, current_hash
           ) VALUES ($1, $2, $3, $4, $5, 'document', $6, $7, $8, $9, $10::jsonb, $11, $12);`,
          [sequenceNumber, event.eventType, event.actorId, event.actorEmail, event.organizationId,
            event.targetId, event.action, event.status, event.reason, canonicalPayload, previousHash, currentHash]
        );
        previousHash = currentHash;
        sequenceNumber += 1;
      }
    }

    await client.query('COMMIT');
    console.log('[SEED] Database seed completed successfully!');
    console.log('================================================================');
    console.log('SEED ACCOUNTS (Password: TrustVault2026!#)');
    console.log('----------------------------------------------------------------');
    console.log('Company: Acme Corp');
    console.log('  Admin:  admin@acme.com  (manage users/audit; CANNOT read docs without grant)');
    console.log('  Owner:  owner@acme.com  (owns Financial Strategy, Secret Roadmap, Directory)');
    console.log('  Viewer: viewer@acme.com (read on Strategy, edit on Directory, denied Roadmap)');
    console.log('Company: Stark Industries');
    console.log('  Admin:  admin@stark.com  (Stark admin)');
    console.log('  Owner:  owner@stark.com  (owns Arc Reactor, Defense Budget)');
    console.log('  Viewer: viewer@stark.com (read on Arc Reactor, denied Defense Budget)');
    console.log('================================================================');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEED] Seed failed:', err);
    throw err;
  } finally {
    client.release();
    if (!customPool) {
      await pool.end();
    }
  }
}

// Direct invocation check
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  runSeed().catch((err) => {
    console.error('[SEED] Seed execution error:', err);
    process.exit(1);
  });
}
