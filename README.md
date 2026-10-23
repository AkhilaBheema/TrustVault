# TrustVault

Zero-trust document sharing. The wrong person never reaches a file. Every access is provable.

## Quick Start (from clean clone)

```bash
git clone https://github.com/AkhilaBheema/TrustVault.git
cd trustvault
cp .env.example .env          # edit secrets if needed
docker-compose up -d          # starts postgres + backend + frontend
npm run db:seed               # loads the demo workspaces and sample activity
```

Open http://localhost:5173

## Seed Credentials

| Role   | Email                | Password           |
|--------|---------------------|--------------------|
| Admin  | admin@acme.com      | TrustVault2026!#   |
| Owner  | owner@acme.com      | TrustVault2026!#   |
| Viewer | viewer@acme.com     | TrustVault2026!#   |
| Admin  | admin@stark.com     | TrustVault2026!#   |
| Owner  | owner@stark.com     | TrustVault2026!#   |
| Viewer | viewer@stark.com    | TrustVault2026!#   |

Two isolated orgs (Acme Corp, Stark Industries) to test cross-tenant isolation.

The Acme preview includes six encrypted sample documents, three documents shared
with the viewer, one private roadmap with a pending access request, and a
hash-chained sample audit trail. The viewer can open the financial strategy,
employee directory, and time-limited board brief; the roadmap remains denied
until the owner reviews the request. Stark has a separate three-document demo.

## Manual Setup (no Docker)

```bash
# 1. PostgreSQL
createdb trustvault
psql trustvault < db/migrations/001_initial_schema.sql
psql trustvault < db/migrations/002_audit_immutability.sql
npm run db:seed               # creates demo accounts, encrypted documents, grants, and preview activity

# 2. Backend
cd backend && npm install
cp ../.env.example ../.env    # edit DATABASE_URL, MASTER_KEY, SESSION_SECRET
npm run dev                   # port 4000

# 3. Frontend
cd ../frontend && npm install
npm run dev                   # port 5173
```

## Run Tests

```bash
cd backend
npm test                      # vitest — uses PGlite in-memory DB, no real PG needed
```

## Deploy to Vercel + Render

The repository includes [`vercel.json`](./vercel.json) and [`render.yaml`](./render.yaml)
for a split deployment. Keep Vercel's project root at the repository root.

1. **Render API:** create a Blueprint from this repository. It provisions a
   PostgreSQL database and the `trustvault-api` web service, applies migrations,
   seeds the demo workspace on its first successful deploy, and stores encrypted
   uploads on a persistent disk.
2. Set `MASTER_KEY` in the Render dashboard to a private, randomly generated
   64-character hexadecimal value. Set `CORS_ORIGIN` to the production Vercel
   origin, such as `https://trustvault.vercel.app`. Render generates
   `SESSION_SECRET` for the service.
3. **Vercel frontend:** import the same repository and deploy from its root.
   `vercel.json` installs and builds `frontend`, then proxies `/api/*` through
   Vercel to `https://trustvault-api.onrender.com/api/*`. If the Render service
   gets a different URL, update that destination in `vercel.json`.
4. Leave `VITE_API_URL` unset in Vercel. The frontend uses the same-origin
   `/api` route, so secure `SameSite=Strict` session cookies work without
   exposing the Render API as a separate browser origin.

The Render Blueprint uses paid small web and PostgreSQL plans so encrypted
uploads and database records persist. Review those plans before creating the
services in Render.

For a same-origin local setup, leave `VITE_API_URL` unset and use the default
`COOKIE_SAME_SITE=strict` from `.env.example`.

## Stack Rationale

| Choice | Why |
|--------|-----|
| Fastify | 3× faster than Express, schema-first validation hooks |
| PostgreSQL | ACID transactions for grant/session atomicity; advisory locks for hash chain |
| Server-side sessions | Revocation = one DELETE row; no JWT clock-skew problem |
| AES-256-GCM | Authenticated encryption; per-file DEK wrapped by env master key |
| Argon2id | Memory-hard; OWASP recommended for passwords |
| PGlite tests | In-memory PG-compatible engine; no test DB setup needed |

## Security Architecture

- **Single `authorize()` chokepoint** — `backend/src/services/authorization.service.ts`
- **Default deny** — every route that touches a document calls `authorize()` first
- **Same 404** for deny and nonexistent — no existence leaks
- **Audit chain** — SHA-256 hash chain; DB triggers block UPDATE/DELETE/TRUNCATE
- **Immediate revocation** — delete session/grant row; next request fails
- **Download tickets** — single-use, ≤60s, re-authorized at stream time

## Project Structure

```
trustvault/
├── backend/src/
│   ├── services/authorization.service.ts   ← THE chokepoint
│   ├── services/audit.service.ts           ← hash chain
│   ├── routes/                             ← all HTTP routes
│   ├── middleware/auth.ts                  ← authenticate, requireRole, verifyCsrf
│   └── repositories/document.repository.ts ← SQL-scoped list queries
├── frontend/src/
│   ├── App.tsx                             ← all UI views
│   └── api.ts                             ← API client with CSRF
├── db/
│   ├── migrations/                         ← plain SQL migrations
│   └── seed.ts                            ← seed data
└── docs/                                   ← ROLES.md, PERMISSION_MODEL.md, etc.
```
